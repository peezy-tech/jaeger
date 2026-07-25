import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  statSync,
  truncateSync,
  watch,
  writeSync,
  type FSWatcher,
} from "node:fs";
import { chmod, mkdir, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { HarnessExecutionError } from "../errors.js";
import { systemdRunCommand } from "../launchers.js";
import {
  attachHarnessProcess,
  clearActiveHarnessProcess,
  createHarnessLaunchIntent,
  PROVIDER_TOKEN_ENV,
  signalActiveHarnessProcess,
  systemdScopeArgs,
  waitForHarnessProcessToStop,
  type ActiveHarnessProcess,
} from "./active-process.js";

export const HARNESS_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 2_000;

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

export interface HarnessProcessInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly transcriptDir: string;
  readonly signal?: AbortSignal;
  readonly boundedOutputFiles?: ReadonlyArray<{
    readonly path: string;
    readonly maxBytes?: number;
  }>;
  /** Test seam; production callers use the 16 MiB default. */
  readonly maxOutputBytes?: number;
  /** Test seam; production callers use the two-second default. */
  readonly killGraceMs?: number;
}

export interface StreamingHarnessProcessInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly transcriptDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly maxOutputBytes?: number;
  readonly killGraceMs?: number;
}

export interface StreamingHarnessProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly terminationReason?: TerminationReason;
}

export interface StreamingHarnessProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly done: Promise<StreamingHarnessProcessResult>;
  terminate(reason?: TerminationReason): void;
}

type TerminationReason =
  | "aborted"
  | "output-limit"
  | "output-monitor-error"
  | "timeout"
  | "transcript-error";

/**
 * Launch a bidirectional native harness transport inside the same lifecycle
 * containment used by non-streaming processes. Protocol consumers own stdin/stdout;
 * this layer records bounded transcripts and owns whole-tree teardown.
 */
