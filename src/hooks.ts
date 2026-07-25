import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  lstat,
  open,
  readFile,
  readdir,
  rename,
} from "node:fs/promises";
import path from "node:path";
import { publishJsonExclusive, syncDirectory } from "./durable-json.js";
import type {
  HookConfig,
  HookDefinition,
  HookEventType,
} from "./hook-config.js";
import { RunJournal, type JournalEvent } from "./journal.js";
import { ensurePrivateDirectory } from "./paths.js";
import { inspectRun } from "./run-state.js";
import type { JsonValue, WorkflowRunSummary } from "./types.js";

const RUN_ID = /^\d{14}-[a-f0-9]{10}$/;
const SCHEDULE_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const EVENT_FILE = /^evt-[a-f0-9]{64}\.json$/;
const MAX_HOOK_OUTPUT_BYTES = 64 * 1024;
const ACTIVE_RUN_RECHECK_MS = 30_000;
const TERMINAL_RUN_FINGERPRINT_MS = 30_000;
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000, 600_000, 3_600_000] as const;
const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "interrupted",
  "stopped",
  "uncertain",
]);

export interface LifecycleHookEvent {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly type: HookEventType;
  readonly occurredAt: string;
  readonly observedAt: string;
  readonly run?: Record<string, JsonValue>;
  readonly schedule?: Record<string, JsonValue>;
  readonly subject?: Record<string, JsonValue>;
}

type DeliveryStatus = "pending" | "running" | "retrying" | "delivered";

interface HookDelivery {
  readonly version: 1;
  readonly hook: string;
  readonly eventId: string;
  readonly eventType: HookEventType;
  readonly createdAt: string;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly lastAttemptAt?: string;
  readonly deliveredAt?: string;
  readonly lastError?: string;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly stdoutBytes?: number;
  readonly stderrBytes?: number;
}

export interface HookManagerOptions {
  readonly stateDir: string;
  readonly configPath?: string;
  readonly config?: HookConfig;
  readonly configError?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly tickIntervalMs?: number;
  readonly now?: () => Date;
  readonly collectEvents?: boolean;
}

export interface HookHistoryFilter {
  readonly hook?: string;
  readonly eventId?: string;
  readonly limit?: number;
}

export class HookManager {
  private readonly stateDir: string;
  private readonly root: string;
  private readonly eventsDir: string;
  private readonly deliveriesDir: string;
  private readonly configPath: string | undefined;
  private readonly config: HookConfig | undefined;
  private readonly configError: string | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly tickIntervalMs: number;
  private readonly now: () => Date;
  private readonly collectEvents: boolean;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private readonly activeRuns = new Set<string>();
  private readonly knownEventIds = new Set<string>();
  private readonly pendingDeliveries = new Map<string, Set<string>>();
  private readonly runCheckedAt = new Map<string, number>();
  private readonly runFingerprintCheckedAt = new Map<string, number>();
  private readonly runFingerprints = new Map<string, string>();
  private deliveriesReconciled = false;
  private started = false;
  private lastTickAt: string | undefined;
  private lastTickError: string | undefined;

