import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { chmod, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { JournalCorruptionError, RunOwnedError } from "./errors.js";

export type RunOwnerKind = "foreground" | "detached";

export interface RunOwnerRecord {
  readonly version: 1;
  readonly runId: string;
  readonly token: string;
  readonly pid: number;
  readonly processStartId?: string;
  readonly kind: RunOwnerKind;
  readonly acquiredAt: string;
}

export interface RunOwnerState {
  readonly owner?: RunOwnerRecord;
  readonly active: boolean;
}

/**
 * A held SQLite exclusive transaction is the run lease. SQLite's filesystem
 * lock is process-scoped, works across runtime network namespaces that share
 * the run directory, and is released by the OS if the owner crashes. Keeping
 * owner.json separate makes inspect cheap without making it authoritative.
 */
export class RunLease {
  private released = false;

  private constructor(
    readonly runDir: string,
    readonly owner: RunOwnerRecord,
    private readonly database: DatabaseSync,
  ) {}

  static async acquire(
    runDir: string,
    runId: string,
    kind: RunOwnerKind,
  ): Promise<RunLease> {
    const leasePath = path.join(runDir, "lease.sqlite");
    const database = new DatabaseSync(leasePath);
    try {
      await acquireExclusiveDatabaseLease(database, runDir, runId);
    } catch (error) {
      database.close();
      if (isDatabaseLocked(error)) {
        throw new RunOwnedError(`Jaeger run ${runId} already has an active owner`);
      }
      throw error;
    }

    // Once the authoritative transaction is held, remove stale diagnostic
    // identity before any asynchronous work. Inspect may briefly see an active
    // lease with no owner metadata, but can never stably pair the new lease with
    // a recycled stale PID.
    try {
      unlinkSync(path.join(runDir, "owner.json"));
    } catch (error) {
      if (!hasCode(error, "ENOENT")) {
        try {
          database.exec("ROLLBACK");
        } finally {
          database.close();
        }
        throw error;
      }
    }

    const token = randomBytes(16).toString("hex");
    const startId = await processStartId(process.pid);
    const owner: RunOwnerRecord = {
      version: 1,
      runId,
      token,
      pid: process.pid,
      ...(startId ? { processStartId: startId } : {}),
      kind,
      acquiredAt: new Date().toISOString(),
    };
    try {
      await chmod(leasePath, 0o600);
      await atomicOwnerWrite(path.join(runDir, "owner.json"), owner);
      return new RunLease(runDir, owner, database);
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } finally {
        database.close();
      }
      throw error;
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    let releaseError: unknown;
    const ownerPath = path.join(this.runDir, "owner.json");
    try {
      const current = await readOwnerFile(ownerPath, this.owner.runId);
      if (current.token === this.owner.token) await unlink(ownerPath);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) releaseError = error;
    }
    // Retain the exclusive transaction until our owner record is gone. A new
    // owner cannot appear between stale-record replacement and lease release.
    try {
      this.database.exec("ROLLBACK");
    } catch (error) {
      releaseError ??= error;
    }
    try {
      this.database.close();
    } catch (error) {
      releaseError ??= error;
    }
    if (releaseError) throw releaseError;
  }
}

export async function readRunOwner(runDir: string, runId: string): Promise<RunOwnerState> {
  const ownerPath = path.join(runDir, "owner.json");
  let owner: RunOwnerRecord;
  try {
    owner = await readOwnerFile(ownerPath, runId);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { active: isRunLeaseHeld(runDir) };
    throw error;
  }
  return { owner, active: isRunLeaseHeld(runDir) };
}

export function isRunLeaseHeld(runDir: string): boolean {
  const leasePath = path.join(runDir, "lease.sqlite");
  if (!existsSync(leasePath)) return false;
  const database = new DatabaseSync(leasePath);
  let transaction = false;
  try {
    // Shared read probes do not contend with one another. In rollback-journal
    // mode the owner's BEGIN EXCLUSIVE blocks this schema read, making a busy
    // result authoritative without taking a competing write lock ourselves.
    database.exec("PRAGMA busy_timeout = 0; BEGIN DEFERRED");
    transaction = true;
    database.prepare("SELECT count(*) AS count FROM sqlite_schema").get();
    return false;
  } catch (error) {
    if (isDatabaseLocked(error)) return true;
    throw error;
  } finally {
    if (transaction) database.exec("ROLLBACK");
    database.close();
  }
}

