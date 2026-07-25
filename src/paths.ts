import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  type Stats,
} from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncDirectory } from "./durable-json.js";

export const BACKEND_SERVICE_NAME = "jaeger-backend.service";
const exclusiveGroups = new Map<number, boolean>();

export interface BackendInstallConfig {
  readonly version: 1 | 2 | 3 | 4;
  readonly socketPath: string;
  readonly stateDir: string;
  readonly entrypoint: string;
  readonly harnessConfigPath?: string;
  readonly hooksConfigPath?: string;
  readonly runtimeModuleConfigPath?: string;
  readonly generation?: string;
  readonly systemctlPath?: string;
  readonly instanceId?: string;
  readonly installedAt: string;
}

export function defaultBackendSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.JAEGER_SOCKET) return path.resolve(env.JAEGER_SOCKET);
  const configured = readBackendInstallConfig(env);
  if (configured) return configured.socketPath;
  return unconfiguredBackendSocketPath(env);
}

export function unconfiguredBackendSocketPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const runtimeRoot =
    env.XDG_RUNTIME_DIR ??
    (process.getuid ? `/run/user/${process.getuid()}` : path.join(os.tmpdir(), `jaeger-${os.userInfo().username}`));
  return path.join(runtimeRoot, "jaeger", "backend.sock");
}

export function defaultPersistentStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.JAEGER_STATE_DIR) return path.resolve(env.JAEGER_STATE_DIR);
  const configured = readBackendInstallConfig(env);
  if (configured) return configured.stateDir;
  const stateRoot = env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  return path.join(stateRoot, "jaeger", "runs");
}

export function defaultSystemdUserDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configRoot = env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(configRoot, "systemd", "user");
}

export function backendServiceUnitPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(defaultSystemdUserDirectory(env), BACKEND_SERVICE_NAME);
}

export function backendInstallConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configRoot = env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(configRoot, "jaeger", "backend.json");
}

export function backendPendingInstallConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(backendInstallConfigPath(env)), "backend.pending.json");
}

export function readBackendInstallConfig(
  env: NodeJS.ProcessEnv = process.env,
): BackendInstallConfig | undefined {
  return readBackendInstallConfigFile(backendInstallConfigPath(env));
}

export function readBackendInstallConfigFile(target: string): BackendInstallConfig | undefined {
  let value: unknown;
  let targetStat: Stats;
  try {
    targetStat = lstatSync(target);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw new Error(`Invalid Jaeger backend configuration: ${target}`, { cause: error });
  }
  try {
    assertTrustedAuthorityAncestors(path.dirname(path.resolve(target)), "Jaeger backend configuration");
    const parentStat = lstatSync(path.dirname(target));
    assertPrivateOwnedDirectory(parentStat, path.dirname(target));
    if (
      !targetStat.isFile() ||
      targetStat.isSymbolicLink() ||
      (process.getuid && targetStat.uid !== process.getuid()) ||
      (targetStat.mode & 0o077) !== 0
    ) {
      throw new Error(`Jaeger backend configuration is not a private owned regular file: ${target}`);
    }
    const descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const openedStat = fstatSync(descriptor);
      if (
        openedStat.dev !== targetStat.dev ||
        openedStat.ino !== targetStat.ino ||
        !openedStat.isFile()
      ) {
        throw new Error(`Jaeger backend configuration changed while opening it: ${target}`);
      }
      value = JSON.parse(readFileSync(descriptor, "utf8"));
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    throw new Error(`Invalid Jaeger backend configuration: ${target}`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Jaeger backend configuration: ${target}`);
  }
  const config = value as Record<string, unknown>;
  if (
    (config.version !== 1 &&
      config.version !== 2 &&
      config.version !== 3 &&
      config.version !== 4) ||
    typeof config.socketPath !== "string" ||
    !path.isAbsolute(config.socketPath) ||
    typeof config.stateDir !== "string" ||
    !path.isAbsolute(config.stateDir) ||
    typeof config.entrypoint !== "string" ||
    !path.isAbsolute(config.entrypoint) ||
    (config.harnessConfigPath !== undefined &&
      (typeof config.harnessConfigPath !== "string" ||
        !path.isAbsolute(config.harnessConfigPath))) ||
    (config.hooksConfigPath !== undefined &&
      (typeof config.hooksConfigPath !== "string" ||
        !path.isAbsolute(config.hooksConfigPath))) ||
    (config.runtimeModuleConfigPath !== undefined &&
      (typeof config.runtimeModuleConfigPath !== "string" ||
        !path.isAbsolute(config.runtimeModuleConfigPath))) ||
    (config.version === 2 &&
      (typeof config.generation !== "string" ||
        !/^[a-f0-9]{32}$/.test(config.generation) ||
        typeof config.systemctlPath !== "string" ||
        !path.isAbsolute(config.systemctlPath))) ||
    ((config.version === 3 || config.version === 4) &&
      (typeof config.generation !== "string" ||
        !/^[a-f0-9]{32}$/.test(config.generation) ||
        typeof config.systemctlPath !== "string" ||
        !path.isAbsolute(config.systemctlPath) ||
        typeof config.instanceId !== "string" ||
        !/^[a-f0-9]{32}$/.test(config.instanceId))) ||
    (config.generation !== undefined &&
      (typeof config.generation !== "string" || !/^[a-f0-9]{32}$/.test(config.generation))) ||
    (config.systemctlPath !== undefined &&
      (typeof config.systemctlPath !== "string" || !path.isAbsolute(config.systemctlPath))) ||
    (config.instanceId !== undefined &&
      (typeof config.instanceId !== "string" || !/^[a-f0-9]{32}$/.test(config.instanceId))) ||
    typeof config.installedAt !== "string" ||
    Number.isNaN(Date.parse(config.installedAt))
  ) {
    throw new Error(`Invalid Jaeger backend configuration: ${target}`);
  }
  return value as BackendInstallConfig;
}

function assertPrivateOwnedDirectory(
  stat: Stats,
  directory: string,
): void {
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error(`Jaeger configuration directory is not private and owned: ${directory}`);
  }
}

export async function ensurePrivateDirectory(directory: string, label: string): Promise<void> {
  const resolved = path.resolve(directory);
  await ensureDirectoryDurable(resolved, 0o700);
  const stat = await lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${resolved}`);
  }
  if (process.getuid && stat.uid !== process.getuid()) {
    throw new Error(`${label} is not owned by the current user: ${resolved}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be accessible by group or other users: ${resolved}`);
  }
  assertTrustedAuthorityAncestors(resolved, label);
}

