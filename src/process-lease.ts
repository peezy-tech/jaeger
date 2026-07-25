import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { hasCode, syncDirectory } from "./durable-json.js";
import {
  currentProcessIdentity,
  isProcessIdentityActive,
  type ProcessIdentity,
} from "./process-identity.js";

const TOKEN_PATTERN = /^[a-f0-9]{32}$/;

export interface ProcessLeaseOwner extends ProcessIdentity {
  readonly token: string;
}

export class ProcessLeaseBusyError extends Error {
  constructor(readonly owner: ProcessLeaseOwner) {
    super(`Process lease is owned by active PID ${owner.pid}`);
    this.name = "ProcessLeaseBusyError";
  }
}

/**
 * Acquire an inter-process lease represented by a non-empty directory.
 *
 * Stale generations are renamed to immutable, token-addressed tombstones. The
 * tombstone is deliberately retained: a contender that observed the old
 * generation can never rename a newer lease out of the canonical path.
 */
export async function acquireProcessLease(
  target: string,
  options: { readonly waitMs?: number; readonly pollMs?: number } = {},
): Promise<ProcessLeaseOwner> {
  const waitMs = checkedNonNegativeInteger(options.waitMs ?? 0, "waitMs");
  const pollMs = checkedPositiveInteger(options.pollMs ?? 25, "pollMs");
  const identity = currentProcessIdentity();
  const owner: ProcessLeaseOwner = {
    ...identity,
    token: randomBytes(16).toString("hex"),
  };
  const parent = path.dirname(target);
  const candidate = `${target}.candidate-${owner.token}`;
  await mkdir(candidate, { mode: 0o700 });
  await writeOwner(path.join(candidate, "owner.json"), owner);
  await syncDirectory(candidate);

  const deadline = Date.now() + waitMs;
  let published = false;
  try {
    while (true) {
      try {
        await rename(candidate, target);
        published = true;
        try {
          await syncDirectory(parent);
        } catch (error) {
          // The rename made this process the visible owner even though the
          // durability barrier failed. Do not strand a live lease that the
          // caller never received and therefore cannot release.
          await releaseProcessLease(target, owner).catch(() => undefined);
          throw error;
        }
        return owner;
      } catch (error) {
        if (
          !hasCode(error, "EEXIST") &&
          !hasCode(error, "ENOTEMPTY") &&
          !hasCode(error, "ENOTDIR") &&
          !hasCode(error, "EISDIR")
        ) {
          throw error;
        }
      }

      let current: ProcessLeaseOwner;
      try {
        current = await readProcessLease(target);
      } catch (error) {
        if (hasCode(error, "ENOENT")) continue;
        throw error;
      }
      if (isProcessIdentityActive(current)) {
        if (Date.now() >= deadline) throw new ProcessLeaseBusyError(current);
        await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
        continue;
      }

      const tombstone = `${target}.stale-${current.token}`;
      try {
        await rename(target, tombstone);
        await syncDirectory(parent);
      } catch (error) {
        if (
          !hasCode(error, "ENOENT") &&
          !hasCode(error, "EEXIST") &&
          !hasCode(error, "ENOTEMPTY") &&
          !hasCode(error, "ENOTDIR") &&
          !hasCode(error, "EISDIR")
        ) {
          throw error;
        }
      }
    }
  } finally {
    if (!published) await rm(candidate, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function readProcessLease(target: string): Promise<ProcessLeaseOwner> {
  let source: string;
  try {
    source = await readFile(path.join(target, "owner.json"), "utf8");
  } catch (error) {
    if (!hasCode(error, "ENOTDIR")) throw error;
    source = await readFile(target, "utf8");
  }
  const value = JSON.parse(source) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid process lease at ${target}`);
  }
  const owner = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(owner.pid) ||
    (owner.pid as number) <= 0 ||
    typeof owner.processStartId !== "string" ||
    owner.processStartId.length === 0 ||
    typeof owner.token !== "string" ||
    !TOKEN_PATTERN.test(owner.token)
  ) {
    throw new Error(`Invalid process lease at ${target}`);
  }
  return value as ProcessLeaseOwner;
}

export async function releaseProcessLease(
  target: string,
  expected: ProcessLeaseOwner,
): Promise<boolean> {
  let current: ProcessLeaseOwner;
  try {
    current = await readProcessLease(target);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
  if (current.token !== expected.token) return false;
  await rm(target, { recursive: true });
  await syncDirectory(path.dirname(target));
  return true;
}

export async function clearInactiveProcessLease(target: string): Promise<boolean> {
  let current: ProcessLeaseOwner;
  try {
    current = await readProcessLease(target);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
  if (isProcessIdentityActive(current)) return false;
  const tombstone = `${target}.stale-${current.token}`;
  try {
    await rename(target, tombstone);
    await syncDirectory(path.dirname(target));
    return true;
  } catch (error) {
    if (
      hasCode(error, "ENOENT") ||
      hasCode(error, "EEXIST") ||
      hasCode(error, "ENOTEMPTY") ||
      hasCode(error, "ENOTDIR") ||
      hasCode(error, "EISDIR")
    ) {
      return false;
    }
    throw error;
  }
}

async function writeOwner(target: string, owner: ProcessLeaseOwner): Promise<void> {
  const handle = await open(target, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function checkedNonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be non-negative`);
  return value;
}

function checkedPositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be positive`);
  return value;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
