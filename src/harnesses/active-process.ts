import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { JournalCorruptionError } from "../errors.js";
import { systemctlCommand, systemdRunCommand } from "../launchers.js";

const RECORD_NAME = "process.json";
const PID_RECORD_NAME = "pid.json";
export const PROVIDER_TOKEN_ENV = "JAEGER_PROVIDER_TOKEN";

export type HarnessContainmentState = "active" | "inactive" | "unverifiable";

export interface ActiveHarnessProcess {
  readonly version: 2;
  readonly token: string;
  readonly unit: string;
  readonly platform: "linux";
  readonly startedAt: string;
  readonly recordPath: string;
  readonly pid?: number;
  readonly processStartId?: string;
}

/** Publish the cgroup identity before any provider process can be spawned. */
export function createHarnessLaunchIntent(transcriptDir: string): ActiveHarnessProcess {
  if (process.platform !== "linux") {
    throw new Error(
      "Jaeger provider containment currently requires Linux with a user systemd manager",
    );
  }
  const token = randomBytes(16).toString("hex");
  const recordPath = path.join(transcriptDir, RECORD_NAME);
  const unit = systemdUnitForTranscriptDir(transcriptDir);
  const record: ActiveHarnessProcess = {
    version: 2,
    token,
    unit,
    platform: "linux",
    startedAt: new Date().toISOString(),
    recordPath,
  };
  atomicCreateJson(recordPath, withoutRuntimeFields(record));
  return record;
}

/** Attach diagnostic PID identity without replacing the immutable intent. */
export function attachHarnessProcess(
  intent: ActiveHarnessProcess,
  pid: number,
): ActiveHarnessProcess {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new TypeError("provider launcher PID must be a positive integer");
  }
  const startId = linuxProcessStartId(pid);
  if (!startId) return intent;
  atomicCreateJson(path.join(path.dirname(intent.recordPath), PID_RECORD_NAME), {
    version: 1,
    token: intent.token,
    pid,
    processStartId: startId,
  });
  return { ...intent, pid, processStartId: startId };
}

