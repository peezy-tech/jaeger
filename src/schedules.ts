import { createHash, randomUUID } from "node:crypto";
import { open, readFile, readdir, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { compileWorkflowSource } from "./compiler.js";
import { syncDirectory } from "./durable-json.js";
import { validateHarnessDefinitions } from "./harnesses/registry.js";
import { ensurePrivateDirectory as ensureTrustedPrivateDirectory } from "./paths.js";
import type { LocalWorkspaceDescriptor } from "./admission.js";
import type {
  HarnessDefinition,
  JsonValue,
  ScheduleTriggerMetadata,
  WorkflowRunStatus,
} from "./types.js";

const SCHEDULE_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const MAX_SCAN_MINUTES = 7 * 24 * 60;
const TERMINAL_RUN_STATUSES = new Set<WorkflowRunStatus>([
  "completed",
  "failed",
  "interrupted",
  "stopped",
  "uncertain",
]);

export type ScheduleMisfirePolicy = "skip" | "latest" | "catch-up";
export type ScheduleOverlapPolicy = "forbid";

export interface CronTrigger {
  readonly type: "cron";
  readonly expression: string;
  readonly timezone: string;
}

export interface SchedulePolicy {
  readonly overlap: ScheduleOverlapPolicy;
  readonly misfire: ScheduleMisfirePolicy;
  readonly maxCatchUp: number;
  readonly pauseOnUncertain: boolean;
  readonly pauseAfterFailures: number;
}

export interface ScheduleApplication {
  readonly version: 1;
  readonly name: string;
  readonly manifestPath: string;
  readonly workflowPath: string;
  readonly workflowSource: string;
  readonly cwd: string;
  readonly inputs: JsonValue;
  readonly maxConcurrency: number;
  readonly trigger: CronTrigger;
  readonly policy: SchedulePolicy;
  readonly sourcePathsPinned?: boolean;
}

export interface ScheduleRevision {
  readonly version: 1;
  readonly scheduleId: string;
  readonly revision: number;
  readonly revisionHash: string;
  readonly manifestPath: string;
  readonly workflowPath: string;
  readonly workflowHash: string;
  readonly workflowSource: string;
  readonly cwd: string;
  readonly workspace: LocalWorkspaceDescriptor;
  readonly inputs: JsonValue;
  readonly maxConcurrency: number;
  readonly harnesses: readonly HarnessDefinition[];
  readonly trigger: CronTrigger;
  readonly policy: SchedulePolicy;
  readonly createdAt: string;
}

export interface ScheduleState {
  readonly version: 1;
  readonly id: string;
  readonly activeRevision: number;
  readonly latestRevision: number;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly healthSince?: string;
  readonly lastEvaluatedMinute?: string;
  readonly pausedReason?: string;
  readonly removedAt?: string;
}

export type ScheduleOccurrenceStatus =
  | "pending"
  | "admitted"
  | "skipped"
  | "completed"
  | "failed"
  | "interrupted"
  | "stopped"
  | "uncertain";

export interface ScheduleOccurrence {
  readonly version: 1;
  readonly id: string;
  readonly scheduleId: string;
  readonly revision: number;
  readonly kind: "cron" | "manual";
  readonly scheduledFor: string;
  readonly requestId?: string;
  readonly submissionId: string;
  readonly status: ScheduleOccurrenceStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly admittedAt?: string;
  readonly finishedAt?: string;
  readonly runId?: string;
  readonly reason?: string;
  readonly lastError?: string;
}

export interface ScheduleLaunchRequest {
  readonly submissionId: string;
  readonly workflowPath: string;
  readonly workflowSource: string;
  readonly cwd: string;
  readonly inputs: JsonValue;
  readonly maxConcurrency: number;
  readonly harnessDefinitions: readonly HarnessDefinition[];
  readonly workspace: LocalWorkspaceDescriptor;
  readonly trigger: ScheduleTriggerMetadata;
}

export interface ScheduleStoreOptions {
  readonly stateDir: string;
  readonly submit: (request: ScheduleLaunchRequest) => Promise<JsonValue>;
  readonly inspectRun: (runId: string) => Promise<{ readonly status: WorkflowRunStatus }>;
  readonly now?: () => Date;
}

export class ScheduleStore {
  private readonly root: string;
  private readonly submitRun: ScheduleStoreOptions["submit"];
  private readonly inspectRun: ScheduleStoreOptions["inspectRun"];
  private readonly now: () => Date;
  private serial: Promise<void> = Promise.resolve();

  constructor(options: ScheduleStoreOptions) {
    this.root = path.join(path.resolve(options.stateDir), ".schedules");
    this.submitRun = options.submit;
    this.inspectRun = options.inspectRun;
    this.now = options.now ?? (() => new Date());
  }

  async apply(
    application: ScheduleApplication,
    harnesses: readonly HarnessDefinition[],
    workspace: LocalWorkspaceDescriptor,
    activate = false,
  ): Promise<JsonValue> {
    return await this.exclusive(async () => {
      await this.ensureRoot();
      const scheduleDir = this.scheduleDir(application.name);
      await ensurePrivateDirectory(scheduleDir);
      await ensurePrivateDirectory(path.join(scheduleDir, "revisions"));
      await ensurePrivateDirectory(path.join(scheduleDir, "occurrences"));
      const existing = await this.readState(application.name);
      const revisionContent = {
        version: 1 as const,
        scheduleId: application.name,
        manifestPath: application.manifestPath,
        workflowPath: application.workflowPath,
        workflowHash: sha256(application.workflowSource),
        workflowSource: application.workflowSource,
        cwd: application.cwd,
        workspace,
        inputs: application.inputs,
        maxConcurrency: application.maxConcurrency,
        harnesses: [...harnesses],
        trigger: application.trigger,
        policy: application.policy,
      };
      const revisionHash = sha256(stableJson(toJsonValue(revisionContent)));
      if (existing && !existing.removedAt) {
        const latest = await this.readRevision(application.name, existing.latestRevision);
        if (latest.revisionHash === revisionHash) {
          if (activate && !existing.enabled) {
            const { pausedReason: _pausedReason, ...unpaused } = existing;
            const enabled = await this.writeState({
              ...unpaused,
              enabled: true,
              lastEvaluatedMinute: minuteIso(this.now()),
              healthSince: this.now().toISOString(),
              updatedAt: this.now().toISOString(),
            });
            return this.publicSchedule(enabled, latest, true);
          }
          return this.publicSchedule(existing, latest, false);
        }
      }
      const createdAt = this.now().toISOString();
      const revisionNumber = (existing?.latestRevision ?? 0) + 1;
      const revision: ScheduleRevision = {
        ...revisionContent,
        revision: revisionNumber,
        revisionHash,
        createdAt,
      };
      await writeJsonExclusive(this.revisionPath(application.name, revisionNumber), revision);
      const state = await this.writeState({
        version: 1,
        id: application.name,
        activeRevision: revisionNumber,
        latestRevision: revisionNumber,
        enabled: activate,
        createdAt: existing?.createdAt ?? createdAt,
        updatedAt: createdAt,
        ...(activate ? { lastEvaluatedMinute: minuteIso(this.now()) } : {}),
        ...(activate ? { healthSince: createdAt } : {}),
      });
      return this.publicSchedule(state, revision, true);
    });
  }

  async list(): Promise<JsonValue> {
    return await this.exclusive(async () => {
      for (const state of await this.readStates()) {
        if (!state.removedAt) await this.reconcile(state);
      }
      const states = await this.readStates();
      const views = await Promise.all(
        states
          .filter((state) => !state.removedAt)
          .map(async (state) =>
            this.publicSchedule(
              state,
              await this.readRevision(state.id, state.activeRevision),
              false,
            ),
          ),
      );
      return toJsonValue(views);
    });
  }

  async inspect(name: string): Promise<JsonValue> {
    return await this.exclusive(async () => {
      const state = await this.requireState(name);
      await this.reconcile(state);
      const current = await this.requireState(name);
      return this.publicSchedule(
        current,
        await this.readRevision(name, current.activeRevision),
        false,
      );
    });
  }

  async enable(name: string): Promise<JsonValue> {
    return await this.exclusive(async () => {
      const state = await this.requireUsableState(name);
      const { pausedReason: _pausedReason, ...unpaused } = state;
      const next = await this.writeState({
        ...unpaused,
        enabled: true,
        lastEvaluatedMinute: minuteIso(this.now()),
        healthSince: this.now().toISOString(),
        updatedAt: this.now().toISOString(),
      });
      return this.publicSchedule(
        next,
        await this.readRevision(name, next.activeRevision),
        false,
      );
    });
  }

  async disable(name: string): Promise<JsonValue> {
    return await this.exclusive(async () => {
      const state = await this.requireUsableState(name);
      const { pausedReason: _pausedReason, ...unpaused } = state;
      const next = await this.writeState({
        ...unpaused,
        enabled: false,
        updatedAt: this.now().toISOString(),
      });
      return this.publicSchedule(
        next,
        await this.readRevision(name, next.activeRevision),
        false,
      );
    });
  }

  async remove(name: string): Promise<JsonValue> {
    return await this.exclusive(async () => {
      const state = await this.requireUsableState(name);
      if (state.enabled) throw new Error(`Disable schedule ${name} before removing it`);
      const removedAt = this.now().toISOString();
      const next = await this.writeState({
        ...state,
        updatedAt: removedAt,
        removedAt,
      });
      return this.publicSchedule(
        next,
        await this.readRevision(name, next.activeRevision),
        false,
      );
    });
  }

  async history(name: string, limit = 50): Promise<JsonValue> {
    return await this.exclusive(async () => {
      await this.requireState(name);
      await this.reconcile(await this.requireState(name));
      const occurrences = await this.readOccurrences(name);
      return toJsonValue(
        occurrences
          .slice(-limit)
          .reverse()
          .map((occurrence) => this.publicOccurrence(occurrence)),
      );
    });
  }

  async trigger(name: string, requestId: string): Promise<JsonValue> {
    if (!REQUEST_ID.test(requestId)) throw new Error("Schedule trigger request id is invalid");
    return await this.exclusive(async () => {
      const occurrenceId = `manual-${sha256(requestId).slice(0, 24)}`;
      await this.requireState(name);
      const existing = await readJsonOptional<ScheduleOccurrence>(
        this.occurrencePath(name, occurrenceId),
      );
      if (existing) {
        validateScheduleOccurrence(existing, name);
        if (existing.requestId !== requestId) {
          throw new Error(`Schedule occurrence identity conflict for ${name}/${occurrenceId}`);
        }
        return this.publicOccurrence(
          existing.status === "pending"
            ? await this.launch(
                existing,
                await this.readRevision(name, existing.revision),
              )
            : existing,
        );
      }
      const state = await this.requireUsableState(name);
      await this.reconcile(state);
      const current = await this.requireUsableState(name);
      const revision = await this.readRevision(name, current.activeRevision);
      const occurrence = await this.admit(
        current,
        revision,
        "manual",
        this.now(),
        occurrenceId,
        requestId,
      );
      return this.publicOccurrence(occurrence);
    });
  }

  async tick(): Promise<void> {
    await this.exclusive(async () => {
      const states = await this.readStates();
      for (const initial of states.filter((state) => !state.removedAt)) {
        try {
          await this.recoverPending(initial);
          await this.reconcile(await this.requireState(initial.id));
          const state = await this.requireState(initial.id);
          if (!state.enabled || state.removedAt) continue;
          await this.evaluate(state);
        } catch (error) {
          process.stderr.write(
            `jaeger schedule ${initial.id}: ${errorMessage(error)}\n`,
          );
        }
      }
    });
  }

  private async evaluate(state: ScheduleState): Promise<void> {
    const now = floorMinute(this.now());
    const revision = await this.readRevision(state.id, state.activeRevision);
    const matchesCron = cronMatcher(
      revision.trigger.expression,
      revision.trigger.timezone,
    );
    const start = state.lastEvaluatedMinute
      ? new Date(state.lastEvaluatedMinute).getTime() + 60_000
      : now.getTime();
    const boundedStart = Math.max(start, now.getTime() - MAX_SCAN_MINUTES * 60_000);
    const matches: Date[] = [];
    for (let cursor = boundedStart; cursor <= now.getTime(); cursor += 60_000) {
      const candidate = new Date(cursor);
      if (matchesCron(candidate)) {
        matches.push(candidate);
      }
    }
    let selected: Date[] = [];
    if (revision.policy.misfire === "skip") {
      selected = matches.filter((candidate) => candidate.getTime() === now.getTime());
    } else if (revision.policy.misfire === "latest") {
      selected = matches.length > 0 ? [matches[matches.length - 1] as Date] : [];
    } else {
      selected = matches.slice(-revision.policy.maxCatchUp);
    }
    for (const candidate of selected) {
      await this.admit(
        state,
        revision,
        "cron",
        candidate,
        `cron-${candidate.toISOString().slice(0, 16).replace(/[-:T]/g, "")}z`,
      );
    }
    const current = await this.requireState(state.id);
    await this.writeState({
      ...current,
      lastEvaluatedMinute: now.toISOString(),
      updatedAt: this.now().toISOString(),
    });
  }

  private async admit(
    state: ScheduleState,
    revision: ScheduleRevision,
    kind: "cron" | "manual",
    scheduledFor: Date,
    id: string,
    requestId?: string,
  ): Promise<ScheduleOccurrence> {
    const occurrencePath = this.occurrencePath(state.id, id);
    const existing = await readJsonOptional<ScheduleOccurrence>(occurrencePath);
    if (existing) {
      if (
        existing.scheduleId !== state.id ||
        existing.revision !== revision.revision ||
        existing.requestId !== requestId
      ) {
        throw new Error(`Schedule occurrence identity conflict for ${state.id}/${id}`);
      }
      if (existing.status === "pending") return await this.launch(existing, revision);
      return existing;
    }
    const active = await this.activeOccurrence(state.id);
    const now = this.now().toISOString();
    const submissionId = `schedule:${sha256(
      `${state.id}\0${revision.revision}\0${id}`,
    ).slice(0, 48)}`;
    if (active) {
      if (kind === "manual") {
        throw new Error(
          `Schedule ${state.id} forbids overlap; run ${active.runId ?? active.id} is still active`,
        );
      }
      const skipped: ScheduleOccurrence = {
        version: 1,
        id,
        scheduleId: state.id,
        revision: revision.revision,
        kind,
        scheduledFor: scheduledFor.toISOString(),
        submissionId,
        status: "skipped",
        createdAt: now,
        updatedAt: now,
        reason: `overlap forbidden by active occurrence ${active.id}`,
      };
      await writeJsonExclusive(occurrencePath, skipped);
      return skipped;
    }
    const occurrence: ScheduleOccurrence = {
      version: 1,
      id,
      scheduleId: state.id,
      revision: revision.revision,
      kind,
      scheduledFor: scheduledFor.toISOString(),
      ...(requestId ? { requestId } : {}),
      submissionId,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    await writeJsonExclusive(occurrencePath, occurrence);
    return await this.launch(occurrence, revision);
  }

  private async launch(
    occurrence: ScheduleOccurrence,
    revision: ScheduleRevision,
  ): Promise<ScheduleOccurrence> {
    const admittedAt = this.now().toISOString();
    let admitted: JsonValue;
    try {
      admitted = await this.submitRun({
        submissionId: occurrence.submissionId,
        workflowPath: revision.workflowPath,
        workflowSource: revision.workflowSource,
        cwd: revision.cwd,
        inputs: revision.inputs,
        maxConcurrency: revision.maxConcurrency,
        harnessDefinitions: revision.harnesses,
        workspace: revision.workspace,
        trigger: {
          type: "schedule",
          scheduleId: revision.scheduleId,
          revision: revision.revision,
          occurrenceId: occurrence.id,
          kind: occurrence.kind,
          scheduledFor: occurrence.scheduledFor,
          admittedAt,
        },
      });
    } catch (error) {
      await writeJsonAtomic(this.occurrencePath(occurrence.scheduleId, occurrence.id), {
        ...occurrence,
        updatedAt: this.now().toISOString(),
        lastError: errorMessage(error),
      });
      throw error;
    }
    const runId = runIdFrom(admitted);
    const { lastError: _lastError, ...recovered } = occurrence;
    const next: ScheduleOccurrence = {
      ...recovered,
      status: "admitted",
      runId,
      admittedAt,
      updatedAt: admittedAt,
    };
    await writeJsonAtomic(this.occurrencePath(occurrence.scheduleId, occurrence.id), next);
    return next;
  }

  private async recoverPending(state: ScheduleState): Promise<void> {
    for (const occurrence of await this.readOccurrences(state.id)) {
      if (occurrence.status !== "pending") continue;
      await this.launch(
        occurrence,
        await this.readRevision(state.id, occurrence.revision),
      );
    }
  }

  private async reconcile(state: ScheduleState): Promise<void> {
    const occurrences = await this.readOccurrences(state.id);
    let changed = false;
    for (const occurrence of occurrences) {
      if (occurrence.status !== "admitted" || !occurrence.runId) continue;
      const run = await this.inspectRun(occurrence.runId);
      if (!TERMINAL_RUN_STATUSES.has(run.status)) continue;
      const now = this.now().toISOString();
      const next: ScheduleOccurrence = {
        ...occurrence,
        status: run.status as ScheduleOccurrenceStatus,
        finishedAt: now,
        updatedAt: now,
      };
      await writeJsonAtomic(this.occurrencePath(state.id, occurrence.id), next);
      changed = true;
    }
    if (!changed && occurrences.length === 0) return;
    const current = await this.requireState(state.id);
    const terminal = (await this.readOccurrences(state.id)).filter(
      (occurrence) =>
        ["completed", "failed", "interrupted", "stopped", "uncertain"].includes(
          occurrence.status,
        ) &&
        (!current.healthSince ||
          (occurrence.admittedAt ?? occurrence.createdAt) >= current.healthSince),
    );
    const uncertain = terminal.findLast((occurrence) => occurrence.status === "uncertain");
    const interrupted = terminal.findLast((occurrence) => occurrence.status === "interrupted");
    let consecutiveFailures = 0;
    for (let index = terminal.length - 1; index >= 0; index--) {
      const status = terminal[index]?.status;
      if (status === "completed") break;
      if (status === "failed" || status === "stopped") consecutiveFailures++;
    }
    const revision = await this.readRevision(state.id, current.activeRevision);
    let pausedReason = current.pausedReason;
    if (uncertain && revision.policy.pauseOnUncertain) {
      pausedReason = `occurrence ${uncertain.id} is uncertain`;
    } else if (interrupted) {
      pausedReason = `occurrence ${interrupted.id} is interrupted and requires operator action`;
    } else if (consecutiveFailures >= revision.policy.pauseAfterFailures) {
      pausedReason = `${consecutiveFailures} consecutive scheduled runs failed`;
    }
    if (pausedReason && (current.enabled || current.pausedReason !== pausedReason)) {
      await this.writeState({
        ...current,
        enabled: false,
        pausedReason,
        updatedAt: this.now().toISOString(),
      });
    }
  }

  private async activeOccurrence(name: string): Promise<ScheduleOccurrence | undefined> {
    for (const occurrence of (await this.readOccurrences(name)).reverse()) {
      if (occurrence.status === "pending") return occurrence;
      if (occurrence.status !== "admitted" || !occurrence.runId) continue;
      const run = await this.inspectRun(occurrence.runId);
      if (!TERMINAL_RUN_STATUSES.has(run.status)) return occurrence;
    }
    return undefined;
  }

  private publicSchedule(
    state: ScheduleState,
    revision: ScheduleRevision,
    changed: boolean,
  ): JsonValue {
    return toJsonValue({
      schemaVersion: 1,
      id: state.id,
      enabled: state.enabled,
      changed,
      activeRevision: state.activeRevision,
      latestRevision: state.latestRevision,
      revisionHash: revision.revisionHash,
      manifestPath: revision.manifestPath,
      workflowPath: revision.workflowPath,
      workflowHash: revision.workflowHash,
      cwd: revision.cwd,
      trigger: revision.trigger,
      policy: revision.policy,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      ...(state.lastEvaluatedMinute
        ? { lastEvaluatedMinute: state.lastEvaluatedMinute }
        : {}),
      ...(state.healthSince ? { healthSince: state.healthSince } : {}),
      ...(state.pausedReason ? { pausedReason: state.pausedReason } : {}),
      ...(state.removedAt ? { removedAt: state.removedAt } : {}),
    });
  }

  private publicOccurrence(occurrence: ScheduleOccurrence): JsonValue {
    if (!occurrence.runId) return toJsonValue(occurrence);
    return toJsonValue({
      ...occurrence,
      inspect: `jaeger inspect ${occurrence.runId} --summary --json`,
      ...(["pending", "admitted"].includes(occurrence.status)
        ? {
            wait: `jaeger wait ${occurrence.runId}`,
            stop: `jaeger stop ${occurrence.runId}`,
          }
        : {}),
    });
  }

  private async readStates(): Promise<ScheduleState[]> {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (hasCode(error, "ENOENT")) return [];
      throw error;
    }
    const states: ScheduleState[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !SCHEDULE_NAME.test(entry.name)) {
        continue;
      }
      const state = await this.readState(entry.name);
      if (state) states.push(state);
    }
    return states.sort((left, right) => left.id.localeCompare(right.id));
  }

  private async readState(name: string): Promise<ScheduleState | undefined> {
    validateScheduleName(name);
    const state = await readJsonOptional<ScheduleState>(this.statePath(name));
    if (state) validateScheduleState(state, name);
    return state;
  }

  private async requireState(name: string): Promise<ScheduleState> {
    const state = await this.readState(name);
    if (!state) throw new Error(`Unknown Jaeger schedule ${name}`);
    return state;
  }

  private async requireUsableState(name: string): Promise<ScheduleState> {
    const state = await this.requireState(name);
    if (state.removedAt) throw new Error(`Jaeger schedule ${name} was removed`);
    return state;
  }

  private async writeState(state: ScheduleState): Promise<ScheduleState> {
    await writeJsonAtomic(this.statePath(state.id), state);
    return state;
  }

  private async readRevision(name: string, revision: number): Promise<ScheduleRevision> {
    const value = await readJsonOptional<ScheduleRevision>(this.revisionPath(name, revision));
    if (!value) throw new Error(`Schedule ${name} revision ${revision} is missing`);
    validateScheduleRevision(value, name, revision);
    return value;
  }

  private async readOccurrences(name: string): Promise<ScheduleOccurrence[]> {
    const directory = path.join(this.scheduleDir(name), "occurrences");
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (hasCode(error, "ENOENT")) return [];
      throw error;
    }
    const occurrences: ScheduleOccurrence[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) continue;
      const occurrence = await readJsonOptional<ScheduleOccurrence>(
        path.join(directory, entry.name),
      );
      if (occurrence) {
        validateScheduleOccurrence(occurrence, name);
        occurrences.push(occurrence);
      }
    }
    return occurrences.sort((left, right) =>
      left.scheduledFor === right.scheduledFor
        ? left.id.localeCompare(right.id)
        : left.scheduledFor.localeCompare(right.scheduledFor),
    );
  }

  private scheduleDir(name: string): string {
    validateScheduleName(name);
    return path.join(this.root, name);
  }

  private statePath(name: string): string {
    return path.join(this.scheduleDir(name), "schedule.json");
  }

  private revisionPath(name: string, revision: number): string {
    return path.join(
      this.scheduleDir(name),
      "revisions",
      `${String(revision).padStart(8, "0")}.json`,
    );
  }

  private occurrencePath(name: string, id: string): string {
    if (!/^[a-z0-9-]{8,80}$/.test(id)) throw new Error("Invalid schedule occurrence id");
    return path.join(this.scheduleDir(name), "occurrences", `${id}.json`);
  }

  private async ensureRoot(): Promise<void> {
    await ensurePrivateDirectory(this.root);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.serial;
    let release!: () => void;
    this.serial = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export async function loadScheduleApplication(
  manifestFile: string,
  options: { readonly remoteWorkspace?: boolean } = {},
): Promise<ScheduleApplication> {
  const manifestPath = await realpath(path.resolve(manifestFile));
  let raw: unknown;
  try {
    raw = parseToml(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid Jaeger schedule manifest ${manifestPath}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  const manifest = record(raw, "schedule manifest");
  assertKeys(
    manifest,
    ["version", "name", "workflow", "cwd", "input", "max_concurrency", "trigger", "policy"],
    "schedule manifest",
  );
  if (manifest.version !== 1) throw new Error("Schedule manifest version must be 1");
  const name = stringValue(manifest.name, "name");
  validateScheduleName(name);
  const base = path.dirname(manifestPath);
  const workflowPath = await realpath(path.resolve(base, stringValue(manifest.workflow, "workflow")));
  const workflowSource = await readFile(workflowPath, "utf8");
  compileWorkflowSource(workflowSource, workflowPath);
  const requestedCwd =
    manifest.cwd === undefined ? "." : stringValue(manifest.cwd, "cwd");
  const cwd = options.remoteWorkspace
    ? remoteWorkspacePath(requestedCwd)
    : await realpath(path.resolve(base, requestedCwd));
  const inputs =
    manifest.input === undefined
      ? {}
      : await readJsonValue(
          await realpath(path.resolve(base, stringValue(manifest.input, "input"))),
        );
  const maxConcurrency =
    manifest.max_concurrency === undefined
      ? 4
      : positiveInteger(manifest.max_concurrency, "max_concurrency");
  if (maxConcurrency > 64) throw new Error("max_concurrency must not exceed 64");
  const triggerValue = record(manifest.trigger, "trigger");
  assertKeys(triggerValue, ["type", "expression", "timezone"], "trigger");
  if (triggerValue.type !== "cron") throw new Error("Schedule trigger type must be cron");
  const trigger: CronTrigger = {
    type: "cron",
    expression: stringValue(triggerValue.expression, "trigger.expression"),
    timezone: stringValue(triggerValue.timezone, "trigger.timezone"),
  };
  validateCronExpression(trigger.expression);
  validateTimezone(trigger.timezone);
  const policyValue =
    manifest.policy === undefined ? {} : record(manifest.policy, "policy");
  assertKeys(
    policyValue,
    [
      "overlap",
      "misfire",
      "max_catch_up",
      "pause_on_uncertain",
      "pause_after_failures",
    ],
    "policy",
  );
  const overlap = policyValue.overlap ?? "forbid";
  if (overlap !== "forbid") throw new Error("Schedule overlap policy must be forbid");
  const misfire = policyValue.misfire ?? "skip";
  if (!["skip", "latest", "catch-up"].includes(String(misfire))) {
    throw new Error("Schedule misfire policy must be skip, latest, or catch-up");
  }
  const policy: SchedulePolicy = {
    overlap,
    misfire: misfire as ScheduleMisfirePolicy,
    maxCatchUp:
      policyValue.max_catch_up === undefined
        ? 1
        : positiveInteger(policyValue.max_catch_up, "policy.max_catch_up"),
    pauseOnUncertain:
      policyValue.pause_on_uncertain === undefined
        ? true
        : booleanValue(policyValue.pause_on_uncertain, "policy.pause_on_uncertain"),
    pauseAfterFailures:
      policyValue.pause_after_failures === undefined
        ? 3
        : positiveInteger(
            policyValue.pause_after_failures,
            "policy.pause_after_failures",
          ),
  };
  if (!policy.pauseOnUncertain) {
    throw new Error("policy.pause_on_uncertain must be true; uncertainty is fail-closed");
  }
  if (policy.maxCatchUp > 24) throw new Error("policy.max_catch_up must not exceed 24");
  return {
    version: 1,
    name,
    manifestPath,
    workflowPath,
    workflowSource,
    cwd,
    inputs,
    maxConcurrency,
    trigger,
    policy,
    ...(options.remoteWorkspace ? { sourcePathsPinned: true } : {}),
  };
}

function remoteWorkspacePath(value: string): string {
  if (!path.posix.isAbsolute(value)) {
    throw new Error(
      "Remote schedule cwd must be an absolute path on the target runtime",
    );
  }
  return path.posix.normalize(value);
}

export function validateCronExpression(expression: string): void {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error("Cron expression must contain exactly five fields");
  }
  parseCronField(fields[0] as string, 0, 59, "minute");
  parseCronField(fields[1] as string, 0, 23, "hour");
  parseCronField(fields[2] as string, 1, 31, "day of month");
  parseCronField(fields[3] as string, 1, 12, "month");
  parseCronField(fields[4] as string, 0, 7, "day of week");
}

export function cronMatches(expression: string, timezone: string, instant: Date): boolean {
  return cronMatcher(expression, timezone)(instant);
}

function cronMatcher(expression: string, timezone: string): (instant: Date) => boolean {
  const fields = expression.trim().split(/\s+/);
  validateCronExpression(expression);
  validateTimezone(timezone);
  const minute = parseCronField(fields[0] as string, 0, 59, "minute");
  const hour = parseCronField(fields[1] as string, 0, 23, "hour");
  const dayOfMonth = parseCronField(fields[2] as string, 1, 31, "day of month");
  const month = parseCronField(fields[3] as string, 1, 12, "month");
  const dayOfWeek = new Set(
    [...parseCronField(fields[4] as string, 0, 7, "day of week")].map((value) =>
      value === 7 ? 0 : value,
    ),
  );
  const domRestricted = fields[2] !== "*";
  const dowRestricted = fields[4] !== "*";
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    minute: "2-digit",
    hour: "2-digit",
    day: "2-digit",
    month: "2-digit",
    weekday: "short",
  });
  return (instant) => {
    const local = localParts(instant, formatter, timezone);
    const dayMatches =
      domRestricted && dowRestricted
        ? dayOfMonth.has(local.day) || dayOfWeek.has(local.weekday)
        : dayOfMonth.has(local.day) && dayOfWeek.has(local.weekday);
    return (
      minute.has(local.minute) &&
      hour.has(local.hour) &&
      month.has(local.month) &&
      dayMatches
    );
  };
}

