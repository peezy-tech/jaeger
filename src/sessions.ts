import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  applyProviderIdentityUpdate,
  createInitialProviderIdentity,
  markProviderIdentityStale,
  parseProviderIdentitySnapshot,
  redactSensitiveText,
  type ProviderIdentityUpdate,
} from "./provider-identity.js";
import { validateHarnessName } from "./harnesses/registry.js";
import {
  acquireProcessLease,
  clearInactiveProcessLease,
  ProcessLeaseBusyError,
  releaseProcessLease,
  type ProcessLeaseOwner,
} from "./process-lease.js";
import type {
  AgentOptions,
  HarnessDriver,
  HarnessName,
  JsonValue,
  ProviderRuntimeEvent,
  ProviderRuntimeSnapshot,
  SessionControlKind,
  SessionControlRequest,
  SessionTurn,
  WorkflowSessionRecord,
  WorkflowSessionSummary,
} from "./types.js";

const POLL_MS = 40;
const CONTROL_TIMEOUT_MS = 10_000;

type ControllerIdentity = ProcessLeaseOwner;

interface StoredSessionRecord extends WorkflowSessionRecord {
  readonly controller?: ControllerIdentity | undefined;
}

interface StoredControlRequest extends SessionControlRequest {
  readonly version: 1;
  readonly token: string;
  readonly requestedAt: string;
}

interface StoredControlResponse {
  readonly version: 1;
  readonly id: string;
  readonly ok: boolean;
  readonly result?: Record<string, JsonValue>;
  readonly error?: string;
  readonly respondedAt: string;
}

export class ManagedSessionTurn implements SessionTurn {
  readonly id: string;
  readonly nativeSessionId: string | undefined;
  private record: StoredSessionRecord;
  private readonly sessionDir: string;
  private readonly controller: ControllerIdentity;
  private closed = false;

  private constructor(
    sessionDir: string,
    record: StoredSessionRecord,
    controller: ControllerIdentity,
  ) {
    this.sessionDir = sessionDir;
    this.record = record;
    this.controller = controller;
    this.id = record.id;
    this.nativeSessionId = record.nativeSessionId;
  }

