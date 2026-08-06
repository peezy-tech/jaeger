import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import {
  readCodexThreadArchiveRecord,
  writeCodexThreadArchiveRecord,
} from "./codex-thread-state.js";
import { CodexAppServerClient } from "./harnesses/codex-app-server-client.js";
import { harnessDefinitionsForRun } from "./harnesses/registry.js";
import { jsonObject, nonEmptyString } from "./harnesses/support.js";
import { RunJournal } from "./journal.js";
import { inspectRun } from "./run-state.js";
import { ProcessLeaseBusyError } from "./process-lease.js";
import {
  listWorkflowSessions,
  withSessionProviderLifecycle,
} from "./sessions.js";
import type { WorkflowSessionRecord } from "./types.js";
import { JAEGER_VERSION } from "./version.js";

const RUN_ID = /^\d{14}-[a-f0-9]{10}$/;
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000, 600_000] as const;
const ADMIN_TIMEOUT_MS = 30_000;
const SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
] as const;

export interface CodexThreadTarget {
  readonly runId: string;
  readonly runDir: string;
  readonly ownerSessionId: string;
  readonly nativeSessionId: string;
  readonly command: string;
  readonly cwd: string;
  readonly profile?: string;
  readonly activityVersion: string;
  readonly busy: boolean;
  readonly ownedDescendantIds: ReadonlySet<string>;
}

export interface CodexThreadArchiveAttempt {
  readonly status: "archived" | "retained" | "busy";
  readonly reason?: string;
}

export interface CodexThreadArchiveManagerOptions {
  readonly stateDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly tickIntervalMs?: number;
  readonly now?: () => Date;
  readonly archive?: (
    target: CodexThreadTarget,
    signal?: AbortSignal,
  ) => Promise<CodexThreadArchiveAttempt>;
}

export class CodexThreadArchiveManager {
  private readonly stateDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly tickIntervalMs: number;
  private readonly now: () => Date;
  private readonly archive: (
    target: CodexThreadTarget,
    signal?: AbortSignal,
  ) => Promise<CodexThreadArchiveAttempt>;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private abortController: AbortController | undefined;
  private readonly settledFingerprints = new Map<string, string>();

  constructor(options: CodexThreadArchiveManagerOptions) {
    this.stateDir = path.resolve(options.stateDir);
    this.env = { ...process.env, ...options.env };
    this.tickIntervalMs = options.tickIntervalMs ?? 2_000;
    this.now = options.now ?? (() => new Date());
    this.archive =
      options.archive ??
      (async (target, signal) => await archiveCodexThread(target, this.env, signal));
  }

