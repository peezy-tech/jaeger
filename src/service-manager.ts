import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { loadHarnessDefinitions } from "./harnesses/registry.js";
import { loadHookConfig } from "./hook-config.js";
import { loadRuntimeModuleConfig } from "./runtime-modules.js";
import {
  BACKEND_SERVICE_NAME,
  backendInstallConfigPath,
  backendPendingInstallConfigPath,
  backendServiceUnitPath,
  defaultBackendSocketPath,
  defaultPersistentStateDir,
  ensureDirectoryDurable,
  ensurePrivateDirectory,
  readBackendInstallConfig,
  readBackendInstallConfigFile,
  unconfiguredBackendSocketPath,
  type BackendInstallConfig,
} from "./paths.js";
import { acquireProcessLease, releaseProcessLease } from "./process-lease.js";
import { trustedDirectory, trustedRegularFile } from "./path-trust.js";
import { ServiceRuntimeClient } from "./runtime-client.js";
import type { JsonValue } from "./types.js";

const execFileAsync = promisify(execFile);

export interface BackendInstallOptions {
  readonly entrypoint: string;
  readonly socketPath?: string;
  readonly stateDir?: string;
  readonly harnessConfigPath?: string;
  readonly hooksConfigPath?: string;
  readonly runtimeModuleConfigPath?: string;
  readonly clearRuntimeModuleConfig?: boolean;
}

export async function installBackendService(options: BackendInstallOptions): Promise<JsonValue> {
  const configPath = backendInstallConfigPath();
  await preparePrivateOwnedDirectory(path.dirname(configPath));
  const installLeasePath = path.join(path.dirname(configPath), "backend.install.lock");
  const lease = await acquireProcessLease(installLeasePath, { waitMs: 30_000 });
  try {
    return await installBackendServiceLocked(options, configPath);
  } finally {
    await releaseProcessLease(installLeasePath, lease);
  }
}

