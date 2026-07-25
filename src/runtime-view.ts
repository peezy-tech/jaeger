import type { BackendMethod } from "./backend-protocol.js";
import type { SshRuntimeTarget } from "./runtime-targets.js";
import type { JsonValue } from "./types.js";

export function qualifyRemoteResult(
  method: BackendMethod,
  value: JsonValue,
  target: SshRuntimeTarget,
): JsonValue {
  if (method === "ping" || method === "doctor") {
    return qualifyBackendDescriptor(value, target);
  }
  if (method === "run.details") {
    const details = asRecord(value);
    if (!details) return value;
    const summary = details.summary;
    return jsonValue({
      ...details,
      ...(summary !== undefined
        ? { summary: qualifyRunSummary(summary as JsonValue, target) }
        : {}),
      location: remoteLocation(target),
    });
  }
  if (method === "run.list") {
    return Array.isArray(value)
      ? value.map((item) => qualifyRunSummary(item, target))
      : value;
  }
  if (
    method === "run.submit" ||
    method === "run.lookup" ||
    method === "run.inspect" ||
    method === "run.wait" ||
    method === "run.stop" ||
    method === "run.resume"
  ) {
    return qualifyRunSummary(value, target);
  }
  if (method === "session.list") {
    return Array.isArray(value)
      ? value.map((item) => qualifySession(item, target))
      : value;
  }
  if (method === "session.inspect") return qualifySession(value, target);
  if (
    method === "session.resume" ||
    method === "session.turn.inspect" ||
    method === "session.turn.wait"
  ) {
    return qualifySessionTurn(value, target);
  }
  if (
    method === "session.query.submit" ||
    method === "session.query.inspect" ||
    method === "session.query.wait"
  ) {
    return qualifySessionQuery(value, target);
  }
  if (method.startsWith("schedule.")) {
    return qualifyScheduleValue(value, target);
  }
  if (method.startsWith("hooks.") || method === "modules.status") {
    const record = asRecord(value);
    return record
      ? jsonValue({
          ...record,
          runtime: target.name,
          location: remoteLocation(target),
        })
      : value;
  }
  return value;
}

function qualifySessionQuery(value: JsonValue, target: SshRuntimeTarget): JsonValue {
  const query = asRecord(value);
  if (
    !query ||
    typeof query.runId !== "string" ||
    typeof query.queryId !== "string"
  ) {
    return value;
  }
  const runRef = `${target.name}:${query.runId}`;
  const commandTarget = `${runRef} ${query.queryId}`;
  return jsonValue({
    ...query,
    runRef,
    location: remoteLocation(target),
    inspect: `jaeger session query inspect ${commandTarget}`,
    ...(typeof query.wait === "string"
      ? { wait: `jaeger session query wait ${commandTarget}` }
      : {}),
  });
}

function qualifyBackendDescriptor(
  value: JsonValue,
  target: SshRuntimeTarget,
): JsonValue {
  const root = asRecord(value);
  const backend = asRecord(root?.backend);
  if (!root || !backend) return value;
  return jsonValue({
    ...root,
    backend: {
      ...backend,
      name: target.name,
      transport: "ssh",
      destination: target.destination,
    },
    location: remoteLocation(target),
  });
}

function qualifyRunSummary(value: JsonValue, target: SshRuntimeTarget): JsonValue {
  const summary = asRecord(value);
  if (!summary || typeof summary.runId !== "string") return value;
  const runId = summary.runId;
  const runRef = `${target.name}:${runId}`;
  return jsonValue({
    ...summary,
    backend: {
      name: target.name,
      kind: "local-service",
      transport: "ssh",
      destination: target.destination,
    },
    runRef,
    location: remoteLocation(target),
    inspect: `jaeger inspect ${runRef} --summary --json`,
    ...(typeof summary.wait === "string" ? { wait: `jaeger wait ${runRef}` } : {}),
    ...(typeof summary.stop === "string" ? { stop: `jaeger stop ${runRef}` } : {}),
    ...(typeof summary.resume === "string" ? { resume: `jaeger resume ${runRef}` } : {}),
  });
}

function qualifySession(value: JsonValue, target: SshRuntimeTarget): JsonValue {
  const session = asRecord(value);
  if (
    !session ||
    typeof session.runId !== "string" ||
    typeof session.id !== "string"
  ) {
    return value;
  }
  const runRef = `${target.name}:${session.runId}`;
  const commandTarget = `${runRef} ${session.id}`;
  return jsonValue({
    ...session,
    runRef,
    location: remoteLocation(target),
    inspect: `jaeger session inspect ${commandTarget}`,
    ...(typeof session.steer === "string"
      ? { steer: `jaeger session steer ${commandTarget} --message -` }
      : {}),
    ...(typeof session.interrupt === "string"
      ? { interrupt: `jaeger session interrupt ${commandTarget}` }
      : {}),
    ...(typeof session.resume === "string"
      ? { resume: `jaeger session resume ${commandTarget} --message -` }
      : {}),
  });
}

function qualifySessionTurn(value: JsonValue, target: SshRuntimeTarget): JsonValue {
  const turn = asRecord(value);
  if (
    !turn ||
    typeof turn.runId !== "string" ||
    typeof turn.turnId !== "string"
  ) {
    return value;
  }
  const runRef = `${target.name}:${turn.runId}`;
  const commandTarget = `${runRef} ${turn.turnId}`;
  return jsonValue({
    ...turn,
    runRef,
    location: remoteLocation(target),
    inspect: `jaeger session turn inspect ${commandTarget}`,
    ...(typeof turn.wait === "string"
      ? { wait: `jaeger session turn wait ${commandTarget}` }
      : {}),
    ...(typeof turn.interrupt === "string" && typeof turn.sessionId === "string"
      ? {
          interrupt: `jaeger session interrupt ${runRef} ${turn.sessionId}`,
        }
      : {}),
  });
}

function qualifyScheduleValue(value: JsonValue, target: SshRuntimeTarget): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => qualifyScheduleValue(item, target));
  }
  const item = asRecord(value);
  if (!item) return value;
  const runId = typeof item.runId === "string" ? item.runId : undefined;
  const runRef = runId ? `${target.name}:${runId}` : undefined;
  return jsonValue({
    ...item,
    runtime: target.name,
    location: remoteLocation(target),
    ...(runRef ? { runRef } : {}),
    ...(runRef && typeof item.inspect === "string"
      ? { inspect: `jaeger inspect ${runRef} --summary --json` }
      : {}),
    ...(runRef && typeof item.wait === "string" ? { wait: `jaeger wait ${runRef}` } : {}),
    ...(runRef && typeof item.stop === "string" ? { stop: `jaeger stop ${runRef}` } : {}),
  });
}

function remoteLocation(target: SshRuntimeTarget): Record<string, string> {
  return {
    runtime: target.name,
    transport: "ssh",
    destination: target.destination,
  };
}

function asRecord(value: unknown): Record<string, JsonValue> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : undefined;
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