  constructor(options: HookManagerOptions) {
    this.stateDir = path.resolve(options.stateDir);
    this.root = path.join(this.stateDir, ".hooks");
    this.eventsDir = path.join(this.root, "events");
    this.deliveriesDir = path.join(this.root, "deliveries");
    this.configPath = options.configPath;
    this.config = options.config;
    this.configError = options.configError;
    this.env = { ...process.env, ...options.env };
    this.tickIntervalMs = options.tickIntervalMs ?? 2_000;
    this.now = options.now ?? (() => new Date());
    this.collectEvents = options.collectEvents ?? false;
    for (const hook of this.config?.hooks ?? []) {
      this.pendingDeliveries.set(hook.name, new Set());
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if ((!this.config || this.config.hooks.length === 0) && !this.collectEvents) return;
    const schedule = (): void => {
      if (this.inFlight) return;
      this.inFlight = this.tick()
        .catch((error) => {
          this.lastTickError = errorMessage(error);
          process.stderr.write(`jaeger hooks: ${this.lastTickError}\n`);
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
    await this.inFlight;
    this.started = false;
  }

  async tick(): Promise<void> {
    if ((!this.config || this.config.hooks.length === 0) && !this.collectEvents) return;
    await this.ensureState();
    if (!this.deliveriesReconciled) {
      await this.reconcileDeliveries();
      this.deliveriesReconciled = true;
    }
    await this.reconcileRuns();
    await this.reconcileSchedules();
    await this.deliverDue();
    this.lastTickAt = this.now().toISOString();
    this.lastTickError = undefined;
  }

  async status(): Promise<JsonValue> {
    const deliveries = await this.readDeliveries().catch((error: unknown) => {
      if (hasCode(error, "ENOENT")) return [];
      throw error;
    });
    const counts: Record<DeliveryStatus, number> = {
      pending: 0,
      running: 0,
      retrying: 0,
      delivered: 0,
    };
    for (const delivery of deliveries) counts[delivery.status]++;
    const latest = deliveries
      .slice()
      .sort((left, right) => deliveryTime(right).localeCompare(deliveryTime(left)))[0];
    return toJsonValue({
      schemaVersion: 1,
      enabled: Boolean(this.config && this.config.hooks.length > 0),
      dispatcherRunning: this.started && Boolean(this.config),
      configPath: this.configPath ?? null,
      configDigest: this.config?.digest ?? null,
      configError: this.configError ?? null,
      hooks: (this.config?.hooks ?? []).map((hook) => ({
        name: hook.name,
        events: [...hook.events],
        command: [...hook.command],
        timeoutMs: hook.timeoutMs,
      })),
      deliveries: {
        total: deliveries.length,
        ...counts,
      },
      lastTickAt: this.lastTickAt ?? null,
      lastTickError: this.lastTickError ?? null,
      latest: latest ?? null,
    });
  }

  async history(filter: HookHistoryFilter = {}): Promise<JsonValue> {
    const limit = filter.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 500) {
      throw new Error("Hook history limit must be between 1 and 500");
    }
    const deliveries = (await this.readDeliveries())
      .filter((delivery) => !filter.hook || delivery.hook === filter.hook)
      .filter((delivery) => !filter.eventId || delivery.eventId === filter.eventId)
      .sort((left, right) => deliveryTime(right).localeCompare(deliveryTime(left)))
      .slice(0, limit);
    return toJsonValue(deliveries);
  }

  private async ensureState(): Promise<void> {
    await ensurePrivateDirectory(this.root, "Jaeger hook state directory");
    await ensurePrivateDirectory(this.eventsDir, "Jaeger hook event directory");
    await ensurePrivateDirectory(this.deliveriesDir, "Jaeger hook delivery directory");
    for (const hook of this.config?.hooks ?? []) {
      await ensurePrivateDirectory(
        this.hookDeliveryDir(hook.name),
        `Jaeger hook ${hook.name} delivery directory`,
      );
    }
  }

  private async reconcileRuns(): Promise<void> {
    const entries = await readdir(this.stateDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !RUN_ID.test(entry.name)) continue;
      const now = this.now().getTime();
      if (
        this.runFingerprints.has(entry.name) &&
        !this.activeRuns.has(entry.name) &&
        now - (this.runFingerprintCheckedAt.get(entry.name) ?? 0) <
          TERMINAL_RUN_FINGERPRINT_MS
      ) {
        continue;
      }
      const fingerprint = await runFingerprint(path.join(this.stateDir, entry.name));
      this.runFingerprintCheckedAt.set(entry.name, now);
      if (this.runFingerprints.get(entry.name) === fingerprint) {
        if (!this.activeRuns.has(entry.name)) continue;
        const checkedAt = this.runCheckedAt.get(entry.name) ?? 0;
        if (now - checkedAt < ACTIVE_RUN_RECHECK_MS) continue;
      }
      try {
        const status = await this.reconcileRun(entry.name);
        this.runFingerprints.set(entry.name, fingerprint);
        this.runCheckedAt.set(entry.name, this.now().getTime());
        if (TERMINAL_STATUSES.has(status)) this.activeRuns.delete(entry.name);
        else this.activeRuns.add(entry.name);
      } catch (error) {
        process.stderr.write(`jaeger hooks run ${entry.name}: ${errorMessage(error)}\n`);
      }
    }
  }

  private async reconcileRun(runId: string): Promise<string> {
    const journal = await RunJournal.open(this.stateDir, runId);
    const [read, summary] = await Promise.all([
      journal.readEvents(),
      inspectRun(this.stateDir, runId),
    ]);
    const observedAt = this.now().toISOString();
    const run = safeRun(summary);
    await this.publishEvent({
      schemaVersion: 1,
      id: lifecycleEventId("run.accepted", runId, journal.record.createdAt),
      type: "run.accepted",
      occurredAt: journal.record.createdAt,
      observedAt,
      run,
    });
    for (const event of read.events) {
      if (event.type === "phase") {
        const stepId = stringField(event, "stepId");
        const name = stringField(event, "name");
        if (!stepId || !name) continue;
        await this.publishEvent({
          schemaVersion: 1,
          id: lifecycleEventId("phase.changed", runId, `${stepId}\0${event.at}`),
          type: "phase.changed",
          occurredAt: event.at,
          observedAt,
          run,
          subject: { stepId, name },
        });
      }
      if (event.type === "agent.completed") {
        const stepId = stringField(event, "stepId");
        if (!stepId) continue;
        await this.publishEvent({
          schemaVersion: 1,
          id: lifecycleEventId("agent.completed", runId, `${stepId}\0${event.at}`),
          type: "agent.completed",
          occurredAt: event.at,
          observedAt,
          run,
          subject: compactSubject(event, [
            "stepId",
            "sessionId",
            "nativeSessionId",
            "durationMs",
          ]),
        });
      }
      if (event.type === "agent.completed") {
        const stepId = stringField(event, "stepId");
        const sessionId = stringField(event, "sessionId");
        const nativeSessionId = stringField(event, "nativeSessionId");
        if (!stepId || !sessionId || !nativeSessionId) continue;
        await this.publishEvent({
          schemaVersion: 1,
          id: lifecycleEventId(
            "session.available",
            runId,
            `${sessionId}\0${nativeSessionId}`,
          ),
          type: "session.available",
          occurredAt: event.at,
          observedAt,
          run,
          subject: { stepId, sessionId, nativeSessionId },
        });
      }
      if (event.type === "workflow.interrupted") {
        await this.publishRunTerminal(runId, run, event.at, "interrupted", event.type);
      }
      if (event.type === "workflow.completed" || event.type === "workflow.failed") {
        const status =
          summary.finishedAt === event.at && TERMINAL_STATUSES.has(summary.status)
            ? summary.status
            : event.type === "workflow.completed"
              ? "completed"
              : "failed";
        await this.publishRunTerminal(runId, run, event.at, status, event.type);
      }
    }
    await this.reconcileSessions(journal.runDir, runId, run);
    await this.reconcileSessionQueries(journal.runDir, runId, run);
    if (
      (summary.status === "stopped" || summary.status === "uncertain") &&
      !read.events.some(
        (event) =>
          (event.type === "workflow.failed" && summary.finishedAt === event.at) ||
          (event.type === "workflow.interrupted" && summary.finishedAt === event.at),
      )
    ) {
      const stop = await journal.stopRequest();
      const occurredAt =
        summary.finishedAt ??
        stop?.requestedAt ??
        read.events.at(-1)?.at ??
        journal.record.createdAt;
      const source =
        summary.uncertainty?.stepId ??
        summary.uncertainty?.reason ??
        stop?.requestedAt ??
        occurredAt;
      await this.publishRunTerminal(
        runId,
        run,
        occurredAt,
        summary.status,
        `derived:${source}`,
      );
    }
    return summary.status;
  }

  private async reconcileSessions(
    runDir: string,
    runId: string,
    run: Record<string, JsonValue>,
  ): Promise<void> {
    const root = path.join(runDir, "sessions");
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const session = record(
        JSON.parse(await readFile(path.join(root, entry.name, "session.json"), "utf8")),
      );
      const sessionId = stringValue(session.id);
      if (
        typeof session.nativeSessionId !== "string" ||
        session.nativeSessionId.length === 0
      ) {
        continue;
      }
      const nativeSessionId = session.nativeSessionId;
      const occurredAt = requiredDate(session.updatedAt, "session updatedAt");
      await this.publishEvent({
        schemaVersion: 1,
        id: lifecycleEventId(
          "session.available",
          runId,
          `${sessionId}\0${nativeSessionId}`,
        ),
        type: "session.available",
        occurredAt,
        observedAt: this.now().toISOString(),
        run,
        subject: compactRecord(session, [
          "id",
          "stepId",
          "harness",
          "label",
          "model",
          "nativeSessionId",
          "status",
          "createdAt",
          "updatedAt",
        ]),
      });
    }
  }

  private async reconcileSessionQueries(
    runDir: string,
    runId: string,
    run: Record<string, JsonValue>,
  ): Promise<void> {
    const root = path.join(runDir, "session-queries");
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      let result: Record<string, unknown>;
      try {
        result = record(
          JSON.parse(await readFile(path.join(root, entry.name, "result.json"), "utf8")),
        );
      } catch (error) {
        if (hasCode(error, "ENOENT")) continue;
        throw error;
      }
      if (result.status !== "completed") continue;
      const queryId = stringValue(result.queryId);
      const finishedAt = requiredDate(result.finishedAt, "session query finishedAt");
      const request = record(
        JSON.parse(await readFile(path.join(root, entry.name, "request.json"), "utf8")),
      );
      await this.publishEvent({
        schemaVersion: 1,
        id: lifecycleEventId("session.query.completed", runId, queryId),
        type: "session.query.completed",
        occurredAt: finishedAt,
        observedAt: this.now().toISOString(),
        run,
        subject: {
          queryId,
          sessionId: stringValue(request.sessionId),
          nativeSessionId: stringValue(result.nativeSessionId),
          ...(typeof request.model === "string" ? { model: request.model } : {}),
        },
      });
    }
  }