export function clearActiveHarnessProcess(record: ActiveHarnessProcess): void {
  let current: ActiveHarnessProcess;
  try {
    current = readActiveHarnessProcess(record.recordPath);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  if (current.token !== record.token) return;
  for (const target of [
    path.join(path.dirname(record.recordPath), PID_RECORD_NAME),
    record.recordPath,
  ]) {
    try {
      unlinkSync(target);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  }
  syncDirectory(path.dirname(record.recordPath));
}

export function listActiveHarnessProcesses(runDir: string): readonly ActiveHarnessProcess[] {
  const harnessDir = path.join(runDir, "harness");
  let entries;
  try {
    entries = readdirSync(harnessDir, { withFileTypes: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
  const records: ActiveHarnessProcess[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const recordPath = path.join(harnessDir, entry.name, RECORD_NAME);
    try {
      records.push(readActiveHarnessProcess(recordPath));
    } catch (error) {
      if (!hasCode(error, "ENOENT") && !(error instanceof JournalCorruptionError)) throw error;
      // Provider scratch is not an authority source. A full-authority worker
      // can delete or corrupt its own intent, so deterministic systemd-unit
      // discovery below must remain usable without trusting this file.
    }
  }
  return records;
}

/**
 * Merge file intents with active transient units whose deterministic run prefix
 * survives provider-writable state deletion.
 */
export function discoverRunHarnessProcesses(
  runDir: string,
  runId: string,
): readonly ActiveHarnessProcess[] {
  const records = [...listActiveHarnessProcesses(runDir)];
  const known = new Set(records.map((record) => record.unit));
  for (const unit of listRunSystemdUnits(runId)) {
    if (known.has(unit)) continue;
    const digest = createHash("sha256").update(unit).digest("hex");
    records.push({
      version: 2,
      token: digest.slice(0, 32),
      unit,
      platform: "linux",
      startedAt: "discovered-from-systemd",
      recordPath: path.join(runDir, "harness", `.systemd-${digest.slice(0, 16)}`, RECORD_NAME),
    });
  }
  return records;
}

/** Resolve one provider containment without attributing unrelated run scopes. */
export function discoverHarnessProcess(transcriptDir: string): ActiveHarnessProcess {
  const resolved = path.resolve(transcriptDir);
  const recordPath = path.join(resolved, RECORD_NAME);
  try {
    return readActiveHarnessProcess(recordPath);
  } catch (error) {
    if (!hasCode(error, "ENOENT") && !(error instanceof JournalCorruptionError)) throw error;
  }
  const unit = systemdUnitForTranscriptDir(resolved);
  const digest = createHash("sha256").update(unit).digest("hex");
  return {
    version: 2,
    token: digest.slice(0, 32),
    unit,
    platform: "linux",
    startedAt: "discovered-from-transcript",
    recordPath,
  };
}

export function runOwnerContainment(runId: string): ActiveHarnessProcess {
  assertRunId(runId);
  const unit = `jaeger-run-${runId}.scope`;
  const digest = createHash("sha256").update(unit).digest("hex");
  return {
    version: 2,
    token: digest.slice(0, 32),
    unit,
    platform: "linux",
    startedAt: "deterministic-run-owner-scope",
    recordPath: `/run/jaeger/${unit}`,
  };
}

export function harnessContainmentState(record: ActiveHarnessProcess): HarnessContainmentState {
  if (record.platform !== process.platform) return "unverifiable";
  const unitState = systemdUnitState(record.unit);
  const tokenState = linuxTokenState(record.token);
  if (unitState === "active" || tokenState === "active") return "active";
  if (unitState === "unverifiable" || tokenState === "unverifiable") {
    return "unverifiable";
  }
  return "inactive";
}

export async function signalActiveHarnessProcess(
  record: ActiveHarnessProcess,
  signal: "SIGTERM" | "SIGKILL",
): Promise<void> {
  if (record.platform !== process.platform) {
    throw new Error(`cannot control ${record.platform} provider scope from ${process.platform}`);
  }
  let signalError: unknown;
  try {
    await signalSystemdUnit(record.unit, signal);
  } catch (error) {
    signalError = error;
  }
  for (const member of scanLinuxTokenMembers(record.token).members) {
    if (!linuxProcessHasIdentityAndToken(member.pid, member.processStartId, record.token)) continue;
    try {
      process.kill(member.pid, signal);
    } catch (error) {
      if (!hasCode(error, "ESRCH")) signalError ??= error;
    }
  }
  if (signalError) throw signalError;
}

export async function waitForHarnessProcessToStop(
  record: ActiveHarnessProcess,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (harnessContainmentState(record) === "inactive") return true;
    await delay(25);
  }
  return harnessContainmentState(record) === "inactive";
}

export function systemdScopeArgs(
  record: ActiveHarnessProcess,
  command: string,
  args: readonly string[],
): readonly string[] {
  return systemdUnitArgs(record.unit, command, args);
}

export function runOwnerSystemdScopeArgs(
  runId: string,
  command: string,
  args: readonly string[],
): readonly string[] {
  return systemdUnitArgs(runOwnerContainment(runId).unit, command, args);
}

function systemdUnitArgs(
  unit: string,
  command: string,
  args: readonly string[],
): readonly string[] {
  return [
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    `--unit=${unit}`,
    "--",
    command,
    ...args,
  ];
}

export function providerContainmentDoctor(): {
  readonly available: boolean;
  readonly kind: "systemd-user-scope";
  readonly error?: string;
};
export function providerContainmentDoctor(
  dependencies?: Partial<ContainmentDoctorDependencies>,
): {
  readonly available: boolean;
  readonly kind: "systemd-user-scope";
  readonly error?: string;
};
export function providerContainmentDoctor(
  dependencies: Partial<ContainmentDoctorDependencies> = {},
): {
  readonly available: boolean;
  readonly kind: "systemd-user-scope";
  readonly error?: string;
} {
  const operations = containmentDoctorDependencies(dependencies);
  if (operations.platform !== "linux") {
    return {
      available: false,
      kind: "systemd-user-scope",
      error: `unsupported platform ${operations.platform}`,
    };
  }

  const systemdRunCommandPath = systemdRunCommand();
  const systemdRun = operations.run(systemdRunCommandPath, ["--version"]);
  if (systemdRun.status !== 0) {
    return unavailableDoctorResult("systemd-run is unavailable", systemdRun);
  }
  const userManager = operations.run(systemctlCommand(), ["--user", "show-environment"]);
  if (userManager.status !== 0) {
    return unavailableDoctorResult("the systemd user manager is unavailable", userManager);
  }

  try {
    operations.readFile("/sys/fs/cgroup/cgroup.controllers");
    const memberships = operations
      .readFile("/proc/self/cgroup")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (memberships.length !== 1 || !/^0::\//.test(memberships[0] ?? "")) {
      return unavailableDoctorResult("the host is not using unified cgroup v2");
    }
  } catch (error) {
    return unavailableDoctorResult("unified cgroup v2 is unavailable", undefined, error);
  }

  const unit = `jaeger-doctor-probe-${process.pid}-${operations.randomHex()}.scope`;
  let probe: DoctorProbeProcess | undefined;
  try {
    probe = operations.start(systemdRunCommandPath, [
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      `--unit=${unit}`,
      "--",
      process.execPath,
      "-e",
      "setTimeout(() => process.exit(0), 10000)",
    ]);

    const controlGroup = waitForDoctorControlGroup(unit, operations);
    if (!controlGroup) {
      return unavailableDoctorResult(
        `transient user scope ${unit} did not expose a control group`,
      );
    }
    if (!controlGroup.startsWith("/") || controlGroup.includes("..")) {
      return unavailableDoctorResult(`systemd returned an invalid cgroup for ${unit}`);
    }
    const killPath = path.join("/sys/fs/cgroup", controlGroup, "cgroup.kill");
    try {
      operations.writeFile(killPath, "1");
    } catch (error) {
      return unavailableDoctorResult(
        `transient user scope ${unit} does not expose a controllable cgroup.kill`,
        undefined,
        error,
      );
    }
    if (!waitForDoctorScopeToStop(unit, operations)) {
      return unavailableDoctorResult(
        `cgroup.kill did not stop transient user scope ${unit}`,
      );
    }
    return { available: true, kind: "systemd-user-scope" };
  } catch (error) {
    return unavailableDoctorResult(`could not launch transient user scope ${unit}`, undefined, error);
  } finally {
    cleanupDoctorScope(unit, probe, operations);
  }
}

interface DoctorCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

interface DoctorProbeProcess {
  kill(signal: NodeJS.Signals): boolean;
}

interface ContainmentDoctorDependencies {
  readonly platform: NodeJS.Platform;
  readonly run: (command: string, args: readonly string[]) => DoctorCommandResult;
  readonly start: (command: string, args: readonly string[]) => DoctorProbeProcess;
  readonly readFile: (filePath: string) => string;
  readonly writeFile: (filePath: string, value: string) => void;
  readonly pause: (milliseconds: number) => void;
  readonly randomHex: () => string;
}

function containmentDoctorDependencies(
  overrides: Partial<ContainmentDoctorDependencies>,
): ContainmentDoctorDependencies {
  return {
    platform: process.platform,
    run: (command, args) => {
      const result = spawnSync(command, [...args], {
        encoding: "utf8",
        timeout: 5_000,
      });
      return {
        status: result.status,
        stdout: result.stdout || "",
        stderr: result.stderr || "",
        ...(result.error ? { error: result.error } : {}),
      };
    },
    start: (command, args) => {
      const child = spawn(command, [...args], { stdio: "ignore" });
      // A successful preflight can still race with removal of the executable.
      // The scope polling below reports that failure; do not let the child
      // process's asynchronous error event terminate the doctor process.
      child.on("error", () => undefined);
      return child;
    },
    readFile: (filePath) => readFileSync(filePath, "utf8"),
    writeFile: (filePath, value) => writeFileSync(filePath, value),
    pause: (milliseconds) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
    },
    randomHex: () => randomBytes(12).toString("hex"),
    ...overrides,
  };
}

function waitForDoctorControlGroup(
  unit: string,
  operations: ContainmentDoctorDependencies,
): string | undefined {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = operations.run(systemctlCommand(), [
      "--user",
      "show",
      unit,
      "--property=ControlGroup",
      "--value",
    ]);
    if (result.status === 0 && result.stdout.trim().length > 0) {
      return result.stdout.trim();
    }
    operations.pause(25);
  }
  return undefined;
}

function waitForDoctorScopeToStop(
  unit: string,
  operations: ContainmentDoctorDependencies,
): boolean {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = operations.run(systemctlCommand(), [
      "--user",
      "show",
      unit,
      "--property=ActiveState",
      "--value",
    ]);
    if (result.status === 4 || /not be found|not loaded/i.test(result.stderr)) return true;
    if (result.status === 0) {
      const state = result.stdout.trim();
      if (!["active", "activating", "deactivating", "reloading"].includes(state)) return true;
    }
    operations.pause(25);
  }
  return false;
}

function cleanupDoctorScope(
  unit: string,
  probe: DoctorProbeProcess | undefined,
  operations: ContainmentDoctorDependencies,
): void {
  operations.run(systemctlCommand(), [
    "--user",
    "kill",
    "--kill-whom=all",
    "--signal=KILL",
    unit,
  ]);
  operations.run(systemctlCommand(), ["--user", "stop", unit]);
  operations.run(systemctlCommand(), ["--user", "reset-failed", unit]);
  try {
    probe?.kill("SIGKILL");
  } catch {
    // The cgroup.kill probe normally terminates the systemd-run wrapper first.
  }
}

function unavailableDoctorResult(
  message: string,
  result?: DoctorCommandResult,
  cause?: unknown,
): {
  readonly available: false;
  readonly kind: "systemd-user-scope";
  readonly error: string;
} {
  const detail =
    result?.stderr.trim() ||
    result?.error?.message ||
    (cause instanceof Error ? cause.message : cause === undefined ? "" : String(cause)) ||
    (result ? `exited ${String(result.status)}` : "");
  return {
    available: false,
    kind: "systemd-user-scope",
    error: detail ? `${message}: ${detail}` : message,
  };
}

function readActiveHarnessProcess(recordPath: string): ActiveHarnessProcess {
  const value = readJson(recordPath, "provider containment intent");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new JournalCorruptionError(`Invalid provider containment intent at ${recordPath}`);
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 2 ||
    typeof candidate.token !== "string" ||
    !/^[a-f0-9]{32}$/.test(candidate.token) ||
    candidate.unit !== systemdUnitForTranscriptDir(path.dirname(recordPath)) ||
    candidate.platform !== "linux" ||
    typeof candidate.startedAt !== "string"
  ) {
    throw new JournalCorruptionError(`Invalid provider containment intent at ${recordPath}`);
  }
  const base: ActiveHarnessProcess = {
    version: 2,
    token: candidate.token,
    unit: candidate.unit,
    platform: "linux",
    startedAt: candidate.startedAt,
    recordPath,
  };
  const pidPath = path.join(path.dirname(recordPath), PID_RECORD_NAME);
  let pidValue: unknown;
  try {
    pidValue = readJson(pidPath, "provider launcher identity");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return base;
    throw error;
  }
  if (!pidValue || typeof pidValue !== "object" || Array.isArray(pidValue)) {
    throw new JournalCorruptionError(`Invalid provider launcher identity at ${pidPath}`);
  }
  const pid = pidValue as Record<string, unknown>;
  if (
    pid.version !== 1 ||
    pid.token !== base.token ||
    !Number.isSafeInteger(pid.pid) ||
    (pid.pid as number) <= 0 ||
    typeof pid.processStartId !== "string"
  ) {
    throw new JournalCorruptionError(`Invalid provider launcher identity at ${pidPath}`);
  }
  return {
    ...base,
    pid: pid.pid as number,
    processStartId: pid.processStartId,
  };
}

