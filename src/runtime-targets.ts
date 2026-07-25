import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { chmod, lstat, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { syncDirectory } from "./durable-json.js";
import { assertTrustedAuthorityAncestors, ensurePrivateDirectory } from "./paths.js";
import { acquireProcessLease, releaseProcessLease } from "./process-lease.js";

const RUNTIME_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const SSH_DESTINATION = /^[A-Za-z0-9._@%+:[\]-]+$/;
const REMOTE_COMMAND = /^(?:[A-Za-z0-9._+-]+|\/[A-Za-z0-9._+/-]+)$/;

export interface LocalRuntimeTarget {
  readonly name: "local";
  readonly transport: "local";
  readonly kind: "local-service";
}

export interface EmbeddedRuntimeTarget {
  readonly name: "embedded";
  readonly transport: "embedded";
  readonly kind: "embedded";
}

export interface SshRuntimeTarget {
  readonly name: string;
  readonly transport: "ssh";
  readonly kind: "ssh-service";
  readonly destination: string;
  readonly command: string;
  readonly instanceId: string;
  readonly connectTimeoutSeconds: number;
}

export type RuntimeTarget =
  | LocalRuntimeTarget
  | EmbeddedRuntimeTarget
  | SshRuntimeTarget;

export interface RuntimeRegistry {
  readonly version: 1;
  readonly defaultRuntime?: string;
  readonly runtimes: Readonly<Record<string, SshRuntimeTarget>>;
}

export function runtimeRegistryPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.XDG_CONFIG_HOME) {
    return path.join(env.XDG_CONFIG_HOME, "jaeger", "runtimes.toml");
  }
  if (platform === "win32") {
    const root =
      env.APPDATA ??
      path.win32.join(env.USERPROFILE ?? os.homedir(), "AppData", "Roaming");
    return path.win32.join(root, "Jaeger", "runtimes.toml");
  }
  return path.join(os.homedir(), ".config", "jaeger", "runtimes.toml");
}

export function loadRuntimeRegistry(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): RuntimeRegistry {
  const target = runtimeRegistryPath(env, platform);
  let text: string;
  try {
    text = readPrivateConfig(target, platform);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { version: 1, runtimes: {} };
    throw new Error(`Invalid Jaeger runtime registry: ${target}`, { cause: error });
  }
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (error) {
    throw new Error(`Invalid Jaeger runtime registry: ${target}`, { cause: error });
  }
  const root = record(raw, "runtime registry");
  rejectUnknown(root, ["version", "default", "runtimes"], "runtime registry");
  if (root.version !== 1) throw new Error("Jaeger runtime registry version must be 1");
  const runtimesValue = root.runtimes === undefined
    ? {}
    : record(root.runtimes, "runtime registry runtimes");
  const runtimes: Record<string, SshRuntimeTarget> = {};
  for (const [name, value] of Object.entries(runtimesValue)) {
    runtimes[name] = parseSshRuntimeTarget(name, value);
  }
  const defaultRuntime =
    root.default === undefined
      ? undefined
      : stringValue(root.default, "runtime registry default");
  if (defaultRuntime !== undefined && !runtimes[defaultRuntime]) {
    throw new Error(
      `Jaeger runtime registry default ${defaultRuntime} is not a registered SSH runtime`,
    );
  }
  return {
    version: 1,
    ...(defaultRuntime ? { defaultRuntime } : {}),
    runtimes,
  };
}

export function resolveRuntimeTarget(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): RuntimeTarget {
  if (name === "local" || name === "service") {
    return { name: "local", transport: "local", kind: "local-service" };
  }
  if (name === "embedded") {
    return { name: "embedded", transport: "embedded", kind: "embedded" };
  }
  validateRuntimeName(name);
  const target = loadRuntimeRegistry(env, platform).runtimes[name];
  if (!target) {
    throw new Error(
      `Unknown Jaeger runtime ${name}; run 'jaeger runtime list' or register it with 'jaeger runtime add ${name} --ssh HOST'`,
    );
  }
  return target;
}

