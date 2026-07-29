#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveBackend } from "./backend-server.js";
import { BackendRpcError } from "./backend-protocol.js";
import { compileWorkflowSource } from "./compiler.js";
import { HarnessExecutionError, RunStoppedError } from "./errors.js";
import { LocalRuntimeService } from "./local-runtime-service.js";
import {
  defaultBackendSocketPath,
  defaultPersistentStateDir,
  readBackendInstallConfig,
} from "./paths.js";
import {
  EmbeddedRuntimeClient,
  ServiceRuntimeClient,
  type RuntimeClient,
} from "./runtime-client.js";
import { executePreparedRun } from "./runtime.js";
import { executeSessionTurnWorker } from "./session-turns.js";
import {
  createSessionQueryId,
  executeSessionQueryWorker,
} from "./session-queries.js";
import {
  activeEnvironment,
  applyEnvironment,
  defaultEnvironmentPaths,
  inspectEnvironmentStatus,
  listEnvironments,
  loadEnvironmentPlan,
  uninstallEnvironment,
  type EnvironmentPaths,
} from "./environments.js";
import {
  backendServiceStatus,
  installBackendService,
  restartBackendService,
} from "./service-manager.js";
import type { JsonValue } from "./types.js";
import { loadScheduleApplication } from "./schedules.js";
import { collectStatus, renderStatus } from "./status.js";
import { loadHookConfig } from "./hook-config.js";
import { loadRuntimeModuleConfig } from "./runtime-modules.js";
import {
  addModules,
  defaultModuleProjectRoot,
  diffModule,
  listInstalledModules,
  removeModules,
  resolveModuleItem,
  syncModules,
} from "./module-registry.js";
import { runStdioBridge } from "./stdio-bridge.js";
import { SshRuntimeClient } from "./ssh-runtime-client.js";
import {
  loadRuntimeRegistry,
  provisionalSshRuntimeTarget,
  resolveRuntimeTarget,
  runtimeRegistryPath,
  saveRuntimeTarget,
  setDefaultRuntimeTarget,
  type RuntimeTarget,
  type SshRuntimeTarget,
} from "./runtime-targets.js";
import {
  assertLocalRuntimeSupported,
  supportsLocalRuntime,
} from "./platform.js";

const ENTRYPOINT = fileURLToPath(import.meta.url);

const HELP = `Jaeger prompt-first cross-harness workflows

Usage:
  jaeger
  jaeger status [--json]
  jaeger runtime list [--json]
  jaeger runtime inspect <name> [--json]
  jaeger runtime doctor <name> [--json]
  jaeger runtime default [<name>|local] [--json]
  jaeger runtime add <name> --ssh <destination> [--jaeger COMMAND]
                     [--connect-timeout SECONDS] [--default] [--force] [--json]
  jaeger run <workflow.js|workflow.ts> [--input FILE|-] [--cwd DIR]
             [--state-dir DIR] [--max-concurrency N] [--detach]
             [--harness-config FILE] [--submission-id ID]
  jaeger resume <run-id> [--state-dir DIR] [--detach]
  jaeger submission <submission-id> [--state-dir DIR]
  jaeger inspect <run-id> [--state-dir DIR] [--summary] [--json]
                 [--events] [--step STEP_ID] [--transcript stdout|stderr]
  jaeger wait <run-id> [--state-dir DIR] [--json]
  jaeger stop <run-id> [--state-dir DIR] [--json]
  jaeger list [--state-dir DIR] [--limit N] [--json]
  jaeger session list <run-id> [--state-dir DIR] [--json]
  jaeger session inspect <run-id> <session> [--state-dir DIR] [--json]
  jaeger session resume <run-id> <session> --message TEXT|- [--state-dir DIR]
                          [--timeout-ms N] [--request-id ID] [--detach] [--json]
  jaeger session query <run-id> <session> --message TEXT|- [--model MODEL]
                         [--timeout-ms N] [--request-id ID] [--detach] [--json]
  jaeger session query inspect <run-id> <query-id> [--json]
  jaeger session query wait <run-id> <query-id> [--json]
  jaeger session turn inspect <run-id> <turn-id> [--state-dir DIR] [--json]
  jaeger session turn wait <run-id> <turn-id> [--state-dir DIR] [--json]
  jaeger session steer <run-id> <session> --message TEXT|- [--state-dir DIR]
  jaeger session interrupt <run-id> <session> [--state-dir DIR]
  jaeger validate <workflow.js|workflow.ts>
  jaeger schedule validate <schedule.toml>
  jaeger schedule apply <schedule.toml> [--activate]
  jaeger schedule list [--json]
  jaeger schedule inspect <name> [--json]
  jaeger schedule enable <name> [--json]
  jaeger schedule disable <name> [--json]
  jaeger schedule remove <name> [--json]
  jaeger schedule history <name> [--limit N] [--json]
  jaeger schedule trigger <name> [--request-id ID] [--json]
  jaeger hooks validate <hooks.toml> [--json]
  jaeger hooks status [--json]
  jaeger hooks history [--hook NAME] [--event ID] [--limit N] [--json]
  jaeger modules validate <jaeger.runtime.mjs> [--json]
  jaeger modules view <name|source> [--json]
  jaeger modules add <name|source>... [--root DIR] [--dry-run] [--no-install]
                     [--overwrite] [--json]
  jaeger modules list [--root DIR] [--json]
  jaeger modules diff <name> [--root DIR] [--json]
  jaeger modules remove <name>... [--root DIR] [--dry-run] [--no-install]
                        [--force] [--json]
  jaeger modules sync [--root DIR] [--dry-run] [--no-install] [--json]
  jaeger modules status [--json]
  jaeger env list [--config-root DIR] [--json]
  jaeger env inspect <name> [--file FILE] [--config-root DIR] [--state-root DIR] [--json]
  jaeger env status [--state-root DIR] [--json]
  jaeger env check <name> [--file FILE] [--config-root DIR] [--state-root DIR] [--json]
  jaeger env diff <name> [--file FILE] [--config-root DIR] [--state-root DIR]
  jaeger env apply <name> [--file FILE] [--config-root DIR] [--state-root DIR] [--force] [--json]
  jaeger env uninstall [name] [--state-root DIR] [--force] [--json]
  jaeger doctor [--harness-config FILE]
  jaeger backend install [--state-dir DIR] [--socket PATH]
                         [--harness-config FILE] [--hooks-config FILE]
                         [--runtime-config FILE|--clear-runtime-config]
  jaeger backend status [--socket PATH]
  jaeger backend restart [--socket PATH]

On Linux, the installed CLI uses the persistent local backend by default. Windows
is supported as an SSH controller and requires a named Linux runtime selected by
--runtime NAME, JAEGER_RUNTIME, or 'jaeger runtime default NAME'. A
target-qualified run id also selects its registered runtime. Embedded mode is
Linux-only debugging and legacy operation. --detach controls whether the CLI
waits; it does not select the runtime. --state-dir applies only to embedded
operation. Workflow workers retain full non-interactive technical authority.
Standing schedules require a persistent backend.
`;