function readJson(filePath: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    if (hasCode(error, "ENOENT")) throw error;
    throw new JournalCorruptionError(`Invalid ${label} at ${filePath}`, { cause: error });
  }
}

function atomicCreateJson(target: string, value: unknown): void {
  const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error(`could not persist ${target}`);
      offset += written;
    }
    fsyncSync(descriptor);
    chmodSync(temporary, 0o600);
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporary, target);
    syncDirectory(path.dirname(target));
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {}
    throw error;
  }
}

function withoutRuntimeFields(
  record: ActiveHarnessProcess,
): Omit<ActiveHarnessProcess, "recordPath" | "pid" | "processStartId"> {
  const {
    recordPath: _recordPath,
    pid: _pid,
    processStartId: _processStartId,
    ...durable
  } = record;
  return durable;
}

function syncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function systemdUnitState(unit: string): HarnessContainmentState {
  const result = spawnSync(
    systemctlCommand(),
    ["--user", "show", unit, "--property=ActiveState", "--value"],
    { encoding: "utf8", timeout: 5_000 },
  );
  if (result.status === 0) {
    const state = result.stdout.trim();
    return ["active", "activating", "deactivating", "reloading"].includes(state)
      ? "active"
      : "inactive";
  }
  const error = `${result.stderr ?? ""} ${result.error?.message ?? ""}`;
  if (result.status === 4 || /not be found|not loaded/i.test(error)) return "inactive";
  return "unverifiable";
}