export function spawnStreamingHarnessProcess(
  input: StreamingHarnessProcessInput,
): StreamingHarnessProcess {
  const maxOutputBytes = checkedPositiveInteger(
    input.maxOutputBytes ?? HARNESS_OUTPUT_LIMIT_BYTES,
    "maxOutputBytes",
  );
  const killGraceMs = checkedPositiveInteger(
    input.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    "killGraceMs",
  );
  mkdirSync(input.transcriptDir, { recursive: true, mode: 0o700 });
  chmodSync(input.transcriptDir, 0o700);
  const stdoutPath = path.join(input.transcriptDir, "stdout.log");
  const stderrPath = path.join(input.transcriptDir, "stderr.log");
  const stdoutFd = openSync(stdoutPath, "w", 0o600);
  const stderrFd = openSync(stderrPath, "w", 0o600);
  let activeProcess: ActiveHarnessProcess;
  try {
    activeProcess = createHarnessLaunchIntent(input.transcriptDir);
  } catch (error) {
    closeSync(stdoutFd);
    closeSync(stderrFd);
    throw error;
  }

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(systemdRunCommand(), [...systemdScopeArgs(activeProcess, input.command, input.args)], {
      cwd: input.cwd,
      env: {
        ...process.env,
        ...input.env,
        [PROVIDER_TOKEN_ENV]: activeProcess.token,
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: false,
    });
  } catch (error) {
    clearActiveHarnessProcess(activeProcess);
    closeSync(stdoutFd);
    closeSync(stderrFd);
    throw error;
  }
  if (child.pid === undefined) {
    clearActiveHarnessProcess(activeProcess);
    closeSync(stdoutFd);
    closeSync(stderrFd);
    throw new Error("provider process did not expose its PID");
  }
  try {
    activeProcess = attachHarnessProcess(activeProcess, child.pid);
  } catch (error) {
    child.kill("SIGKILL");
    closeSync(stdoutFd);
    closeSync(stderrFd);
    throw error;
  }

  let outputBytes = 0;
  let stderrTail = "";
  let terminationReason: TerminationReason | undefined;
  let forceKillTimer: NodeJS.Timeout | undefined;
  let treeKillChain = Promise.resolve();
  let transcriptError: unknown;
  let settled = false;

  const requestTreeKill = (signal: "SIGTERM" | "SIGKILL"): void => {
    treeKillChain = treeKillChain.catch(() => undefined).then(async () => {
      await signalActiveHarnessProcess(activeProcess, signal);
      try {
        child.kill(signal);
      } catch {}
    });
  };
  const terminate = (reason: TerminationReason = "aborted"): void => {
    if (settled || terminationReason) return;
    terminationReason = reason;
    requestTreeKill("SIGTERM");
    forceKillTimer = setTimeout(() => requestTreeKill("SIGKILL"), killGraceMs);
    forceKillTimer.unref();
  };
  const record = (fd: number, chunk: Buffer): void => {
    const accepted = boundedChunk(chunk, outputBytes, maxOutputBytes);
    if (accepted.length > 0) {
      outputBytes += accepted.length;
      try {
        let offset = 0;
        while (offset < accepted.length) {
          const written = writeSync(fd, accepted, offset, accepted.length - offset);
          if (written <= 0) throw new Error("could not persist harness transcript output");
          offset += written;
        }
      } catch (error) {
        transcriptError ??= error;
        terminate("transcript-error");
      }
    }
    if (accepted.length < chunk.length) terminate("output-limit");
  };
  child.stdout.on("data", (chunk: Buffer) => record(stdoutFd, chunk));
  child.stderr.on("data", (chunk: Buffer) => {
    record(stderrFd, chunk);
    stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-8_000);
  });

  const onAbort = (): void => terminate("aborted");
  input.signal?.addEventListener("abort", onAbort, { once: true });

  const done = new Promise<StreamingHarnessProcessResult>((resolve, reject) => {
    child.once("error", (error) => reject(error));
    child.once("close", (exitCode, signal) => {
      void (async () => {
        settled = true;
        if (forceKillTimer) clearTimeout(forceKillTimer);
        input.signal?.removeEventListener("abort", onAbort);
        if (terminationReason) requestTreeKill("SIGKILL");
        await treeKillChain.catch(() => undefined);
        if (!(await waitForHarnessProcessToStop(activeProcess, killGraceMs))) {
          requestTreeKill("SIGKILL");
          await treeKillChain.catch(() => undefined);
        }
        if (await waitForHarnessProcessToStop(activeProcess, killGraceMs)) {
          clearActiveHarnessProcess(activeProcess);
        }
        try {
          fsyncSync(stdoutFd);
          fsyncSync(stderrFd);
          closeSync(stdoutFd);
          closeSync(stderrFd);
        } catch (error) {
          transcriptError ??= error;
        }
        if (transcriptError) {
          reject(transcriptError);
          return;
        }
        resolve({
          exitCode,
          signal,
          stderr: stderrTail,
          stdoutPath,
          stderrPath,
          ...(terminationReason ? { terminationReason } : {}),
        });
      })();
    });
  });

  return { child, stdoutPath, stderrPath, done, terminate };
}