async function main(rawArgv: string[]): Promise<void> {
  const selection = parseRuntimeSelection(rawArgv);
  const argv = selection.argv;
  const command = argv[0];
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (command === "__worker") {
    await runInternalWorker(argv.slice(1));
    return;
  }
  if (command === "__session-worker") {
    await runInternalSessionWorker(argv.slice(1));
    return;
  }
  if (command === "__query-worker") {
    await runInternalQueryWorker(argv.slice(1));
    return;
  }
  if (command === "__backend") {
    await runBackendServer(argv.slice(1));
    return;
  }
  if (command === "__rpc-stdio") {
    await runStdioBridge();
    return;
  }
  if (command === "runtime") {
    await runtimeCommand(argv.slice(1));
    return;
  }
  if (command === "backend") {
    assertLocalRuntimeSupported("Backend management");
    if (selection.name !== "local" && selection.name !== "service") {
      throw new Error(
        "Backend install, status, and restart are host-local operations; run them through an interactive SSH shell on the target host",
      );
    }
    await backendCommand(argv.slice(1));
    return;
  }
  if (command === "validate") {
    await validateCommand(argv.slice(1));
    return;
  }
  if (command === "env") {
    assertLocalRuntimeSupported("Environment management");
    await envCommand(argv.slice(1));
    return;
  }
  if (
    command === "modules" &&
    argv[1] !== "status"
  ) {
    // validate and view only read a local file or a registry manifest, so they
    // run locally for every runtime selection. The module project actions
    // mutate or inspect the host's project directory.
    const localOnlyAction = ["add", "diff", "list", "remove", "sync"].includes(
      argv[1] ?? "",
    );
    if (localOnlyAction) {
      if (selection.name !== "local") {
        throw new Error(
          "Module project management is host-local; run it through an interactive SSH shell on the target host",
        );
      }
      assertLocalRuntimeSupported("Module project management");
    }
    await modulesLocalCommand(argv.slice(1));
    return;
  }
  const routed = routeQualifiedRuntime(argv, selection);
  const target = resolveRuntimeTarget(routed.name);
  const client = runtimeClient(target);
  if (!command || command === "status") {
    const statusArgs = command === "status" ? routed.argv.slice(1) : [];
    if (statusArgs.some((option) => option !== "--json")) {
      throw new Error(`Unknown status option: ${String(statusArgs[0])}`);
    }
    const status = await collectStatus(client, target);
    if (statusArgs.includes("--json")) writeJson(status);
    else {
      process.stdout.write(
        renderStatus(status, {
          color: process.stdout.isTTY && !("NO_COLOR" in process.env),
        }),
      );
    }
    return;
  }
  if (command === "hooks") {
    await hooksCommand(client, routed.argv.slice(1));
    return;
  }
  if (command === "modules") {
    await modulesCommand(client, routed.argv.slice(1));
    return;
  }

  if (command === "doctor") {
    const requestedHarnessConfigPath = parseDoctorArgs(routed.argv.slice(1));
    const harnessConfigPath = requestedHarnessConfigPath
      ? client.remote
        ? requireRemoteAbsolutePath(requestedHarnessConfigPath, "--harness-config")
        : path.resolve(requestedHarnessConfigPath)
      : undefined;
    const result = await client.call(
      "doctor",
      jsonParams({ ...(harnessConfigPath ? { harnessConfigPath } : {}) }),
    );
    writeJson(result);
    if (!booleanField(result, "ready")) process.exitCode = 1;
    return;
  }
  if (command === "schedule") {
    await scheduleCommand(client, routed.argv.slice(1));
    return;
  }
  if (command === "run") {
    await runCommand(client, routed.argv.slice(1));
    return;
  }
  if (command === "resume") {
    await resumeCommand(client, routed.argv.slice(1));
    return;
  }
  if (command === "submission") {
    await submissionCommand(client, routed.argv.slice(1));
    return;
  }
  if (command === "inspect") {
    await inspectCommand(client, routed.argv.slice(1));
    return;
  }
  if (command === "wait" || command === "stop") {
    await controlCommand(client, command, routed.argv.slice(1));
    return;
  }
  if (command === "list") {
    await listCommand(client, routed.argv.slice(1));
    return;
  }
  if (command === "session") {
    await sessionCommand(client, routed.argv.slice(1));
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

async function runtimeCommand(argv: string[]): Promise<void> {
  const action = argv[0];
  if (action === "list") {
    if (argv.slice(1).some((option) => option !== "--json")) {
      throw new Error("runtime list accepts only --json");
    }
    const registry = loadRuntimeRegistry();
    writeJson({
      schemaVersion: 1,
      configPath: runtimeRegistryPath(),
      platform: process.platform,
      defaultRuntime: registry.defaultRuntime ?? "local",
      runtimes: [
        {
          name: "local",
          transport: "local",
          kind: "local-service",
          supported: supportsLocalRuntime(),
        },
        {
          name: "embedded",
          transport: "embedded",
          kind: "embedded",
          supported: supportsLocalRuntime(),
        },
        ...Object.values(registry.runtimes).sort((left, right) =>
          left.name.localeCompare(right.name),
        ),
      ],
    });
    return;
  }
  if (action === "default") {
    const candidate = argv[1];
    const name = candidate && !candidate.startsWith("-") ? candidate : undefined;
    if (argv.slice(name ? 2 : 1).some((option) => option !== "--json")) {
      throw new Error("runtime default accepts only a runtime name and --json");
    }
    if (!name) {
      const registry = loadRuntimeRegistry();
      writeJson({
        schemaVersion: 1,
        defaultRuntime: registry.defaultRuntime ?? "local",
        configPath: runtimeRegistryPath(),
      });
      return;
    }
    if (name === "embedded") {
      throw new Error("The embedded runtime cannot be persisted as the default");
    }
    if ((name === "local" || name === "service") && !supportsLocalRuntime()) {
      assertLocalRuntimeSupported("The local runtime");
    }
    const target = resolveRuntimeTarget(name);
    if (target.kind === "ssh-service") {
      const result = await runtimeClient(target).call("doctor");
      if (!booleanField(result, "ready")) {
        throw new Error(`Jaeger runtime ${name} doctor did not report ready`);
      }
    }
    const configPath = await setDefaultRuntimeTarget(name);
    writeJson({
      schemaVersion: 1,
      defaultRuntime: target.name,
      configPath,
    });
    return;
  }
  if (action === "inspect" || action === "doctor") {
    const name = argv[1];
    if (!name || name.startsWith("-")) {
      throw new Error(`runtime ${action} requires a runtime name`);
    }
    if (argv.slice(2).some((option) => option !== "--json")) {
      throw new Error(`runtime ${action} accepts only a name and --json`);
    }
    const target = resolveRuntimeTarget(name);
    if (action === "inspect") {
      writeJson({ schemaVersion: 1, target, configPath: runtimeRegistryPath() });
      return;
    }
    const client = runtimeClient(target);
    const result = await client.call("doctor");
    writeJson({
      schemaVersion: 1,
      target,
      doctor: result,
    });
    if (!booleanField(result, "ready")) process.exitCode = 1;
    return;
  }
  if (action === "add") {
    const name = argv[1];
    if (!name || name.startsWith("-")) {
      throw new Error("runtime add requires a runtime name");
    }
    let destination: string | undefined;
    let command: string | undefined;
    let connectTimeoutSeconds: number | undefined;
    let force = false;
    let makeDefault = false;
    for (let index = 2; index < argv.length; index++) {
      const option = argv[index];
      if (option === "--json") continue;
      if (option === "--default") {
        makeDefault = true;
        continue;
      }
      if (option === "--force") {
        force = true;
        continue;
      }
      const value = argv[++index];
      if (!value) throw new Error(`${String(option)} requires a value`);
      if (option === "--ssh") destination = value;
      else if (option === "--jaeger") command = value;
      else if (option === "--connect-timeout") {
        connectTimeoutSeconds = parsePositiveInteger(value, option);
      } else {
        throw new Error(`Unknown runtime add option: ${String(option)}`);
      }
    }
    if (!destination) throw new Error("runtime add requires --ssh DESTINATION");
    const provisional = provisionalSshRuntimeTarget({
      name,
      destination,
      ...(command ? { command } : {}),
      ...(connectTimeoutSeconds !== undefined ? { connectTimeoutSeconds } : {}),
    });
    const discovery = await new SshRuntimeClient(provisional, {
      discoverInstance: true,
      retryWindowMs: 0,
    }).call("ping");
    const backend = jsonRecordField(discovery, "backend");
    const instanceId =
      backend && typeof backend.instanceId === "string"
        ? backend.instanceId
        : undefined;
    if (!instanceId || !/^[a-f0-9]{32}$/.test(instanceId)) {
      throw new Error(
        "Remote Jaeger did not report a stable instance id; reinstall its backend with 'jaeger backend install'",
      );
    }
    if (backend?.admissionReady !== true) {
      throw new Error("Remote Jaeger backend is not ready to admit work");
    }
    const target: SshRuntimeTarget = { ...provisional, instanceId };
    const doctor = await new SshRuntimeClient(target, { retryWindowMs: 0 }).call("doctor");
    if (!booleanField(doctor, "ready")) {
      throw new Error("Remote Jaeger doctor did not report ready");
    }
    const configPath = await saveRuntimeTarget(target, {
      force,
      makeDefault,
    });
    writeJson({
      schemaVersion: 1,
      added: true,
      default: makeDefault,
      target,
      configPath,
      doctor,
    });
    return;
  }
  throw new Error("runtime requires list, inspect, doctor, default, or add");
}

async function scheduleCommand(client: RuntimeClient, argv: string[]): Promise<void> {
  const action = argv[0];
  if (
    !action ||
    ![
      "validate",
      "apply",
      "list",
      "inspect",
      "enable",
      "disable",
      "remove",
      "history",
      "trigger",
    ].includes(action)
  ) {
    throw new Error(
      "schedule requires validate, apply, list, inspect, enable, disable, remove, history, or trigger",
    );
  }
  if (action === "validate" || action === "apply") {
    const manifest = argv[1];
    if (!manifest || manifest.startsWith("-")) {
      throw new Error(`schedule ${action} requires a manifest path`);
    }
    let activate = false;
    for (const option of argv.slice(2)) {
      if (option === "--activate" && action === "apply") activate = true;
      else if (option !== "--json") {
        throw new Error(`Unknown schedule ${action} option: ${option}`);
      }
    }
    const application = await loadScheduleApplication(manifest, {
      remoteWorkspace: client.remote === true,
    });
    if (action === "validate") {
      writeJson({
        valid: true,
        name: application.name,
        manifestPath: application.manifestPath,
        workflowPath: application.workflowPath,
        cwd: application.cwd,
        trigger: application.trigger,
        policy: application.policy,
      });
      return;
    }
    writeJson(
      await client.call(
        "schedule.apply",
        jsonParams({ application, ...(activate ? { activate: true } : {}) }),
      ),
    );
    return;
  }
  if (action === "list") {
    if (argv.slice(1).some((option) => option !== "--json")) {
      throw new Error("schedule list accepts only --json");
    }
    writeJson(await client.call("schedule.list"));
    return;
  }
  const name = normalizeScheduleName(argv[1], `schedule ${action} requires a name`);
  if (action === "history") {
    let limit: number | undefined;
    for (let index = 2; index < argv.length; index++) {
      const option = argv[index];
      if (option === "--json") continue;
      if (option !== "--limit") throw new Error(`Unknown schedule history option: ${option}`);
      const value = argv[++index];
      if (!value) throw new Error("--limit requires a value");
      limit = parsePositiveInteger(value, "--limit");
    }
    writeJson(
      await client.call(
        "schedule.history",
        jsonParams({ name, ...(limit ? { limit } : {}) }),
      ),
    );
    return;
  }
  if (action === "trigger") {
    let requestId: string | undefined;
    for (let index = 2; index < argv.length; index++) {
      const option = argv[index];
      if (option === "--json") continue;
      if (option !== "--request-id") {
        throw new Error(`Unknown schedule trigger option: ${option}`);
      }
      const value = argv[++index];
      if (!value) throw new Error("--request-id requires a value");
      requestId = normalizeSubmissionId(value, "Invalid schedule trigger request id");
    }
    requestId ??= randomUUID();
    process.stderr.write(`jaeger schedule trigger: ${requestId}\n`);
    writeJson(
      await client.call(
        "schedule.trigger",
        jsonParams({ name, requestId }),
      ),
    );
    return;
  }
  if (argv.slice(2).some((option) => option !== "--json")) {
    throw new Error(`schedule ${action} accepts only a name and --json`);
  }
  const method = `schedule.${action}` as
    | "schedule.inspect"
    | "schedule.enable"
    | "schedule.disable"
    | "schedule.remove";
  writeJson(await client.call(method, jsonParams({ name })));
}

async function hooksCommand(client: RuntimeClient, argv: string[]): Promise<void> {
  const action = argv[0];
  if (action === "validate") {
    const configPath = argv[1];
    if (!configPath || configPath.startsWith("-")) {
      throw new Error("hooks validate requires a configuration path");
    }
    if (argv.slice(2).some((option) => option !== "--json")) {
      throw new Error(`Unknown hooks validate option: ${String(argv[2])}`);
    }
    const config = await loadHookConfig(path.resolve(configPath));
    writeJson({
      valid: true,
      path: config.path,
      digest: config.digest,
      hooks: config.hooks.map((hook) => ({
        name: hook.name,
        events: [...hook.events],
        command: [...hook.command],
        timeoutMs: hook.timeoutMs,
      })),
    });
    return;
  }
  if (client.kind === "embedded") {
    throw new Error("Jaeger lifecycle hooks require a persistent backend");
  }
  if (action === "status") {
    if (argv.slice(1).some((option) => option !== "--json")) {
      throw new Error(`Unknown hooks status option: ${String(argv[1])}`);
    }
    writeJson(await client.call("hooks.status"));
    return;
  }
  if (action === "history") {
    let hook: string | undefined;
    let eventId: string | undefined;
    let limit: number | undefined;
    for (let index = 1; index < argv.length; index++) {
      const option = argv[index];
      if (option === "--json") continue;
      const value = argv[++index];
      if (!value) throw new Error(`${String(option)} requires a value`);
      if (option === "--hook") hook = value;
      else if (option === "--event") eventId = value;
      else if (option === "--limit") limit = parsePositiveInteger(value, option);
      else throw new Error(`Unknown hooks history option: ${String(option)}`);
    }
    writeJson(
      await client.call(
        "hooks.history",
        jsonParams({
          ...(hook ? { hook } : {}),
          ...(eventId ? { eventId } : {}),
          ...(limit ? { limit } : {}),
        }),
      ),
    );
    return;
  }
  throw new Error("hooks requires validate, status, or history");
}

async function modulesValidateCommand(argv: string[]): Promise<void> {
  const target = argv[0];
  if (!target || target.startsWith("-")) {
    throw new Error("modules validate requires a runtime configuration file");
  }
  if (argv.slice(1).some((option) => option !== "--json")) {
    throw new Error(`Unknown modules validate option: ${String(argv[1])}`);
  }
  const config = await loadRuntimeModuleConfig(path.resolve(target));
  writeJson({
    schemaVersion: 1,
    valid: true,
    path: config.path,
    digest: config.digest,
    modules: config.modules.map((module) => module.name),
  });
}

async function modulesLocalCommand(argv: string[]): Promise<void> {
  const action = argv[0];
  if (action === "validate") {
    await modulesValidateCommand(argv.slice(1));
    return;
  }
  if (action === "view") {
    const source = argv[1];
    if (!source || source.startsWith("-")) throw new Error("modules view requires a source");
    if (argv.slice(2).some((option) => option !== "--json")) {
      throw new Error(`Unknown modules view option: ${String(argv[2])}`);
    }
    const resolved = await resolveModuleItem(source);
    writeJson({
      schemaVersion: 1,
      source: resolved.reference,
      resolvedSource: resolved.resolvedSource,
      digest: resolved.digest,
      item: resolved.item,
      files: [...resolved.files.entries()].map(([file, contents]) => ({
        file,
        bytes: contents.byteLength,
      })),
    });
    return;
  }
  if (action === "add") {
    const parsed = parseModuleMutationArgs("add", argv.slice(1));
    writeJson(
      await addModules({
        root: parsed.root,
        references: parsed.values,
        dryRun: parsed.dryRun,
        install: parsed.install,
        overwrite: parsed.overwrite,
      }),
    );
    return;
  }
  if (action === "remove") {
    const parsed = parseModuleMutationArgs("remove", argv.slice(1));
    writeJson(
      await removeModules({
        root: parsed.root,
        names: parsed.values,
        dryRun: parsed.dryRun,
        install: parsed.install,
        force: parsed.force,
      }),
    );
    return;
  }
  if (action === "sync") {
    const parsed = parseModuleMutationArgs("sync", argv.slice(1));
    if (parsed.values.length > 0) throw new Error("modules sync does not accept module names");
    writeJson(
      await syncModules({
        root: parsed.root,
        dryRun: parsed.dryRun,
        install: parsed.install,
      }),
    );
    return;
  }
  if (action === "list") {
    const { root, remaining } = parseModuleRootArgs(argv.slice(1));
    if (remaining.some((option) => option !== "--json")) {
      throw new Error(`Unknown modules list option: ${String(remaining[0])}`);
    }
    writeJson(await listInstalledModules(root));
    return;
  }
  if (action === "diff") {
    const name = argv[1];
    if (!name || name.startsWith("-")) throw new Error("modules diff requires a module name");
    const { root, remaining } = parseModuleRootArgs(argv.slice(2));
    if (remaining.some((option) => option !== "--json")) {
      throw new Error(`Unknown modules diff option: ${String(remaining[0])}`);
    }
    writeJson(await diffModule(root, name));
    return;
  }
  throw new Error(
    "modules requires add, diff, list, remove, status, sync, validate, or view",
  );
}

async function modulesCommand(client: RuntimeClient, argv: string[]): Promise<void> {
  if (argv[0] !== "status") {
    throw new Error(
      "modules requires add, diff, list, remove, status, sync, validate, or view",
    );
  }
  if (argv.slice(1).some((option) => option !== "--json")) {
    throw new Error(`Unknown modules status option: ${String(argv[1])}`);
  }
  writeJson(await client.call("modules.status"));
}

interface ModuleMutationArgs {
  readonly root: string;
  readonly values: readonly string[];
  readonly dryRun: boolean;
  readonly install: boolean;
  readonly overwrite: boolean;
  readonly force: boolean;
}

function parseModuleMutationArgs(
  action: "add" | "remove" | "sync",
  argv: string[],
): ModuleMutationArgs {
  let root = defaultModuleProjectRoot();
  let dryRun = false;
  let install = true;
  let overwrite = false;
  let force = false;
  const values: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (option === "--json") continue;
    if (option === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (option === "--no-install") {
      install = false;
      continue;
    }
    if (option === "--overwrite" && action === "add") {
      overwrite = true;
      continue;
    }
    if (option === "--force" && action === "remove") {
      force = true;
      continue;
    }
    if (option === "--root") {
      const value = argv[++index];
      if (!value) throw new Error("--root requires a value");
      root = path.resolve(value);
      continue;
    }
    if (!option || option.startsWith("-")) {
      throw new Error(`Unknown modules ${action} option: ${String(option)}`);
    }
    values.push(option);
  }
  if (action !== "sync" && values.length === 0) {
    throw new Error(`modules ${action} requires ${action === "add" ? "a source" : "a module name"}`);
  }
  return { root, values, dryRun, install, overwrite, force };
}

function parseModuleRootArgs(argv: string[]): {
  readonly root: string;
  readonly remaining: readonly string[];
} {
  let root = defaultModuleProjectRoot();
  const remaining: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (option === "--root") {
      const value = argv[++index];
      if (!value) throw new Error("--root requires a value");
      root = path.resolve(value);
    } else if (option) {
      remaining.push(option);
    }
  }
  return { root, remaining };
}

interface EnvironmentArgs {
  readonly name?: string;
  readonly file?: string;
  readonly paths: EnvironmentPaths;
  readonly force: boolean;
  readonly json: boolean;
}

async function envCommand(argv: string[]): Promise<void> {
  const action = argv[0];
  if (!action || !["list", "inspect", "status", "check", "diff", "apply", "uninstall"].includes(action)) {
    throw new Error("env requires list, inspect, status, check, diff, apply, or uninstall");
  }
  const parsed = parseEnvironmentArgs(action, argv.slice(1));
  if (action === "list") {
    const environments = await listEnvironments(parsed.paths.configRoot);
    if (parsed.json) writeJson(environments);
    else for (const environment of environments) process.stdout.write(`${environment}\n`);
    return;
  }
  if (action === "status") {
    const state = await activeEnvironment(parsed.paths);
    if (parsed.json) writeJson(state ?? null);
    else if (!state) process.stdout.write("No Jaeger environment is active.\n");
    else {
      process.stdout.write(
        `${state.environment}\t${state.manifestPath}\t${state.resources.length} resource(s)\t${state.plugins.length} plugin(s)\t${state.packages.length} package(s)\n`,
      );
    }
    return;
  }
  if (action === "uninstall") {
    const result = await uninstallEnvironment(parsed.paths, parsed.name, { force: parsed.force });
    if (parsed.json) writeJson(result);
    else process.stdout.write(
      `Uninstalled ${result.environment}: restored ${result.restored}, removed ${result.removed}, removed ${result.removedPlugins} plugin(s) and ${result.removedPackages} Pi package(s).\n`,
    );
    return;
  }
  if (!parsed.name) throw new Error(`env ${action} requires an environment name`);
  const plan = await loadEnvironmentPlan(parsed.name, parsed.paths, parsed.file);
  if (action === "inspect") {
    const status = await inspectEnvironmentStatus(plan, parsed.paths);
    const result = { ...plan, status };
    if (parsed.json) writeJson(result);
    else {
      process.stdout.write(`${plan.name}\t${plan.manifestPath}\n`);
      for (const snippet of plan.snippets) {
        process.stdout.write(`${snippet.selected ? "+" : "-"} ${snippet.path}: ${snippet.reason}${snippet.description ? ` — ${snippet.description}` : ""}\n`);
      }
      for (const resource of status.resources) {
        process.stdout.write(`${resource.status}\t${resource.provider}/${resource.category}\t${resource.target}\n`);
      }
      for (const plugin of status.plugins) {
        process.stdout.write(`${plugin.status}\t${plugin.provider}/plugin\t${plugin.selector}\n`);
      }
      for (const packageDefinition of status.packages) {
        process.stdout.write(
          `${packageDefinition.status}\tpi/package\t${packageDefinition.source}\n`,
        );
      }
    }
    return;
  }
  if (action === "check" || action === "diff") {
    const status = await inspectEnvironmentStatus(plan, parsed.paths);
    if (parsed.json) writeJson(status);
    else {
      if (status.activeEnvironment && status.activeEnvironment !== plan.name) {
        process.stdout.write(`different\tactive environment is ${status.activeEnvironment}\n`);
      }
      for (const resource of status.resources) {
        process.stdout.write(`${resource.status}\t${resource.provider}/${resource.category}\t${resource.target}\n`);
      }
      for (const plugin of status.plugins) {
        process.stdout.write(`${plugin.status}\t${plugin.provider}/plugin\t${plugin.selector}\n`);
      }
      for (const packageDefinition of status.packages) {
        process.stdout.write(
          `${packageDefinition.status}\tpi/package\t${packageDefinition.source}\n`,
        );
      }
      if (status.current) process.stdout.write(`Environment ${plan.name} is current.\n`);
    }
    if (!status.current) process.exitCode = 1;
    return;
  }
  const result = await applyEnvironment(plan, parsed.paths, { force: parsed.force });
  if (parsed.json) writeJson(result);
  else process.stdout.write(
    `Applied ${result.environment}: changed ${result.changed}, unchanged ${result.unchanged}, removed ${result.removed}; installed ${result.installedPlugins} and removed ${result.removedPlugins} plugin(s); installed ${result.installedPackages} and removed ${result.removedPackages} Pi package(s).\n`,
  );
}

function parseEnvironmentArgs(action: string, argv: string[]): EnvironmentArgs {
  const defaults = defaultEnvironmentPaths();
  let name: string | undefined;
  let file: string | undefined;
  let configRoot = defaults.configRoot;
  let stateRoot = defaults.stateRoot;
  let force = false;
  let json = false;
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (option === "--force") {
      force = true;
      continue;
    }
    if (option === "--json") {
      json = true;
      continue;
    }
    if (option === "--file" || option === "--config-root" || option === "--state-root") {
      const value = argv[++index];
      if (!value) throw new Error(`${option} requires a value`);
      if (option === "--file") file = path.resolve(value);
      else if (option === "--config-root") configRoot = path.resolve(value);
      else stateRoot = path.resolve(value);
      continue;
    }
    if (option?.startsWith("-")) throw new Error(`Unknown env ${action} option: ${option}`);
    if (name) throw new Error(`env ${action} accepts at most one environment name`);
    name = option;
  }
  if (action === "list" && name) throw new Error("env list does not accept an environment name");
  if (action === "status" && name) throw new Error("env status does not accept an environment name");
  if ((action === "list" || action === "status" || action === "uninstall") && file) {
    throw new Error(`env ${action} does not accept --file`);
  }
  if (action !== "apply" && action !== "uninstall" && force) {
    throw new Error(`env ${action} does not accept --force`);
  }
  return {
    ...(name ? { name } : {}),
    ...(file ? { file } : {}),
    paths: { configRoot, stateRoot },
    force,
    json,
  };
}

