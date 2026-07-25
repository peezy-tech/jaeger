import { randomBytes } from "node:crypto";
import { link, lstat, open, unlink } from "node:fs/promises";
import path from "node:path";

export async function publishJsonExclusive(target: string, value: unknown): Promise<boolean> {
  const directory = path.dirname(target);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  let handleOpen = true;
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handleOpen = false;
    await link(temporary, target);
    await syncDirectory(directory);
    return true;
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
    return false;
  } finally {
    if (handleOpen) await handle.close().catch(() => undefined);
    // The canonical hard link, once created, is the authority. A leftover
    // temporary name is harmless and must never turn a successful claim into a
    // caller-visible failure that might discard the claimed payload.
    await unlink(temporary).catch(() => undefined);
  }
}

export async function assertRegularFile(target: string, label: string): Promise<void> {
  const stats = await lstat(target);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file: ${target}`);
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be accessible by group or other users: ${target}`);
  }
}

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