function listRunSystemdUnits(runId: string): readonly string[] {
  assertRunId(runId);
  const prefix = `jaeger-provider-${runId}-`;
  const result = spawnSync(
    systemctlCommand(),
    ["--user", "list-units", "--all", "--plain", "--no-legend", "--full", `${prefix}*.scope`],
    { encoding: "utf8", timeout: 5_000 },
  );
  if (result.status !== 0) {
    throw new Error(
      `could not enumerate provider scopes for ${runId}: ${(
        result.stderr ||
        result.error?.message ||
        `systemctl exited ${String(result.status)}`
      ).trim()}`,
    );
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/, 1)[0] ?? "")
    .filter(
      (unit) =>
        unit.startsWith(prefix) &&
        unit.endsWith(".scope") &&
        /^jaeger-provider-\d{14}-[a-f0-9]{10}-[a-f0-9]{16}\.scope$/.test(unit),
    );
}

function assertRunId(runId: string): void {
  if (!/^\d{14}-[a-f0-9]{10}$/.test(runId)) {
    throw new Error(`invalid run id for systemd containment discovery: ${runId}`);
  }
}

function systemdUnitForTranscriptDir(transcriptDir: string): string {
  const runDir = path.dirname(path.dirname(path.resolve(transcriptDir)));
  const runId = path.basename(runDir);
  const namespace = /^\d{14}-[a-f0-9]{10}$/.test(runId)
    ? runId
    : `adhoc-${createHash("sha256").update(runDir).digest("hex").slice(0, 16)}`;
  const digest = createHash("sha256").update(path.resolve(transcriptDir)).digest("hex").slice(0, 16);
  return `jaeger-provider-${namespace}-${digest}.scope`;
}