async function installBackendServiceLocked(
  options: BackendInstallOptions,
  configPath: string,
): Promise<JsonValue> {
  const unitPath = backendServiceUnitPath();
  const pendingPath = backendPendingInstallConfigPath();
  const previousProfile = readBackendInstallConfig();
  const pendingProfile = readBackendInstallConfigFile(pendingPath);
  const fallbackProfile = pendingProfile ?? previousProfile;
  const socketPath = path.resolve(
    options.socketPath ??
      fallbackProfile?.socketPath ??
      process.env.JAEGER_SOCKET ??
      unconfiguredBackendSocketPath(),
  );
  const compatibilitySocketPath = path.resolve(
    previousProfile?.socketPath ?? unconfiguredBackendSocketPath(),
  );
  const stateDir = path.resolve(
    options.stateDir ?? fallbackProfile?.stateDir ?? defaultPersistentStateDir(),
  );
  const entrypoint = await trustedRegularFile(path.resolve(options.entrypoint), "Jaeger CLI entrypoint");
  const nodePath = await trustedRegularFile(process.execPath, "Node.js executable", true);
  const harnessConfigPath = options.harnessConfigPath
    ? path.resolve(options.harnessConfigPath)
    : fallbackProfile?.harnessConfigPath;
  const pinnedHarnessConfigPath = harnessConfigPath
    ? await trustedRegularFile(harnessConfigPath, "Jaeger harness configuration")
    : undefined;
  if (pinnedHarnessConfigPath) await loadHarnessDefinitions(pinnedHarnessConfigPath);
  const hooksConfigPath = options.hooksConfigPath
    ? path.resolve(options.hooksConfigPath)
    : fallbackProfile?.hooksConfigPath;
  const pinnedHooksConfigPath = hooksConfigPath
    ? await trustedRegularFile(hooksConfigPath, "Jaeger hooks configuration")
    : undefined;
  if (pinnedHooksConfigPath) await loadHookConfig(pinnedHooksConfigPath);
  const runtimeModuleConfigPath = options.clearRuntimeModuleConfig
    ? undefined
    : options.runtimeModuleConfigPath
      ? path.resolve(options.runtimeModuleConfigPath)
      : fallbackProfile?.runtimeModuleConfigPath;
  const pinnedRuntimeModuleConfigPath = runtimeModuleConfigPath
    ? await trustedRegularFile(
        runtimeModuleConfigPath,
        "Jaeger runtime module configuration",
      )
    : undefined;
  if (pinnedRuntimeModuleConfigPath) {
    await loadRuntimeModuleConfig(pinnedRuntimeModuleConfigPath);
  }
  const servicePath = await normalizedServicePath(process.env.PATH ?? "");
  const systemdRunPath = await executableOnPath("systemd-run", servicePath);
  const systemctlPath = await executableOnPath("systemctl", servicePath);
  const generation = randomBytes(16).toString("hex");
  const instanceId =
    fallbackProfile?.stateDir === stateDir && fallbackProfile.instanceId
      ? fallbackProfile.instanceId
      : randomBytes(16).toString("hex");
  const commonUnit = {
    entrypoint,
    nodePath,
    socketPath,
    stateDir,
    servicePath,
    systemdRunPath,
    systemctlPath,
    generation,
    instanceId,
    profilePath: configPath,
    ...(pinnedHarnessConfigPath ? { harnessConfigPath: pinnedHarnessConfigPath } : {}),
    ...(pinnedHooksConfigPath ? { hooksConfigPath: pinnedHooksConfigPath } : {}),
    ...(pinnedRuntimeModuleConfigPath
      ? { runtimeModuleConfigPath: pinnedRuntimeModuleConfigPath }
      : {}),
  } as const;
  const handoffUnit = renderBackendUnit({
    ...commonUnit,
    admissionPending: true,
    ...(compatibilitySocketPath !== socketPath ? { compatibilitySocketPath } : {}),
  });
  const finalUnit = renderBackendUnit(commonUnit);
  const config: BackendInstallConfig = {
    version: 4,
    socketPath,
    stateDir,
    entrypoint,
    ...(pinnedHarnessConfigPath ? { harnessConfigPath: pinnedHarnessConfigPath } : {}),
    ...(pinnedHooksConfigPath ? { hooksConfigPath: pinnedHooksConfigPath } : {}),
    ...(pinnedRuntimeModuleConfigPath
      ? { runtimeModuleConfigPath: pinnedRuntimeModuleConfigPath }
      : {}),
    generation,
    instanceId,
    systemctlPath,
    installedAt: new Date().toISOString(),
  };
  await prepareTrustedAuthorityDirectory(path.dirname(unitPath), "systemd user unit directory");
  await ensurePrivateDirectory(path.dirname(socketPath), "Jaeger backend socket directory");
  if (compatibilitySocketPath !== socketPath) {
    await ensurePrivateDirectory(
      path.dirname(compatibilitySocketPath),
      "Jaeger compatibility socket directory",
    );
  }
  await ensurePrivateDirectory(stateDir, "Jaeger state directory");
  const previousUnit = await readOptionalOwnedUnit(unitPath);
  const previousConfig = previousProfile
    ? `${JSON.stringify(previousProfile, null, 2)}\n`
    : undefined;
  const previousPending = await readOptional(pendingPath);
  await systemctl(systemctlPath, ["daemon-reload"]);
  const previousLifecycle = await serviceLifecycleState(systemctlPath);
  assertInstallTargetOwned(unitPath, previousUnit, previousLifecycle);
  try {
    await atomicWrite(pendingPath, `${JSON.stringify(config, null, 2)}\n`);
    await atomicWrite(unitPath, handoffUnit);
    await systemctl(systemctlPath, ["daemon-reload"]);
    await systemctl(systemctlPath, ["enable", BACKEND_SERVICE_NAME]);
    await systemctl(systemctlPath, ["restart", BACKEND_SERVICE_NAME]);
    await waitForManagedBackend(socketPath, systemctlPath, generation, false);
    await atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
  } catch (error) {
    const rollbackErrors = await rollbackInstall({
      unitPath,
      configPath,
      pendingPath,
      systemctlPath,
      ...(previousUnit !== undefined ? { previousUnit } : {}),
      ...(previousConfig !== undefined ? { previousConfig } : {}),
      ...(previousPending !== undefined ? { previousPending } : {}),
      previousLifecycle,
    });
    const message = rollbackErrors.length === 0
      ? "Jaeger backend installation failed and the previous service configuration and lifecycle were restored"
      : "Jaeger backend installation failed and rollback was incomplete";
    throw new AggregateError([error, ...rollbackErrors], message);
  }

  const warnings: string[] = [];
  await unlink(pendingPath).then(
    async () => await syncDirectory(path.dirname(pendingPath)),
    (error: unknown) => {
      if (!hasCode(error, "ENOENT")) warnings.push(`Could not remove pending profile: ${errorMessage(error)}`);
    },
  );
  try {
    await atomicWrite(unitPath, finalUnit);
    await systemctl(systemctlPath, ["daemon-reload"]);
    await systemctl(systemctlPath, ["restart", BACKEND_SERVICE_NAME]);
    await waitForManagedBackend(socketPath, systemctlPath, generation, true);
  } catch (error) {
    throw new AggregateError(
      [error],
      "Jaeger backend profile committed, but final service activation failed; rerun 'jaeger backend install' to reconcile it",
    );
  }
  const status = await waitForManagedBackend(socketPath, systemctlPath, generation, true);
  return jsonValue({
    installed: true,
    ...status,
    configuration: config,
    compatibilitySocketRetired: true,
    ...(warnings.length > 0 ? { warnings } : {}),
  });
}