export async function runHarnessProcess(input: HarnessProcessInput): Promise<ProcessResult> {
  const maxOutputBytes = checkedPositiveInteger(
    input.maxOutputBytes ?? HARNESS_OUTPUT_LIMIT_BYTES,
    "maxOutputBytes",
  );
  const killGraceMs = checkedPositiveInteger(
    input.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    "killGraceMs",
  );
  const stdoutPath = path.join(input.transcriptDir, "stdout.log");
  const stderrPath = path.join(input.transcriptDir, "stderr.log");
  await mkdir(input.transcriptDir, { recursive: true, mode: 0o700 });
  await chmod(input.transcriptDir, 0o700);
  const transcripts = await openTranscripts(stdoutPath, stderrPath);

  const command = displayCommand(input.command, input.args);
  if (input.signal?.aborted) {
    await closeTranscripts(transcripts);
    throw executionError({
      command,
      exitCode: null,
      signal: null,
      stderr: "",
      reason: "aborted",
      executable: input.command,
      timeoutMs: input.timeoutMs,
    });
  }

  let activeProcess: ActiveHarnessProcess;
  try {
    activeProcess = createHarnessLaunchIntent(input.transcriptDir);
  } catch (error) {
    await closeTranscripts(transcripts);
    throw error;
  }

  let child: ChildProcessWithoutNullStreams;
  let earlySpawnError: unknown;
  const observeEarlySpawnError = (error: unknown): void => {
    earlySpawnError = error;
  };
  try {
    child = spawn(systemdRunCommand(), [...systemdScopeArgs(activeProcess, input.command, input.args)], {
      cwd: input.cwd,
      env: { ...process.env, [PROVIDER_TOKEN_ENV]: activeProcess.token },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: false,
    });
    child.once("error", observeEarlySpawnError);
  } catch (error) {
    clearActiveHarnessProcess(activeProcess);
    await closeTranscripts(transcripts);
    throw error;
  }

  if (child.pid === undefined) {
    // ENOENT is emitted asynchronously. Yield once with an observer already
    // attached, then clean the intent without attempting to control a scope
    // that was never launched.
    await new Promise<void>((resolve) => setImmediate(resolve));
    clearActiveHarnessProcess(activeProcess);
    await closeTranscripts(transcripts);
    throw earlySpawnError ?? new Error("provider process did not expose its PID");
  }

  try {
    activeProcess = attachHarnessProcess(activeProcess, child.pid);
  } catch (error) {
    try {
      await signalActiveHarnessProcess(activeProcess, "SIGKILL");
    } catch {}
    try {
      child.kill("SIGKILL");
    } catch {}
    if (await waitForHarnessProcessToStop(activeProcess, killGraceMs)) {
      clearActiveHarnessProcess(activeProcess);
    }
    await closeTranscripts(transcripts);
    throw earlySpawnError ?? error;
  }

  return await new Promise<ProcessResult>((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputBytes = 0;
    let settled = false;
    let terminationReason: TerminationReason | undefined;
    let transcriptError: unknown;
    let outputMonitorError: unknown;
    let treeKillError: unknown;
    let treeKillChain = Promise.resolve();
    let forceKillTimer: NodeJS.Timeout | undefined;

    const timeout = setTimeout(() => terminate("timeout"), input.timeoutMs);
    timeout.unref();

    const onAbort = (): void => terminate("aborted");
    input.signal?.addEventListener("abort", onAbort, { once: true });

    const terminate = (reason: TerminationReason): void => {
      if (terminationReason || settled) return;
      terminationReason = reason;
      clearTimeout(timeout);

      // Do not retain output produced while a process tree is being torn down.
      child.stdout.removeAllListeners("data");
      child.stderr.removeAllListeners("data");
      child.stdout.destroy();
      child.stderr.destroy();

      requestTreeKill("SIGTERM");
      forceKillTimer = setTimeout(() => requestTreeKill("SIGKILL"), killGraceMs);
      forceKillTimer.unref();
    };

    const requestTreeKill = (signal: "SIGTERM" | "SIGKILL"): void => {
      treeKillChain = treeKillChain.catch(() => undefined).then(async () => {
        await signalActiveHarnessProcess(activeProcess, signal);
        try {
          child.kill(signal);
        } catch {}
      });
      void treeKillChain.catch((error: unknown) => {
        treeKillError ??= error;
      });
    };

    const outputMonitor = monitorBoundedFiles(
      (input.boundedOutputFiles ?? []).map((file) => ({
        path: file.path,
        maxBytes: checkedPositiveInteger(file.maxBytes ?? maxOutputBytes, "bounded file maxBytes"),
      })),
      () => terminate("output-limit"),
      (error) => {
        outputMonitorError ??= error;
        terminate("output-monitor-error");
      },
    );

    child.stdout.on("data", (chunk: Buffer) => {
      const accepted = boundedChunk(chunk, outputBytes, maxOutputBytes);
      if (accepted.length > 0) {
        stdout.push(accepted);
        stdoutBytes += accepted.length;
        outputBytes += accepted.length;
        try {
          writeFully(transcripts.stdout, accepted);
        } catch (error) {
          transcriptError ??= error;
          terminate("transcript-error");
        }
      }
      if (accepted.length < chunk.length) terminate("output-limit");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const accepted = boundedChunk(chunk, outputBytes, maxOutputBytes);
      if (accepted.length > 0) {
        stderr.push(accepted);
        stderrBytes += accepted.length;
        outputBytes += accepted.length;
        try {
          writeFully(transcripts.stderr, accepted);
        } catch (error) {
          transcriptError ??= error;
          terminate("transcript-error");
        }
      }
      if (accepted.length < chunk.length) terminate("output-limit");
    });

    child.once("error", (error) => {
      void finish(async () => reject(error));
    });
    child.removeListener("error", observeEarlySpawnError);
    child.once("close", (code, signal) => {
      void finish(async () => {
        const stdoutText = Buffer.concat(stdout, stdoutBytes).toString("utf8");
        const stderrText = Buffer.concat(stderr, stderrBytes).toString("utf8");
        if (terminationReason || code !== 0) {
          reject(
            executionError({
              command,
              exitCode: code,
              signal,
              stderr: stderrText.slice(-8_000),
              ...(terminationReason ? { reason: terminationReason } : {}),
              executable: input.command,
              timeoutMs: input.timeoutMs,
              maxOutputBytes,
            }),
          );
          return;
        }
        resolve({
          stdout: stdoutText,
          stderr: stderrText,
          exitCode: code ?? 0,
          stdoutPath,
          stderrPath,
        });
      });
    });

    child.stdin.on("error", () => undefined);
    child.stdin.end(input.stdin);

    async function finish(callback: () => Promise<void>): Promise<void> {
      if (settled) return;
      outputMonitor.check();
      settled = true;
      clearTimeout(timeout);
      // The group leader can exit on SIGTERM before a descendant that ignores
      // it. Re-signal the group before canceling the grace timer.
      if (terminationReason) requestTreeKill("SIGKILL");
      if (forceKillTimer) clearTimeout(forceKillTimer);
      input.signal?.removeEventListener("abort", onAbort);
      requestTreeKill("SIGKILL");
      try {
        await treeKillChain;
        if (!(await waitForHarnessProcessToStop(activeProcess, killGraceMs))) {
          throw new Error(`provider systemd scope ${activeProcess.unit} did not become empty`);
        }
      } catch (error) {
        treeKillError ??= error;
      }
      outputMonitor.check();
      outputMonitor.close();
      if (!treeKillError) {
        try {
          clearActiveHarnessProcess(activeProcess);
        } catch (error) {
          treeKillError ??= error;
        }
      }
      try {
        await closeTranscripts(transcripts);
      } catch (error) {
        transcriptError ??= error;
      }
      if (transcriptError) {
        reject(transcriptError);
        return;
      }
      if (outputMonitorError) {
        reject(outputMonitorError);
        return;
      }
      if (treeKillError) {
        reject(treeKillError);
        return;
      }
      await callback();
    }
  });
}

