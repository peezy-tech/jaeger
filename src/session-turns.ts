import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { abortableDelay } from "./abortable-delay.js";
import { assertRunExecutionAdmission, type RuntimeBackendKind } from "./admission.js";
import { BackendRpcError } from "./backend-protocol.js";
import { assertRegularFile, hasCode, publishJsonExclusive, syncDirectory } from "./durable-json.js";
import {
  discoverHarnessProcess,
  harnessContainmentState,
  type ActiveHarnessProcess,
} from "./harnesses/active-process.js";
import { stepScratchDirectory } from "./harnesses/support.js";
import { RunJournal } from "./journal.js";
import { systemdRunCommand } from "./launchers.js";
import { ensurePrivateDirectory } from "./paths.js";
import {
  acquireProcessLease,
  ProcessLeaseBusyError,
  releaseProcessLease,
} from "./process-lease.js";
import { currentProcessIdentity, isProcessIdentityActive } from "./process-identity.js";
import { resumeSession, type SessionResumeResult } from "./session-runtime.js";
import {
  finalizeCompletedSessionTurn,
  resolveSession,
} from "./sessions.js";
import type {
  JsonValue,
  SessionTurnSummary,
  WorkflowSessionRecord,
} from "./types.js";

const TURN_ID_PATTERN = /^turn-[A-Za-z0-9._:-]{8,123}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const RUN_ID_PATTERN = /^\d{14}-[a-f0-9]{10}$/;
const SESSION_ID_PATTERN = /^session-[a-f0-9]{16}$/;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1_000;
const ACTIVE_TURN_LEASE_WAIT_MS = 30_000;

export interface SessionTurnRequest {
  readonly version: 1;
  readonly turnId: string;
  readonly requestHash: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly message: string;
  readonly timeoutMs: number;
  readonly turn: number;
  readonly backend: RuntimeBackendKind;
  readonly createdAt: string;
}

interface SessionTurnOwner {
  readonly version: 1;
  readonly turnId: string;
  readonly requestHash: string;
  readonly pid: number;
  readonly processStartId: string;
  readonly unit: string;
  readonly claimedAt: string;
}

interface SessionTurnResult {
  readonly version: 1;
  readonly turnId: string;
  readonly requestHash: string;
  readonly status: "completed" | "rejected" | "uncertain";
  readonly output?: JsonValue;
  readonly nativeSessionId?: string;
  readonly metadata?: Record<string, JsonValue>;
  readonly error?: string;
  readonly finishedAt: string;
}

interface ActiveSessionTurn {
  readonly version: 1;
  readonly turnId: string;
  readonly requestHash: string;
  readonly createdAt: string;
}

export interface SessionTurnServiceOptions {
  readonly stateDir: string;
  readonly entrypoint: string;
  readonly env: NodeJS.ProcessEnv;
  readonly backend: RuntimeBackendKind;
}

export function createSessionTurnId(): string {
  return `turn-${randomBytes(16).toString("hex")}`;
}