  start(): void {
    if (this.timer) return;
    this.abortController = new AbortController();
    const schedule = (): void => {
      if (this.inFlight) return;
      this.inFlight = this.tick()
        .catch((error) => {
          process.stderr.write(`jaeger codex thread archive: ${errorMessage(error)}\n`);
        })
        .finally(() => {
          this.inFlight = undefined;
        });
    };
    schedule();
    this.timer = setInterval(schedule, this.tickIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.abortController?.abort(new Error("Codex thread housekeeping stopped"));
    await this.inFlight;
    this.abortController = undefined;
  }

  async tick(): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.stateDir, { withFileTypes: true });
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !RUN_ID.test(entry.name)) continue;
      try {
        const fingerprint = await archiveInputFingerprint(
          path.join(this.stateDir, entry.name),
        );
        if (this.settledFingerprints.get(entry.name) === fingerprint) continue;
        const summary = await inspectRun(this.stateDir, entry.name);
        if (summary.status !== "completed") {
          this.settledFingerprints.set(entry.name, fingerprint);
          continue;
        }
        if (await this.reconcileRun(entry.name)) {
          this.settledFingerprints.set(entry.name, fingerprint);
        }
      } catch (error) {
        process.stderr.write(
          `jaeger codex thread archive ${entry.name}: ${errorMessage(error)}\n`,
        );
      }
    }
  }

  private async reconcileRun(runId: string): Promise<boolean> {
    const journal = await RunJournal.open(this.stateDir, runId);
    if (
      journal.record.version !== 4 ||
      journal.record.runtime.backend !== "local-service"
    ) {
      return true;
    }
    const targets = await discoverTargets(this.stateDir, runId);
    const results = await Promise.all(
      targets.map(async (target) => await this.reconcileTarget(target)),
    );
    return results.every(Boolean);
  }

  private async reconcileTarget(target: CodexThreadTarget): Promise<boolean> {
    const prior = await readCodexThreadArchiveRecord(target.runDir, target.nativeSessionId);
    if (
      prior?.activityVersion === target.activityVersion &&
      (prior.status === "archived" || prior.status === "retained")
    ) {
      return true;
    }
    if (target.busy) return false;
    if (
      prior?.status === "retrying" &&
      prior.activityVersion === target.activityVersion &&
      prior.nextAttemptAt &&
      Date.parse(prior.nextAttemptAt) > this.now().getTime()
    ) {
      return false;
    }
    const attempts =
      prior?.activityVersion === target.activityVersion ? prior.attempts + 1 : 1;
    try {
      const result = await withSessionProviderLifecycle(
        target.runDir,
        target.ownerSessionId,
        async () => {
          const current = (await discoverTargets(this.stateDir, target.runId)).find(
            (candidate) => candidate.nativeSessionId === target.nativeSessionId,
          );
          if (
            !current ||
            current.busy ||
            current.activityVersion !== target.activityVersion
          ) {
            return { status: "busy", reason: "Jaeger session activity changed" } as const;
          }
          return await this.archive(current, this.abortController?.signal);
        },
        { waitMs: 0 },
      );
      const nowDate = this.now();
      const now = nowDate.toISOString();
      if (result.status === "busy") {
        await writeCodexThreadArchiveRecord(target.runDir, {
          version: 1,
          runId: target.runId,
          nativeSessionId: target.nativeSessionId,
          status: "retrying",
          activityVersion: target.activityVersion,
          attempts,
          updatedAt: now,
          nextAttemptAt: new Date(nowDate.getTime() + 30_000).toISOString(),
          ...(result.reason ? { reason: result.reason } : {}),
        });
        return false;
      }
      await writeCodexThreadArchiveRecord(target.runDir, {
        version: 1,
        runId: target.runId,
        nativeSessionId: target.nativeSessionId,
        status: result.status,
        activityVersion: target.activityVersion,
        attempts,
        updatedAt: now,
        ...(result.status === "archived" ? { archivedAt: now } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      });
      return true;
    } catch (error) {
      if (error instanceof ProcessLeaseBusyError) return false;
      const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
      const now = this.now();
      await writeCodexThreadArchiveRecord(target.runDir, {
        version: 1,
        runId: target.runId,
        nativeSessionId: target.nativeSessionId,
        status: "retrying",
        activityVersion: target.activityVersion,
        attempts,
        updatedAt: now.toISOString(),
        nextAttemptAt: new Date(now.getTime() + (delay ?? 600_000)).toISOString(),
        lastError: errorMessage(error),
      });
      return false;
    }
  }
}

async function archiveInputFingerprint(runDir: string): Promise<string> {
  const parts: string[] = [];
  await addFingerprint(parts, path.join(runDir, "run.json"));
  await addFingerprint(parts, path.join(runDir, "events.jsonl"));
  for (const [directory, names] of [
    ["sessions", ["session.json"]],
    ["session-queries", ["request.json", "result.json"]],
  ] as const) {
    const root = path.join(runDir, directory);
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (hasCode(error, "ENOENT")) continue;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      for (const name of names) {
        await addFingerprint(parts, path.join(root, entry.name, name));
      }
    }
  }
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

async function addFingerprint(parts: string[], target: string): Promise<void> {
  try {
    const stats = await lstat(target);
    parts.push(
      `${target}:${stats.isFile() && !stats.isSymbolicLink() ? "file" : "unsafe"}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`,
    );
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    parts.push(`${target}:missing`);
  }
}