function parseCronField(
  source: string,
  minimum: number,
  maximum: number,
  label: string,
): Set<number> {
  const values = new Set<number>();
  for (const rawPart of source.split(",")) {
    if (!rawPart) throw new Error(`Cron ${label} field is empty`);
    const [rangePart, stepPart, extra] = rawPart.split("/");
    if (extra !== undefined) throw new Error(`Cron ${label} field has too many slashes`);
    const step = stepPart === undefined ? 1 : parseCronNumber(stepPart, 1, maximum, label);
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = minimum;
      end = maximum;
    } else if (rangePart?.includes("-")) {
      const [left, right, overflow] = rangePart.split("-");
      if (overflow !== undefined || left === undefined || right === undefined) {
        throw new Error(`Cron ${label} range is invalid`);
      }
      start = parseCronNumber(left, minimum, maximum, label);
      end = parseCronNumber(right, minimum, maximum, label);
      if (start > end) throw new Error(`Cron ${label} range must be ascending`);
    } else {
      if (stepPart !== undefined) {
        throw new Error(`Cron ${label} step requires * or a range`);
      }
      start = parseCronNumber(rangePart as string, minimum, maximum, label);
      end = start;
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

function parseCronNumber(
  value: string,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!/^\d+$/.test(value)) throw new Error(`Cron ${label} value is invalid: ${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Cron ${label} value must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function localParts(
  instant: Date,
  formatter: Intl.DateTimeFormat,
  timezone: string,
): { minute: number; hour: number; day: number; month: number; weekday: number } {
  const parts = Object.fromEntries(
    formatter
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const weekdays: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const weekday = weekdays[String(parts.weekday)];
  if (weekday === undefined) throw new Error(`Could not evaluate timezone ${timezone}`);
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    day: Number(parts.day),
    month: Number(parts.month),
    weekday,
  };
}

function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
  } catch (error) {
    throw new Error(`Invalid IANA timezone: ${timezone}`, { cause: error });
  }
}

function validateScheduleName(name: string): void {
  if (!SCHEDULE_NAME.test(name)) {
    throw new Error(
      "Schedule name must start with a lowercase letter and contain only lowercase letters, digits, underscores, or hyphens",
    );
  }
}

function validateScheduleState(state: ScheduleState, expectedName: string): void {
  if (
    state.version !== 1 ||
    state.id !== expectedName ||
    !Number.isSafeInteger(state.activeRevision) ||
    state.activeRevision <= 0 ||
    !Number.isSafeInteger(state.latestRevision) ||
    state.latestRevision < state.activeRevision ||
    typeof state.enabled !== "boolean" ||
    !validDate(state.createdAt) ||
    !validDate(state.updatedAt) ||
    (state.lastEvaluatedMinute !== undefined && !validDate(state.lastEvaluatedMinute)) ||
    (state.healthSince !== undefined && !validDate(state.healthSince)) ||
    (state.pausedReason !== undefined &&
      (typeof state.pausedReason !== "string" || state.pausedReason.length === 0)) ||
    (state.removedAt !== undefined && !validDate(state.removedAt))
  ) {
    throw new Error(`Invalid Jaeger schedule state for ${expectedName}`);
  }
}

function validateScheduleRevision(
  revision: ScheduleRevision,
  expectedName: string,
  expectedRevision: number,
): void {
  if (
    revision.version !== 1 ||
    revision.scheduleId !== expectedName ||
    revision.revision !== expectedRevision ||
    !/^[a-f0-9]{64}$/.test(revision.revisionHash) ||
    !path.isAbsolute(revision.manifestPath) ||
    !path.isAbsolute(revision.workflowPath) ||
    !path.isAbsolute(revision.cwd) ||
    revision.workflowHash !== sha256(revision.workflowSource) ||
    !Number.isSafeInteger(revision.maxConcurrency) ||
    revision.maxConcurrency <= 0 ||
    revision.maxConcurrency > 64 ||
    !validDate(revision.createdAt)
  ) {
    throw new Error(`Invalid Jaeger schedule revision ${expectedName}/${expectedRevision}`);
  }
  validateCronExpression(revision.trigger.expression);
  validateTimezone(revision.trigger.timezone);
  validateHarnessDefinitions(revision.harnesses, {
    allowPinnedBuiltins: true,
    allowMissingBuiltins: true,
  });
  const {
    revision: _revision,
    revisionHash: _revisionHash,
    createdAt: _createdAt,
    ...content
  } = revision;
  if (sha256(stableJson(toJsonValue(content))) !== revision.revisionHash) {
    throw new Error(
      `Jaeger schedule revision hash mismatch for ${expectedName}/${expectedRevision}`,
    );
  }
}

function validateScheduleOccurrence(
  occurrence: ScheduleOccurrence,
  expectedName: string,
): void {
  if (
    occurrence.version !== 1 ||
    occurrence.scheduleId !== expectedName ||
    !/^[a-z0-9-]{8,80}$/.test(occurrence.id) ||
    !Number.isSafeInteger(occurrence.revision) ||
    occurrence.revision <= 0 ||
    (occurrence.kind !== "cron" && occurrence.kind !== "manual") ||
    !validDate(occurrence.scheduledFor) ||
    !REQUEST_ID.test(occurrence.submissionId) ||
    ![
      "pending",
      "admitted",
      "skipped",
      "completed",
      "failed",
      "interrupted",
      "stopped",
      "uncertain",
    ].includes(occurrence.status) ||
    !validDate(occurrence.createdAt) ||
    !validDate(occurrence.updatedAt) ||
    (occurrence.requestId !== undefined && !REQUEST_ID.test(occurrence.requestId)) ||
    (occurrence.admittedAt !== undefined && !validDate(occurrence.admittedAt)) ||
    (occurrence.finishedAt !== undefined && !validDate(occurrence.finishedAt)) ||
    (occurrence.runId !== undefined &&
      !/^\d{14}-[a-f0-9]{10}$/.test(occurrence.runId)) ||
    (occurrence.lastError !== undefined &&
      (typeof occurrence.lastError !== "string" || occurrence.lastError.length === 0))
  ) {
    throw new Error(`Invalid Jaeger schedule occurrence ${expectedName}/${occurrence.id}`);
  }
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function floorMinute(value: Date): Date {
  const result = new Date(value);
  result.setUTCSeconds(0, 0);
  return result;
}

function minuteIso(value: Date): string {
  return floorMinute(value).toISOString();
}

async function readJsonValue(target: string): Promise<JsonValue> {
  try {
    return toJsonValue(JSON.parse(await readFile(target, "utf8")));
  } catch (error) {
    throw new Error(`Schedule input is not valid JSON: ${target}`, { cause: error });
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a table`);
  }
  return value as Record<string, unknown>;
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown field: ${unknown[0]}`);
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await ensureTrustedPrivateDirectory(directory, "Jaeger schedule state directory");
}

async function writeJsonExclusive(target: string, value: unknown): Promise<void> {
  await ensurePrivateDirectory(path.dirname(target));
  const handle = await open(target, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(target));
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await ensurePrivateDirectory(path.dirname(target));
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
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

async function readJsonOptional<T>(target: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(target, "utf8")) as T;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw new Error(`Invalid Jaeger schedule state: ${target}`, { cause: error });
  }
}

function runIdFrom(value: JsonValue): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Scheduled run submission returned an invalid result");
  }
  const runId = value.runId;
  if (typeof runId !== "string" || !/^\d{14}-[a-f0-9]{10}$/.test(runId)) {
    throw new Error("Scheduled run submission returned no valid run id");
  }
  return runId;
}

function toJsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Value is not JSON-serializable");
  return JSON.parse(serialized) as JsonValue;
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key] as JsonValue)}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
