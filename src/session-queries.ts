import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { assertRunExecutionAdmission, type RuntimeBackendKind } from "./admission.js";
import { abortableDelay } from "./abortable-delay.js";
import { BackendRpcError } from "./backend-protocol.js";
import {
  assertRegularFile,
  hasCode,
  publishJsonExclusive,
  syncDirectory,
} from "./durable-json.js";
import {
  discoverHarnessProcess,
  harnessContainmentState,
} from "./harnesses/active-process.js";
import { harnessesForRun } from "./harnesses/registry.js";
import { stepScratchDirectory } from "./harnesses/support.js";
import { RunJournal } from "./journal.js";
import { systemdRunCommand } from "./launchers.js";
import { ensurePrivateDirectory } from "./paths.js";
import {
  currentProcessIdentity,
  isProcessIdentityActive,
} from "./process-identity.js";
import { resolveSession } from "./sessions.js";
import {
  clearSessionQueryReservation,
  reserveSessionForQuery,
  sessionQueryReservationMatches,
} from "./session-turns.js";
import type {
  AgentRequest,
  JsonValue,
  SessionQuerySummary,
  SessionTurn,
} from "./types.js";

const QUERY_ID_PATTERN = /^query-[A-Za-z0-9._:-]{8,122}$/;
const RUN_ID_PATTERN = /^\d{14}-[a-f0-9]{10}$/;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1_000;

export interface SessionQueryRequest {
  readonly version: 1;
  readonly queryId: string;
  readonly requestHash: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly parentNativeSessionId: string;
  readonly message: string;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly backend: RuntimeBackendKind;
  readonly createdAt: string;
}

interface SessionQueryOwner {
  readonly version: 1;
  readonly queryId: string;
  readonly requestHash: string;
  readonly pid: number;
  readonly processStartId: string;
  readonly unit: string;
  readonly claimedAt: string;
}

interface SessionQueryResult {
  readonly version: 1;
  readonly queryId: string;
  readonly requestHash: string;
  readonly status: "completed" | "rejected" | "uncertain";
  readonly output?: JsonValue;
  readonly nativeSessionId?: string;
  readonly metadata?: Record<string, JsonValue>;
  readonly error?: string;
  readonly finishedAt: string;
}

export interface SessionQueryServiceOptions {
  readonly stateDir: string;
  readonly entrypoint: string;
  readonly env: NodeJS.ProcessEnv;
  readonly backend: RuntimeBackendKind;
}

export function createSessionQueryId(): string {
  return `query-${randomBytes(16).toString("hex")}`;
}