function runtimeClient(target: RuntimeTarget): RuntimeClient {
  if (target.kind === "local-service") {
    assertLocalRuntimeSupported("The local runtime");
    const socketPath = defaultBackendSocketPath();
    const profile = readBackendInstallConfig();
    return new ServiceRuntimeClient(socketPath, {
      ...(profile?.socketPath === socketPath && profile.generation
        ? { expectedGeneration: profile.generation }
        : {}),
      ...(profile?.socketPath === socketPath && profile.instanceId
        ? { expectedInstanceId: profile.instanceId }
        : {}),
    });
  }
  if (target.kind === "ssh-service") return new SshRuntimeClient(target);
  assertLocalRuntimeSupported("The embedded runtime");
  return new EmbeddedRuntimeClient(
    new LocalRuntimeService({
      stateDir: path.resolve(".jaeger", "runs"),
      entrypoint: ENTRYPOINT,
      backendKind: "embedded",
    }),
  );
}

async function runCommand(client: RuntimeClient, argv: string[]): Promise<void> {
  const parsed = parseRunArgs(argv);
  assertRemoteStateDirAbsent(client, parsed.stateDir);
  const submissionId = parsed.submissionId ?? randomUUID();
  process.stderr.write(`jaeger submission: ${submissionId}\n`);
  let workflowPath: string;
  let workflowSource: string;
  let cwd: string;
  let inputs: unknown;
  try {
    workflowPath = await realpath(path.resolve(parsed.workflowPath));
    workflowSource = await readFile(workflowPath, "utf8");
    compileWorkflowSource(workflowSource, workflowPath);
    if (client.remote) {
      if (!parsed.cwd) {
        throw new Error("--cwd is required for a remote Jaeger runtime");
      }
      if (!path.posix.isAbsolute(parsed.cwd)) {
        throw new Error("--cwd must be an absolute path on the remote Jaeger runtime");
      }
      cwd = path.posix.normalize(parsed.cwd);
    } else {
      cwd = await realpath(path.resolve(parsed.cwd ?? process.cwd()));
    }
    inputs = parsed.inputPath ? await readJsonInput(parsed.inputPath) : {};
  } catch (error) {
    if (!parsed.submissionId) throw error;
    try {
      const existing = await client.call(
        "run.lookup",
        jsonParams({
          submissionId,
          ...(parsed.stateDir ? { stateDir: parsed.stateDir } : {}),
        }),
      );
      await finishRunSubmission(client, parsed, existing);
      return;
    } catch (lookupError) {
      if (lookupError instanceof BackendRpcError && lookupError.code === "not_found") throw error;
      throw lookupError;
    }
  }
  const submitted = await client.call(
    "run.submit",
    jsonParams({
      submissionId,
      workflowPath,
      workflowSource,
      ...(client.remote ? { workflowPathPinned: true } : {}),
      cwd,
      inputs,
      ...(parsed.stateDir ? { stateDir: parsed.stateDir } : {}),
      ...(parsed.maxConcurrency !== undefined
        ? { maxConcurrency: parsed.maxConcurrency }
        : {}),
      ...(parsed.harnessConfigPath
        ? {
            harnessConfigPath: client.remote
              ? requireRemoteAbsolutePath(
                  parsed.harnessConfigPath,
                  "--harness-config",
                )
              : path.resolve(parsed.harnessConfigPath),
          }
        : {}),
    }),
  );
  await finishRunSubmission(client, parsed, submitted);
}