async function discoverTargets(stateDir: string, runId: string): Promise<CodexThreadTarget[]> {
  const journal = await RunJournal.open(stateDir, runId);
  const definitions = new Map(
    harnessDefinitionsForRun(journal.record).map((definition) => [definition.name, definition]),
  );
  const sessions = await listWorkflowSessions(journal.runDir);
  const queryState = await readQueryState(journal.runDir, sessions);
  const targets = new Map<string, CodexThreadTarget>();
  for (const session of sessions) {
    const definition = definitions.get(session.harness);
    if (definition?.driver !== "codex-app-server" || !session.nativeSessionId) continue;
    const query = queryState.get(session.id);
    targets.set(session.nativeSessionId, {
      runId,
      runDir: journal.runDir,
      ownerSessionId: session.id,
      nativeSessionId: session.nativeSessionId,
      command: definition.command,
      cwd: session.cwd,
      ...(session.profile ? { profile: session.profile } : {}),
      activityVersion: session.updatedAt,
      busy:
        session.status !== "idle" ||
        Boolean(query?.active),
      ownedDescendantIds: new Set(query?.completed.map((child) => child.nativeSessionId) ?? []),
    });
    for (const child of query?.completed ?? []) {
      if (child.nativeSessionId === session.nativeSessionId) continue;
      targets.set(child.nativeSessionId, {
        runId,
        runDir: journal.runDir,
        ownerSessionId: session.id,
        nativeSessionId: child.nativeSessionId,
        command: definition.command,
        cwd: session.cwd,
        ...(session.profile ? { profile: session.profile } : {}),
        activityVersion: child.finishedAt,
        busy: false,
        ownedDescendantIds: new Set(),
      });
    }
  }
  return [...targets.values()];
}

async function readQueryState(
  runDir: string,
  sessions: readonly WorkflowSessionRecord[],
): Promise<Map<string, { active: boolean; completed: Array<{ nativeSessionId: string; finishedAt: string }> }>> {
  const state = new Map<
    string,
    { active: boolean; completed: Array<{ nativeSessionId: string; finishedAt: string }> }
  >();
  const knownSessions = new Set(sessions.map((session) => session.id));
  const root = path.join(runDir, "session-queries");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return state;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = path.join(root, entry.name);
    let request: Record<string, unknown>;
    try {
      request = record(JSON.parse(await readFile(path.join(directory, "request.json"), "utf8")));
    } catch (error) {
      if (hasCode(error, "ENOENT")) continue;
      throw error;
    }
    const sessionId = nonEmptyString(request.sessionId);
    if (!sessionId || !knownSessions.has(sessionId)) continue;
    const current = state.get(sessionId) ?? { active: false, completed: [] };
    try {
      const result = record(
        JSON.parse(await readFile(path.join(directory, "result.json"), "utf8")),
      );
      const nativeSessionId = nonEmptyString(result.nativeSessionId);
      const finishedAt = nonEmptyString(result.finishedAt);
      if (result.status === "completed" && nativeSessionId && finishedAt) {
        current.completed.push({ nativeSessionId, finishedAt });
      }
    } catch (error) {
      if (hasCode(error, "ENOENT")) current.active = true;
      else throw error;
    }
    state.set(sessionId, current);
  }
  return state;
}