export async function saveRuntimeTarget(
  target: SshRuntimeTarget,
  options: {
    readonly force?: boolean;
    readonly makeDefault?: boolean;
    readonly env?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
  } = {},
): Promise<string> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const configPath = runtimeRegistryPath(env, platform);
  await ensureRuntimeRegistryDirectory(path.dirname(configPath), platform);
  const leasePath = path.join(path.dirname(configPath), "runtimes.lock");
  const lease = await acquireRuntimeRegistryLease(leasePath, platform);
  try {
    const current = loadRuntimeRegistry(env, platform);
    if (current.runtimes[target.name] && !options.force) {
      throw new Error(
        `Jaeger runtime ${target.name} already exists; rerun with --force to replace it`,
      );
    }
    const runtimes = {
      ...current.runtimes,
      [target.name]: target,
    };
    const defaultRuntime = options.makeDefault
      ? target.name
      : current.defaultRuntime;
    await writeRuntimeRegistry(configPath, runtimes, defaultRuntime, platform);
    return configPath;
  } finally {
    await releaseRuntimeRegistryLease(leasePath, lease, platform);
  }
}

export async function setDefaultRuntimeTarget(
  name: string,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
  } = {},
): Promise<string> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const configPath = runtimeRegistryPath(env, platform);
  await ensureRuntimeRegistryDirectory(path.dirname(configPath), platform);
  const leasePath = path.join(path.dirname(configPath), "runtimes.lock");
  const lease = await acquireRuntimeRegistryLease(leasePath, platform);
  try {
    const current = loadRuntimeRegistry(env, platform);
    const defaultRuntime = name === "local" || name === "service"
      ? undefined
      : name;
    if (defaultRuntime !== undefined && !current.runtimes[defaultRuntime]) {
      throw new Error(
        `Unknown Jaeger runtime ${defaultRuntime}; register it before making it the default`,
      );
    }
    await writeRuntimeRegistry(
      configPath,
      current.runtimes,
      defaultRuntime,
      platform,
    );
    return configPath;
  } finally {
    await releaseRuntimeRegistryLease(leasePath, lease, platform);
  }
}

export function provisionalSshRuntimeTarget(input: {
  readonly name: string;
  readonly destination: string;
  readonly command?: string;
  readonly instanceId?: string;
  readonly connectTimeoutSeconds?: number;
}): SshRuntimeTarget {
  validateRuntimeName(input.name);
  if (input.name === "local" || input.name === "service" || input.name === "embedded") {
    throw new Error(`Jaeger runtime name ${input.name} is reserved`);
  }
  const destination = input.destination;
  if (!SSH_DESTINATION.test(destination) || destination.startsWith("-")) {
    throw new Error("SSH destination must be one OpenSSH host alias or destination without spaces");
  }
  const command = input.command ?? "jaeger";
  if (!REMOTE_COMMAND.test(command) || command.includes("..")) {
    throw new Error(
      "Remote Jaeger command must be an executable name or absolute path without shell syntax",
    );
  }
  const instanceId = input.instanceId ?? "0".repeat(32);
  if (!/^[a-f0-9]{32}$/.test(instanceId)) {
    throw new Error("Remote Jaeger instance id is invalid");
  }
  const connectTimeoutSeconds = input.connectTimeoutSeconds ?? 10;
  if (
    !Number.isSafeInteger(connectTimeoutSeconds) ||
    connectTimeoutSeconds < 1 ||
    connectTimeoutSeconds > 60
  ) {
    throw new Error("SSH connect timeout must be between 1 and 60 seconds");
  }
  return {
    name: input.name,
    transport: "ssh",
    kind: "ssh-service",
    destination,
    command,
    instanceId,
    connectTimeoutSeconds,
  };
}

function parseSshRuntimeTarget(name: string, value: unknown): SshRuntimeTarget {
  const target = record(value, `runtime ${name}`);
  rejectUnknown(
    target,
    ["transport", "destination", "command", "instance_id", "connect_timeout_seconds"],
    `runtime ${name}`,
  );
  if (target.transport !== "ssh") {
    throw new Error(`Runtime ${name} transport must be ssh`);
  }
  return provisionalSshRuntimeTarget({
    name,
    destination: stringValue(target.destination, `runtime ${name} destination`),
    ...(target.command !== undefined
      ? { command: stringValue(target.command, `runtime ${name} command`) }
      : {}),
    instanceId: stringValue(target.instance_id, `runtime ${name} instance_id`),
    ...(target.connect_timeout_seconds !== undefined
      ? {
          connectTimeoutSeconds: integerValue(
            target.connect_timeout_seconds,
            `runtime ${name} connect_timeout_seconds`,
          ),
        }
      : {}),
  });
}