export async function backendServiceStatus(
  socketPath = defaultBackendSocketPath(),
): Promise<Record<string, JsonValue>> {
  const profile = readBackendInstallConfig();
  const systemctlPath = await managementSystemctlPath(profile);
  const unit = await systemctlState(systemctlPath);
  let backend: Record<string, JsonValue> | undefined;
  let error: string | undefined;
  try {
    backend = backendDescriptor(
      await new ServiceRuntimeClient(socketPath, {
        timeoutMs: 750,
        ...(profile?.socketPath === socketPath && profile.generation
          ? { expectedGeneration: profile.generation }
          : {}),
        ...(profile?.socketPath === socketPath && profile.instanceId
          ? { expectedInstanceId: profile.instanceId }
          : {}),
      }).call("ping"),
    );
  } catch (failure) {
    error = errorMessage(failure);
  }
  const connectedPid = backend && typeof backend.pid === "number" ? backend.pid : undefined;
  const configurationMatches = !profile || profile.socketPath !== socketPath
    ? true
    : backend !== undefined && backendMatchesProfile(backend, profile);
  const active =
    unit.active &&
    unit.mainPid !== undefined &&
    connectedPid !== undefined &&
    unit.mainPid === connectedPid &&
    configurationMatches &&
    backend?.admissionReady === true;
  if (unit.active && backend && !active) {
    error = !configurationMatches
      ? "Backend process configuration does not match the committed Jaeger profile; run 'jaeger backend install'"
      : backend.admissionReady !== true
        ? "Backend process is waiting for its installation profile to commit; run 'jaeger backend install'"
        : `Backend socket PID ${String(connectedPid)} does not match systemd MainPID ${String(unit.mainPid)}`;
  }
  return {
    schemaVersion: 1,
    active,
    unitActive: unit.active,
    connected: backend !== undefined,
    service: {
      name: BACKEND_SERVICE_NAME,
      unitPath: backendServiceUnitPath(),
      ...(unit.mainPid !== undefined ? { mainPid: unit.mainPid } : {}),
    },
    socketPath,
    ...(backend ? { backend } : {}),
    ...(error ? { error } : {}),
  };
}

export async function restartBackendService(
  socketPath = defaultBackendSocketPath(),
): Promise<Record<string, JsonValue>> {
  const configPath = backendInstallConfigPath();
  await preparePrivateOwnedDirectory(path.dirname(configPath));
  const leasePath = path.join(path.dirname(configPath), "backend.install.lock");
  const lease = await acquireProcessLease(leasePath, { waitMs: 30_000 });
  try {
    const profile = readBackendInstallConfig();
    const systemctlPath = await managementSystemctlPath(profile);
    await systemctl(systemctlPath, ["restart", BACKEND_SERVICE_NAME]);
    return await waitForManagedBackend(
      socketPath,
      systemctlPath,
      profile?.socketPath === socketPath ? profile.generation : undefined,
      profile?.socketPath === socketPath && profile?.generation !== undefined,
    );
  } finally {
    await releaseProcessLease(leasePath, lease);
  }
}