  static async create(
    runDir: string,
    runId: string,
    stepId: string,
    options: AgentOptions,
    cwd: string,
    driver?: HarnessDriver,
  ): Promise<ManagedSessionTurn> {
    if (driver !== undefined && !isHarnessDriver(driver)) {
      throw new TypeError("session driver is invalid");
    }
    const id = sessionIdFor(stepId, options.harness);
    const sessionDir = sessionDirectory(runDir, id);
    await prepareSessionDirectory(sessionDir);
    const recordPath = path.join(sessionDir, "session.json");
    const createdAt = new Date().toISOString();
    const record: StoredSessionRecord = {
      version: 1,
      id,
      runId,
      stepId,
      harness: canonicalHarness(options.harness),
      driver: driver ?? legacyDriverForHarness(options.harness),
      cwd,
      ...(options.label ? { label: options.label } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
      ...(options.profile ? { profile: options.profile } : {}),
      status: "starting",
      runtime: initialRuntime(createdAt),
      turnCount: 0,
      createdAt,
      updatedAt: createdAt,
    };
    try {
      await readFile(recordPath, "utf8");
      throw new Error(`Jaeger session ${id} already exists for ${stepId}`);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    const controller = await acquireTurn(sessionDir);
    const active = { ...record, controller };
    await atomicWriteJson(recordPath, active);
    return new ManagedSessionTurn(sessionDir, active, controller);
  }

  static async resume(
    runDir: string,
    selector: string,
    driver?: HarnessDriver,
  ): Promise<ManagedSessionTurn> {
    if (driver !== undefined && !isHarnessDriver(driver)) {
      throw new TypeError("session driver is invalid");
    }
    const existing = await resolveSession(runDir, selector);
    if (!existing.nativeSessionId) {
      throw new Error(`Jaeger session ${existing.id} has no native provider session to resume`);
    }
    if (existing.status === "starting" || existing.status === "running") {
      if (!existing.controller || !isControllerActive(existing.controller)) {
        throw new Error(
          `Jaeger session ${existing.id} has an uncertain stale turn and cannot be safely resumed`,
        );
      }
      throw new Error(
        `Jaeger session ${existing.id} already has an active turn owned by PID ${existing.controller.pid}`,
      );
    }
    const sessionDir = sessionDirectory(runDir, existing.id);
    const controller = await acquireTurn(sessionDir);
    const updatedAt = new Date().toISOString();
    const activeDriver = driver ?? existing.driver ?? legacyDriverForHarness(existing.harness);
    const active: StoredSessionRecord = {
      ...existing,
      driver: activeDriver,
      status: "starting",
      runtime: restartRuntime(existing.runtime, updatedAt),
      updatedAt,
      controller,
      activeTurnId: undefined,
      lastError: undefined,
    };
    await atomicWriteJson(path.join(sessionDir, "session.json"), active);
    return new ManagedSessionTurn(sessionDir, active, controller);
  }

  async providerStarted(nativeSessionId: string): Promise<void> {
    if (!nativeSessionId) throw new TypeError("native session id must be non-empty");
    if (this.record.nativeSessionId && this.record.nativeSessionId !== nativeSessionId) {
      throw new Error(
        `Provider changed native session id for ${this.id}: ${this.record.nativeSessionId} -> ${nativeSessionId}`,
      );
    }
    await this.update({
      nativeSessionId,
      status: "running",
      runtime: updateRuntime(this.record, {
        id: `provider.session.started:${nativeSessionId}`,
        type: "provider.session.started",
        source: driverForRecord(this.record),
        at: new Date().toISOString(),
        activity: "running",
      }),
    });
  }

  async turnStarted(nativeTurnId?: string): Promise<void> {
    await this.update({
      status: "running",
      ...(nativeTurnId ? { activeTurnId: nativeTurnId } : {}),
      runtime: updateRuntime(this.record, {
        id: `provider.turn.started:${nativeTurnId ?? this.id}`,
        type: "provider.turn.started",
        source: driverForRecord(this.record),
        at: new Date().toISOString(),
        activity: "running",
      }),
    });
  }

  async providerEvent(event: ProviderRuntimeEvent): Promise<void> {
    if (event.source !== driverForRecord(this.record)) {
      throw new Error(
        `Provider event source ${event.source} does not match session driver ${driverForRecord(this.record)}`,
      );
    }
    if (!Number.isFinite(Date.parse(event.at))) {
      throw new TypeError("provider event timestamp must be an ISO date");
    }
    if (
      this.record.runtime &&
      Date.parse(event.at) < Date.parse(this.record.runtime.updatedAt)
    ) return;
    await this.update({ runtime: updateRuntime(this.record, event) });
  }

  async processControls(
    handler: (request: SessionControlRequest) => Promise<Record<string, JsonValue> | void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const inbox = path.join(this.sessionDir, "control", "inbox");
    const outbox = path.join(this.sessionDir, "control", "outbox");
    while (!this.closed && !signal?.aborted) {
      let entries: string[];
      try {
        entries = (await readdir(inbox)).sort();
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
        await delay(POLL_MS, signal);
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const requestPath = path.join(inbox, entry);
        let request: StoredControlRequest;
        try {
          request = parseControlRequest(JSON.parse(await readFile(requestPath, "utf8")));
        } catch (error) {
          await unlink(requestPath).catch(() => undefined);
          continue;
        }
        if (request.token !== this.controller.token) {
          await writeControlResponse(outbox, request.id, false, undefined, "stale session turn");
          await unlink(requestPath).catch(() => undefined);
          continue;
        }
        try {
          const result = await handler(request);
          await writeControlResponse(outbox, request.id, true, result);
        } catch (error) {
          await writeControlResponse(outbox, request.id, false, undefined, errorMessage(error));
        } finally {
          await unlink(requestPath).catch(() => undefined);
        }
      }
      await delay(POLL_MS, signal);
    }
  }

  async complete(output: unknown, _metadata?: Record<string, JsonValue>): Promise<void> {
    const durable = jsonValue(output);
    await this.finish({
      status: "idle",
      ...(durable !== undefined ? { lastOutput: durable } : {}),
      lastError: undefined,
      turnCount: this.record.turnCount + 1,
      runtime: updateRuntime(this.record, {
        id: `provider.turn.completed:${this.record.activeTurnId ?? this.id}:${this.record.turnCount + 1}`,
        type: "provider.turn.completed",
        source: driverForRecord(this.record),
        at: new Date().toISOString(),
        activity: "completed",
      }),
    });
  }

  async fail(error: unknown): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.update({
      status: this.record.nativeSessionId ? "uncertain" : "failed",
      lastError: redactSensitiveText(error),
      controller: undefined,
      activeTurnId: undefined,
      runtime: updateRuntime(this.record, {
        id: `provider.turn.failed:${this.record.activeTurnId ?? this.id}:${this.record.turnCount + 1}`,
        type: "provider.turn.failed",
        source: driverForRecord(this.record),
        at: new Date().toISOString(),
        activity: "failed",
        error: errorMessage(error),
      }),
    });
    await releaseProcessLease(turnLeasePath(this.sessionDir), this.controller);
  }

  private async finish(update: Partial<StoredSessionRecord>): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.update({ ...update, activeTurnId: undefined, controller: undefined });
    await releaseProcessLease(turnLeasePath(this.sessionDir), this.controller);
  }