async function finishRunSubmission(
  client: RuntimeClient,
  parsed: ReturnType<typeof parseRunArgs>,
  submitted: JsonValue,
): Promise<void> {
  if (parsed.detach || terminalStatus(submitted)) {
    writeJson(submitted);
    setFailureExitCode(submitted);
    return;
  }
  process.stderr.write(`jaeger run accepted: ${compactRunRecord(submitted)}\n`);
  const result = await withClientSignals(
    async (signal) =>
      await client.call(
        "run.wait",
        jsonParams({
          runId: runIdFromValue(submitted),
          ...(parsed.stateDir ? { stateDir: parsed.stateDir } : {}),
        }),
        signal,
      ),
  );
  if (isFailureStatus(result)) {
    process.stderr.write(`jaeger run summary: ${JSON.stringify(result)}\n`);
  }
  writeJson(result);
  setFailureExitCode(result);
}

async function submissionCommand(client: RuntimeClient, argv: string[]): Promise<void> {
  const submissionId = normalizeSubmissionId(argv[0], "submission requires a submission id");
  let stateDir: string | undefined;
  for (let index = 1; index < argv.length; index++) {
    const option = argv[index];
    if (option === "--json") continue;
    if (option !== "--state-dir") {
      throw new Error(`Unknown submission option: ${String(option)}`);
    }
    const value = argv[++index];
    if (!value) throw new Error("--state-dir requires a value");
    if (stateDir) throw new Error("--state-dir may only be supplied once");
    stateDir = path.resolve(value);
  }
  assertRemoteStateDirAbsent(client, stateDir);
  writeJson(
    await client.call(
      "run.lookup",
      jsonParams({ submissionId, ...(stateDir ? { stateDir } : {}) }),
    ),
  );
}