  private async publishRunTerminal(
    runId: string,
    run: Record<string, JsonValue>,
    occurredAt: string,
    status: string,
    source: string,
  ): Promise<void> {
    await this.publishEvent({
      schemaVersion: 1,
      id: lifecycleEventId("run.terminal", runId, `${source}\0${status}\0${occurredAt}`),
      type: "run.terminal",
      occurredAt,
      observedAt: this.now().toISOString(),
      run,
      subject: { status },
    });
  }

  private async reconcileSchedules(): Promise<void> {
    const root = path.join(this.stateDir, ".schedules");
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !SCHEDULE_NAME.test(entry.name)) {
        continue;
      }
      try {
        const state = record(
          JSON.parse(await readFile(path.join(root, entry.name, "schedule.json"), "utf8")),
        );
        const updatedAt = requiredDate(state.updatedAt, "schedule updatedAt");
        const schedule = safeSchedule(state);
        await this.publishEvent({
          schemaVersion: 1,
          id: lifecycleEventId(
            "schedule.changed",
            entry.name,
            `${updatedAt}\0${stableJson(schedule)}`,
          ),
          type: "schedule.changed",
          occurredAt: updatedAt,
          observedAt: this.now().toISOString(),
          schedule,
        });
        await this.reconcileScheduleOccurrences(root, entry.name, schedule);
      } catch (error) {
        process.stderr.write(`jaeger hooks schedule ${entry.name}: ${errorMessage(error)}\n`);
      }
    }
  }

  private async reconcileScheduleOccurrences(
    root: string,
    scheduleId: string,
    schedule: Record<string, JsonValue>,
  ): Promise<void> {
    const directory = path.join(root, scheduleId, "occurrences");
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) continue;
      const occurrence = record(JSON.parse(await readFile(path.join(directory, entry.name), "utf8")));
      const id = stringValue(occurrence.id);
      const updatedAt = requiredDate(occurrence.updatedAt, "schedule occurrence updatedAt");
      const subject = compactRecord(occurrence, [
        "id",
        "revision",
        "kind",
        "scheduledFor",
        "status",
        "createdAt",
        "updatedAt",
        "admittedAt",
        "finishedAt",
        "runId",
        "reason",
      ]);
      await this.publishEvent({
        schemaVersion: 1,
        id: lifecycleEventId(
          "schedule.occurrence",
          scheduleId,
          `${id}\0${updatedAt}\0${stableJson(subject)}`,
        ),
        type: "schedule.occurrence",
        occurredAt: updatedAt,
        observedAt: this.now().toISOString(),
        schedule,
        subject,
      });
    }
  }

  private async publishEvent(event: LifecycleHookEvent): Promise<void> {
    if (this.knownEventIds.has(event.id)) return;
    await publishJsonExclusive(path.join(this.eventsDir, `${event.id}.json`), event);
    for (const hook of this.config?.hooks ?? []) {
      if (!hook.events.includes(event.type)) continue;
      await this.ensureDelivery(hook, event, false);
    }
    this.knownEventIds.add(event.id);
  }

  private async reconcileDeliveries(): Promise<void> {
    const entries = await readdir(this.eventsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !EVENT_FILE.test(entry.name)) continue;
      const event = parseLifecycleEvent(
        JSON.parse(await readFile(path.join(this.eventsDir, entry.name), "utf8")),
      );
      for (const hook of this.config?.hooks ?? []) {
        if (!hook.events.includes(event.type)) continue;
        await this.ensureDelivery(hook, event, true);
      }
      this.knownEventIds.add(event.id);
    }
  }

  private async ensureDelivery(
    hook: HookDefinition,
    event: LifecycleHookEvent,
    discoverExisting: boolean,
  ): Promise<void> {
    const delivery: HookDelivery = {
      version: 1,
      hook: hook.name,
      eventId: event.id,
      eventType: event.type,
      createdAt: this.now().toISOString(),
      status: "pending",
      attempts: 0,
      nextAttemptAt: this.now().toISOString(),
    };
    const created = await publishJsonExclusive(
      this.deliveryPath(hook.name, event.id),
      delivery,
    );
    if (created) {
      this.pendingDeliverySet(hook.name).add(event.id);
      return;
    }
    if (!discoverExisting) return;
    const existing = parseDelivery(
      JSON.parse(await readFile(this.deliveryPath(hook.name, event.id), "utf8")),
    );
    if (existing.status !== "delivered") {
      this.pendingDeliverySet(hook.name).add(event.id);
    }
  }

  private async deliverDue(): Promise<void> {
    for (const hook of this.config?.hooks ?? []) {
      const pending = this.pendingDeliverySet(hook.name);
      const deliveries: HookDelivery[] = [];
      for (const eventId of pending) {
        const delivery = parseDelivery(
          JSON.parse(await readFile(this.deliveryPath(hook.name, eventId), "utf8")),
        );
        if (delivery.status === "delivered") {
          pending.delete(eventId);
          continue;
        }
        deliveries.push(delivery);
      }
      deliveries.sort((left, right) =>
        left.createdAt === right.createdAt
          ? left.eventId.localeCompare(right.eventId)
          : left.createdAt.localeCompare(right.createdAt),
      );
      const delivery = deliveries[0];
      if (!delivery) continue;
      const now = this.now();
      if (Date.parse(delivery.nextAttemptAt) > now.getTime()) continue;
      const result = await this.deliver(hook, delivery, now);
      if (result.status === "delivered") pending.delete(result.eventId);
    }
  }

  private async deliver(
    hook: HookDefinition,
    delivery: HookDelivery,
    now: Date,
  ): Promise<HookDelivery> {
    const running: HookDelivery = {
      ...delivery,
      status: "running",
      attempts: delivery.attempts + 1,
      lastAttemptAt: now.toISOString(),
    };
    await writeJsonAtomic(this.deliveryPath(hook.name, delivery.eventId), running);
    const event = parseLifecycleEvent(
      JSON.parse(
        await readFile(path.join(this.eventsDir, `${delivery.eventId}.json`), "utf8"),
      ),
    );
    const result = await executeHook(hook, event, this.env);
    if (result.ok) {
      const {
        lastError: _lastError,
        signal: _signal,
        deliveredAt: _deliveredAt,
        exitCode: _exitCode,
        ...clean
      } = running;
      const delivered: HookDelivery = {
        ...clean,
        status: "delivered",
        deliveredAt: this.now().toISOString(),
        nextAttemptAt: this.now().toISOString(),
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        stdoutBytes: result.stdoutBytes,
        stderrBytes: result.stderrBytes,
      };
      await writeJsonAtomic(this.deliveryPath(hook.name, delivery.eventId), delivered);
      return delivered;
    }
    const retryDelay =
      RETRY_DELAYS_MS[Math.min(running.attempts - 1, RETRY_DELAYS_MS.length - 1)] ??
      RETRY_DELAYS_MS.at(-1) ??
      3_600_000;
    const retrying: HookDelivery = {
      ...running,
      status: "retrying",
      nextAttemptAt: new Date(this.now().getTime() + retryDelay).toISOString(),
      lastError: result.error,
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      ...(result.signal ? { signal: result.signal } : {}),
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
    };
    await writeJsonAtomic(this.deliveryPath(hook.name, delivery.eventId), retrying);
    return retrying;
  }

  private pendingDeliverySet(hook: string): Set<string> {
    const pending = this.pendingDeliveries.get(hook);
    if (!pending) throw new Error(`Unknown lifecycle hook ${hook}`);
    return pending;
  }

  private async readDeliveries(): Promise<HookDelivery[]> {
    let hooks;
    try {
      hooks = await readdir(this.deliveriesDir, { withFileTypes: true });
    } catch (error) {
      if (hasCode(error, "ENOENT")) return [];
      throw error;
    }
    const deliveries: HookDelivery[] = [];
    for (const hook of hooks) {
      if (!hook.isDirectory() || hook.isSymbolicLink()) continue;
      deliveries.push(...(await this.readHookDeliveries(hook.name)));
    }
    return deliveries;
  }

  private async readHookDeliveries(hook: string): Promise<HookDelivery[]> {
    const directory = this.hookDeliveryDir(hook);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (hasCode(error, "ENOENT")) return [];
      throw error;
    }
    const deliveries: HookDelivery[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !EVENT_FILE.test(entry.name)) continue;
      deliveries.push(
        parseDelivery(JSON.parse(await readFile(path.join(directory, entry.name), "utf8"))),
      );
    }
    return deliveries;
  }

  private hookDeliveryDir(hook: string): string {
    return path.join(this.deliveriesDir, hook);
  }

  private deliveryPath(hook: string, eventId: string): string {
    return path.join(this.hookDeliveryDir(hook), `${eventId}.json`);
  }
}