  private async update(update: Partial<StoredSessionRecord>): Promise<void> {
    this.record = {
      ...this.record,
      ...update,
      updatedAt: new Date().toISOString(),
    };
    await atomicWriteJson(path.join(this.sessionDir, "session.json"), this.record);
  }
}

export function workflowSessionId(stepId: string, harness: HarnessName): string {
  return sessionIdFor(stepId, harness);
}

export async function listWorkflowSessions(
  runDir: string,
  stateDir?: string,
): Promise<WorkflowSessionSummary[]> {
  const root = path.join(runDir, "sessions");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
  const summaries: WorkflowSessionSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    let record: WorkflowSessionRecord;
    try {
      record = parseSessionRecord(
        JSON.parse(await readFile(path.join(root, entry.name, "session.json"), "utf8")),
      );
    } catch (error) {
      // Directory creation precedes the atomic record rename by a few awaits.
      // Inspection may race that initialization, so an absent record is not
      // corruption. The workflow journal remains authoritative for uncertainty.
      if (hasCode(error, "ENOENT")) continue;
      throw error;
    }
    summaries.push(sessionSummary(record, stateDir ?? path.dirname(runDir)));
  }
  return summaries.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function resolveSession(
  runDir: string,
  selector: string,
): Promise<StoredSessionRecord> {
  const sessions = await listStoredSessions(runDir);
  const exact = sessions.filter(
    (session) =>
      session.id === selector ||
      session.stepId === selector ||
      session.nativeSessionId === selector,
  );
  if (exact.length === 1) return exact[0] as StoredSessionRecord;
  if (exact.length > 1) throw new Error(`Session selector ${selector} is ambiguous`);
  throw new Error(`Unknown Jaeger session ${selector}`);
}

