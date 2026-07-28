import os from "node:os";
import path from "node:path";
import {
  activeEnvironment,
  defaultEnvironmentPaths,
} from "./environments.js";
import { inspectHarnesses, type HarnessInspection } from "./doctor.js";
import { loadHarnessDefinitions } from "./harnesses/registry.js";
import {
  defaultBackendSocketPath,
  readBackendInstallConfig,
} from "./paths.js";
import type { RuntimeClient } from "./runtime-client.js";
import type { RuntimeTarget } from "./runtime-targets.js";
import { backendServiceStatus } from "./service-manager.js";
import type { JsonValue } from "./types.js";
import { JAEGER_VERSION } from "./version.js";

export interface JaegerStatus {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly version: string;
  readonly node: string;
  readonly host: string;
  readonly runtime: "local-service" | "embedded" | "ssh-service";
  readonly target: string;
  readonly transport: "local" | "embedded" | "ssh";
  readonly backend: {
    readonly active: boolean;
    readonly connected: boolean;
    readonly pid?: number;
    readonly version?: string;
    readonly stateDir?: string;
    readonly error?: string;
  };
  readonly harnesses: readonly HarnessInspection[];
  readonly workflows: {
    readonly total: number;
    readonly active: number;
    readonly sessions: {
      readonly running: number;
      readonly idle: number;
    };
    readonly current: readonly {
      readonly runId: string;
      readonly status: string;
      readonly phase?: string;
    }[];
    readonly error?: string;
  };
  readonly schedules: {
    readonly total: number;
    readonly active: number;
    readonly paused: number;
    readonly names: readonly string[];
    readonly error?: string;
  };
  readonly environment: {
    readonly name: string;
    readonly resources: number;
    readonly plugins: number;
    readonly packages: number;
    readonly appliedAt: string;
  } | null;
  readonly warnings: readonly string[];
}

export async function collectStatus(
  client: RuntimeClient,
  selectedTarget: RuntimeTarget | "service" | "embedded",
): Promise<JaegerStatus> {
  const target: RuntimeTarget =
    selectedTarget === "service"
      ? { name: "local", transport: "local", kind: "local-service" }
      : selectedTarget === "embedded"
        ? { name: "embedded", transport: "embedded", kind: "embedded" }
        : selectedTarget;
  const profile = target.kind === "local-service" ? readBackendInstallConfig() : undefined;
  const harnessConfigPath =
    target.kind === "local-service" && profile?.socketPath === defaultBackendSocketPath()
      ? profile.harnessConfigPath
      : undefined;
  const [backendResult, harnessResult, runsResult, schedulesResult, environmentResult] =
    await Promise.allSettled([
      target.kind === "local-service"
        ? backendServiceStatus()
        : target.kind === "embedded"
          ? Promise.resolve({
            active: true,
            connected: true,
            backend: {
              pid: process.pid,
              version: JAEGER_VERSION,
              stateDir: path.resolve(".jaeger", "runs"),
            },
          })
          : client.call("ping"),
      target.kind === "ssh-service"
        ? client.call("doctor").then(harnessesFromDoctor)
        : loadHarnessDefinitions(harnessConfigPath).then(
            async (definitions) => await inspectHarnesses(definitions, 3_000),
          ),
      client.call("run.list", { limit: 500 }),
      target.kind !== "embedded"
        ? client.call("schedule.list")
        : Promise.resolve([] as JsonValue[]),
      target.kind === "ssh-service"
        ? Promise.resolve(undefined)
        : activeEnvironment(defaultEnvironmentPaths()),
    ]);

  const warnings: string[] = [];
  const backend =
    backendResult.status === "fulfilled"
      ? backendStatus(backendResult.value)
      : {
          active: false,
          connected: false,
          error: failureMessage(backendResult.reason),
        };
  if (backend.error) warnings.push(`backend: ${backend.error}`);

  const harnesses =
    harnessResult.status === "fulfilled" ? harnessResult.value : [];
  if (harnessResult.status === "rejected") {
    warnings.push(`harnesses: ${failureMessage(harnessResult.reason)}`);
  }

  const workflows =
    runsResult.status === "fulfilled"
      ? workflowStatus(runsResult.value)
      : emptyWorkflowStatus(failureMessage(runsResult.reason));
  if (workflows.error) warnings.push(`workflows: ${workflows.error}`);

  const schedules =
    schedulesResult.status === "fulfilled"
      ? scheduleStatus(schedulesResult.value)
      : emptyScheduleStatus(failureMessage(schedulesResult.reason));
  if (schedules.error) warnings.push(`schedules: ${schedules.error}`);

  let environment: JaegerStatus["environment"] = null;
  if (environmentResult.status === "fulfilled" && environmentResult.value) {
    const state = environmentResult.value;
    environment = {
      name: state.environment,
      resources: state.resources.length,
      plugins: state.plugins.length,
      packages: state.packages.length,
      appliedAt: state.appliedAt,
    };
  } else if (environmentResult.status === "rejected") {
    warnings.push(`environment: ${failureMessage(environmentResult.reason)}`);
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    version: JAEGER_VERSION,
    node: process.version,
    host: target.kind === "ssh-service" ? target.destination : os.hostname(),
    runtime: target.kind,
    target: target.name,
    transport: target.transport,
    backend,
    harnesses,
    workflows,
    schedules,
    environment,
    warnings,
  };
}