interface HookExecutionResult {
  readonly ok: boolean;
  readonly error: string;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

async function executeHook(
  hook: HookDefinition,
  event: LifecycleHookEvent,
  env: NodeJS.ProcessEnv,
): Promise<HookExecutionResult> {
  const command = hook.command[0] as string;
  const args = hook.command.slice(1);
  return await new Promise<HookExecutionResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let outputExceeded = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let child: ChildProcess;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (result: HookExecutionResult): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };
    const kill = (): void => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    try {
      child = spawn(command, args, {
        shell: false,
        detached: true,
        cwd: "/",
        env: {
          ...env,
          JAEGER_HOOK_NAME: hook.name,
          JAEGER_EVENT_ID: event.id,
          JAEGER_EVENT_TYPE: event.type,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        ok: false,
        error: `could not start hook command: ${errorMessage(error)}`,
        stdoutBytes,
        stderrBytes,
      });
      return;
    }
    timeout = setTimeout(() => {
      timedOut = true;
      kill();
    }, hook.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > MAX_HOOK_OUTPUT_BYTES) {
        outputExceeded = true;
        kill();
      }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > MAX_HOOK_OUTPUT_BYTES) {
        outputExceeded = true;
        kill();
      }
    });
    child.once("error", (error) => {
      finish({
        ok: false,
        error: `hook command failed to start: ${errorMessage(error)}`,
        stdoutBytes,
        stderrBytes,
      });
    });
    child.once("close", (code, signal) => {
      const ok = code === 0 && !timedOut && !outputExceeded;
      finish({
        ok,
        error: timedOut
          ? `hook timed out after ${hook.timeoutMs}ms`
          : outputExceeded
            ? `hook output exceeded ${MAX_HOOK_OUTPUT_BYTES} bytes`
            : code === 0
              ? ""
              : `hook exited with code ${String(code)}${signal ? ` (${signal})` : ""}`,
        ...(code !== null ? { exitCode: code } : {}),
        ...(signal ? { signal } : {}),
        stdoutBytes,
        stderrBytes,
      });
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(`${JSON.stringify(event)}\n`);
  });
}