export async function finalizeCompletedSessionTurn(
  runDir: string,
  input: {
    readonly sessionId: string;
    readonly turn: number;
    readonly output: JsonValue;
    readonly nativeSessionId: string;
  },
): Promise<boolean> {
  const sessionDir = sessionDirectory(runDir, input.sessionId);
  const recordPath = path.join(sessionDir, "session.json");
  const record = parseStoredSessionRecord(JSON.parse(await readFile(recordPath, "utf8")));
  if (record.turnCount >= input.turn) {
    if (record.turnCount === input.turn && record.nativeSessionId !== input.nativeSessionId) {
      throw new Error(
        `Cannot reconcile session ${record.id} turn ${input.turn}; native session identity changed`,
      );
    }
    return true;
  }
  if (record.turnCount !== input.turn - 1) {
    throw new Error(
      `Cannot reconcile session ${record.id} turn ${input.turn}; durable count is ${record.turnCount}`,
    );
  }
  if (record.controller && isControllerActive(record.controller)) return false;
  const completed: StoredSessionRecord = {
    ...record,
    nativeSessionId: input.nativeSessionId,
    status: "idle",
    turnCount: input.turn,
    lastOutput: input.output,
    lastError: undefined,
    activeTurnId: undefined,
    controller: undefined,
    ...(record.driver
      ? {
          runtime: updateRuntime(record, {
            id: `provider.turn.completed:${record.activeTurnId ?? record.id}:${input.turn}`,
            type: "provider.turn.completed",
            source: record.driver,
            at: new Date().toISOString(),
            activity: "completed",
          }),
        }
      : {}),
    updatedAt: new Date().toISOString(),
  };
  await atomicWriteJson(recordPath, completed);
  await clearInactiveProcessLease(turnLeasePath(sessionDir));
  return true;
}

export async function requestSessionControl(
  runDir: string,
  selector: string,
  kind: SessionControlKind,
  message?: string,
): Promise<Record<string, JsonValue>> {
  const record = await resolveSession(runDir, selector);
  if (record.status !== "running" || !record.controller) {
    throw new Error(`Jaeger session ${record.id} is not running; use session resume to continue it`);
  }
  if (!isControllerActive(record.controller)) {
    throw new Error(`Jaeger session ${record.id} has a stale active turn; inspect the workflow run`);
  }
  if (kind === "steer" && (!message || message.trim().length === 0)) {
    throw new TypeError("steer message must be non-empty");
  }
  const id = `${Date.now()}-${randomBytes(8).toString("hex")}`;
  const request: StoredControlRequest = {
    version: 1,
    id,
    token: record.controller.token,
    kind,
    ...(message ? { message } : {}),
    requestedAt: new Date().toISOString(),
  };
  const controlRoot = path.join(sessionDirectory(runDir, record.id), "control");
  await atomicWriteJson(path.join(controlRoot, "inbox", `${id}.json`), request);
  const responsePath = path.join(controlRoot, "outbox", `${id}.json`);
  const deadline = Date.now() + CONTROL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = parseControlResponse(JSON.parse(await readFile(responsePath, "utf8")));
      await unlink(responsePath).catch(() => undefined);
      if (!response.ok) throw new Error(response.error ?? `${kind} failed`);
      return response.result ?? {};
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    if (!isControllerActive(record.controller)) {
      throw new Error(`Session turn exited before acknowledging ${kind}`);
    }
    await delay(POLL_MS);
  }
  throw new Error(`Timed out waiting for session ${kind} acknowledgement`);
}

function sessionSummary(
  record: WorkflowSessionRecord,
  stateDir: string,
): WorkflowSessionSummary {
  const prefix = `jaeger session`;
  const target = `${shellQuote(record.runId)} ${shellQuote(record.id)} --state-dir ${shellQuote(stateDir)}`;
  return {
    ...record,
    inspect: `${prefix} inspect ${target}`,
    ...(record.status === "running"
      ? {
          steer: `${prefix} steer ${target} --message -`,
          interrupt: `${prefix} interrupt ${target}`,
        }
      : record.nativeSessionId && record.status === "idle"
        ? { resume: `${prefix} resume ${target} --message -` }
        : {}),
  };
}

async function listStoredSessions(runDir: string): Promise<StoredSessionRecord[]> {
  const root = path.join(runDir, "sessions");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
  const records: StoredSessionRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    try {
      records.push(
        parseStoredSessionRecord(
          JSON.parse(await readFile(path.join(root, entry.name, "session.json"), "utf8")),
        ),
      );
    } catch (error) {
      if (hasCode(error, "ENOENT")) continue;
      throw error;
    }
  }
  return records;
}

