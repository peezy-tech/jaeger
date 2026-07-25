import { execFile } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const exclusiveGroups = new Map<number, Promise<boolean>>();

export async function trustedDirectory(target: string, label: string): Promise<string> {
  const canonical = await realpath(target);
  const stat = await lstat(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a real directory: ${canonical}`);
  }
  await assertTrustedNode(canonical, stat, label);
  await assertTrustedAncestors(canonical, label);
  return canonical;
}

export async function trustedRegularFile(
  target: string,
  label: string,
  executable = false,
): Promise<string> {
  if (executable) await access(target, constants.X_OK);
  const canonical = await realpath(target);
  const stat = await lstat(canonical);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file: ${canonical}`);
  }
  await assertTrustedNode(canonical, stat, label);
  await assertTrustedAncestors(path.dirname(canonical), label);
  return canonical;
}

async function assertTrustedAncestors(start: string, label: string): Promise<void> {
  let current = start;
  while (true) {
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${label} ancestor is not a real directory: ${current}`);
    }
    await assertTrustedNode(current, stat, `${label} ancestor`);
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function assertTrustedNode(target: string, stat: Stats, label: string): Promise<void> {
  const currentUid = process.getuid?.();
  if (currentUid === undefined) throw new Error(`${label} requires Unix ownership checks`);
  if (stat.uid !== 0 && stat.uid !== currentUid) {
    throw new Error(`${label} is owned by an untrusted account: ${target}`);
  }
  const stickyDirectory = stat.isDirectory() && (stat.mode & 0o1000) !== 0;
  if ((stat.mode & 0o002) !== 0 && !stickyDirectory) {
    throw new Error(`${label} is writable by other users: ${target}`);
  }
  if (
    (stat.mode & 0o020) !== 0 &&
    !stickyDirectory &&
    !(await groupIsExclusiveToCurrentUser(stat.gid, currentUid))
  ) {
    throw new Error(`${label} is writable by a shared group: ${target}`);
  }
}

async function groupIsExclusiveToCurrentUser(gid: number, uid: number): Promise<boolean> {
  let cached = exclusiveGroups.get(gid);
  if (!cached) {
    cached = inspectGroup(gid, uid);
    exclusiveGroups.set(gid, cached);
  }
  return await cached;
}

async function inspectGroup(gid: number, uid: number): Promise<boolean> {
  try {
    const [{ stdout: passwd }, { stdout: group }] = await Promise.all([
      execFileAsync("/usr/bin/getent", ["passwd"], { encoding: "utf8", timeout: 5_000 }),
      execFileAsync("/usr/bin/getent", ["group", String(gid)], {
        encoding: "utf8",
        timeout: 5_000,
      }),
    ]);
    const users = new Map<string, number>();
    for (const line of passwd.split("\n")) {
      if (!line) continue;
      const fields = line.split(":");
      const name = fields[0];
      const accountUid = Number(fields[2]);
      const accountGid = Number(fields[3]);
      if (name && Number.isSafeInteger(accountUid)) users.set(name, accountUid);
      if (accountGid === gid && accountUid !== uid) return false;
    }
    const members = group.trim().split(":")[3]?.split(",").filter(Boolean) ?? [];
    return members.every((member) => users.get(member) === uid);
  } catch {
    // If NSS membership cannot be proven, a group-writable path is not trusted.
    return false;
  }
}