export function renderBackendUnit(input: {
  readonly entrypoint: string;
  readonly nodePath: string;
  readonly socketPath: string;
  readonly stateDir: string;
  readonly servicePath: string;
  readonly systemdRunPath: string;
  readonly systemctlPath: string;
  readonly generation: string;
  readonly instanceId: string;
  readonly profilePath: string;
  readonly admissionPending?: boolean;
  readonly compatibilitySocketPath?: string;
  readonly harnessConfigPath?: string;
  readonly hooksConfigPath?: string;
  readonly runtimeModuleConfigPath?: string;
}): string {
  const args = [
    path.resolve(input.entrypoint),
    "__backend",
    "--socket",
    path.resolve(input.socketPath),
    ...(input.compatibilitySocketPath
      ? ["--compat-socket", path.resolve(input.compatibilitySocketPath)]
      : []),
    "--state-dir",
    path.resolve(input.stateDir),
    "--generation",
    input.generation,
    "--instance-id",
    input.instanceId,
    "--profile-path",
    path.resolve(input.profilePath),
    ...(input.admissionPending ? ["--admission-pending"] : []),
    ...(input.harnessConfigPath
      ? ["--harness-config", path.resolve(input.harnessConfigPath)]
      : []),
    ...(input.hooksConfigPath
      ? ["--hooks-config", path.resolve(input.hooksConfigPath)]
      : []),
    ...(input.runtimeModuleConfigPath
      ? ["--runtime-config", path.resolve(input.runtimeModuleConfigPath)]
      : []),
  ];
  return `[Unit]
Description=Jaeger persistent workflow backend

[Service]
Type=simple
ExecStart=${[path.resolve(input.nodePath), ...args].map(systemdExecQuote).join(" ")}
Environment=${systemdEnvironmentQuote(`PATH=${input.servicePath}`)}
Environment=${systemdEnvironmentQuote(`JAEGER_SYSTEMD_RUN=${path.resolve(input.systemdRunPath)}`)}
Environment=${systemdEnvironmentQuote(`JAEGER_SYSTEMCTL=${path.resolve(input.systemctlPath)}`)}
Restart=on-failure
RestartSec=1
TimeoutStopSec=15
UMask=0077

[Install]
WantedBy=default.target
`;
}