async function acquireTurn(sessionDir: string): Promise<ControllerIdentity> {
  try {
    return await acquireProcessLease(turnLeasePath(sessionDir));
  } catch (error) {
    if (error instanceof ProcessLeaseBusyError) {
      throw new Error(
        `Jaeger session already has an active turn owned by PID ${error.owner.pid}`,
      );
    }
    throw error;
  }
}

function turnLeasePath(sessionDir: string): string {
  return path.join(sessionDir, "turn.lock");
}

async function prepareSessionDirectory(sessionDir: string): Promise<void> {
  await mkdir(path.join(sessionDir, "control", "inbox"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(sessionDir, "control", "outbox"), { recursive: true, mode: 0o700 });
  await chmod(sessionDir, 0o700);
  await chmod(path.join(sessionDir, "control"), 0o700);
  await chmod(path.join(sessionDir, "control", "inbox"), 0o700);
  await chmod(path.join(sessionDir, "control", "outbox"), 0o700);
}

function sessionDirectory(runDir: string, id: string): string {
  if (!/^session-[a-f0-9]{16}$/.test(id)) throw new Error(`Invalid Jaeger session id: ${id}`);
  return path.join(runDir, "sessions", id);
}

function sessionIdFor(stepId: string, harness: HarnessName): string {
  return `session-${createHash("sha256").update(`${harness}\0${stepId}`).digest("hex").slice(0, 16)}`;
}

function canonicalHarness(harness: HarnessName): HarnessName {
  return harness;
}

function parseSessionRecord(value: unknown): WorkflowSessionRecord {
  return stripController(parseStoredSessionRecord(value));
}

function parseStoredSessionRecord(value: unknown): StoredSessionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Jaeger session record");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.id !== "string" ||
    typeof record.runId !== "string" ||
    typeof record.stepId !== "string" ||
    !isHarnessName(record.harness) ||
    typeof record.cwd !== "string" ||
    !["starting", "running", "idle", "failed", "uncertain"].includes(String(record.status)) ||
    !Number.isSafeInteger(record.turnCount) ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string"
  ) {
    throw new Error("Invalid Jaeger session record");
  }
  if (record.driver !== undefined && !isHarnessDriver(record.driver)) {
    throw new Error("Invalid Jaeger session driver");
  }
  if (record.controller !== undefined) parseController(record.controller);
  if (record.runtime !== undefined) parseRuntime(record.runtime, record.harness, record.driver);
  return value as StoredSessionRecord;
}

function isHarnessName(value: unknown): value is string {
  try {
    validateHarnessName(value);
    return true;
  } catch {
    return false;
  }
}

function stripController(record: StoredSessionRecord): WorkflowSessionRecord {
  const { controller: _controller, ...publicRecord } = record;
  return publicRecord;
}

const MAX_RUNTIME_EVENTS = 48;
const MAX_RUNTIME_PROGRESS = 48;

function initialRuntime(updatedAt: string): ProviderRuntimeSnapshot {
  return {
    version: 1,
    activity: "starting",
    updatedAt,
    progress: [],
    recentEvents: [],
  };
}

function restartRuntime(
  current: ProviderRuntimeSnapshot | undefined,
  updatedAt: string,
): ProviderRuntimeSnapshot {
  if (!current) return initialRuntime(updatedAt);
  const { lastError: _lastError, ...withoutLastError } = current;
  const identity = current.identity
    ? jsonValue(markProviderIdentityStale(parseProviderIdentitySnapshot(current.identity)))
    : undefined;
  return {
    ...withoutLastError,
    activity: "starting",
    updatedAt,
    ...(identity ? { identity } : {}),
  };
}