export async function ownerProcessIdentityMatches(owner: RunOwnerRecord): Promise<boolean> {
  if (!owner.processStartId) return false;
  const current = await processStartId(owner.pid);
  return current !== undefined && current === owner.processStartId;
}

async function atomicOwnerWrite(target: string, owner: RunOwnerRecord): Promise<void> {
  const temporary = `${target}.${process.pid}.${owner.token}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    // Windows rename does not replace an existing stale owner file. The held
    // SQLite transaction proves no other live owner can race this replacement.
    if (!hasCode(error, "EEXIST") && !hasCode(error, "EPERM")) throw error;
    try {
      await unlink(target);
    } catch (unlinkError) {
      if (!hasCode(unlinkError, "ENOENT")) throw unlinkError;
    }
    await rename(temporary, target);
  }
}

async function readOwnerFile(ownerPath: string, expectedRunId: string): Promise<RunOwnerRecord> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(ownerPath, "utf8"));
  } catch (error) {
    if (hasCode(error, "ENOENT")) throw error;
    throw new JournalCorruptionError(`Invalid Jaeger owner record at ${ownerPath}`, {
      cause: error,
    });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new JournalCorruptionError(`Invalid Jaeger owner record at ${ownerPath}`);
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    candidate.runId !== expectedRunId ||
    typeof candidate.token !== "string" ||
    !/^[a-f0-9]{32}$/.test(candidate.token) ||
    !Number.isSafeInteger(candidate.pid) ||
    (candidate.pid as number) <= 0 ||
    (candidate.kind !== "foreground" && candidate.kind !== "detached") ||
    typeof candidate.acquiredAt !== "string" ||
    (candidate.processStartId !== undefined && typeof candidate.processStartId !== "string")
  ) {
    throw new JournalCorruptionError(`Invalid Jaeger owner record at ${ownerPath}`);
  }
  return candidate as unknown as RunOwnerRecord;
}

async function processStartId(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const closingParen = stat.lastIndexOf(")");
    if (closingParen < 0) return undefined;
    return stat.slice(closingParen + 2).trim().split(/\s+/)[19];
  } catch {
    return undefined;
  }
}

function isDatabaseLocked(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ERR_SQLITE_ERROR" &&
    /database is locked/i.test(error.message)
  );
}

async function acquireExclusiveDatabaseLease(
  database: DatabaseSync,
  runDir: string,
  runId: string,
): Promise<void> {
  const deadline = Date.now() + 500;
  while (true) {
    try {
      // DELETE mode is required so the exclusive owner blocks shared probes;
      // the short busy timeout lets a pending writer outlast transient readers.
      database.exec(
        "PRAGMA busy_timeout = 50; PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE",
      );
      return;
    } catch (error) {
      if (!isDatabaseLocked(error) || Date.now() >= deadline) throw error;
      // A stable, live owner record accompanying SQLite's authoritative busy
      // result proves this is real ownership rather than a momentary shared
      // inspect probe. Fail immediately so concurrent execute calls cannot
      // silently turn into replay after the first owner finishes.
      if (await hasStableLiveOwner(runDir, runId)) {
        throw new RunOwnedError(`Jaeger run ${runId} already has an active owner`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

async function hasStableLiveOwner(runDir: string, runId: string): Promise<boolean> {
  let first: RunOwnerRecord;
  try {
    first = await readOwnerFile(path.join(runDir, "owner.json"), runId);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
  if (!(await ownerProcessIdentityMatches(first))) return false;
  await new Promise((resolve) => setTimeout(resolve, 5));
  let second: RunOwnerRecord;
  try {
    second = await readOwnerFile(path.join(runDir, "owner.json"), runId);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
  return (
    second.token === first.token &&
    second.pid === first.pid &&
    (await ownerProcessIdentityMatches(second))
  );
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