export function renderStatus(
  status: JaegerStatus,
  options: { readonly color?: boolean } = {},
): string {
  const color = options.color ?? false;
  const cyan = (value: string): string => paint(value, "36", color);
  const green = (value: string): string => paint(value, "32", color);
  const yellow = (value: string): string => paint(value, "33", color);
  const red = (value: string): string => paint(value, "31", color);
  const dim = (value: string): string => paint(value, "2", color);
  const label = (value: string): string => cyan(value.padEnd(12));

  const availableHarnesses = status.harnesses.filter((harness) => harness.available);
  const harnessSummary =
    status.harnesses.length === 0
      ? "none detected"
      : `${availableHarnesses.length}/${status.harnesses.length} available`;
  const backendState = status.backend.active
    ? green(`healthy${status.backend.pid ? ` · pid ${status.backend.pid}` : ""}`)
    : red("unavailable");
  const workflowSummary =
    `${status.workflows.active} active · ${status.workflows.total} recorded`;
  const sessionSummary =
    `${status.workflows.sessions.running} running · ${status.workflows.sessions.idle} idle`;
  const scheduleSummary =
    `${status.schedules.active} active · ${status.schedules.paused} paused · ${status.schedules.total} configured`;
  const environmentSummary = status.environment
    ? `${status.environment.name} · ${status.environment.resources} resources · ${status.environment.plugins} plugins · ${status.environment.packages} packages`
    : "none";

  const info: string[] = [
    `${cyan("jaeger")}@${status.host}`,
    dim("─".repeat(Math.min(38, `jaeger@${status.host}`.length))),
    `${label("Version")} ${status.version} · Node ${status.node}`,
    `${label("Runtime")} ${status.target} · ${status.runtime} · ${backendState}`,
    `${label("Harnesses")} ${harnessSummary}`,
    ...status.harnesses.map((harness) => {
      const state = harness.available ? green("●") : red("○");
      const version = harness.version ? compactVersion(harness.version) : "unavailable";
      return `${"".padEnd(13)}${state} ${harness.name} · ${version}`;
    }),
    `${label("Workflows")} ${workflowSummary}`,
    `${label("Sessions")} ${sessionSummary}`,
    ...status.workflows.current.slice(0, 3).map(
      (run) =>
        `${"".padEnd(13)}${yellow("●")} ${run.runId} · ${run.status}${run.phase ? ` · ${run.phase}` : ""}`,
    ),
    `${label("Schedules")} ${scheduleSummary}`,
    ...(status.schedules.names.length > 0
      ? [`${"".padEnd(13)}${status.schedules.names.join(", ")}`]
      : []),
    `${label("Environment")} ${environmentSummary}`,
    ...(status.backend.stateDir
      ? [`${label("State")} ${status.backend.stateDir}`]
      : []),
    ...(status.warnings.length > 0
      ? [`${label("Warnings")} ${status.warnings.length} · run ${cyan("jaeger doctor")}`]
      : []),
    `${label("Commands")} ${cyan("jaeger --help")} · ${cyan("jaeger status --json")}`,
  ];

  const logo = [
    "       /\\",
    "   ___/  \\___",
    "  /   JAEGER  \\",
    "  \\___    ___/",
    "      \\__/",
  ];
  const height = Math.max(logo.length, info.length);
  const lines: string[] = [];
  for (let index = 0; index < height; index++) {
    const mark = logo[index] ?? "";
    const detail = info[index] ?? "";
    lines.push(`${cyan(mark.padEnd(19))}${detail}`.trimEnd());
  }
  return `${lines.join("\n")}\n`;
}