export async function archiveCodexThread(
  target: CodexThreadTarget,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<CodexThreadArchiveAttempt> {
  return await withCodexAdminClient(target, env, signal, async (client) => {
    if (await isArchived(client, target.nativeSessionId)) return { status: "archived" };
    const read = await client.request("thread/read", {
      threadId: target.nativeSessionId,
      includeTurns: false,
    });
    const thread = jsonObject(read.thread);
    if (!thread) throw new Error("Codex thread/read response is missing thread");
    if (thread.isPinned === true) {
      return { status: "retained", reason: "Codex thread is pinned" };
    }
    const status = jsonObject(thread.status);
    const statusType = nonEmptyString(status?.type);
    if (statusType && statusType !== "idle" && statusType !== "notLoaded") {
      return { status: "busy", reason: `Codex thread is ${statusType}` };
    }
    const descendants = await listDescendants(client, target.nativeSessionId);
    const pinnedDescendant = descendants.find((descendant) => descendant.isPinned);
    if (pinnedDescendant) {
      return {
        status: "retained",
        reason: `Codex descendant is pinned: ${pinnedDescendant.id}`,
      };
    }
    const activeDescendant = descendants.find(
      (descendant) =>
        descendant.status &&
        descendant.status !== "idle" &&
        descendant.status !== "notLoaded",
    );
    if (activeDescendant) {
      return {
        status: "busy",
        reason: `Codex descendant ${activeDescendant.id} is ${activeDescendant.status}`,
      };
    }
    const external = descendants.filter(
      (descendant) => !target.ownedDescendantIds.has(descendant.id),
    );
    if (external.length > 0) {
      return {
        status: "retained",
        reason: `Codex thread has non-Jaeger descendants: ${external.map(({ id }) => id).join(", ")}`,
      };
    }
    try {
      await client.request("thread/archive", { threadId: target.nativeSessionId });
    } catch (error) {
      if (await isArchived(client, target.nativeSessionId)) return { status: "archived" };
      throw error;
    }
    return { status: "archived" };
  });
}

async function withCodexAdminClient<T>(
  target: Pick<CodexThreadTarget, "command" | "cwd" | "profile">,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  operation: (client: CodexAppServerClient) => Promise<T>,
): Promise<T> {
  const args = [
    ...(target.profile ? ["--profile", target.profile] : []),
    "app-server",
    "--stdio",
  ];
  const child = spawn(target.command, args, {
    cwd: target.cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
  if (!child.stdin || !child.stdout || !child.stderr) {
    child.kill("SIGKILL");
    throw new Error("Codex app-server administration process has no stdio");
  }
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-64 * 1024);
  });
  const client = new CodexAppServerClient(
    child as import("node:child_process").ChildProcessWithoutNullStreams,
  );
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), ADMIN_TIMEOUT_MS);
  timeout.unref();
  const abort = (): void => {
    child.kill("SIGKILL");
  };
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  try {
    await client.request("initialize", {
      clientInfo: { name: "jaeger", title: "Jaeger", version: JAEGER_VERSION },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized", {});
    return await operation(client);
  } catch (error) {
    throw new Error(
      stderr.trim().length > 0
        ? `${errorMessage(error)}\n${stderr.trim()}`
        : errorMessage(error),
      { cause: error },
    );
  } finally {
    signal?.removeEventListener("abort", abort);
    client.closeInput();
    const result = await closed;
    clearTimeout(timeout);
    if (result.code !== 0) {
      process.stderr.write(
        `jaeger codex thread archive app-server exited (${String(result.code ?? result.signal)})${stderr.trim() ? `: ${stderr.trim()}` : ""}\n`,
      );
    }
  }
}

async function isArchived(
  client: CodexAppServerClient,
  nativeSessionId: string,
): Promise<boolean> {
  let cursor: string | undefined;
  do {
    const response = await client.request("thread/list", {
      archived: true,
      limit: 100,
      sourceKinds: [...SOURCE_KINDS],
      ...(cursor ? { cursor } : {}),
    });
    const data = Array.isArray(response.data) ? response.data : [];
    if (
      data.some((value) => nonEmptyString(jsonObject(value)?.id) === nativeSessionId)
    ) {
      return true;
    }
    cursor = nonEmptyString(response.nextCursor);
  } while (cursor);
  return false;
}

async function listDescendants(
  client: CodexAppServerClient,
  nativeSessionId: string,
): Promise<Array<{ id: string; isPinned: boolean; status?: string }>> {
  const descendants: Array<{ id: string; isPinned: boolean; status?: string }> = [];
  let cursor: string | undefined;
  do {
    const response = await client.request("thread/list", {
      ancestorThreadId: nativeSessionId,
      archived: false,
      limit: 100,
      sourceKinds: [...SOURCE_KINDS],
      ...(cursor ? { cursor } : {}),
    });
    const data = Array.isArray(response.data) ? response.data : [];
    for (const value of data) {
      const thread = jsonObject(value);
      const id = nonEmptyString(thread?.id);
      if (!id) continue;
      const status = nonEmptyString(jsonObject(thread?.status)?.type);
      descendants.push({
        id,
        isPinned: thread?.isPinned === true,
        ...(status ? { status } : {}),
      });
    }
    cursor = nonEmptyString(response.nextCursor);
  } while (cursor);
  return descendants;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object");
  }
  return value as Record<string, unknown>;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