function safeRun(summary: WorkflowRunSummary): Record<string, JsonValue> {
  return compactRecord(summary as unknown as Record<string, unknown>, [
    "runId",
    "submissionId",
    "status",
    "scriptPath",
    "cwd",
    "createdAt",
    "startedAt",
    "finishedAt",
    "currentPhase",
    "agents",
    "sessions",
    "trigger",
    "inspect",
    "wait",
    "stop",
    "resume",
  ]);
}

function safeSchedule(state: Record<string, unknown>): Record<string, JsonValue> {
  return compactRecord(state, [
    "id",
    "activeRevision",
    "latestRevision",
    "enabled",
    "createdAt",
    "updatedAt",
    "healthSince",
    "lastEvaluatedMinute",
    "pausedReason",
    "removedAt",
  ]);
}

function compactSubject(
  event: JournalEvent,
  keys: readonly string[],
): Record<string, JsonValue> {
  return compactRecord(event as unknown as Record<string, unknown>, keys);
}

function compactRecord(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const key of keys) {
    const field = value[key];
    if (isJsonValue(field)) result[key] = field;
  }
  return result;
}

function lifecycleEventId(type: HookEventType, scope: string, source: string): string {
  return `evt-${createHash("sha256").update(`${type}\0${scope}\0${source}`).digest("hex")}`;
}