async function resumeCommand(client: RuntimeClient, argv: string[]): Promise<void> {
  const parsed = parseResumeArgs(argv);
  assertRemoteStateDirAbsent(client, parsed.stateDir);
  await resumeAndMaybeWait(client, parsed, parsed.detach);
}

async function resumeAndMaybeWait(
  client: RuntimeClient,
  input: { readonly runId: string; readonly stateDir?: string },
  detach: boolean,
): Promise<void> {
  const resumed = await client.call("run.resume", jsonParams(input));
  if (detach || terminalStatus(resumed)) {
    writeJson(resumed);
    setFailureExitCode(resumed);
    return;
  }
  process.stderr.write(`jaeger run resumed: ${compactRunRecord(resumed)}\n`);
  const result = await withClientSignals(
    async (signal) =>
      await client.call(
        "run.wait",
        jsonParams({
          runId: input.runId,
          ...(input.stateDir ? { stateDir: input.stateDir } : {}),
        }),
        signal,
      ),
  );
  writeJson(result);
  setFailureExitCode(result);
}

async function inspectCommand(client: RuntimeClient, argv: string[]): Promise<void> {
  const parsed = parseInspectArgs(argv);
  assertRemoteStateDirAbsent(client, parsed.stateDir);
  const params = jsonParams({
    runId: parsed.runId,
    ...(parsed.stateDir ? { stateDir: parsed.stateDir } : {}),
    ...(parsed.events ? { events: true } : {}),
    ...(parsed.stepId ? { stepId: parsed.stepId } : {}),
    ...(parsed.transcript ? { transcript: parsed.transcript } : {}),
  });
  writeJson(
    await client.call(
      parsed.events || parsed.stepId || parsed.transcript ? "run.details" : "run.inspect",
      params,
    ),
  );
}

async function controlCommand(
  client: RuntimeClient,
  command: "wait" | "stop",
  argv: string[],
): Promise<void> {
  const parsed = parseControlArgs(argv, command);
  assertRemoteStateDirAbsent(client, parsed.stateDir);
  const result =
    command === "wait"
      ? await withClientSignals(
          async (signal) => await client.call("run.wait", jsonParams(parsed), signal),
        )
      : await client.call("run.stop", jsonParams(parsed));
  writeJson(result);
  if (command === "wait") setFailureExitCode(result);
}

async function listCommand(client: RuntimeClient, argv: string[]): Promise<void> {
  const parsed = parseListArgs(argv);
  assertRemoteStateDirAbsent(client, parsed.stateDir);
  writeJson(await client.call("run.list", jsonParams(parsed)));
}

async function sessionCommand(client: RuntimeClient, argv: string[]): Promise<void> {
  const action = argv[0];
  if (action === "turn") {
    await sessionTurnCommand(client, argv.slice(1));
    return;
  }
  if (action === "query") {
    await sessionQueryCommand(client, argv.slice(1));
    return;
  }
  if (!action || !["list", "inspect", "resume", "steer", "interrupt"].includes(action)) {
    throw new Error(
      "session requires list, inspect, resume, steer, interrupt, or query",
    );
  }
  const runId = normalizeRunId(argv[1], `session ${action} requires a run id`);
  const needsSelector = action !== "list";
  const selector = needsSelector ? argv[2] : undefined;
  if (needsSelector && (!selector || selector.startsWith("-"))) {
    throw new Error(`session ${action} requires a session selector`);
  }
  const parsed = parseSessionOptions(argv.slice(needsSelector ? 3 : 2), action);
  assertRemoteStateDirAbsent(client, parsed.stateDir);
  const base = {
    runId,
    ...(selector ? { selector } : {}),
    ...(parsed.stateDir ? { stateDir: parsed.stateDir } : {}),
  };
  if (action === "list") {
    writeJson(await client.call("session.list", jsonParams(base)));
    return;
  }
  if (action === "inspect") {
    writeJson(await client.call("session.inspect", jsonParams(base)));
    return;
  }
  if (action === "resume") {
    if (client.kind === "embedded" && parsed.detach) {
      throw new Error("Detached session turns require the persistent backend");
    }
    const turnId = parsed.requestId ?? `turn-${randomUUID()}`;
    const message = await requiredSessionMessage(parsed.message, action);
    process.stderr.write(`jaeger session turn: ${turnId}\n`);
    const operation = async (signal?: AbortSignal) =>
      await client.call(
        "session.resume",
        jsonParams({
          ...base,
          message,
          turnId,
          ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
          ...(parsed.detach ? { detach: true } : {}),
        }),
        signal,
      );
    const result = parsed.detach
      ? await operation()
      : await withClientSignals(async (signal) => await operation(signal));
    writeJson(result);
    setFailureExitCode(result);
    return;
  }
  const message =
    action === "steer" ? await requiredSessionMessage(parsed.message, action) : undefined;
  writeJson(
    await client.call(
      "session.control",
      jsonParams({
        ...base,
        kind: action,
        ...(message ? { message } : {}),
      }),
    ),
  );
}