export async function ensureDirectoryDurable(directory: string, mode = 0o700): Promise<void> {
  const resolved = path.resolve(directory);
  const firstCreated = await mkdir(resolved, { recursive: true, mode });
  if (firstCreated) await syncCreatedDirectoryChain(path.resolve(firstCreated), resolved);
}

async function syncCreatedDirectoryChain(firstCreated: string, target: string): Promise<void> {
  const relative = path.relative(firstCreated, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Created directory ${firstCreated} is outside requested path ${target}`);
  }
  const segments = relative === "" ? [] : relative.split(path.sep);
  let current = firstCreated;
  await syncDirectory(path.dirname(current));
  for (const segment of segments) {
    current = path.join(current, segment);
    await syncDirectory(path.dirname(current));
  }
}

export function assertTrustedAuthorityAncestors(start: string, label: string): void {
  const currentUid = process.getuid?.();
  if (currentUid === undefined) throw new Error(`${label} requires Unix ownership checks`);
  let current = start;
  while (true) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${label} ancestor is not a real directory: ${current}`);
    }
    if (stat.uid !== 0 && stat.uid !== currentUid) {
      throw new Error(`${label} ancestor is owned by an untrusted account: ${current}`);
    }
    const sticky = (stat.mode & 0o1000) !== 0;
    if ((stat.mode & 0o002) !== 0 && !sticky) {
      throw new Error(`${label} ancestor is writable by other users: ${current}`);
    }
    if (
      (stat.mode & 0o020) !== 0 &&
      !sticky &&
      !groupIsExclusiveToCurrentUser(stat.gid, currentUid)
    ) {
      throw new Error(`${label} ancestor is writable by a shared group: ${current}`);
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function groupIsExclusiveToCurrentUser(gid: number, uid: number): boolean {
  const cached = exclusiveGroups.get(gid);
  if (cached !== undefined) return cached;
  let exclusive = false;
  try {
    const passwd = execFileSync("/usr/bin/getent", ["passwd"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    const group = execFileSync("/usr/bin/getent", ["group", String(gid)], {
      encoding: "utf8",
      timeout: 5_000,
    });
    const users = new Map<string, number>();
    exclusive = true;
    for (const line of passwd.split("\n")) {
      if (!line) continue;
      const fields = line.split(":");
      const name = fields[0];
      const accountUid = Number(fields[2]);
      const accountGid = Number(fields[3]);
      if (name && Number.isSafeInteger(accountUid)) users.set(name, accountUid);
      if (accountGid === gid && accountUid !== uid) {
        exclusive = false;
        break;
      }
    }
    if (exclusive) {
      const members = group.trim().split(":")[3]?.split(",").filter(Boolean) ?? [];
      exclusive = members.every((member) => users.get(member) === uid);
    }
  } catch {
    // If NSS membership cannot be proven, a group-writable authority path is not trusted.
    exclusive = false;
  }
  exclusiveGroups.set(gid, exclusive);
  return exclusive;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