function boundedChunk(chunk: Buffer, storedBytes: number, maxOutputBytes: number): Buffer {
  const remaining = maxOutputBytes - storedBytes;
  if (remaining <= 0) return Buffer.alloc(0);
  const accepted = Math.min(remaining, chunk.length);
  return accepted === chunk.length ? chunk : chunk.subarray(0, accepted);
}

function writeFully(file: FileHandle, chunk: Buffer): void {
  let offset = 0;
  while (offset < chunk.length) {
    const written = writeSync(file.fd, chunk, offset, chunk.length - offset);
    if (written <= 0) throw new Error("could not persist harness transcript output");
    offset += written;
  }
}

async function openTranscripts(
  stdoutPath: string,
  stderrPath: string,
): Promise<{ readonly stdout: FileHandle; readonly stderr: FileHandle }> {
  const stdout = await open(stdoutPath, "w", 0o600);
  let stderr: FileHandle | undefined;
  try {
    stderr = await open(stderrPath, "w", 0o600);
    await Promise.all([stdout.chmod(0o600), stderr.chmod(0o600)]);
    return { stdout, stderr };
  } catch (error) {
    await Promise.allSettled([stdout.close(), ...(stderr ? [stderr.close()] : [])]);
    throw error;
  }
}

async function closeTranscripts(transcripts: {
  readonly stdout: FileHandle;
  readonly stderr: FileHandle;
}): Promise<void> {
  const synced = await Promise.allSettled([transcripts.stdout.sync(), transcripts.stderr.sync()]);
  const closed = await Promise.allSettled([transcripts.stdout.close(), transcripts.stderr.close()]);
  const failure = [...synced, ...closed].find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) throw failure.reason;
}