export async function submitSessionTurn(
  options: SessionTurnServiceOptions & {
    readonly runId: string;
    readonly selector: string;
    readonly message: string;
    readonly timeoutMs?: number;
    readonly turnId: string;
  },
): Promise<SessionTurnSummary> {
  validateTurnId(options.turnId);
  if (options.message.trim().length === 0) {
    throw new BackendRpcError("invalid_request", "session message must be non-empty");
  }
  const timeoutMs = checkedTimeout(options.timeoutMs);
  const journal = await admittedJournal(options.stateDir, options.runId, options.backend);
  const session = await resolveSession(journal.runDir, options.selector);
  let stored: SessionTurnRequest;
  let accepted = false;
  try {
    stored = await readRequest(journal.runDir, options.turnId);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    assertSessionCanContinue(session);
    const turn = session.turnCount + 1;
    const request: SessionTurnRequest = {
      version: 1,
      turnId: options.turnId,
      requestHash: sessionTurnRequestHash({
        runId: options.runId,
        sessionId: session.id,
        message: options.message,
        timeoutMs,
        turn,
        backend: options.backend,
      }),
      runId: options.runId,
      sessionId: session.id,
      message: options.message,
      timeoutMs,
      turn,
      backend: options.backend,
      createdAt: new Date().toISOString(),
    };
    const published = await createOrReadRequest(journal.runDir, request);
    stored = published.request;
  }
  if (
    !sameSessionTurnRequest(stored, {
      runId: options.runId,
      sessionId: session.id,
      message: options.message,
      timeoutMs,
      backend: options.backend,
    })
  ) {
    throw new BackendRpcError(
      "idempotency_conflict",
      `Session turn id ${options.turnId} was already used for a different request`,
    );
  }
  let summary = await inspectSessionTurn({
    stateDir: options.stateDir,
    runId: options.runId,
    turnId: options.turnId,
    backend: options.backend,
  });
  if (summary.status !== "queued") return summary;

  try {
    const current = await resolveSession(journal.runDir, stored.sessionId);
    if (current.status !== "idle" || current.turnCount + 1 !== stored.turn) {
      summary = await inspectSessionTurn({
        stateDir: options.stateDir,
        runId: options.runId,
        turnId: options.turnId,
        backend: options.backend,
      });
      if (summary.status !== "queued") return summary;
    }
    assertSessionCanContinue(current);
    if (current.turnCount + 1 !== stored.turn) {
      throw new BackendRpcError(
        "session_busy",
        `Session turn ${stored.turnId} targets turn ${stored.turn}, but session ${stored.sessionId} is at turn ${current.turnCount}`,
      );
    }
    await reserveActiveTurn(journal.runDir, stored);
    accepted = true;
  } catch (error) {
    const disposition = await rejectUnacceptedTurn(journal.runDir, stored, error);
    if (disposition.kind === "terminal") {
      return publicTurnSummary(stored, disposition.result.status, disposition.result);
    }
    accepted = disposition.kind === "accepted";
    if (accepted) throw acceptedAmbiguousError(stored, error);
    throw error;
  }
  try {
    summary = await inspectSessionTurn({
      stateDir: options.stateDir,
      runId: options.runId,
      turnId: options.turnId,
      backend: options.backend,
    });
    if (summary.status !== "queued") return summary;
    await launchSessionTurnWorker(options, stored, journal.runDir);
    return await inspectSessionTurn({
      stateDir: options.stateDir,
      runId: options.runId,
      turnId: options.turnId,
      backend: options.backend,
    });
  } catch (error) {
    throw acceptedAmbiguousError(stored, error);
  }
}

export async function inspectSessionTurn(input: {
  readonly stateDir: string;
  readonly runId: string;
  readonly turnId: string;
  readonly backend: RuntimeBackendKind;
}): Promise<SessionTurnSummary> {
  const journal = await admittedJournal(input.stateDir, input.runId, input.backend);
  const request = await readRequest(journal.runDir, input.turnId);
  const result = await readResult(journal.runDir, request).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  });
  if (result) {
    if (result.status === "completed") {
      const finalized = await finalizeCompletedSessionTurn(journal.runDir, {
        sessionId: request.sessionId,
        turn: request.turn,
        output: result.output as JsonValue,
        nativeSessionId: result.nativeSessionId as string,
      });
      if (finalized) await clearActiveTurn(journal.runDir, request);
    } else if (result.status === "rejected") {
      // A rejected turn never reached a provider. Clear a matching pointer
      // defensively so an interrupted rejection path cannot wedge the session.
      await clearActiveTurn(journal.runDir, request);
    }
    return publicTurnSummary(request, result.status, result);
  }
  const owner = await readOwner(journal.runDir, request).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  });
  if (!owner) return publicTurnSummary(request, "queued");
  const ownerState = harnessContainmentState(ownerContainment(owner));
  if (ownerState === "active" || isProcessIdentityActive(owner)) {
    return publicTurnSummary(request, "running");
  }
  const session = await resolveSession(journal.runDir, request.sessionId);
  const provider = discoverHarnessProcess(
    stepScratchDirectory(journal.runDir, `${session.stepId}/turn:${request.turnId}`),
  );
  const providerState = harnessContainmentState(provider);
  if (ownerState === "unverifiable" || providerState !== "inactive") {
    return publicTurnSummary(
      request,
      "orphaned",
      undefined,
      "Session turn owner exited while provider containment is still active or unverifiable",
    );
  }
  const uncertain: SessionTurnResult = {
    version: 1,
    turnId: request.turnId,
    requestHash: request.requestHash,
    status: "uncertain",
    error: "Session turn owner exited without a durable provider result; replay is forbidden",
    finishedAt: new Date().toISOString(),
  };
  await publishTurnResult(journal.runDir, request, uncertain);
  return publicTurnSummary(request, "uncertain", uncertain);
}