export async function submitSessionQuery(
  options: SessionQueryServiceOptions & {
    readonly runId: string;
    readonly selector: string;
    readonly message: string;
    readonly model?: string;
    readonly timeoutMs?: number;
    readonly queryId: string;
    readonly launch?: boolean;
  },
): Promise<SessionQuerySummary> {
  validateQueryId(options.queryId);
  if (options.message.trim().length === 0) {
    throw new BackendRpcError("invalid_request", "session query message must be non-empty");
  }
  const timeoutMs = checkedTimeout(options.timeoutMs);
  const journal = await admittedJournal(options.stateDir, options.runId, options.backend);
  const session = await resolveSession(journal.runDir, options.selector);
  const adapter = harnessesForRun(journal.record).get(session.harness);
  if (!adapter) {
    throw new BackendRpcError(
      "session_not_available",
      `No session adapter is installed for ${session.harness}`,
    );
  }
  if (!session.nativeSessionId) {
    throw new BackendRpcError(
      "session_not_available",
      `Jaeger session ${session.id} has no native provider session to query`,
    );
  }
  if (session.status === "failed" || session.status === "uncertain") {
    throw new BackendRpcError(
      "session_not_available",
      `Jaeger session ${session.id} is ${session.status}`,
    );
  }
  const candidate: SessionQueryRequest = {
    version: 1,
    queryId: options.queryId,
    requestHash: queryHash({
      runId: options.runId,
      sessionId: session.id,
      parentNativeSessionId: session.nativeSessionId,
      message: options.message,
      ...(options.model ? { model: options.model } : {}),
      timeoutMs,
      backend: options.backend,
    }),
    runId: options.runId,
    sessionId: session.id,
    parentNativeSessionId: session.nativeSessionId,
    message: options.message,
    ...(options.model ? { model: options.model } : {}),
    timeoutMs,
    backend: options.backend,
    createdAt: new Date().toISOString(),
  };
  const existingRequest = await readRequest(
    journal.runDir,
    options.queryId,
  ).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  });
  if (existingRequest) {
    if (!sameRequest(existingRequest, candidate)) {
      throw new BackendRpcError(
        "idempotency_conflict",
        `Session query id ${options.queryId} was already used for a different request`,
      );
    }
    const existingSummary = await inspectSessionQuery({
      stateDir: options.stateDir,
      runId: options.runId,
      queryId: options.queryId,
      backend: options.backend,
    });
    if (existingSummary.status !== "queued") return existingSummary;
  }
  if (adapter.driver === "pi-rpc" && session.status !== "idle") {
    throw new BackendRpcError(
      "session_not_available",
      `Pi session ${session.id} must be idle before it can be forked for a query`,
    );
  }
  const request =
    existingRequest ?? await createOrReadRequest(journal.runDir, candidate);
  if (!sameRequest(request, candidate)) {
    throw new BackendRpcError(
      "idempotency_conflict",
      `Session query id ${options.queryId} was already used for a different request`,
    );
  }
  const summary = await inspectSessionQuery({
    stateDir: options.stateDir,
    runId: options.runId,
    queryId: options.queryId,
    backend: options.backend,
  });
  if (summary.status !== "queued") return summary;
  if (adapter.driver === "pi-rpc") {
    try {
      await reserveSessionForQuery(journal.runDir, request);
    } catch (error) {
      if (await sessionQueryReservationMatches(journal.runDir, request)) {
        throw acceptedAmbiguousError(request, error);
      }
      await publishRejectedResult(journal.runDir, request, error);
      throw error;
    }
  }
  if (options.launch === false) {
    return await inspectSessionQuery({
      stateDir: options.stateDir,
      runId: options.runId,
      queryId: options.queryId,
      backend: options.backend,
    });
  }
  try {
    await launchSessionQueryWorker(options, request, journal.runDir);
  } catch (error) {
    throw acceptedAmbiguousError(request, error);
  }
  return await inspectSessionQuery({
    stateDir: options.stateDir,
    runId: options.runId,
    queryId: options.queryId,
    backend: options.backend,
  });
}

export async function inspectSessionQuery(input: {
  readonly stateDir: string;
  readonly runId: string;
  readonly queryId: string;
  readonly backend: RuntimeBackendKind;
}): Promise<SessionQuerySummary> {
  const journal = await admittedJournal(input.stateDir, input.runId, input.backend);
  const request = await readRequest(journal.runDir, input.queryId);
  const result = await readResult(journal.runDir, request).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  });
  if (result) {
    await clearSessionQueryReservation(journal.runDir, request);
    return publicSummary(request, result.status, result);
  }
  const owner = await readOwner(journal.runDir, request).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  });
  if (!owner) return publicSummary(request, "queued");
  if (isProcessIdentityActive(owner)) return publicSummary(request, "running");
  const session = await resolveSession(journal.runDir, request.sessionId);
  const provider = discoverHarnessProcess(
    stepScratchDirectory(journal.runDir, `${session.stepId}/query:${request.queryId}`),
  );
  if (harnessContainmentState(provider) !== "inactive") {
    return publicSummary(
      request,
      "orphaned",
      undefined,
      "Query worker exited while provider containment is active or unverifiable",
    );
  }
  const uncertain: SessionQueryResult = {
    version: 1,
    queryId: request.queryId,
    requestHash: request.requestHash,
    status: "uncertain",
    error: "Session query worker exited without a durable provider result; replay is forbidden",
    finishedAt: new Date().toISOString(),
  };
  await publishResult(journal.runDir, request, uncertain);
  await clearSessionQueryReservation(journal.runDir, request);
  return publicSummary(request, "uncertain", uncertain);
}

