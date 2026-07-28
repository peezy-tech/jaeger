import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { JournalCorruptionError } from "./errors.js";
import { validateHarnessDefinitions } from "./harnesses/registry.js";
import { ensurePrivateDirectory } from "./paths.js";
import type {
  JsonValue,
  WorkflowRunRecord,
  WorkflowRunRecordV3,
  WorkflowRunRecordV4,
} from "./types.js";

const RUN_ID_PATTERN = /^\d{14}-[a-f0-9]{10}$/;

export type JournalEvent = {
  readonly type: string;
  readonly at: string;
  readonly [key: string]: JsonValue | undefined;
};

export interface JournalReadResult {
  readonly events: readonly JournalEvent[];
  readonly truncatedTail: boolean;
}

export interface StopRequest {
  readonly version: 1;
  readonly requestedAt: string;
  readonly requestedByPid: number;
  readonly ownerPid: number;
  readonly ownerToken?: string;
}

export interface StagedRunJournal {
  readonly stateDir: string;
  readonly runId: string;
  readonly runDir: string;
  readonly stagingDir: string;
  readonly record: WorkflowRunRecord;
  readonly recordHash: string;
  readonly sourceHash: string;
}

export class RunJournal {
  readonly runDir: string;
  readonly record: WorkflowRunRecord;
  private pending: Promise<void> = Promise.resolve();

  private constructor(runDir: string, record: WorkflowRunRecord) {
    this.runDir = runDir;
    this.record = record;
  }

  static async create(
    stateDir: string,
    record:
      | Omit<WorkflowRunRecordV3, "runId">
      | Omit<WorkflowRunRecordV4, "runId">,
    source: string,
  ): Promise<RunJournal> {
    const staged = await RunJournal.stage(stateDir, record, source);
    try {
      return await RunJournal.publish(staged);
    } catch (error) {
      try {
        const published = await RunJournal.open(staged.stateDir, staged.runId);
        const recordBytes = await readFile(path.join(published.runDir, "run.json"), "utf8");
        if (sha256(recordBytes) === staged.recordHash) {
          // A rename can become visible before one of publish()'s directory
          // fsyncs reports failure. Do not turn that ambiguous visibility into
          // accepted work until both rename parents are durable.
          await Promise.all([
            syncDirectory(path.dirname(staged.stagingDir)),
            syncDirectory(staged.stateDir),
          ]);
          return published;
        }
      } catch {
        // Publication did not produce this complete run. The staging path is
        // still the only candidate we are permitted to discard.
      }
      await RunJournal.discard(staged).catch(() => undefined);
      throw error;
    }
  }