function updateRuntime(
  record: StoredSessionRecord,
  event: ProviderRuntimeEvent,
): ProviderRuntimeSnapshot {
  const current = record.runtime ?? initialRuntime(event.at);
  const progress = new Map(current.progress.map((item) => [item.id, item]));
  if (event.progress) progress.set(event.progress.id, event.progress);
  const identity = runtimeIdentity(record, current, event);
  const recentEvents = [
    ...current.recentEvents,
    {
      id: event.id,
      type: event.type,
      at: event.at,
      ...(event.activity ? { activity: event.activity } : {}),
    },
  ].slice(-MAX_RUNTIME_EVENTS);
  return {
    version: 1,
    activity: event.activity ?? current.activity,
    updatedAt: event.at,
    ...(identity ? { identity } : {}),
    ...(event.usage ? { usage: event.usage } : current.usage ? { usage: current.usage } : {}),
    ...(event.rateLimits
      ? { rateLimits: event.rateLimits }
      : current.rateLimits
        ? { rateLimits: current.rateLimits }
        : {}),
    progress: [...progress.values()].slice(-MAX_RUNTIME_PROGRESS),
    recentEvents,
    ...(event.error
      ? { lastError: redactSensitiveText(event.error) }
      : event.activity !== "completed" && current.lastError
        ? { lastError: current.lastError }
        : {}),
  };
}

function runtimeIdentity(
  record: StoredSessionRecord,
  current: ProviderRuntimeSnapshot,
  event: ProviderRuntimeEvent,
): JsonValue | undefined {
  if (event.identity === undefined) return current.identity;
  try {
    const prior = current.identity
      ? parseProviderIdentitySnapshot(current.identity)
      : createInitialProviderIdentity(record.harness, event.source);
    return jsonValue(
      applyProviderIdentityUpdate(prior, event.identity as ProviderIdentityUpdate, event.at),
    );
  } catch {
    return jsonValue(
      markIdentityUncertain(record.harness, event.source, event.at),
    );
  }
}

function markIdentityUncertain(
  harness: HarnessName,
  driver: HarnessDriver,
  observedAt: string,
): Record<string, JsonValue> {
  return {
    provider: harness,
    driver,
    auth: { status: "unknown" },
    freshness: "uncertain",
    observedAt,
  };
}

function driverForRecord(record: WorkflowSessionRecord): HarnessDriver {
  return record.driver ?? legacyDriverForHarness(record.harness);
}

function legacyDriverForHarness(harness: HarnessName): HarnessDriver {
  return harness === "claude" || harness.includes("claude")
    ? "claude-agent-sdk"
    : harness === "pi"
      ? "pi-rpc"
      : "codex-app-server";
}

function isHarnessDriver(value: unknown): value is HarnessDriver {
  return value === "codex-app-server" || value === "claude-agent-sdk" || value === "pi-rpc";
}

function parseController(value: unknown): ControllerIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid session controller identity");
  }
  const controller = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(controller.pid) ||
    typeof controller.processStartId !== "string" ||
    typeof controller.token !== "string" ||
    !/^[a-f0-9]{32}$/.test(controller.token)
  ) {
    throw new Error("Invalid session controller identity");
  }
  return value as ControllerIdentity;
}