async function sessionQueryCommand(client: RuntimeClient, argv: string[]): Promise<void> {
  if (argv[0] === "inspect" || argv[0] === "wait") {
    const action = argv[0];
    const runId = normalizeRunId(argv[1], `session query ${action} requires a run id`);
    const queryId = normalizeQueryId(
      argv[2],
      `session query ${action} requires a query id`,
    );
    if (argv.slice(3).some((option) => option !== "--json")) {
      throw new Error(`Unknown session query ${action} option: ${String(argv[3])}`);
    }
    const result =
      action === "wait"
        ? await withClientSignals(
            async (signal) =>
              await client.call(
                "session.query.wait",
                jsonParams({ runId, queryId }),
                signal,
              ),
          )
        : await client.call(
            "session.query.inspect",
            jsonParams({ runId, queryId }),
          );
    writeJson(result);
    if (action === "wait") setFailureExitCode(result);
    return;
  }
  const runId = normalizeRunId(argv[0], "session query requires a run id");
  const selector = argv[1];
  if (!selector || selector.startsWith("-")) {
    throw new Error("session query requires a session selector");
  }
  let messageArg: string | undefined;
  let model: string | undefined;
  let timeoutMs: number | undefined;
  let requestId: string | undefined;
  let detach = false;
  for (let index = 2; index < argv.length; index++) {
    const option = argv[index];
    if (option === "--json") continue;
    if (option === "--detach") {
      if (detach) throw new Error("--detach may only be supplied once");
      detach = true;
      continue;
    }
    if (
      !option ||
      !["--message", "--model", "--timeout-ms", "--request-id"].includes(option)
    ) {
      throw new Error(`Unknown session query option: ${String(option)}`);
    }
    const value = argv[++index];
    if (!value) throw new Error(`${option} requires a value`);
    if (option === "--message") messageArg = value;
    if (option === "--model") model = value;
    if (option === "--timeout-ms") timeoutMs = parsePositiveInteger(value, option);
    if (option === "--request-id") requestId = normalizeQueryId(value, "Invalid request id");
  }
  const message = await requiredSessionMessage(messageArg, "query");
  const queryId = requestId ?? createSessionQueryId();
  process.stderr.write(`jaeger session query: ${queryId}\n`);
  const operation = async (signal?: AbortSignal) =>
    await client.call(
      "session.query.submit",
      jsonParams({
        runId,
        selector,
        message,
        queryId,
        ...(model ? { model } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
        ...(detach ? { detach: true } : {}),
      }),
      signal,
    );
  const result = detach
    ? await operation()
    : await withClientSignals(async (signal) => await operation(signal));
  writeJson(result);
  setFailureExitCode(result);
}

async function sessionTurnCommand(client: RuntimeClient, argv: string[]): Promise<void> {
  const action = argv[0];
  if (action !== "inspect" && action !== "wait") {
    throw new Error("session turn requires inspect or wait");
  }
  const runId = normalizeRunId(argv[1], `session turn ${action} requires a run id`);
  const turnId = normalizeTurnId(argv[2], `session turn ${action} requires a turn id`);
  let stateDir: string | undefined;
  for (let index = 3; index < argv.length; index++) {
    const option = argv[index];
    if (option === "--json") continue;
    if (option !== "--state-dir") {
      throw new Error(`Unknown session turn ${action} option: ${String(option)}`);
    }
    const value = argv[++index];
    if (!value) throw new Error("--state-dir requires a value");
    if (stateDir) throw new Error("--state-dir may only be supplied once");
    stateDir = path.resolve(value);
  }
  const params = jsonParams({ runId, turnId, ...(stateDir ? { stateDir } : {}) });
  assertRemoteStateDirAbsent(client, stateDir);
  const result =
    action === "wait"
      ? await withClientSignals(
          async (signal) => await client.call("session.turn.wait", params, signal),
        )
      : await client.call("session.turn.inspect", params);
  writeJson(result);
  if (action === "wait") setFailureExitCode(result);
}

async function validateCommand(argv: string[]): Promise<void> {
  const workflowArg = argv[0];
  if (!workflowArg) throw new Error("validate requires a workflow path");
  if (argv.length !== 1) throw new Error(`Unknown validate option: ${String(argv[1])}`);
  const workflowPath = path.resolve(workflowArg);
  compileWorkflowSource(await readFile(workflowPath, "utf8"), workflowPath);
  writeJson({ valid: true, workflowPath });
}

async function backendCommand(argv: string[]): Promise<void> {
  const action = argv[0];
  if (action === "install") {
    const parsed = parseBackendOptions(argv.slice(1), true);
    writeJson(
      await installBackendService({
        entrypoint: ENTRYPOINT,
        ...(parsed.socketPath ? { socketPath: parsed.socketPath } : {}),
        ...(parsed.stateDir ? { stateDir: parsed.stateDir } : {}),
        ...(parsed.harnessConfigPath ? { harnessConfigPath: parsed.harnessConfigPath } : {}),
        ...(parsed.hooksConfigPath ? { hooksConfigPath: parsed.hooksConfigPath } : {}),
        ...(parsed.runtimeModuleConfigPath
          ? { runtimeModuleConfigPath: parsed.runtimeModuleConfigPath }
          : {}),
        ...(parsed.clearRuntimeModuleConfig ? { clearRuntimeModuleConfig: true } : {}),
      }),
    );
    return;
  }
  if (action === "status") {
    const parsed = parseBackendOptions(argv.slice(1), false);
    if (
      parsed.stateDir ||
      parsed.harnessConfigPath ||
      parsed.hooksConfigPath ||
      parsed.runtimeModuleConfigPath ||
      parsed.clearRuntimeModuleConfig
    ) {
      throw new Error("backend status accepts only --socket");
    }
    const result = await backendServiceStatus(parsed.socketPath);
    writeJson(result);
    if (!booleanField(result, "active") || !recordField(result, "backend")) {
      process.exitCode = 1;
    }
    return;
  }
  if (action === "restart") {
    const parsed = parseBackendOptions(argv.slice(1), false);
    if (
      parsed.stateDir ||
      parsed.harnessConfigPath ||
      parsed.hooksConfigPath ||
      parsed.runtimeModuleConfigPath ||
      parsed.clearRuntimeModuleConfig
    ) {
      throw new Error("backend restart accepts only --socket");
    }
    writeJson(await restartBackendService(parsed.socketPath));
    return;
  }
  throw new Error("backend requires install, status, or restart");
}

async function runBackendServer(argv: string[]): Promise<void> {
  const parsed = parseBackendServerOptions(argv);
  const socketPath = parsed.socketPath ?? defaultBackendSocketPath();
  const stateDir = parsed.stateDir ?? defaultPersistentStateDir();
  let hooksConfig;
  let hooksConfigError: string | undefined;
  if (parsed.hooksConfigPath) {
    try {
      hooksConfig = await loadHookConfig(parsed.hooksConfigPath);
    } catch (error) {
      hooksConfigError = error instanceof Error ? error.message : String(error);
    }
  }
  const runtimeModuleConfig = parsed.runtimeModuleConfigPath
    ? await loadRuntimeModuleConfig(parsed.runtimeModuleConfigPath)
    : undefined;
  await serveBackend({
    socketPath,
    ...(parsed.compatibilitySocketPaths.length > 0
      ? { compatibilitySocketPaths: parsed.compatibilitySocketPaths }
      : {}),
    service: new LocalRuntimeService({
      stateDir,
      entrypoint: ENTRYPOINT,
      ...(parsed.harnessConfigPath ? { harnessConfigPath: parsed.harnessConfigPath } : {}),
      ...(parsed.hooksConfigPath ? { hooksConfigPath: parsed.hooksConfigPath } : {}),
      ...(hooksConfig ? { hooksConfig } : {}),
      ...(hooksConfigError ? { hooksConfigError } : {}),
      ...(runtimeModuleConfig ? { runtimeModuleConfig } : {}),
      ...(parsed.runtimeModuleConfigPath
        ? { runtimeModuleConfigPath: parsed.runtimeModuleConfigPath }
        : {}),
      ...(parsed.generation ? { installGeneration: parsed.generation } : {}),
      ...(parsed.instanceId ? { installInstanceId: parsed.instanceId } : {}),
      ...(parsed.profilePath ? { installProfilePath: parsed.profilePath } : {}),
      ...(parsed.admissionPending ? { installPending: true } : {}),
      backendKind: "local-service",
    }),
  });
}

function parseBackendServerOptions(argv: string[]): {
  socketPath?: string;
  stateDir?: string;
  harnessConfigPath?: string;
  hooksConfigPath?: string;
  runtimeModuleConfigPath?: string;
  clearRuntimeModuleConfig?: boolean;
  generation?: string;
  instanceId?: string;
  profilePath?: string;
  admissionPending?: boolean;
  compatibilitySocketPaths: string[];
} {
  const ordinary: string[] = [];
  const compatibilitySocketPaths: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (
      option !== "--compat-socket" &&
      option !== "--generation" &&
      option !== "--instance-id" &&
      option !== "--profile-path" &&
      option !== "--admission-pending"
    ) {
      ordinary.push(String(option));
      continue;
    }
    if (option === "--admission-pending") {
      ordinary.push(option);
      continue;
    }
    const value = argv[++index];
    if (!value) throw new Error(`${option} requires a value`);
    if (option === "--compat-socket") compatibilitySocketPaths.push(path.resolve(value));
    if (option === "--generation") {
      if (!/^[a-f0-9]{32}$/.test(value)) throw new Error("--generation is invalid");
      ordinary.push("--generation", value);
    }
    if (option === "--instance-id") {
      if (!/^[a-f0-9]{32}$/.test(value)) throw new Error("--instance-id is invalid");
      ordinary.push("--instance-id", value);
    }
    if (option === "--profile-path") ordinary.push("--profile-path", path.resolve(value));
  }
  let generation: string | undefined;
  let instanceId: string | undefined;
  let profilePath: string | undefined;
  let admissionPending = false;
  const backendOptions: string[] = [];
  for (let index = 0; index < ordinary.length; index++) {
    const option = ordinary[index];
    if (option === "--generation") generation = ordinary[++index];
    else if (option === "--instance-id") instanceId = ordinary[++index];
    else if (option === "--profile-path") profilePath = ordinary[++index];
    else if (option === "--admission-pending") admissionPending = true;
    else backendOptions.push(String(option));
  }
  return {
    ...parseBackendOptions(backendOptions, true),
    ...(generation ? { generation } : {}),
    ...(instanceId ? { instanceId } : {}),
    ...(profilePath ? { profilePath } : {}),
    ...(admissionPending ? { admissionPending: true } : {}),
    compatibilitySocketPaths,
  };
}

async function runInternalWorker(argv: string[]): Promise<void> {
  let stateDir: string | undefined;
  let runId: string | undefined;
  let backend: "embedded" | "local-service" | undefined;
  let resumeRequested = false;
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (option === "--resume") {
      if (resumeRequested) throw new Error("--resume may only be supplied once");
      resumeRequested = true;
      continue;
    }
    const value = argv[index + 1];
    if (option !== "--state-dir" && option !== "--run-id" && option !== "--backend") {
      throw new Error(`Unknown internal worker option: ${String(option)}`);
    }
    if (!value) throw new Error(`${option} requires a value`);
    index++;
    if (option === "--state-dir") stateDir = path.resolve(value);
    if (option === "--run-id") runId = value;
    if (option === "--backend") {
      if (value !== "embedded" && value !== "local-service") {
        throw new Error("Internal worker backend is invalid");
      }
      backend = value;
    }
  }
  if (!stateDir || !runId || !backend) {
    throw new Error("Internal worker requires --state-dir, --run-id, and --backend");
  }
  await withClientSignals(
    async (signal) =>
      await executePreparedRun({
        stateDir,
        runId,
        ownerKind: "detached",
        resumeRequested,
        expectedBackend: backend,
        signal,
      }),
  );
}