async function waitForManagedBackend(
  socketPath: string,
  systemctlPath: string,
  generation: string | undefined,
  requireCommitted: boolean,
): Promise<Record<string, JsonValue>> {
  const deadline = Date.now() + 10_000;
  let latest: Record<string, JsonValue> | undefined;
  let failure: unknown;
  while (Date.now() < deadline) {
    try {
      const unit = await systemctlState(systemctlPath);
      const backend = backendDescriptor(
        await new ServiceRuntimeClient(socketPath, {
          timeoutMs: 500,
          ...(generation ? { expectedGeneration: generation } : {}),
        }).call("ping"),
      );
      const connectedPid = typeof backend.pid === "number" ? backend.pid : undefined;
      const active =
        unit.active &&
        unit.mainPid !== undefined &&
        connectedPid === unit.mainPid &&
        (!generation || backend.generation === generation) &&
        (!requireCommitted || backend.admissionReady === true);
      latest = {
        schemaVersion: 1,
        active,
        unitActive: unit.active,
        connected: true,
        service: {
          name: BACKEND_SERVICE_NAME,
          unitPath: backendServiceUnitPath(),
          ...(unit.mainPid !== undefined ? { mainPid: unit.mainPid } : {}),
        },
        socketPath,
        backend,
      };
      if (active) return latest;
    } catch (error) {
      failure = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Jaeger systemd service did not own the expected backend configuration: ${JSON.stringify(latest ?? {})}${failure ? `: ${errorMessage(failure)}` : ""}`,
  );
}

async function systemctl(command: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, ["--user", ...args], {
      encoding: "utf8",
      timeout: 15_000,
    });
    return stdout;
  } catch (error) {
    throw new Error(
      `systemctl --user ${args.join(" ")} failed: ${commandFailureDetail(error)}`,
      { cause: error },
    );
  }
}

async function systemctlState(command: string): Promise<{
  readonly active: boolean;
  readonly mainPid?: number;
}> {
  const observed = await systemctlQuery(command, ["is-active", BACKEND_SERVICE_NAME]);
  if (observed !== "active") {
    if (
      observed === undefined ||
      ["inactive", "failed", "activating", "deactivating", "reloading", "maintenance", "unknown", "not-found"]
        .includes(observed)
    ) {
      return { active: false };
    }
    throw new Error(`systemctl returned an unexpected active state for ${BACKEND_SERVICE_NAME}: ${observed}`);
  }
  const value = (
    await systemctl(command, ["show", BACKEND_SERVICE_NAME, "--property=MainPID", "--value"])
  ).trim();
  const mainPid = Number(value);
  if (!Number.isSafeInteger(mainPid) || mainPid <= 0) {
    throw new Error(`Active ${BACKEND_SERVICE_NAME} has an invalid systemd MainPID: ${value}`);
  }
  return { active: true, mainPid };
}

async function rollbackInstall(input: {
  readonly unitPath: string;
  readonly configPath: string;
  readonly pendingPath: string;
  readonly systemctlPath: string;
  readonly previousUnit?: string;
  readonly previousConfig?: string;
  readonly previousPending?: string;
  readonly previousLifecycle: ServiceLifecycleState;
}): Promise<unknown[]> {
  const errors: unknown[] = [];
  if (input.previousUnit === undefined) {
    try {
      await systemctl(input.systemctlPath, ["disable", "--now", BACKEND_SERVICE_NAME]);
    } catch (error) {
      if (!/not loaded|does not exist|no such file/i.test(errorMessage(error))) errors.push(error);
    }
  }
  try {
    if (input.previousUnit === undefined) {
      await unlink(input.unitPath).catch(ignoreMissing);
      await syncDirectory(path.dirname(input.unitPath));
    }
    else await atomicWrite(input.unitPath, input.previousUnit);
  } catch (error) {
    errors.push(error);
  }
  try {
    if (input.previousConfig === undefined) {
      await unlink(input.configPath).catch(ignoreMissing);
      await syncDirectory(path.dirname(input.configPath)).catch(ignoreMissing);
    }
    else {
      await mkdir(path.dirname(input.configPath), { recursive: true, mode: 0o700 });
      await atomicWrite(input.configPath, input.previousConfig);
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    if (input.previousPending === undefined) {
      await unlink(input.pendingPath).catch(ignoreMissing);
      await syncDirectory(path.dirname(input.pendingPath)).catch(ignoreMissing);
    } else await atomicWrite(input.pendingPath, input.previousPending);
  } catch (error) {
    errors.push(error);
  }
  await captureRollbackError(
    errors,
    async () => await systemctl(input.systemctlPath, ["daemon-reload"]),
  );
  if (input.previousUnit !== undefined) {
    await captureRollbackError(errors, async () => {
      if (input.previousLifecycle.enabledState === "enabled-runtime") {
        await systemctl(input.systemctlPath, ["disable", BACKEND_SERVICE_NAME]);
        await systemctl(input.systemctlPath, ["--runtime", "disable", BACKEND_SERVICE_NAME]);
        await systemctl(input.systemctlPath, ["--runtime", "enable", BACKEND_SERVICE_NAME]);
      } else {
        await systemctl(input.systemctlPath, [
          input.previousLifecycle.enabledState === "enabled" ? "enable" : "disable",
          BACKEND_SERVICE_NAME,
        ]);
      }
    });
    await captureRollbackError(errors, async () => {
      await systemctl(input.systemctlPath, [
        input.previousLifecycle.active ? "restart" : "stop",
        BACKEND_SERVICE_NAME,
      ]);
    });
  }
  return errors;
}

async function readOptional(target: string): Promise<string | undefined> {
  try {
    return await readFile(target, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function atomicWrite(target: string, contents: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  let published = false;
  try {
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    await syncDirectory(path.dirname(target));
    published = true;
  } finally {
    if (!published) await unlink(temporary).catch(ignoreMissing);
  }
}

interface ServiceLifecycleState {
  readonly exists: boolean;
  readonly fragmentPath?: string;
  readonly enabledState: "enabled" | "enabled-runtime" | "disabled";
  readonly active: boolean;
}

async function serviceLifecycleState(command: string): Promise<ServiceLifecycleState> {
  const loadState = await systemctlQuery(command, [
    "show",
    BACKEND_SERVICE_NAME,
    "--property=LoadState",
    "--value",
  ]);
  if (loadState === undefined || loadState === "not-found") {
    return { exists: false, active: false, enabledState: "disabled" };
  }
  if (loadState !== "loaded") {
    throw new Error(
      `Refusing to replace ${BACKEND_SERVICE_NAME} with systemd load state ${loadState}`,
    );
  }
  const fragment = await systemctlQuery(command, [
    "show",
    BACKEND_SERVICE_NAME,
    "--property=FragmentPath",
    "--value",
  ]);
  const fragmentPath = fragment ? path.resolve(fragment) : undefined;
  const activeState = await systemctlQuery(command, ["is-active", BACKEND_SERVICE_NAME]);
  if (activeState !== "active" && activeState !== "inactive") {
    throw new Error(
      `Refusing to replace ${BACKEND_SERVICE_NAME} with non-stable active state ${activeState ?? "unknown"}`,
    );
  }
  const active = activeState === "active";
  const observed = await systemctlQuery(command, ["is-enabled", BACKEND_SERVICE_NAME]);
  if (observed !== "enabled" && observed !== "enabled-runtime" && observed !== "disabled") {
    throw new Error(
      `Refusing to replace ${BACKEND_SERVICE_NAME} with systemd enablement state ${observed ?? "unknown"}`,
    );
  }
  return {
    exists: true,
    ...(fragmentPath ? { fragmentPath } : {}),
    active,
    enabledState: observed === "enabled-runtime"
      ? "enabled-runtime"
      : observed === "enabled"
        ? "enabled"
        : "disabled",
  };
}

async function systemctlQuery(command: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(command, ["--user", ...args], {
      encoding: "utf8",
      timeout: 15_000,
    });
    return stdout.trim();
  } catch (error) {
    if (error && typeof error === "object" && "stdout" in error) {
      const stdout = (error as { readonly stdout?: unknown }).stdout;
      if (typeof stdout === "string" && stdout.trim().length > 0) return stdout.trim();
    }
    const stderr = error && typeof error === "object" && "stderr" in error
      ? (error as { readonly stderr?: unknown }).stderr
      : undefined;
    if (
      typeof stderr === "string" &&
      /could not be found|not found|not loaded|does not exist|no such file/i.test(stderr) &&
      (args[0] === "is-active" || args[0] === "is-enabled" || args[0] === "show")
    ) {
      return undefined;
    }
    throw new Error(
      `Could not snapshot systemd user-unit state before installation: ${commandFailureDetail(error)}`,
      { cause: error },
    );
  }
}

async function preparePrivateOwnedDirectory(directory: string): Promise<void> {
  await ensureDirectoryDurable(directory);
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (stat.mode & 0o022) !== 0
  ) {
    throw new Error(`Jaeger configuration directory must be a non-writable real directory owned by the current user: ${directory}`);
  }
  await chmod(directory, 0o700);
  await ensurePrivateDirectory(directory, "Jaeger configuration directory");
}

async function prepareTrustedAuthorityDirectory(directory: string, label: string): Promise<void> {
  const resolved = path.resolve(directory);
  await ensureDirectoryDurable(resolved);
  const canonical = await trustedDirectory(resolved, label);
  if (canonical !== resolved) {
    throw new Error(`${label} must not contain a symlinked ancestor: ${resolved}`);
  }
}

async function readOptionalOwnedUnit(target: string): Promise<string | undefined> {
  let stat;
  try {
    stat = await lstat(target);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
  const currentUid = process.getuid?.();
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    currentUid === undefined ||
    stat.uid !== currentUid ||
    (stat.mode & 0o022) !== 0
  ) {
    throw new Error(
      `Refusing to replace non-regular, unowned, or writable systemd unit path: ${target}`,
    );
  }
  return await readFile(target, "utf8");
}

function assertInstallTargetOwned(
  unitPath: string,
  previousUnit: string | undefined,
  lifecycle: ServiceLifecycleState,
): void {
  if (previousUnit === undefined) {
    if (lifecycle.exists) {
      throw new Error(
        `Refusing to shadow existing ${BACKEND_SERVICE_NAME} from ${lifecycle.fragmentPath ?? "another systemd source"}`,
      );
    }
    return;
  }
  if (!lifecycle.exists || lifecycle.fragmentPath !== path.resolve(unitPath)) {
    throw new Error(
      `Refusing to replace ${BACKEND_SERVICE_NAME} because systemd does not resolve it to ${unitPath}`,
    );
  }
}

async function normalizedServicePath(rawPath: string): Promise<string> {
  const normalized: string[] = [];
  for (const entry of rawPath.split(path.delimiter)) {
    if (!entry || !path.isAbsolute(entry)) {
      throw new Error(
        "PATH used to install the Jaeger backend must contain only non-empty absolute directories",
      );
    }
    if (entry.includes("\0") || entry.includes("\n") || entry.includes("\r")) {
      throw new Error("PATH used to install the Jaeger backend contains a control character");
    }
    let canonical: string;
    try {
      canonical = await trustedDirectory(entry, "Backend PATH entry");
    } catch (error) {
      if (hasCode(error, "ENOENT")) continue;
      throw error;
    }
    if (!normalized.includes(canonical)) normalized.push(canonical);
  }
  if (normalized.length === 0) throw new Error("Jaeger backend installation requires a non-empty PATH");
  return normalized.join(path.delimiter);
}

async function executableOnPath(command: string, searchPath: string): Promise<string> {
  for (const directory of searchPath.split(path.delimiter)) {
    const candidate = path.join(directory, command);
    try {
      return await trustedRegularFile(candidate, command, true);
    } catch {
      // Continue to the next pinned absolute PATH element.
    }
  }
  throw new Error(`Could not resolve ${command} from the normalized install PATH`);
}

async function managementSystemctlPath(
  profile: BackendInstallConfig | undefined,
): Promise<string> {
  if (profile?.systemctlPath) {
    return await trustedRegularFile(profile.systemctlPath, "systemctl", true);
  }
  return await executableOnPath(
    "systemctl",
    await normalizedServicePath(process.env.PATH ?? ""),
  );
}

function backendMatchesProfile(
  backend: Record<string, JsonValue>,
  profile: BackendInstallConfig,
): boolean {
  return (
    backend.stateDir === profile.stateDir &&
    backend.entrypoint === profile.entrypoint &&
    (profile.generation === undefined || backend.generation === profile.generation) &&
    (profile.instanceId === undefined || backend.instanceId === profile.instanceId) &&
    (profile.harnessConfigPath === undefined
      ? backend.harnessConfigPath === undefined
      : backend.harnessConfigPath === profile.harnessConfigPath) &&
    (profile.hooksConfigPath === undefined
      ? backend.hooksConfigPath === undefined
      : backend.hooksConfigPath === profile.hooksConfigPath) &&
    (profile.runtimeModuleConfigPath === undefined
      ? backend.runtimeModuleConfigPath === undefined
      : backend.runtimeModuleConfigPath === profile.runtimeModuleConfigPath)
  );
}

async function captureRollbackError(
  errors: unknown[],
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    errors.push(error);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function backendDescriptor(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Jaeger backend returned an invalid readiness envelope");
  }
  const descriptor = value.backend;
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new Error("Jaeger backend readiness envelope has no descriptor");
  }
  return descriptor;
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function systemdExecQuote(value: string): string {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error("A Jaeger service argument contains a forbidden control character");
  }
  return `"${value.replace(/%/g, "%%").replace(/\$/g, () => "$$").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function systemdEnvironmentQuote(value: string): string {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error("A Jaeger service environment value contains a forbidden control character");
  }
  return `"${value.replace(/%/g, "%%").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function commandFailureDetail(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const candidate = error as {
    readonly stderr?: unknown;
    readonly stdout?: unknown;
    readonly message?: unknown;
    readonly code?: unknown;
  };
  const detail = [candidate.stderr, candidate.stdout, candidate.message]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim())
    .join("; ");
  return detail || `exit ${String(candidate.code)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function ignoreMissing(error: unknown): void {
  if (!hasCode(error, "ENOENT")) throw error;
}