function monitorBoundedFiles(
  files: ReadonlyArray<{ readonly path: string; readonly maxBytes: number }>,
  onExceeded: () => void,
  onError: (error: unknown) => void,
): { readonly check: () => void; readonly close: () => void } {
  if (files.length === 0) return { check() {}, close() {} };
  let closed = false;
  let reportedError = false;
  let reportedExceeded = false;
  const check = (): void => {
    if (closed) return;
    for (const file of files) {
      try {
        if (statSync(file.path).size <= file.maxBytes) continue;
        truncateSync(file.path, file.maxBytes);
        if (!reportedExceeded) {
          reportedExceeded = true;
          onExceeded();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        if (!reportedError) {
          reportedError = true;
          onError(error);
        }
      }
    }
  };
  const watchers: FSWatcher[] = [];
  for (const file of files) {
    try {
      const watcher = watch(file.path, { persistent: false }, check);
      watcher.on("error", (error) => {
        if (!reportedError) {
          reportedError = true;
          onError(error);
        }
      });
      watchers.push(watcher);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") onError(error);
    }
  }
  const poll = setInterval(check, 25);
  poll.unref();
  return {
    check,
    close() {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      for (const watcher of watchers) watcher.close();
    },
  };
}

function executionError(input: {
  readonly command: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly reason?: TerminationReason;
  readonly executable: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number;
}): HarnessExecutionError {
  const outputLimit = input.maxOutputBytes ?? HARNESS_OUTPUT_LIMIT_BYTES;
  const reason =
    input.reason === "timeout"
      ? `timed out after ${input.timeoutMs}ms`
      : input.reason === "output-limit"
        ? outputLimit === HARNESS_OUTPUT_LIMIT_BYTES
          ? "exceeded the 16 MiB output limit"
          : `exceeded the ${String(outputLimit)} byte output limit`
        : input.reason === "aborted"
          ? "was aborted"
          : input.reason === "transcript-error"
            ? "could not persist its transcripts"
            : input.reason === "output-monitor-error"
              ? "could not enforce a bounded output file"
              : input.signal
                ? `was terminated by ${input.signal}`
                : `exited with code ${String(input.exitCode)}`;
  return new HarnessExecutionError({
    command: input.command,
    exitCode: input.exitCode,
    signal: input.signal,
    stderr: input.stderr,
    message: `${input.executable} ${reason}`,
  });
}

function displayCommand(command: string, args: readonly string[]): string {
  return [command, ...args].join(" ");
}

function checkedPositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}