export function parseLifecycleEvent(value: unknown): LifecycleHookEvent {
  const candidate = record(value);
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.id !== "string" ||
    !/^evt-[a-f0-9]{64}$/.test(candidate.id) ||
    typeof candidate.type !== "string" ||
    typeof candidate.occurredAt !== "string" ||
    typeof candidate.observedAt !== "string"
  ) {
    throw new Error("Invalid Jaeger lifecycle hook event");
  }
  return candidate as unknown as LifecycleHookEvent;
}

function parseDelivery(value: unknown): HookDelivery {
  const candidate = record(value);
  if (
    candidate.version !== 1 ||
    typeof candidate.hook !== "string" ||
    typeof candidate.eventId !== "string" ||
    typeof candidate.eventType !== "string" ||
    typeof candidate.createdAt !== "string" ||
    !["pending", "running", "retrying", "delivered"].includes(String(candidate.status)) ||
    !Number.isSafeInteger(candidate.attempts) ||
    typeof candidate.nextAttemptAt !== "string"
  ) {
    throw new Error("Invalid Jaeger hook delivery state");
  }
  return candidate as unknown as HookDelivery;
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
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

function deliveryTime(delivery: HookDelivery): string {
  return delivery.deliveredAt ?? delivery.lastAttemptAt ?? delivery.createdAt;
}

async function runFingerprint(runDir: string): Promise<string> {
  const parts: string[] = [];
  for (const name of ["run.json", "events.jsonl", "stop.json"]) {
    try {
      const stats = await lstat(path.join(runDir, name));
      parts.push(
        `${name}:${stats.isFile() && !stats.isSymbolicLink() ? "file" : "unsafe"}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`,
      );
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      parts.push(`${name}:missing`);
    }
  }
  for (const [directory, file] of [
    ["sessions", "session.json"],
    ["session-queries", "result.json"],
  ] as const) {
    const root = path.join(runDir, directory);
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      parts.push(`${directory}:missing`);
      continue;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const target = path.join(root, entry.name, file);
      try {
        const stats = await lstat(target);
        parts.push(
          `${directory}/${entry.name}/${file}:${
            stats.isFile() && !stats.isSymbolicLink() ? "file" : "unsafe"
          }:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`,
        );
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
        parts.push(`${directory}/${entry.name}/${file}:missing`);
      }
    }
  }
  return parts.join("|");
}

function requiredDate(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("Expected string");
  return value;
}

function stringField(event: JournalEvent, key: string): string | undefined {
  const value = event[key];
  return typeof value === "string" ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected JSON object");
  }
  return value as Record<string, unknown>;
}

function toJsonValue(value: unknown): JsonValue {
  if (!isJsonValue(value)) throw new Error("Hook state is not JSON");
  return value;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every(isJsonValue)
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