async function signalSystemdUnit(
  unit: string,
  signal: "SIGTERM" | "SIGKILL",
): Promise<void> {
  const controlGroup = systemdControlGroup(unit);
  if (!controlGroup) return;
  const cgroupPath = `/sys/fs/cgroup${controlGroup}`;
  if (signal === "SIGKILL") {
    try {
      // cgroup v2's kill switch terminates every member in this scope and all
      // nested cgroups atomically, including new-session descendants.
      writeFileSync(path.join(cgroupPath, "cgroup.kill"), "1");
      return;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      throw error;
    }
  }
  for (const pid of cgroupPids(cgroupPath)) {
    if (!processBelongsToCgroup(pid, controlGroup)) continue;
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (!hasCode(error, "ESRCH")) throw error;
    }
  }
}

function systemdControlGroup(unit: string): string | undefined {
  const result = spawnSync(
    systemctlCommand(),
    ["--user", "show", unit, "--property=ControlGroup", "--value"],
    { encoding: "utf8", timeout: 5_000 },
  );
  if (result.status === 0) {
    const group = result.stdout.trim();
    if (group.length === 0) return undefined;
    if (!group.startsWith("/") || group.includes("..")) {
      throw new Error(`systemd returned an invalid cgroup for ${unit}`);
    }
    return group;
  }
  const error = `${result.stderr ?? ""} ${result.error?.message ?? ""}`;
  if (result.status === 4 || /not be found|not loaded/i.test(error)) return undefined;
  throw new Error(`could not inspect provider scope ${unit}: ${error.trim()}`);
}