function readPrivateConfig(
  target: string,
  platform: NodeJS.Platform,
): string {
  const initial = lstatSync(target);
  if (
    !initial.isFile() ||
    initial.isSymbolicLink() ||
    (platform !== "win32" &&
      ((process.getuid && initial.uid !== process.getuid()) ||
        (initial.mode & 0o077) !== 0))
  ) {
    throw new Error(`Jaeger runtime registry is not a private owned regular file: ${target}`);
  }
  if (platform !== "win32") {
    assertTrustedAuthorityAncestors(
      path.dirname(path.resolve(target)),
      "Jaeger runtime registry",
    );
  }
  const descriptor = openSync(
    target,
    constants.O_RDONLY |
      (platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const opened = fstatSync(descriptor);
    if (
      opened.dev !== initial.dev ||
      opened.ino !== initial.ino ||
      !opened.isFile()
    ) {
      throw new Error(`Jaeger runtime registry changed while opening it: ${target}`);
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

async function atomicWrite(
  target: string,
  contents: string,
  platform: NodeJS.Platform,
): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporary, 0o600);
  try {
    await rename(temporary, target);
    if (platform !== "win32") await syncDirectory(path.dirname(target));
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function writeRuntimeRegistry(
  configPath: string,
  runtimes: Readonly<Record<string, SshRuntimeTarget>>,
  defaultRuntime: string | undefined,
  platform: NodeJS.Platform,
): Promise<void> {
  const serialized = stringifyToml({
    version: 1,
    ...(defaultRuntime ? { default: defaultRuntime } : {}),
    runtimes: Object.fromEntries(
      Object.values(runtimes)
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((runtime) => [
          runtime.name,
          {
            transport: "ssh",
            destination: runtime.destination,
            command: runtime.command,
            instance_id: runtime.instanceId,
            connect_timeout_seconds: runtime.connectTimeoutSeconds,
          },
        ]),
    ),
  });
  await atomicWrite(configPath, serialized, platform);
}

async function ensureRuntimeRegistryDirectory(
  directory: string,
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform !== "win32") {
    await ensurePrivateDirectory(
      directory,
      "Jaeger runtime configuration directory",
    );
    return;
  }
  await mkdir(directory, { recursive: true });
  const opened = await lstat(directory);
  if (!opened.isDirectory() || opened.isSymbolicLink()) {
    throw new Error(
      `Jaeger runtime configuration directory must be a real directory: ${directory}`,
    );
  }
}

type RuntimeRegistryLease =
  | Awaited<ReturnType<typeof acquireProcessLease>>
  | { readonly handle: Awaited<ReturnType<typeof open>> };

async function acquireRuntimeRegistryLease(
  leasePath: string,
  platform: NodeJS.Platform,
): Promise<RuntimeRegistryLease> {
  if (platform !== "win32") {
    return await acquireProcessLease(leasePath, { waitMs: 30_000 });
  }
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      const handle = await open(leasePath, "wx");
      try {
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
          "utf8",
        );
        return { handle };
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(leasePath).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const existing = await stat(leasePath).catch(() => undefined);
      if (existing && Date.now() - existing.mtimeMs > 60_000) {
        await unlink(leasePath).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for Jaeger runtime registry lock: ${leasePath}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function releaseRuntimeRegistryLease(
  leasePath: string,
  lease: RuntimeRegistryLease,
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform !== "win32") {
    await releaseProcessLease(
      leasePath,
      lease as Awaited<ReturnType<typeof acquireProcessLease>>,
    );
    return;
  }
  await (lease as { readonly handle: Awaited<ReturnType<typeof open>> }).handle.close();
  await unlink(leasePath).catch(() => undefined);
}

function validateRuntimeName(name: string): void {
  if (!RUNTIME_NAME.test(name)) {
    throw new Error(
      "Jaeger runtime name must start with a lowercase letter and contain only lowercase letters, numbers, hyphens, or underscores",
    );
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a table`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
  }
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function integerValue(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be an integer`);
  return value as number;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