async function runInternalSessionWorker(argv: string[]): Promise<void> {
  let stateDir: string | undefined;
  let runId: string | undefined;
  let turnId: string | undefined;
  let backend: "embedded" | "local-service" | undefined;
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (!option || !["--state-dir", "--run-id", "--turn-id", "--backend"].includes(option)) {
      throw new Error(`Unknown internal session worker option: ${String(option)}`);
    }
    const value = argv[++index];
    if (!value) throw new Error(`${option} requires a value`);
    if (option === "--state-dir") stateDir = path.resolve(value);
    if (option === "--run-id") runId = normalizeRunId(value, "Invalid internal run id");
    if (option === "--turn-id") turnId = normalizeTurnId(value, "Invalid internal turn id");
    if (option === "--backend") {
      if (value !== "embedded" && value !== "local-service") {
        throw new Error("Internal session worker backend is invalid");
      }
      backend = value;
    }
  }
  if (!stateDir || !runId || !turnId || !backend) {
    throw new Error(
      "Internal session worker requires --state-dir, --run-id, --turn-id, and --backend",
    );
  }
  await withClientSignals(
    async (signal) =>
      await executeSessionTurnWorker({ stateDir, runId, turnId, backend, signal }),
  );
}

async function runInternalQueryWorker(argv: string[]): Promise<void> {
  let stateDir: string | undefined;
  let runId: string | undefined;
  let queryId: string | undefined;
  let backend: "embedded" | "local-service" | undefined;
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (!option || !["--state-dir", "--run-id", "--query-id", "--backend"].includes(option)) {
      throw new Error(`Unknown internal query worker option: ${String(option)}`);
    }
    const value = argv[++index];
    if (!value) throw new Error(`${option} requires a value`);
    if (option === "--state-dir") stateDir = path.resolve(value);
    if (option === "--run-id") runId = normalizeRunId(value, "Invalid internal run id");
    if (option === "--query-id") {
      queryId = normalizeQueryId(value, "Invalid internal query id");
    }
    if (option === "--backend") {
      if (value !== "embedded" && value !== "local-service") {
        throw new Error("Internal query worker backend is invalid");
      }
      backend = value;
    }
  }
  if (!stateDir || !runId || !queryId || !backend) {
    throw new Error(
      "Internal query worker requires --state-dir, --run-id, --query-id, and --backend",
    );
  }
  await withClientSignals(
    async (signal) =>
      await executeSessionQueryWorker({ stateDir, runId, queryId, backend, signal }),
  );
}

function parseRuntimeSelection(rawArgv: string[]): {
  readonly argv: string[];
  readonly name: string;
  readonly explicit: boolean;
} {
  const argv = [...rawArgv];
  let selected =
    process.env.JAEGER_RUNTIME ??
    loadRuntimeRegistry().defaultRuntime ??
    "local";
  let explicit = false;
  if (argv[0] === "--runtime") {
    const value = argv[1];
    if (!value) throw new Error("--runtime requires a runtime name");
    selected = value;
    explicit = true;
    argv.splice(0, 2);
  }
  if (selected === "service") selected = "local";
  return { argv, name: selected, explicit };
}

function routeQualifiedRuntime(
  input: readonly string[],
  selection: { readonly name: string; readonly explicit: boolean },
): { readonly argv: string[]; readonly name: string } {
  const argv = [...input];
  const command = argv[0];
  let index: number | undefined;
  if (
    command === "resume" ||
    command === "inspect" ||
    command === "wait" ||
    command === "stop"
  ) {
    index = 1;
  } else if (command === "session") {
    index =
      argv[1] === "turn" || (argv[1] === "query" && ["inspect", "wait"].includes(String(argv[2])))
        ? 3
        : 2;
  }
  if (index === undefined) return { argv, name: selection.name };
  const value = argv[index];
  if (!value || value.startsWith("-")) return { argv, name: selection.name };
  const separator = value.indexOf(":");
  if (separator <= 0) return { argv, name: selection.name };
  const targetName = value.slice(0, separator);
  const identifier = value.slice(separator + 1);
  if (!identifier) return { argv, name: selection.name };
  if (selection.explicit && selection.name !== targetName) {
    throw new Error(
      `Runtime ${selection.name} conflicts with target-qualified reference ${targetName}`,
    );
  }
  argv[index] = identifier;
  return { argv, name: targetName };
}

function parseRunArgs(argv: string[]): {
  workflowPath: string;
  inputPath?: string;
  cwd?: string;
  stateDir?: string;
  maxConcurrency?: number;
  harnessConfigPath?: string;
  submissionId?: string;
  detach: boolean;
} {
  const workflowPath = argv[0];
  if (!workflowPath || workflowPath.startsWith("-")) throw new Error("run requires a workflow path");
  const result: {
    workflowPath: string;
    inputPath?: string;
    cwd?: string;
    stateDir?: string;
    maxConcurrency?: number;
    harnessConfigPath?: string;
    submissionId?: string;
    detach: boolean;
  } = { workflowPath, detach: false };
  for (let index = 1; index < argv.length; index++) {
    const option = argv[index];
    if (option === "--detach") {
      if (result.detach) throw new Error("--detach may only be supplied once");
      result.detach = true;
      continue;
    }
    const value = argv[index + 1];
    if (
      !option ||
      ![
        "--input",
        "--cwd",
        "--state-dir",
        "--max-concurrency",
        "--harness-config",
        "--submission-id",
      ].includes(option)
    ) {
      throw new Error(`Unknown run option: ${String(option)}`);
    }
    if (!value) throw new Error(`${option} requires a value`);
    index++;
    if (option === "--input") result.inputPath = value;
    if (option === "--cwd") result.cwd = value;
    if (option === "--state-dir") result.stateDir = path.resolve(value);
    if (option === "--max-concurrency") result.maxConcurrency = parsePositiveInteger(value, option);
    if (option === "--harness-config") result.harnessConfigPath = value;
    if (option === "--submission-id") {
      result.submissionId = normalizeSubmissionId(value, "Invalid submission id");
    }
  }
  return result;
}

function parseResumeArgs(argv: string[]): {
  runId: string;
  stateDir?: string;
  detach: boolean;
} {
  const runId = normalizeRunId(argv[0], "resume requires a run id");
  let stateDir: string | undefined;
  let detach = false;
  for (let index = 1; index < argv.length; index++) {
    const option = argv[index];
    if (option === "--detach") {
      detach = true;
      continue;
    }
    if (option !== "--state-dir") throw new Error(`Unknown resume option: ${String(option)}`);
    const value = argv[++index];
    if (!value) throw new Error("--state-dir requires a value");
    stateDir = path.resolve(value);
  }
  return { runId, ...(stateDir ? { stateDir } : {}), detach };
}

function parseInspectArgs(argv: string[]): {
  runId: string;
  stateDir?: string;
  events: boolean;
  stepId?: string;
  transcript?: "stdout" | "stderr";
} {
  const runId = normalizeRunId(argv[0], "inspect requires a run id");
  const result: {
    runId: string;
    stateDir?: string;
    events: boolean;
    stepId?: string;
    transcript?: "stdout" | "stderr";
  } = { runId, events: false };
  for (let index = 1; index < argv.length; index++) {
    const option = argv[index];
    if (option === "--summary" || option === "--json") continue;
    if (option === "--events") {
      result.events = true;
      continue;
    }
    const value = argv[index + 1];
    if (option !== "--state-dir" && option !== "--step" && option !== "--transcript") {
      throw new Error(`Unknown inspect option: ${String(option)}`);
    }
    if (!value) throw new Error(`${option} requires a value`);
    index++;
    if (option === "--state-dir") result.stateDir = path.resolve(value);
    if (option === "--step") result.stepId = value;
    if (option === "--transcript") {
      if (value !== "stdout" && value !== "stderr") {
        throw new Error("--transcript must be stdout or stderr");
      }
      result.transcript = value;
    }
  }
  return result;
}

function parseControlArgs(
  argv: string[],
  command: "wait" | "stop",
): { runId: string; stateDir?: string } {
  const runId = normalizeRunId(argv[0], `${command} requires a run id`);
  let stateDir: string | undefined;
  for (let index = 1; index < argv.length; index++) {
    const option = argv[index];
    if (option === "--json") continue;
    if (option !== "--state-dir") throw new Error(`Unknown ${command} option: ${String(option)}`);
    const value = argv[++index];
    if (!value) throw new Error("--state-dir requires a value");
    stateDir = path.resolve(value);
  }
  return { runId, ...(stateDir ? { stateDir } : {}) };
}