function parseRuntime(
  value: unknown,
  harness: HarnessName,
  driver: HarnessDriver | undefined,
): asserts value is ProviderRuntimeSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid provider runtime snapshot");
  }
  const runtime = value as Record<string, unknown>;
  if (
    runtime.version !== 1 ||
    !["starting", "running", "completed", "failed", "interrupted"].includes(String(runtime.activity)) ||
    !isIsoTimestamp(runtime.updatedAt) ||
    !Array.isArray(runtime.progress) ||
    !Array.isArray(runtime.recentEvents) ||
    runtime.progress.length > MAX_RUNTIME_PROGRESS ||
    runtime.recentEvents.length > MAX_RUNTIME_EVENTS ||
    (runtime.identity !== undefined && jsonValue(runtime.identity) === undefined) ||
    (runtime.usage !== undefined && !isJsonRecord(runtime.usage)) ||
    (runtime.rateLimits !== undefined && !isJsonRecord(runtime.rateLimits)) ||
    (runtime.lastError !== undefined && typeof runtime.lastError !== "string")
  ) {
    throw new Error("Invalid provider runtime snapshot");
  }
  if (runtime.identity !== undefined) {
    const identity = parseProviderIdentitySnapshot(runtime.identity);
    if (identity.provider !== harness || (driver !== undefined && identity.driver !== driver)) {
      throw new Error("Provider runtime identity does not match its session");
    }
  }
  for (const progress of runtime.progress) {
    if (!progress || typeof progress !== "object" || Array.isArray(progress)) {
      throw new Error("Invalid provider runtime progress");
    }
    const item = progress as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      !["task", "tool", "workflow"].includes(String(item.kind)) ||
      !["running", "completed", "failed", "interrupted"].includes(String(item.status)) ||
      !isIsoTimestamp(item.updatedAt) ||
      (item.label !== undefined && typeof item.label !== "string") ||
      (item.parentId !== undefined && typeof item.parentId !== "string")
    ) {
      throw new Error("Invalid provider runtime progress");
    }
  }
  for (const event of runtime.recentEvents) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new Error("Invalid provider runtime event");
    }
    const item = event as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      typeof item.type !== "string" ||
      !isIsoTimestamp(item.at) ||
      (item.activity !== undefined &&
        !["starting", "running", "completed", "failed", "interrupted"].includes(
          String(item.activity),
        ))
    ) {
      throw new Error("Invalid provider runtime event");
    }
  }
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  const durable = jsonValue(value);
  return durable !== undefined && typeof durable === "object" && !Array.isArray(durable);
}

function parseControlRequest(value: unknown): StoredControlRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid session control request");
  }
  const request = value as Record<string, unknown>;
  if (
    request.version !== 1 ||
    typeof request.id !== "string" ||
    typeof request.token !== "string" ||
    (request.kind !== "steer" && request.kind !== "interrupt") ||
    (request.message !== undefined && typeof request.message !== "string") ||
    typeof request.requestedAt !== "string"
  ) {
    throw new Error("Invalid session control request");
  }
  return value as StoredControlRequest;
}

function parseControlResponse(value: unknown): StoredControlResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid session control response");
  }
  const response = value as Record<string, unknown>;
  if (
    response.version !== 1 ||
    typeof response.id !== "string" ||
    typeof response.ok !== "boolean" ||
    typeof response.respondedAt !== "string"
  ) {
    throw new Error("Invalid session control response");
  }
  return value as StoredControlResponse;
}

async function writeControlResponse(
  outbox: string,
  id: string,
  ok: boolean,
  result?: Record<string, JsonValue> | void,
  error?: string,
): Promise<void> {
  const response: StoredControlResponse = {
    version: 1,
    id,
    ok,
    ...(result ? { result } : {}),
    ...(error ? { error } : {}),
    respondedAt: new Date().toISOString(),
  };
  await atomicWriteJson(path.join(outbox, `${id}.json`), response);
}

async function atomicWriteJson(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
  await syncDirectory(path.dirname(target));
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function processStartId(pid: number): string {
  const stat = requireProcessStat(pid);
  const close = stat.lastIndexOf(")");
  const fields = stat.slice(close + 2).split(" ");
  const start = fields[19];
  if (!start) throw new Error(`Could not read process start identity for PID ${pid}`);
  return start;
}

function requireProcessStat(pid: number): string {
  try {
    return requireReadFile(`/proc/${pid}/stat`);
  } catch (error) {
    throw new Error(`Could not inspect process ${pid}`, { cause: error });
  }
}

function requireReadFile(filePath: string): string {
  // This synchronous identity check closes the PID-reuse race around a tiny
  // lock acquisition window without introducing an await between probes.
  return process.getBuiltinModule("node:fs").readFileSync(filePath, "utf8") as string;
}

function isControllerActive(controller: ControllerIdentity): boolean {
  try {
    return processStartId(controller.pid) === controller.processStartId;
  } catch {
    return false;
  }
}

function jsonValue(value: unknown): JsonValue | undefined {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return undefined;
  }
  return serialized === undefined ? undefined : (JSON.parse(serialized) as JsonValue);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