export async function waitForSessionQuery(
  input: {
    readonly stateDir: string;
    readonly runId: string;
    readonly queryId: string;
    readonly backend: RuntimeBackendKind;
  },
  signal?: AbortSignal,
): Promise<SessionQuerySummary> {
  while (true) {
    if (signal?.aborted) throw abortReason(signal);
    const summary = await inspectSessionQuery(input);
    if (
      summary.status === "completed" ||
      summary.status === "rejected" ||
      summary.status === "uncertain"
    ) return summary;
    await abortableDelay(100, signal);
  }
}

export async function recoverSessionQueries(
  options: SessionQueryServiceOptions,
  runId: string,
): Promise<{
  readonly considered: number;
  readonly launched: readonly string[];
  readonly errors: readonly { readonly queryId: string; readonly error: string }[];
}> {
  const journal = await admittedJournal(options.stateDir, runId, options.backend);
  const root = queriesRoot(journal.runDir);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { considered: 0, launched: [], errors: [] };
    throw error;
  }
  const launched: string[] = [];
  const errors: Array<{ queryId: string; error: string }> = [];
  let considered = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !QUERY_ID_PATTERN.test(entry.name)) continue;
    considered++;
    try {
      const request = await readRequest(journal.runDir, entry.name);
      const summary = await inspectSessionQuery({
        stateDir: options.stateDir,
        runId,
        queryId: request.queryId,
        backend: options.backend,
      });
      if (summary.status === "queued") {
        const session = await resolveSession(journal.runDir, request.sessionId);
        const adapter = harnessesForRun(journal.record).get(session.harness);
        if (!adapter) {
          throw new Error(`No session adapter is installed for ${session.harness}`);
        }
        if (
          adapter.driver === "pi-rpc" &&
          !(await sessionQueryReservationMatches(journal.runDir, request))
        ) {
          await publishRejectedResult(
            journal.runDir,
            request,
            new Error("Pi session query has no durable session reservation"),
          );
          continue;
        }
        await launchSessionQueryWorker(options, request, journal.runDir);
        launched.push(request.queryId);
      }
    } catch (error) {
      errors.push({ queryId: entry.name, error: errorMessage(error) });
    }
  }
  return { considered, launched, errors };
}