  static async stage(
    stateDir: string,
    record:
      | Omit<WorkflowRunRecordV3, "runId">
      | Omit<WorkflowRunRecordV4, "runId">,
    source: string,
    requestedRunId = createRunId(),
  ): Promise<StagedRunJournal> {
    if (!RUN_ID_PATTERN.test(requestedRunId)) throw new Error("Invalid requested Jaeger run id");
    const resolvedStateDir = path.resolve(stateDir);
    const stagingRoot = path.join(resolvedStateDir, ".staged-runs");
    const stagingDir = path.join(stagingRoot, requestedRunId);
    await ensurePrivateDirectory(resolvedStateDir, "Jaeger state directory");
    await ensurePrivateDirectory(stagingRoot, "Jaeger staged-run directory");
    await mkdir(stagingDir, { recursive: false, mode: 0o700 });
    const fullRecord: WorkflowRunRecord = { ...record, runId: requestedRunId };
    const recordBytes = `${JSON.stringify(fullRecord, null, 2)}\n`;
    const sourceHash = sha256(source);
    try {
      if (sourceHash !== fullRecord.workflowHash) {
        throw new JournalCorruptionError(
          `Staged workflow source does not match run ${requestedRunId}`,
        );
      }
      await atomicWrite(path.join(stagingDir, "run.json"), recordBytes);
      await atomicWrite(path.join(stagingDir, "workflow.source"), source);
      await atomicWrite(path.join(stagingDir, "events.jsonl"), "");
      await Promise.all([
        syncDirectory(stagingDir),
        syncDirectory(stagingRoot),
        syncDirectory(resolvedStateDir),
      ]);
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return {
      stateDir: resolvedStateDir,
      runId: requestedRunId,
      runDir: path.join(resolvedStateDir, requestedRunId),
      stagingDir,
      record: fullRecord,
      recordHash: sha256(recordBytes),
      sourceHash,
    };
  }

  static async openStaged(stateDir: string, runId: string): Promise<StagedRunJournal> {
    if (!RUN_ID_PATTERN.test(runId)) throw new Error("Invalid Jaeger run id");
    const resolvedStateDir = path.resolve(stateDir);
    const stagingDir = path.join(resolvedStateDir, ".staged-runs", runId);
    const recordBytes = await readFile(path.join(stagingDir, "run.json"), "utf8");
    const record = parseRunRecord(recordBytes, runId);
    const [source, events] = await Promise.all([
      readFile(path.join(stagingDir, "workflow.source"), "utf8"),
      readFile(path.join(stagingDir, "events.jsonl")),
    ]);
    const sourceHash = sha256(source);
    if (sourceHash !== record.workflowHash) {
      throw new JournalCorruptionError(
        `Staged workflow source does not match run ${runId}`,
      );
    }
    if (events.length !== 0) {
      throw new JournalCorruptionError(
        `Staged run ${runId} already contains journal events`,
      );
    }
    return {
      stateDir: resolvedStateDir,
      runId,
      runDir: path.join(resolvedStateDir, runId),
      stagingDir,
      record,
      recordHash: sha256(recordBytes),
      sourceHash,
    };
  }

  static async publish(staged: StagedRunJournal): Promise<RunJournal> {
    const verified = await RunJournal.openStaged(staged.stateDir, staged.runId);
    if (
      verified.stagingDir !== staged.stagingDir ||
      verified.runDir !== staged.runDir ||
      verified.recordHash !== staged.recordHash ||
      verified.sourceHash !== staged.sourceHash
    ) {
      throw new JournalCorruptionError(
        `Staged run ${staged.runId} changed before publication`,
      );
    }
    await rename(verified.stagingDir, verified.runDir);
    await Promise.all([
      syncDirectory(path.dirname(verified.stagingDir)),
      syncDirectory(verified.stateDir),
    ]);
    return new RunJournal(verified.runDir, verified.record);
  }

  static async discard(staged: StagedRunJournal): Promise<void> {
    await rm(staged.stagingDir, { recursive: true, force: true });
    await syncDirectory(path.dirname(staged.stagingDir));
  }

  static async open(stateDir: string, runId: string): Promise<RunJournal> {
    if (!RUN_ID_PATTERN.test(runId)) throw new Error("Invalid Jaeger run id");
    const runDir = path.join(stateDir, runId);
    const parsed = parseRunRecord(await readFile(path.join(runDir, "run.json"), "utf8"), runId);
    return new RunJournal(runDir, parsed);
  }

  async events(): Promise<JournalEvent[]> {
    const result = await this.readEvents();
    if (result.truncatedTail) {
      throw new JournalCorruptionError(`Jaeger journal has a truncated final event: ${this.runDir}`);
    }
    return [...result.events];
  }

  async readEvents(): Promise<JournalReadResult> {
    const text = await readFile(path.join(this.runDir, "events.jsonl"), "utf8");
    const hasTruncatedTail = text.length > 0 && !text.endsWith("\n");
    const lines = text.split(/\n/);
    if (hasTruncatedTail) lines.pop();
    const events: JournalEvent[] = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]?.replace(/\r$/, "") ?? "";
      if (!line) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch (error) {
        throw new JournalCorruptionError(
          `Invalid Jaeger journal event at ${this.runDir}/events.jsonl:${index + 1}`,
          { cause: error },
        );
      }
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        throw new JournalCorruptionError(
          `Invalid Jaeger journal event at ${this.runDir}/events.jsonl:${index + 1}`,
        );
      }
      const candidate = event as Record<string, unknown>;
      if (typeof candidate.type !== "string" || typeof candidate.at !== "string") {
        throw new JournalCorruptionError(
          `Invalid Jaeger journal event at ${this.runDir}/events.jsonl:${index + 1}`,
        );
      }
      events.push(candidate as JournalEvent);
    }
    return { events, truncatedTail: hasTruncatedTail };
  }

  async source(): Promise<string> {
    return await readFile(path.join(this.runDir, "workflow.source"), "utf8");
  }

  /**
   * Remove only the incomplete final row. The caller must hold the exclusive
   * run lease and must first prove the complete prefix has no uncertain agent.
   */
  async discardTruncatedTail(): Promise<boolean> {
    await this.flush();
    const journalPath = path.join(this.runDir, "events.jsonl");
    const handle = await open(journalPath, "r+");
    try {
      const contents = await handle.readFile();
      if (contents.length === 0 || contents.at(-1) === 0x0a) return false;
      const lastNewline = contents.lastIndexOf(0x0a);
      await handle.truncate(lastNewline + 1);
      await handle.sync();
      return true;
    } finally {
      await handle.close();
    }
  }

  async requestStop(
    requestedByPid: number,
    ownerPid: number,
    ownerToken?: string,
  ): Promise<StopRequest> {
    const request: StopRequest = {
      version: 1,
      requestedAt: new Date().toISOString(),
      requestedByPid,
      ownerPid,
      ...(ownerToken ? { ownerToken } : {}),
    };
    await atomicWrite(
      path.join(this.runDir, "stop.json"),
      `${JSON.stringify(request, null, 2)}\n`,
    );
    return request;
  }

  async stopRequest(): Promise<StopRequest | undefined> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path.join(this.runDir, "stop.json"), "utf8"));
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      throw new JournalCorruptionError(`Invalid Jaeger stop request at ${this.runDir}/stop.json`, {
        cause: error,
      });
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new JournalCorruptionError(`Invalid Jaeger stop request at ${this.runDir}/stop.json`);
    }
    const request = value as Record<string, unknown>;
    if (
      request.version !== 1 ||
      typeof request.requestedAt !== "string" ||
      !Number.isSafeInteger(request.requestedByPid) ||
      !Number.isSafeInteger(request.ownerPid) ||
      (request.ownerToken !== undefined &&
        (typeof request.ownerToken !== "string" || !/^[a-f0-9]{32}$/.test(request.ownerToken)))
    ) {
      throw new JournalCorruptionError(`Invalid Jaeger stop request at ${this.runDir}/stop.json`);
    }
    return request as unknown as StopRequest;
  }

  async clearStopRequest(): Promise<void> {
    try {
      await unlink(path.join(this.runDir, "stop.json"));
      await syncDirectory(this.runDir);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  }

  append(event: Omit<JournalEvent, "at">): Promise<void> {
    const row = { ...event, at: new Date().toISOString() } as JournalEvent;
    this.pending = this.pending.then(async () => {
      const handle = await open(path.join(this.runDir, "events.jsonl"), "a", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(row)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    return this.pending;
  }

  async flush(): Promise<void> {
    await this.pending;
  }
}

export function createRunId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${timestamp}-${randomBytes(5).toString("hex")}`;
}

function validateV4Record(record: WorkflowRunRecordV4): void {
  const trigger = record.trigger;
  if (
    !record.runtime ||
    !Number.isSafeInteger(record.runtime.abi) ||
    record.runtime.abi <= 0 ||
    typeof record.runtime.version !== "string" ||
    record.runtime.version.length === 0 ||
    (record.runtime.backend !== "embedded" && record.runtime.backend !== "local-service") ||
    !record.workspace ||
    record.workspace.kind !== "local-path" ||
    typeof record.workspace.root !== "string" ||
    record.workspace.root.length === 0 ||
    typeof record.workspace.device !== "string" ||
    !/^\d+$/.test(record.workspace.device) ||
    typeof record.workspace.inode !== "string" ||
    !/^\d+$/.test(record.workspace.inode) ||
    typeof record.workspace.identity !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.workspace.identity) ||
    (record.submissionId !== undefined &&
      (typeof record.submissionId !== "string" ||
        !/^[A-Za-z0-9._:-]{8,128}$/.test(record.submissionId))) ||
    (record.submissionHash !== undefined &&
      (typeof record.submissionHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(record.submissionHash))) ||
    (record.submissionId === undefined) !== (record.submissionHash === undefined) ||
    (trigger !== undefined &&
      (trigger.type !== "schedule" ||
        typeof trigger.scheduleId !== "string" ||
        typeof trigger.revision !== "number" ||
        !Number.isSafeInteger(trigger.revision) ||
        trigger.revision <= 0 ||
        typeof trigger.occurrenceId !== "string" ||
        (trigger.kind !== "cron" && trigger.kind !== "manual") ||
        typeof trigger.scheduledFor !== "string" ||
        Number.isNaN(Date.parse(trigger.scheduledFor)) ||
        typeof trigger.admittedAt !== "string" ||
        Number.isNaN(Date.parse(trigger.admittedAt))))
  ) {
    throw new Error("Invalid Jaeger version 4 run record");
  }
}

function parseRunRecord(contents: string, runId: string): WorkflowRunRecord {
  const parsed = JSON.parse(contents) as WorkflowRunRecord;
  if (
    (parsed.version !== 2 && parsed.version !== 3 && parsed.version !== 4) ||
    parsed.runId !== runId ||
    !Number.isSafeInteger(parsed.maxConcurrency) ||
    parsed.maxConcurrency <= 0 ||
    parsed.maxConcurrency > 64
  ) {
    throw new Error("Invalid Jaeger run record");
  }
  validateCommonRecord(parsed);
  if (parsed.version === 3 || parsed.version === 4) {
    validateHarnessDefinitions(parsed.harnesses, {
      allowPinnedBuiltins: true,
      allowMissingBuiltins: true,
    });
  }
  if (parsed.version === 4) validateV4Record(parsed);
  return parsed;
}

function validateCommonRecord(record: WorkflowRunRecord): void {
  if (
    typeof record.workflowPath !== "string" ||
    !path.isAbsolute(record.workflowPath) ||
    typeof record.workflowHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.workflowHash) ||
    typeof record.cwd !== "string" ||
    !path.isAbsolute(record.cwd) ||
    !isJsonValue(record.inputs) ||
    !record.boundary ||
    typeof record.boundary.kind !== "string" ||
    typeof record.boundary.isolated !== "boolean" ||
    typeof record.boundary.description !== "string" ||
    typeof record.createdAt !== "string" ||
    Number.isNaN(Date.parse(record.createdAt))
  ) {
    throw new Error("Invalid Jaeger run record");
  }
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
  return Boolean(
    value &&
      typeof value === "object" &&
      Object.values(value).every(isJsonValue),
  );
}

async function atomicWrite(target: string, contents: string): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
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

function sha256(value: string | Buffer): string {
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