function parseListArgs(argv: string[]): { stateDir?: string; limit?: number } {
  let stateDir: string | undefined;
  let limit: number | undefined;
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (option === "--json") continue;
    const value = argv[++index];
    if (!value) throw new Error(`${String(option)} requires a value`);
    if (option === "--state-dir") stateDir = path.resolve(value);
    else if (option === "--limit") limit = parsePositiveInteger(value, option);
    else throw new Error(`Unknown list option: ${String(option)}`);
  }
  return { ...(stateDir ? { stateDir } : {}), ...(limit ? { limit } : {}) };
}

function parseSessionOptions(
  argv: string[],
  action: string,
): {
  stateDir?: string;
  message?: string;
  timeoutMs?: number;
  requestId?: string;
  detach: boolean;
} {
  const result: {
    stateDir?: string;
    message?: string;
    timeoutMs?: number;
    requestId?: string;
    detach: boolean;
  } = { detach: false };
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (option === "--json") continue;
    if (option === "--detach") {
      if (result.detach) throw new Error("--detach may only be supplied once");
      result.detach = true;
      continue;
    }
    if (
      !option ||
      !["--state-dir", "--message", "--timeout-ms", "--request-id"].includes(option)
    ) {
      throw new Error(`Unknown session ${action} option: ${String(option)}`);
    }
    const value = argv[++index];
    if (!value) throw new Error(`${option} requires a value`);
    if (option === "--state-dir") result.stateDir = path.resolve(value);
    if (option === "--message") result.message = value;
    if (option === "--timeout-ms") result.timeoutMs = parsePositiveInteger(value, option);
    if (option === "--request-id") result.requestId = normalizeTurnId(value, "Invalid request id");
  }
  if (action !== "resume" && result.timeoutMs !== undefined) {
    throw new Error("--timeout-ms is only valid for session resume");
  }
  if (action !== "resume" && action !== "steer" && result.message !== undefined) {
    throw new Error(`--message is not valid for session ${action}`);
  }
  if (action !== "resume" && (result.requestId !== undefined || result.detach)) {
    throw new Error(`--request-id and --detach are only valid for session resume`);
  }
  return result;
}

function parseDoctorArgs(argv: string[]): string | undefined {
  if (argv.length === 0) return undefined;
  if (argv[0] !== "--harness-config" || !argv[1] || argv.length !== 2) {
    throw new Error("doctor accepts only --harness-config FILE");
  }
  return argv[1];
}

function parseBackendOptions(
  argv: string[],
  allowInstallOptions: boolean,
): {
  socketPath?: string;
  stateDir?: string;
  harnessConfigPath?: string;
  hooksConfigPath?: string;
  runtimeModuleConfigPath?: string;
  clearRuntimeModuleConfig?: boolean;
} {
  const result: {
    socketPath?: string;
    stateDir?: string;
    harnessConfigPath?: string;
    hooksConfigPath?: string;
    runtimeModuleConfigPath?: string;
    clearRuntimeModuleConfig?: boolean;
  } = {};
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    const allowed = allowInstallOptions
      ? [
          "--socket",
          "--state-dir",
          "--harness-config",
          "--hooks-config",
          "--runtime-config",
          "--clear-runtime-config",
        ]
      : ["--socket"];
    if (!option || !allowed.includes(option)) {
      throw new Error(`Unknown backend option: ${String(option)}`);
    }
    if (option === "--clear-runtime-config") {
      if (result.clearRuntimeModuleConfig) {
        throw new Error("--clear-runtime-config may only be supplied once");
      }
      result.clearRuntimeModuleConfig = true;
      continue;
    }
    const value = argv[++index];
    if (!value) throw new Error(`${option} requires a value`);
    if (option === "--socket") result.socketPath = path.resolve(value);
    if (option === "--state-dir") result.stateDir = path.resolve(value);
    if (option === "--harness-config") result.harnessConfigPath = path.resolve(value);
    if (option === "--hooks-config") result.hooksConfigPath = path.resolve(value);
    if (option === "--runtime-config") result.runtimeModuleConfigPath = path.resolve(value);
  }
  if (result.runtimeModuleConfigPath && result.clearRuntimeModuleConfig) {
    throw new Error("--runtime-config conflicts with --clear-runtime-config");
  }
  return result;
}

async function requiredSessionMessage(value: string | undefined, action: string): Promise<string> {
  if (value === undefined) throw new Error(`session ${action} requires --message TEXT|-`);
  const message = value === "-" ? await readStdin() : value;
  if (message.trim().length === 0) throw new Error(`session ${action} message must be non-empty`);
  return message;
}

async function readJsonInput(inputPath: string): Promise<unknown> {
  const text = inputPath === "-" ? await readStdin() : await readFile(path.resolve(inputPath), "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Input is not valid JSON: ${errorMessage(error)}`);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function withClientSignals<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const onTerm = (): void => controller.abort(new RunStoppedError("Jaeger command received SIGTERM"));
  const onInt = (): void => controller.abort(new RunStoppedError("Jaeger command received SIGINT"));
  process.once("SIGTERM", onTerm);
  process.once("SIGINT", onInt);
  try {
    return await operation(controller.signal);
  } finally {
    process.removeListener("SIGTERM", onTerm);
    process.removeListener("SIGINT", onInt);
  }
}

function normalizeRunId(value: string | undefined, missingMessage: string): string {
  if (!value || value.startsWith("-")) throw new Error(missingMessage);
  const runId = value.startsWith("local:") ? value.slice("local:".length) : value;
  if (!/^\d{14}-[a-f0-9]{10}$/.test(runId)) throw new Error("Invalid Jaeger run id");
  return runId;
}

function normalizeSubmissionId(value: string | undefined, missingMessage: string): string {
  if (!value || value.startsWith("-")) throw new Error(missingMessage);
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(value)) throw new Error("Invalid submission id");
  return value;
}

function normalizeTurnId(value: string | undefined, missingMessage: string): string {
  if (!value || value.startsWith("-")) throw new Error(missingMessage);
  if (!/^turn-[A-Za-z0-9._:-]{8,123}$/.test(value)) throw new Error("Invalid session turn id");
  return value;
}

function normalizeQueryId(value: string | undefined, missingMessage: string): string {
  if (!value || value.startsWith("-")) throw new Error(missingMessage);
  if (!/^query-[A-Za-z0-9._:-]{8,122}$/.test(value)) {
    throw new Error("Invalid session query id");
  }
  return value;
}

function normalizeScheduleName(value: string | undefined, missingMessage: string): string {
  if (!value || value.startsWith("-")) throw new Error(missingMessage);
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(value)) throw new Error("Invalid schedule name");
  return value;
}

function runIdFromValue(value: JsonValue): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Jaeger backend returned an invalid run view");
  }
  return normalizeRunId(typeof value.runId === "string" ? value.runId : undefined, "Run view has no id");
}

function terminalStatus(value: JsonValue): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return ["completed", "failed", "stopped", "rejected", "uncertain"].includes(String(value.status));
}

function setFailureExitCode(value: JsonValue): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  if (isFailureStatus(value)) process.exitCode = 1;
}

function isFailureStatus(value: JsonValue): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return ["failed", "stopped", "rejected", "uncertain", "interrupted"].includes(String(value.status));
}

function compactRunRecord(value: JsonValue): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value);
  return JSON.stringify({
    runId: value.runId,
    status: value.status,
    inspect: value.inspect,
    stop: value.stop,
  });
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} requires a positive integer`);
  }
  return parsed;
}

function jsonParams(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Command parameters are not JSON-serializable");
  return JSON.parse(serialized) as JsonValue;
}

function booleanField(value: JsonValue, key: string): boolean {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) && value[key] === true,
  );
}

function recordField(value: JsonValue, key: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const field = value[key];
  return Boolean(field && typeof field === "object" && !Array.isArray(field));
}

function jsonRecordField(
  value: JsonValue,
  key: string,
): Record<string, JsonValue> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const field = value[key];
  return field && typeof field === "object" && !Array.isArray(field)
    ? (field as Record<string, JsonValue>)
    : undefined;
}

function assertRemoteStateDirAbsent(
  client: RuntimeClient,
  stateDir: string | undefined,
): void {
  if (client.remote && stateDir) {
    throw new Error(
      "--state-dir cannot target a remote runtime; the remote backend owns its configured state root",
    );
  }
}

function requireRemoteAbsolutePath(value: string, option: string): string {
  if (!path.posix.isAbsolute(value)) {
    throw new Error(`${option} must be an absolute path on the remote Jaeger runtime`);
  }
  return path.posix.normalize(value);
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`jaeger: ${formatError(error)}\n`);
  process.exitCode = 1;
});

function formatError(error: unknown): string {
  if (error instanceof AggregateError) {
    return `${error.message}\n${error.errors.map(formatError).join("\n")}`;
  }
  if (error instanceof HarnessExecutionError) {
    const detail = error.stderr.trim();
    return detail ? `${error.message}\n${detail}` : error.message;
  }
  return errorMessage(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