export async function waitForSessionTurn(
  input: {
    readonly stateDir: string;
    readonly runId: string;
    readonly turnId: string;
    readonly backend: RuntimeBackendKind;
  },
  signal?: AbortSignal,
): Promise<SessionTurnSummary> {
  while (true) {
    if (signal?.aborted) throw abortReason(signal);
    const summary = await inspectSessionTurn(input);
    if (
      summary.status === "completed" ||
      summary.status === "rejected" ||
      summary.status === "uncertain"
    ) return summary;
    await delay(100, signal);
  }
}

export async function recoverSessionTurns(
  options: SessionTurnServiceOptions,
  runId: string,
): Promise<{
  readonly considered: number;
  readonly launched: readonly string[];
  readonly errors: readonly { readonly turnId: string; readonly error: string }[];
}> {
  const journal = await admittedJournal(options.stateDir, runId, options.backend);
  const sessionsRoot = path.join(journal.runDir, "sessions");
  let entries;
  try {
    entries = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { considered: 0, launched: [], errors: [] };
    throw error;
  }
  const launched: string[] = [];
  const errors: Array<{ turnId: string; error: string }> = [];
  let considered = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !SESSION_ID_PATTERN.test(entry.name)) continue;
    let active: ActiveSessionTurn;
    try {
      active = await readActiveTurn(journal.runDir, entry.name);
    } catch (error) {
      if (hasCode(error, "ENOENT")) continue;
      errors.push({ turnId: `session:${entry.name}`, error: errorMessage(error) });
      continue;
    }
    considered++;
    try {
      const request = await readRequest(journal.runDir, active.turnId);
      const summary = await inspectSessionTurn({
        stateDir: options.stateDir,
        runId,
        turnId: active.turnId,
        backend: options.backend,
      });
      if (summary.status === "queued") {
        await launchSessionTurnWorker(options, request, journal.runDir);
        launched.push(active.turnId);
      }
    } catch (error) {
      errors.push({ turnId: active.turnId, error: errorMessage(error) });
    }
  }
  return { considered, launched, errors };
}

