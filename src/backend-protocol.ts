import type { JsonValue } from "./types.js";

export const BACKEND_PROTOCOL_VERSION = 1;
export const MAX_BACKEND_FRAME_BYTES = 16 * 1024 * 1024;

export type BackendMethod =
  | "ping"
  | "doctor"
  | "run.submit"
  | "run.lookup"
  | "run.inspect"
  | "run.wait"
  | "run.stop"
  | "run.resume"
  | "run.list"
  | "run.details"
  | "schedule.apply"
  | "schedule.list"
  | "schedule.inspect"
  | "schedule.enable"
  | "schedule.disable"
  | "schedule.remove"
  | "schedule.history"
  | "schedule.trigger"
  | "hooks.status"
  | "hooks.history"
  | "modules.status"
  | "session.list"
  | "session.inspect"
  | "session.resume"
  | "session.query.submit"
  | "session.query.inspect"
  | "session.query.wait"
  | "session.turn.inspect"
  | "session.turn.wait"
  | "session.control";

export interface BackendRequest {
  readonly protocol: 1;
  readonly id: string;
  readonly generation?: string;
  readonly instanceId?: string;
  readonly method: BackendMethod;
  readonly params: JsonValue;
}

export interface BackendResponse {
  readonly protocol: 1;
  readonly id: string;
  readonly ok: boolean;
  readonly result?: JsonValue;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export class BackendRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BackendRpcError";
  }
}

export function parseBackendRequest(value: unknown): BackendRequest {
  if (!isRecord(value)) throw new BackendRpcError("invalid_request", "Backend request must be an object");
  if (value.protocol !== BACKEND_PROTOCOL_VERSION) {
    throw new BackendRpcError(
      "protocol_mismatch",
      `Backend protocol ${String(value.protocol)} is unsupported; expected ${BACKEND_PROTOCOL_VERSION}`,
    );
  }
  if (typeof value.id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.id)) {
    throw new BackendRpcError("invalid_request", "Backend request id is invalid");
  }
  if (
    value.generation !== undefined &&
    (typeof value.generation !== "string" || !/^[a-f0-9]{32}$/.test(value.generation))
  ) {
    throw new BackendRpcError("invalid_request", "Backend generation is invalid");
  }
  if (
    value.instanceId !== undefined &&
    (typeof value.instanceId !== "string" || !/^[a-f0-9]{32}$/.test(value.instanceId))
  ) {
    throw new BackendRpcError("invalid_request", "Backend instance id is invalid");
  }
  if (!isBackendMethod(value.method)) {
    throw new BackendRpcError("unknown_method", `Unknown backend method: ${String(value.method)}`);
  }
  if (!isJsonValue(value.params)) {
    throw new BackendRpcError("invalid_request", "Backend request params must be JSON");
  }
  return value as unknown as BackendRequest;
}

export function parseBackendResponse(value: unknown, expectedId: string): BackendResponse {
  if (!isRecord(value)) throw new Error("Jaeger backend returned a non-object response");
  if (value.protocol !== BACKEND_PROTOCOL_VERSION) {
    throw new Error(
      `Jaeger backend protocol ${String(value.protocol)} is unsupported; expected ${BACKEND_PROTOCOL_VERSION}`,
    );
  }
  if (value.id !== expectedId || typeof value.ok !== "boolean") {
    throw new Error("Jaeger backend returned an invalid response envelope");
  }
  if (value.ok) {
    if (!isJsonValue(value.result)) throw new Error("Jaeger backend returned a non-JSON result");
  } else if (
    !isRecord(value.error) ||
    typeof value.error.code !== "string" ||
    typeof value.error.message !== "string"
  ) {
    throw new Error("Jaeger backend returned an invalid error envelope");
  }
  return value as unknown as BackendResponse;
}

export function successResponse(id: string, result: JsonValue): BackendResponse {
  return { protocol: BACKEND_PROTOCOL_VERSION, id, ok: true, result };
}

export function errorResponse(id: string, error: unknown): BackendResponse {
  const rpc = error instanceof BackendRpcError ? error : undefined;
  return {
    protocol: BACKEND_PROTOCOL_VERSION,
    id,
    ok: false,
    error: {
      code: rpc?.code ?? errorCode(error),
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

export function isBackendMethod(value: unknown): value is BackendMethod {
  return (
    typeof value === "string" &&
    [
      "ping",
      "doctor",
      "run.submit",
      "run.lookup",
      "run.inspect",
      "run.wait",
      "run.stop",
      "run.resume",
      "run.list",
      "run.details",
      "schedule.apply",
      "schedule.list",
      "schedule.inspect",
      "schedule.enable",
      "schedule.disable",
      "schedule.remove",
      "schedule.history",
      "schedule.trigger",
      "hooks.status",
      "hooks.history",
      "modules.status",
      "session.list",
      "session.inspect",
      "session.resume",
      "session.query.submit",
      "session.query.inspect",
      "session.query.wait",
      "session.turn.inspect",
      "session.turn.wait",
      "session.control",
    ].includes(value)
  );
}

function errorCode(error: unknown): string {
  if (!(error instanceof Error)) return "internal_error";
  if (error.name === "UncertainAgentRunError") return "uncertain_run";
  if (error.name === "RunOwnedError") return "run_owned";
  if (error.name === "RunTerminalError") return "terminal_run";
  if (error.name === "WorkflowChangedError") return "workflow_changed";
  if (error.name === "JournalCorruptionError") return "state_corruption";
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return "not_found";
  return "operation_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}