export async function executeSessionQueryWorker(input: {
  readonly stateDir: string;
  readonly runId: string;
  readonly queryId: string;
  readonly backend: RuntimeBackendKind;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const journal = await admittedJournal(input.stateDir, input.runId, input.backend);
  const request = await readRequest(journal.runDir, input.queryId);
  if (request.backend !== input.backend) {
    throw new Error(`Session query ${request.queryId} is pinned to ${request.backend}`);
  }
  try {
    await readResult(journal.runDir, request);
    await clearSessionQueryReservation(journal.runDir, request);
    return;
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  const session = await resolveSession(journal.runDir, request.sessionId);
  const adapter = harnessesForRun(journal.record).get(session.harness);
  if (!adapter) throw new Error(`No session adapter is installed for ${session.harness}`);
  const reserved = adapter.driver === "pi-rpc";
  if (reserved) {
    try {
      await reserveSessionForQuery(journal.runDir, request);
    } catch (error) {
      await publishRejectedResult(journal.runDir, request, error);
      return;
    }
  }
  const owner: SessionQueryOwner = {
    version: 1,
    queryId: request.queryId,
    requestHash: request.requestHash,
    ...currentProcessIdentity(),
    unit: sessionQueryUnit(request.runId, request.queryId),
    claimedAt: new Date().toISOString(),
  };
  if (!(await publishJsonExclusive(ownerPath(journal.runDir, request), owner))) return;
  try {
    await readResult(journal.runDir, request);
    await clearSessionQueryReservation(journal.runDir, request);
    return;
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  const passive = new QuerySession(request.queryId);
  const agentRequest: AgentRequest = {
    harness: session.harness,
    prompt: queryPrompt(request.message),
    cwd: session.cwd,
    timeoutMs: request.timeoutMs,
    runDir: journal.runDir,
    stepId: `${session.stepId}/query:${request.queryId}`,
    session: passive,
    forkSessionId: request.parentNativeSessionId,
    readOnly: true,
    ...(session.label ? { label: `Query: ${session.label}` } : {}),
    ...(request.model ? { model: request.model } : session.model ? { model: session.model } : {}),
    ...(session.effort ? { effort: session.effort } : {}),
    ...(session.serviceTier ? { serviceTier: session.serviceTier } : {}),
    ...(session.profile ? { profile: session.profile } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  };
  try {
    const execution = await adapter.execute(agentRequest);
    const result: SessionQueryResult = {
      version: 1,
      queryId: request.queryId,
      requestHash: request.requestHash,
      status: "completed",
      output: toJsonValue(execution.output),
      nativeSessionId:
        execution.nativeSessionId ?? passive.nativeSessionId ?? request.parentNativeSessionId,
      ...(execution.metadata ? { metadata: execution.metadata } : {}),
      finishedAt: new Date().toISOString(),
    };
    await publishResult(journal.runDir, request, result);
  } catch (error) {
    const uncertain: SessionQueryResult = {
      version: 1,
      queryId: request.queryId,
      requestHash: request.requestHash,
      status: "uncertain",
      error: errorMessage(error),
      finishedAt: new Date().toISOString(),
    };
    await publishResult(journal.runDir, request, uncertain).catch((publishError: unknown) => {
      if (!hasCode(publishError, "EEXIST")) throw publishError;
    });
    throw error;
  } finally {
    if (reserved) {
      await clearSessionQueryReservation(journal.runDir, request);
    }
  }
}

class QuerySession implements SessionTurn {
  readonly id: string;
  nativeSessionId: string | undefined;

  constructor(queryId: string) {
    this.id = queryId;
  }

  async providerStarted(nativeSessionId: string): Promise<void> {
    this.nativeSessionId = nativeSessionId;
  }

  async turnStarted(): Promise<void> {}

  async providerEvent(): Promise<void> {}

  async processControls(): Promise<void> {}
}

async function launchSessionQueryWorker(
  options: SessionQueryServiceOptions,
  request: SessionQueryRequest,
  runDir: string,
): Promise<void> {
  try {
    await readOwner(runDir, request);
    return;
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  const directory = queryDirectory(runDir, request.queryId);
  const stdout = await open(path.join(directory, "runtime.stdout.log"), "a", 0o600);
  const stderr = await open(path.join(directory, "runtime.stderr.log"), "a", 0o600);
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
        `--unit=${sessionQueryUnit(request.runId, request.queryId)}`,
        "--",
        process.execPath,
        options.entrypoint,
        "__query-worker",
        "--state-dir",
        options.stateDir,
        "--run-id",
        request.runId,
        "--query-id",
        request.queryId,
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
        `Detached query worker exited before claiming ${request.queryId}; inspect ${directory}/runtime.stderr.log`,
      );
    }
    await abortableDelay(25);
  }
  child.unref();
  throw new Error(`Detached query worker did not claim ${request.queryId} within 5000ms`);
}

async function admittedJournal(
  stateDir: string,
  runId: string,
  backend: RuntimeBackendKind,
): Promise<RunJournal> {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new BackendRpcError("invalid_request", "Invalid Jaeger run id");
  }
  const journal = await RunJournal.open(path.resolve(stateDir), runId);
  assertRunExecutionAdmission(journal.record, backend);
  return journal;
}

async function createOrReadRequest(
  runDir: string,
  candidate: SessionQueryRequest,
): Promise<SessionQueryRequest> {
  const root = queriesRoot(runDir);
  await ensurePrivateDirectory(root, "Jaeger session-query directory");
  await syncDirectory(runDir);
  try {
    return await readRequest(runDir, candidate.queryId);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  const temporary = path.join(
    root,
    `.creating-${candidate.queryId}-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  await mkdir(temporary, { mode: 0o700 });
  try {
    await publishJsonExclusive(path.join(temporary, "request.json"), candidate);
    await syncDirectory(temporary);
    await rename(temporary, queryDirectory(runDir, candidate.queryId));
    await syncDirectory(root);
    return candidate;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    if (hasCode(error, "EEXIST") || hasCode(error, "ENOTEMPTY")) {
      return await readRequest(runDir, candidate.queryId);
    }
    throw error;
  }
}

async function readRequest(runDir: string, queryId: string): Promise<SessionQueryRequest> {
  validateQueryId(queryId);
  const target = path.join(queryDirectory(runDir, queryId), "request.json");
  await assertRegularFile(target, "Jaeger session-query request");
  const request = JSON.parse(await readFile(target, "utf8")) as unknown;
  validateRequest(request);
  if (request.queryId !== queryId) throw new Error(`Session query index collision for ${queryId}`);
  return request;
}

async function readOwner(
  runDir: string,
  request: SessionQueryRequest,
): Promise<SessionQueryOwner> {
  const target = ownerPath(runDir, request);
  await assertRegularFile(target, "Jaeger session-query owner");
  const owner = JSON.parse(await readFile(target, "utf8")) as unknown;
  validateOwner(owner, request);
  return owner;
}

async function readResult(
  runDir: string,
  request: SessionQueryRequest,
): Promise<SessionQueryResult> {
  const target = resultPath(runDir, request);
  await assertRegularFile(target, "Jaeger session-query result");
  const result = JSON.parse(await readFile(target, "utf8")) as unknown;
  validateResult(result, request);
  return result;
}

async function publishResult(
  runDir: string,
  request: SessionQueryRequest,
  result: SessionQueryResult,
): Promise<void> {
  const created = await publishJsonExclusive(resultPath(runDir, request), result);
  if (created) return;
  const existing = await readResult(runDir, request);
  if (existing.status === "completed" && result.status === "uncertain") return;
  if (
    existing.status === result.status &&
    existing.requestHash === result.requestHash &&
    existing.output === result.output &&
    existing.error === result.error
  ) {
    return;
  }
  throw new Error(`Session query ${request.queryId} already has a different terminal result`);
}

async function publishRejectedResult(
  runDir: string,
  request: SessionQueryRequest,
  reason: unknown,
): Promise<void> {
  await publishResult(runDir, request, {
    version: 1,
    queryId: request.queryId,
    requestHash: request.requestHash,
    status: "rejected",
    error: `Session query was not accepted: ${errorMessage(reason)}`,
    finishedAt: new Date().toISOString(),
  });
  await clearSessionQueryReservation(runDir, request);
}

function acceptedAmbiguousError(
  request: SessionQueryRequest,
  reason: unknown,
): BackendRpcError {
  const inspect = publicSummary(request, "queued").inspect;
  return new BackendRpcError(
    "accepted_ambiguous",
    `Session query ${request.queryId} is durably accepted, but continued execution could not be confirmed: ${errorMessage(reason)}. Retry the original session query command with --request-id ${request.queryId}, or inspect it with '${inspect}'.`,
  );
}

function publicSummary(
  request: SessionQueryRequest,
  status: SessionQuerySummary["status"],
  result?: SessionQueryResult,
  error?: string,
): SessionQuerySummary {
  const finalError = result?.error ?? error;
  return {
    schemaVersion: 1,
    runId: request.runId,
    sessionId: request.sessionId,
    queryId: request.queryId,
    status,
    createdAt: request.createdAt,
    parentNativeSessionId: request.parentNativeSessionId,
    ...(request.model ? { model: request.model } : {}),
    ...(result?.output !== undefined ? { output: result.output } : {}),
    ...(result?.nativeSessionId ? { nativeSessionId: result.nativeSessionId } : {}),
    ...(result?.metadata ? { metadata: result.metadata } : {}),
    ...(result?.finishedAt ? { finishedAt: result.finishedAt } : {}),
    ...(finalError ? { error: finalError } : {}),
    inspect: `jaeger session query inspect ${request.runId} ${request.queryId}`,
    ...(status === "queued" || status === "running" || status === "orphaned"
      ? { wait: `jaeger session query wait ${request.runId} ${request.queryId}` }
      : {}),
  };
}

function queryHash(value: {
  readonly runId: string;
  readonly sessionId: string;
  readonly parentNativeSessionId: string;
  readonly message: string;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly backend: RuntimeBackendKind;
}): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sameRequest(left: SessionQueryRequest, right: SessionQueryRequest): boolean {
  return left.requestHash === right.requestHash;
}

function validateRequest(value: unknown): asserts value is SessionQueryRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Jaeger session-query request");
  }
  const request = value as Partial<SessionQueryRequest>;
  if (
    request.version !== 1 ||
    typeof request.queryId !== "string" ||
    !QUERY_ID_PATTERN.test(request.queryId) ||
    typeof request.requestHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(request.requestHash) ||
    typeof request.runId !== "string" ||
    !RUN_ID_PATTERN.test(request.runId) ||
    typeof request.sessionId !== "string" ||
    typeof request.parentNativeSessionId !== "string" ||
    typeof request.message !== "string" ||
    (request.model !== undefined && typeof request.model !== "string") ||
    !Number.isSafeInteger(request.timeoutMs) ||
    (request.backend !== "embedded" && request.backend !== "local-service") ||
    typeof request.createdAt !== "string"
  ) {
    throw new Error("Invalid Jaeger session-query request");
  }
}

function validateOwner(
  value: unknown,
  request: SessionQueryRequest,
): asserts value is SessionQueryOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Jaeger session-query owner");
  }
  const owner = value as Partial<SessionQueryOwner>;
  if (
    owner.version !== 1 ||
    owner.queryId !== request.queryId ||
    owner.requestHash !== request.requestHash ||
    !Number.isSafeInteger(owner.pid) ||
    typeof owner.processStartId !== "string" ||
    typeof owner.unit !== "string" ||
    typeof owner.claimedAt !== "string"
  ) {
    throw new Error("Invalid Jaeger session-query owner");
  }
}

function validateResult(
  value: unknown,
  request: SessionQueryRequest,
): asserts value is SessionQueryResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Jaeger session-query result");
  }
  const result = value as Partial<SessionQueryResult>;
  if (
    result.version !== 1 ||
    result.queryId !== request.queryId ||
    result.requestHash !== request.requestHash ||
    !["completed", "rejected", "uncertain"].includes(String(result.status)) ||
    typeof result.finishedAt !== "string" ||
    (result.status === "completed" &&
      (result.output === undefined || typeof result.nativeSessionId !== "string")) ||
    ((result.status === "rejected" || result.status === "uncertain") &&
      typeof result.error !== "string")
  ) {
    throw new Error("Invalid Jaeger session-query result");
  }
}

function queryPrompt(message: string): string {
  return [
    "You are answering a side-channel question about this ongoing agent thread.",
    "Inspect the inherited conversation and current workspace as needed.",
    "Do not modify files, send messages, or perform external side effects.",
    "Answer the question directly and concisely.",
    "",
    message,
  ].join("\n");
}

function checkedTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 24 * 60 * 60 * 1_000) {
    throw new BackendRpcError(
      "invalid_request",
      "session query timeout must be a positive integer no greater than 24 hours",
    );
  }
  return timeout;
}

function validateQueryId(value: string): void {
  if (!QUERY_ID_PATTERN.test(value)) {
    throw new BackendRpcError("invalid_request", "Invalid session query id");
  }
}

function queriesRoot(runDir: string): string {
  return path.join(runDir, "session-queries");
}

function queryDirectory(runDir: string, queryId: string): string {
  return path.join(queriesRoot(runDir), queryId);
}

function ownerPath(runDir: string, request: SessionQueryRequest): string {
  return path.join(queryDirectory(runDir, request.queryId), "owner.json");
}

function resultPath(runDir: string, request: SessionQueryRequest): string {
  return path.join(queryDirectory(runDir, request.queryId), "result.json");
}

function sessionQueryUnit(runId: string, queryId: string): string {
  const suffix = createHash("sha256").update(queryId).digest("hex").slice(0, 12);
  return `jaeger-query-${runId}-${suffix}.scope`;
}

function toJsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Session query output is not JSON");
  return JSON.parse(serialized) as JsonValue;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Session query wait aborted");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