export async function executeSessionTurnWorker(input: {
  readonly stateDir: string;
  readonly runId: string;
  readonly turnId: string;
  readonly backend: RuntimeBackendKind;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const journal = await admittedJournal(input.stateDir, input.runId, input.backend);
  const request = await readRequest(journal.runDir, input.turnId);
  if (request.backend !== input.backend) {
    throw new Error(`Session turn ${request.turnId} is pinned to ${request.backend}`);
  }
  const identity = currentProcessIdentity();
  const owner: SessionTurnOwner = {
    version: 1,
    turnId: request.turnId,
    requestHash: request.requestHash,
    ...identity,
    unit: sessionTurnUnit(request.runId, request.turnId),
    claimedAt: new Date().toISOString(),
  };
  let claimed = false;
  const lease = await acquireActiveTurnLease(journal.runDir, request.sessionId);
  try {
    try {
      await readResult(journal.runDir, request);
      return;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    let active: ActiveSessionTurn | undefined;
    try {
      active = await readActiveTurn(journal.runDir, request.sessionId);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    if (
      !active ||
      active.turnId !== request.turnId ||
      active.requestHash !== request.requestHash
    ) {
      await publishTurnResult(journal.runDir, request, {
        version: 1,
        turnId: request.turnId,
        requestHash: request.requestHash,
        status: "rejected",
        error: "Session turn worker lost its durable admission before provider execution",
        finishedAt: new Date().toISOString(),
      });
      return;
    }
    if (!(await publishJsonExclusive(ownerPath(journal.runDir, request), owner))) return;
    // Recheck after publishing ownership. A pre-fix backend may have raced a
    // rejection against this worker; a terminal result always forbids replay.
    try {
      await readResult(journal.runDir, request);
      return;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    claimed = true;
  } finally {
    await releaseProcessLease(activeTurnLeasePath(journal.runDir, request.sessionId), lease);
  }
  if (!claimed) return;
  try {
    await resumeSession({
      stateDir: input.stateDir,
      runId: input.runId,
      selector: request.sessionId,
      message: request.message,
      timeoutMs: request.timeoutMs,
      expectedBackend: input.backend,
      turnId: request.turnId,
      ...(input.signal ? { signal: input.signal } : {}),
      beforeComplete: async (result) => {
        await publishCompletedResult(journal.runDir, request, result);
      },
    });
    await inspectSessionTurn({
      stateDir: input.stateDir,
      runId: input.runId,
      turnId: input.turnId,
      backend: input.backend,
    });
  } catch (error) {
    const uncertain: SessionTurnResult = {
      version: 1,
      turnId: request.turnId,
      requestHash: request.requestHash,
      status: "uncertain",
      error: errorMessage(error),
      finishedAt: new Date().toISOString(),
    };
    await publishTurnResult(journal.runDir, request, uncertain).catch((publishError: unknown) => {
      if (!hasCode(publishError, "EEXIST")) throw publishError;
    });
    throw error;
  }
}

async function launchSessionTurnWorker(
  options: SessionTurnServiceOptions,
  request: SessionTurnRequest,
  runDir: string,
): Promise<void> {
  try {
    await readOwner(runDir, request);
    return;
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  const stdout = await open(path.join(turnDirectory(runDir, request.turnId), "runtime.stdout.log"), "a", 0o600);
  const stderr = await open(path.join(turnDirectory(runDir, request.turnId), "runtime.stderr.log"), "a", 0o600);
  let child: ChildProcess;
  let spawnError: unknown;
  try {
    child = spawn(
      systemdRunCommand(options.env),
      [
        "--user",
        "--scope",
        "--quiet",
        "--collect",
        `--unit=${sessionTurnUnit(request.runId, request.turnId)}`,
        "--",
        process.execPath,
        options.entrypoint,
        "__session-worker",
        "--state-dir",
        options.stateDir,
        "--run-id",
        request.runId,
        "--turn-id",
        request.turnId,
        "--backend",
        options.backend,
      ],
      {
        cwd: runDir,
        env: options.env,
        detached: true,
        shell: false,
        stdio: ["ignore", stdout.fd, stderr.fd],
      },
    );
    // ENOENT can arrive on the next turn. Observe it before closing logs.
    child.once("error", (error) => {
      spawnError = error;
    });
  } finally {
    await Promise.all([stdout.close(), stderr.close()]);
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    try {
      await readOwner(runDir, request);
      child.unref();
      return;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    try {
      await readResult(runDir, request);
      child.unref();
      return;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Detached session worker exited before claiming ${request.turnId}; inspect ${turnDirectory(runDir, request.turnId)}/runtime.stderr.log`,
      );
    }
    await delay(25);
  }
  child.unref();
  throw new Error(`Detached session worker did not claim ${request.turnId} within 5000ms`);
}

async function admittedJournal(
  stateDir: string,
  runId: string,
  backend: RuntimeBackendKind,
): Promise<RunJournal> {
  if (!RUN_ID_PATTERN.test(runId)) throw new BackendRpcError("invalid_request", "Invalid Jaeger run id");
  const journal = await RunJournal.open(path.resolve(stateDir), runId);
  assertRunExecutionAdmission(journal.record, backend);
  return journal;
}

async function createOrReadRequest(
  runDir: string,
  candidate: SessionTurnRequest,
): Promise<{ readonly request: SessionTurnRequest; readonly created: boolean }> {
  const root = path.join(runDir, "session-turns");
  await ensurePrivateDirectory(root, "Jaeger session-turn directory");
  await syncDirectory(runDir);
  const target = turnDirectory(runDir, candidate.turnId);
  try {
    return { request: await readRequest(runDir, candidate.turnId), created: false };
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  const temporary = path.join(
    root,
    `.creating-${turnKey(candidate.turnId)}-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  await mkdir(temporary, { mode: 0o700 });
  try {
    if (!(await publishJsonExclusive(path.join(temporary, "request.json"), candidate))) {
      throw new Error("Could not publish new session turn request");
    }
    await syncDirectory(temporary);
    await rename(temporary, target);
    await syncDirectory(root);
    return { request: candidate, created: true };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    if (hasCode(error, "EEXIST") || hasCode(error, "ENOTEMPTY")) {
      return { request: await readRequest(runDir, candidate.turnId), created: false };
    }
    throw error;
  }
}

async function reserveActiveTurn(runDir: string, request: SessionTurnRequest): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    let current: ActiveSessionTurn | undefined;
    const lease = await acquireActiveTurnLease(runDir, request.sessionId);
    try {
      try {
        current = await readActiveTurn(runDir, request.sessionId);
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
      }
      if (!current) {
        const session = await resolveSession(runDir, request.sessionId);
        if (session.status !== "idle" || session.turnCount + 1 !== request.turn) {
          throw new BackendRpcError(
            "session_busy",
            `Session turn ${request.turnId} targets turn ${request.turn}, but session ${request.sessionId} is ${session.status} at turn ${session.turnCount}`,
          );
        }
        const active: ActiveSessionTurn = {
          version: 1,
          turnId: request.turnId,
          requestHash: request.requestHash,
          createdAt: request.createdAt,
        };
        if (await publishJsonExclusive(activeTurnPath(runDir, request.sessionId), active)) return;
        continue;
      }
      if (current.turnId === request.turnId && current.requestHash === request.requestHash) return;
    } finally {
      await releaseProcessLease(activeTurnLeasePath(runDir, request.sessionId), lease);
    }

    const summary = await inspectSessionTurn({
      stateDir: path.dirname(runDir),
      runId: request.runId,
      turnId: current.turnId,
      backend: request.backend,
    });
    if (summary.status !== "completed" && summary.status !== "rejected") {
      throw new BackendRpcError(
        "session_busy",
        `Session ${request.sessionId} already has unresolved turn ${current.turnId} (${summary.status})`,
      );
    }
  }
  throw new BackendRpcError(
    "session_busy",
    `Session ${request.sessionId} accepted another turn before ${request.turnId}`,
  );
}

async function clearActiveTurn(runDir: string, request: SessionTurnRequest): Promise<void> {
  const lease = await acquireActiveTurnLease(runDir, request.sessionId);
  try {
    let current: ActiveSessionTurn;
    try {
      current = await readActiveTurn(runDir, request.sessionId);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      throw error;
    }
    if (current.turnId !== request.turnId || current.requestHash !== request.requestHash) return;
    await unlink(activeTurnPath(runDir, request.sessionId));
    await syncDirectory(path.join(runDir, "sessions", request.sessionId));
  } finally {
    await releaseProcessLease(activeTurnLeasePath(runDir, request.sessionId), lease);
  }
}

async function acquireActiveTurnLease(runDir: string, sessionId: string) {
  try {
    return await acquireProcessLease(activeTurnLeasePath(runDir, sessionId), {
      waitMs: ACTIVE_TURN_LEASE_WAIT_MS,
    });
  } catch (error) {
    if (error instanceof ProcessLeaseBusyError) {
      throw new BackendRpcError(
        "session_busy",
        `Timed out serializing session ${sessionId} turn state behind PID ${error.owner.pid}`,
      );
    }
    throw error;
  }
}

async function readRequest(runDir: string, turnId: string): Promise<SessionTurnRequest> {
  validateTurnId(turnId);
  const target = path.join(turnDirectory(runDir, turnId), "request.json");
  await assertRegularFile(target, "Jaeger session-turn request");
  const value = JSON.parse(await readFile(target, "utf8")) as unknown;
  validateRequest(value);
  if (value.turnId !== turnId) throw new Error(`Session turn index collision for ${turnId}`);
  return value;
}

async function readOwner(
  runDir: string,
  request: SessionTurnRequest,
): Promise<SessionTurnOwner> {
  const target = ownerPath(runDir, request);
  await assertRegularFile(target, "Jaeger session-turn owner");
  const value = JSON.parse(await readFile(target, "utf8")) as unknown;
  validateOwner(value, request);
  return value;
}

async function readResult(
  runDir: string,
  request: SessionTurnRequest,
): Promise<SessionTurnResult> {
  const target = resultPath(runDir, request);
  await assertRegularFile(target, "Jaeger session-turn result");
  const value = JSON.parse(await readFile(target, "utf8")) as unknown;
  validateResult(value, request);
  return value;
}

async function readActiveTurn(runDir: string, sessionId: string): Promise<ActiveSessionTurn> {
  const target = activeTurnPath(runDir, sessionId);
  await assertRegularFile(target, "Jaeger active session turn");
  const value = JSON.parse(await readFile(target, "utf8")) as unknown;
  validateActiveTurn(value);
  return value;
}

async function publishCompletedResult(
  runDir: string,
  request: SessionTurnRequest,
  result: SessionResumeResult,
): Promise<void> {
  if (result.turn !== request.turn || result.sessionId !== request.sessionId) {
    throw new Error(`Provider result does not match session turn ${request.turnId}`);
  }
  await publishTurnResult(runDir, request, {
    version: 1,
    turnId: request.turnId,
    requestHash: request.requestHash,
    status: "completed",
    output: result.output,
    nativeSessionId: result.nativeSessionId,
    ...(result.metadata ? { metadata: result.metadata } : {}),
    finishedAt: new Date().toISOString(),
  });
}

async function publishTurnResult(
  runDir: string,
  request: SessionTurnRequest,
  result: SessionTurnResult,
): Promise<void> {
  const created = await publishJsonExclusive(resultPath(runDir, request), result);
  if (!created) {
    const existing = await readResult(runDir, request);
    if (existing.status === result.status && sameTerminalResult(existing, result)) return;
    if (existing.status === "completed" && result.status === "uncertain") return;
    throw new Error(`Session turn ${request.turnId} already has a different terminal result`);
  }
}

async function rejectUnacceptedTurn(
  runDir: string,
  request: SessionTurnRequest,
  reason: unknown,
): Promise<
  | { readonly kind: "unaccepted" }
  | { readonly kind: "accepted" }
  | { readonly kind: "terminal"; readonly result: SessionTurnResult }
> {
  const lease = await acquireActiveTurnLease(runDir, request.sessionId);
  try {
    try {
      const result = await readResult(runDir, request);
      return { kind: "terminal", result };
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    let active: ActiveSessionTurn | undefined;
    try {
      active = await readActiveTurn(runDir, request.sessionId);
      if (active.turnId === request.turnId && active.requestHash === request.requestHash) {
        return { kind: "accepted" };
      }
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    try {
      await readOwner(runDir, request);
      return { kind: "accepted" };
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    if (!active) {
      const session = await resolveSession(runDir, request.sessionId);
      if (session.status === "idle" && session.turnCount + 1 === request.turn) {
        return { kind: "unaccepted" };
      }
    }
    await publishTurnResult(runDir, request, {
      version: 1,
      turnId: request.turnId,
      requestHash: request.requestHash,
      status: "rejected",
      error: `Session turn was not accepted: ${errorMessage(reason)}`,
      finishedAt: new Date().toISOString(),
    });
    return { kind: "unaccepted" };
  } finally {
    await releaseProcessLease(activeTurnLeasePath(runDir, request.sessionId), lease);
  }
}

function acceptedAmbiguousError(request: SessionTurnRequest, reason: unknown): BackendRpcError {
  const inspect = publicTurnSummary(request, "queued").inspect;
  return new BackendRpcError(
    "accepted_ambiguous",
    `Session turn ${request.turnId} is durably accepted, but continued execution could not be confirmed: ${errorMessage(reason)}. Retry the original session resume command with --request-id ${shellQuote(request.turnId)}, or inspect it with '${inspect}'.`,
  );
}

function sameTerminalResult(left: SessionTurnResult, right: SessionTurnResult): boolean {
  if (left.status !== right.status) return false;
  if (left.status === "completed" && right.status === "completed") {
    return (
      left.nativeSessionId === right.nativeSessionId &&
      stableJson(left.output as JsonValue) === stableJson(right.output as JsonValue) &&
      stableJson((left.metadata ?? {}) as JsonValue) ===
        stableJson((right.metadata ?? {}) as JsonValue)
    );
  }
  return left.error === right.error;
}

function publicTurnSummary(
  request: SessionTurnRequest,
  status: SessionTurnSummary["status"],
  result?: SessionTurnResult,
  error?: string,
): SessionTurnSummary {
  const target = `${shellQuote(request.runId)} ${shellQuote(request.turnId)}`;
  const effectiveError = result?.error ?? error;
  return {
    schemaVersion: 1,
    runId: request.runId,
    sessionId: request.sessionId,
    turnId: request.turnId,
    turn: request.turn,
    status,
    createdAt: request.createdAt,
    ...(result?.output !== undefined ? { output: result.output } : {}),
    ...(result?.nativeSessionId ? { nativeSessionId: result.nativeSessionId } : {}),
    ...(result?.metadata ? { metadata: result.metadata } : {}),
    ...(effectiveError ? { error: effectiveError } : {}),
    inspect: `jaeger session turn inspect ${target}`,
    ...(status === "queued" || status === "running" || status === "orphaned"
      ? { wait: `jaeger session turn wait ${target}` }
      : {}),
    ...(status === "running"
      ? { interrupt: `jaeger session interrupt ${shellQuote(request.runId)} ${shellQuote(request.sessionId)}` }
      : {}),
  };
}

function ownerContainment(owner: SessionTurnOwner): ActiveHarnessProcess {
  return {
    version: 2,
    token: createHash("sha256").update(owner.unit).digest("hex").slice(0, 32),
    unit: owner.unit,
    platform: "linux",
    startedAt: owner.claimedAt,
    recordPath: `/run/jaeger/${owner.unit}`,
    pid: owner.pid,
    processStartId: owner.processStartId,
  };
}

function sessionTurnUnit(runId: string, turnId: string): string {
  return `jaeger-provider-${runId}-${createHash("sha256")
    .update(`session-turn\0${turnId}`)
    .digest("hex")
    .slice(0, 16)}.scope`;
}

function turnDirectory(runDir: string, turnId: string): string {
  validateTurnId(turnId);
  return path.join(runDir, "session-turns", turnKey(turnId));
}

function ownerPath(runDir: string, request: SessionTurnRequest): string {
  return path.join(turnDirectory(runDir, request.turnId), "owner.json");
}

function resultPath(runDir: string, request: SessionTurnRequest): string {
  return path.join(turnDirectory(runDir, request.turnId), "result.json");
}

function activeTurnPath(runDir: string, sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error(`Invalid Jaeger session id: ${sessionId}`);
  return path.join(runDir, "sessions", sessionId, "active-turn.json");
}

function activeTurnLeasePath(runDir: string, sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error(`Invalid Jaeger session id: ${sessionId}`);
  return path.join(runDir, "sessions", sessionId, "active-turn.lock");
}

function turnKey(turnId: string): string {
  return createHash("sha256").update(`session-turn\0${turnId}`).digest("hex");
}

function validateTurnId(turnId: string): void {
  if (!TURN_ID_PATTERN.test(turnId)) {
    throw new BackendRpcError("invalid_request", "session turn id is invalid");
  }
}

function validateRequest(value: unknown): asserts value is SessionTurnRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Jaeger session-turn request");
  }
  const request = value as Record<string, unknown>;
  if (
    request.version !== 1 ||
    typeof request.turnId !== "string" ||
    !TURN_ID_PATTERN.test(request.turnId) ||
    typeof request.requestHash !== "string" ||
    !HASH_PATTERN.test(request.requestHash) ||
    typeof request.runId !== "string" ||
    !RUN_ID_PATTERN.test(request.runId) ||
    typeof request.sessionId !== "string" ||
    !SESSION_ID_PATTERN.test(request.sessionId) ||
    typeof request.message !== "string" ||
    request.message.trim().length === 0 ||
    !Number.isSafeInteger(request.timeoutMs) ||
    (request.timeoutMs as number) <= 0 ||
    (request.timeoutMs as number) > 24 * 60 * 60 * 1_000 ||
    !Number.isSafeInteger(request.turn) ||
    (request.turn as number) <= 0 ||
    (request.backend !== "embedded" && request.backend !== "local-service") ||
    typeof request.createdAt !== "string" ||
    Number.isNaN(Date.parse(request.createdAt))
  ) {
    throw new Error("Invalid Jaeger session-turn request");
  }
}

function validateOwner(value: unknown, request: SessionTurnRequest): asserts value is SessionTurnOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Jaeger session-turn owner");
  }
  const owner = value as Record<string, unknown>;
  if (
    owner.version !== 1 ||
    owner.turnId !== request.turnId ||
    owner.requestHash !== request.requestHash ||
    !Number.isSafeInteger(owner.pid) ||
    typeof owner.processStartId !== "string" ||
    owner.unit !== sessionTurnUnit(request.runId, request.turnId) ||
    typeof owner.claimedAt !== "string" ||
    Number.isNaN(Date.parse(owner.claimedAt))
  ) {
    throw new Error("Invalid Jaeger session-turn owner");
  }
}

function validateResult(value: unknown, request: SessionTurnRequest): asserts value is SessionTurnResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Jaeger session-turn result");
  }
  const result = value as Record<string, unknown>;
  if (
    result.version !== 1 ||
    result.turnId !== request.turnId ||
    result.requestHash !== request.requestHash ||
    !["completed", "rejected", "uncertain"].includes(String(result.status)) ||
    typeof result.finishedAt !== "string" ||
    Number.isNaN(Date.parse(result.finishedAt)) ||
    (result.status === "completed" &&
      (result.output === undefined ||
        !isJsonValue(result.output) ||
        typeof result.nativeSessionId !== "string" ||
        result.nativeSessionId.length === 0 ||
        result.error !== undefined)) ||
    (result.metadata !== undefined && !isJsonRecord(result.metadata)) ||
    ((result.status === "uncertain" || result.status === "rejected") &&
      (typeof result.error !== "string" ||
        result.error.trim().length === 0 ||
        result.output !== undefined ||
        result.nativeSessionId !== undefined ||
        result.metadata !== undefined))
  ) {
    throw new Error("Invalid Jaeger session-turn result");
  }
}

function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && isJsonValue(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function validateActiveTurn(value: unknown): asserts value is ActiveSessionTurn {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid active Jaeger session turn");
  }
  const active = value as Record<string, unknown>;
  if (
    active.version !== 1 ||
    typeof active.turnId !== "string" ||
    !TURN_ID_PATTERN.test(active.turnId) ||
    typeof active.requestHash !== "string" ||
    !HASH_PATTERN.test(active.requestHash) ||
    typeof active.createdAt !== "string" ||
    Number.isNaN(Date.parse(active.createdAt))
  ) {
    throw new Error("Invalid active Jaeger session turn");
  }
}

function assertSessionCanContinue(session: WorkflowSessionRecord): void {
  if (!session.nativeSessionId) {
    throw new Error(`Jaeger session ${session.id} has no native provider session to resume`);
  }
  if (session.status !== "idle") {
    throw new BackendRpcError(
      "session_busy",
      `Jaeger session ${session.id} is ${session.status} and cannot accept another turn`,
    );
  }
}

function checkedTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 24 * 60 * 60 * 1_000) {
    throw new BackendRpcError(
      "invalid_request",
      "session timeout must be a positive integer no greater than 24 hours",
    );
  }
  return timeout;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(stableJson(JSON.parse(JSON.stringify(value)) as JsonValue)).digest("hex");
}

function sessionTurnRequestHash(input: {
  readonly runId: string;
  readonly sessionId: string;
  readonly message: string;
  readonly timeoutMs: number;
  readonly turn: number;
  readonly backend: RuntimeBackendKind;
}): string {
  return hashJson(input);
}

function sameSessionTurnRequest(
  stored: SessionTurnRequest,
  input: {
    readonly runId: string;
    readonly sessionId: string;
    readonly message: string;
    readonly timeoutMs: number;
    readonly backend: RuntimeBackendKind;
  },
): boolean {
  return (
    stored.runId === input.runId &&
    stored.sessionId === input.sessionId &&
    stored.message === input.message &&
    stored.timeoutMs === input.timeoutMs &&
    stored.backend === input.backend &&
    stored.requestHash === sessionTurnRequestHash({ ...input, turn: stored.turn })
  );
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key] as JsonValue)}`)
    .join(",")}}`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Session turn wait aborted");
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await abortableDelay(milliseconds, signal, "Session turn wait aborted");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