function backendStatus(value: unknown): JaegerStatus["backend"] {
  const record = asRecord(value);
  const descriptor = asRecord(record?.backend);
  return {
    active:
      record?.active === true ||
      (record?.ready === true && descriptor?.admissionReady === true),
    connected: record?.connected === true || descriptor !== undefined,
    ...(typeof descriptor?.pid === "number" ? { pid: descriptor.pid } : {}),
    ...(typeof descriptor?.version === "string" ? { version: descriptor.version } : {}),
    ...(typeof descriptor?.stateDir === "string" ? { stateDir: descriptor.stateDir } : {}),
    ...(typeof record?.error === "string" ? { error: record.error } : {}),
  };
}

function harnessesFromDoctor(value: JsonValue): readonly HarnessInspection[] {
  const record = asRecord(value);
  if (!Array.isArray(record?.harnesses)) {
    throw new Error("Remote Jaeger doctor returned no harness inspection");
  }
  return record.harnesses.map((value, index) => {
    const harness = asRecord(value);
    if (
      !harness ||
      typeof harness.name !== "string" ||
      typeof harness.transport !== "string" ||
      typeof harness.available !== "boolean"
    ) {
      throw new Error(`Remote Jaeger doctor returned invalid harness ${index}`);
    }
    return {
      name: harness.name,
      transport: harness.transport,
      available: harness.available,
      ...(typeof harness.version === "string" ? { version: harness.version } : {}),
      ...(typeof harness.error === "string" ? { error: harness.error } : {}),
    };
  });
}

function workflowStatus(value: JsonValue): JaegerStatus["workflows"] {
  const records = Array.isArray(value) ? value.map(asRecord).filter(isPresent) : [];
  const activeRecords = records.filter((record) =>
    ["pending", "running", "stopping"].includes(String(record.status)),
  );
  return {
    total: records.length,
    active: activeRecords.length,
    sessions: {
      running: records.reduce(
        (count, record) => count + numericField(asRecord(record.sessions), "running"),
        0,
      ),
      idle: records.reduce(
        (count, record) => count + numericField(asRecord(record.sessions), "idle"),
        0,
      ),
    },
    current: activeRecords.map((record) => ({
      runId: String(record.runId ?? "unknown"),
      status: String(record.status ?? "unknown"),
      ...(typeof record.currentPhase === "string" ? { phase: record.currentPhase } : {}),
    })),
  };
}

function scheduleStatus(value: JsonValue): JaegerStatus["schedules"] {
  const records = Array.isArray(value) ? value.map(asRecord).filter(isPresent) : [];
  return {
    total: records.length,
    active: records.filter((record) => record.enabled === true).length,
    paused: records.filter((record) => typeof record.pausedReason === "string").length,
    names: records.map((record) => String(record.id ?? "unknown")),
  };
}

function emptyWorkflowStatus(error: string): JaegerStatus["workflows"] {
  return {
    total: 0,
    active: 0,
    sessions: { running: 0, idle: 0 },
    current: [],
    error,
  };
}

function emptyScheduleStatus(error: string): JaegerStatus["schedules"] {
  return { total: 0, active: 0, paused: 0, names: [], error };
}

function asRecord(value: unknown): Record<string, JsonValue> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function numericField(
  record: Record<string, JsonValue> | undefined,
  key: string,
): number {
  const value = record?.[key];
  return typeof value === "number" ? value : 0;
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function compactVersion(version: string): string {
  return version.replace(/\s+/g, " ").trim().slice(0, 72);
}

function paint(value: string, code: string, enabled: boolean): string {
  return enabled ? `\u001b[${code}m${value}\u001b[0m` : value;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