function cgroupPids(cgroupPath: string): readonly number[] {
  const pids: number[] = [];
  const visit = (directory: string): void => {
    try {
      for (const value of readFileSync(path.join(directory, "cgroup.procs"), "utf8").split(/\s+/)) {
        if (/^\d+$/.test(value)) pids.push(Number(value));
      }
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) visit(path.join(directory, entry.name));
      }
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  };
  visit(cgroupPath);
  return pids;
}

function processBelongsToCgroup(pid: number, controlGroup: string): boolean {
  try {
    const membership = readFileSync(`/proc/${pid}/cgroup`, "utf8");
    return membership
      .split("\n")
      .some((line) => line === `0::${controlGroup}` || line.startsWith(`0::${controlGroup}/`));
  } catch {
    return false;
  }
}

function linuxTokenState(token: string): HarnessContainmentState {
  const scan = scanLinuxTokenMembers(token);
  if (scan.members.length > 0) return "active";
  return scan.unverifiable ? "unverifiable" : "inactive";
}

function scanLinuxTokenMembers(token: string): {
  readonly members: ReadonlyArray<{ readonly pid: number; readonly processStartId: string }>;
  readonly unverifiable: boolean;
} {
  const members: Array<{ readonly pid: number; readonly processStartId: string }> = [];
  let unverifiable = false;
  const ownUid = process.getuid?.();
  for (const entry of readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    const processDir = path.join("/proc", entry.name);
    try {
      if (ownUid !== undefined && statSync(processDir).uid !== ownUid) continue;
      const environment = readFileSync(path.join(processDir, "environ"), "utf8");
      if (!environment.split("\0").includes(`${PROVIDER_TOKEN_ENV}=${token}`)) continue;
      const startId = linuxProcessStartId(pid);
      if (!startId) {
        unverifiable = true;
        continue;
      }
      members.push({ pid, processStartId: startId });
    } catch (error) {
      // Unrelated same-UID processes may deliberately make /proc/PID/environ
      // unreadable. The systemd cgroup remains the authoritative membership
      // source; this token scan only closes the pre-scope launcher window.
      if (hasCode(error, "ENOENT") || hasCode(error, "ESRCH")) continue;
    }
  }
  return { members, unverifiable };
}

function linuxProcessHasIdentityAndToken(pid: number, startId: string, token: string): boolean {
  if (linuxProcessStartId(pid) !== startId) return false;
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf8")
      .split("\0")
      .includes(`${PROVIDER_TOKEN_ENV}=${token}`);
  } catch {
    return false;
  }
}

function linuxProcessStartId(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closingParen = stat.lastIndexOf(")");
    if (closingParen < 0) return undefined;
    const fields = stat.slice(closingParen + 2).trim().split(/\s+/);
    if (fields[0] === "Z") return undefined;
    return fields[19];
  } catch {
    return undefined;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
