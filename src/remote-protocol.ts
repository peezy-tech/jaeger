import {
  BACKEND_PROTOCOL_VERSION,
  BackendRpcError,
  isBackendMethod,
  type BackendMethod,
} from "./backend-protocol.js";
import type { JsonValue } from "./types.js";

export const REMOTE_TRANSPORT_VERSION = 1;

export interface RemoteTransportRequest {
  readonly transport: 1;
  readonly id: string;
  readonly expectedInstanceId?: string;
  readonly backendProtocol: 1;
  readonly method: BackendMethod;
  readonly params: JsonValue;
}

export interface RemoteTransportResponse {
  readonly transport: 1;
  readonly id: string;
  readonly instanceId?: string;
  readonly backendProtocol: 1;
  readonly ok: boolean;
  readonly result?: JsonValue;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export function parseRemoteTransportRequest(value: unknown): RemoteTransportRequest {
  const request = record(value, "Remote transport request");
  if (request.transport !== REMOTE_TRANSPORT_VERSION) {
    throw new BackendRpcError(
      "transport_mismatch",
      `Remote transport ${String(request.transport)} is unsupported; expected ${REMOTE_TRANSPORT_VERSION}`,
    );
  }
  if (request.backendProtocol !== BACKEND_PROTOCOL_VERSION) {
    throw new BackendRpcError(
      "protocol_mismatch",
      `Remote backend protocol ${String(request.backendProtocol)} is unsupported; expected ${BACKEND_PROTOCOL_VERSION}`,
    );
  }
  if (typeof request.id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(request.id)) {
    throw new BackendRpcError("invalid_request", "Remote transport request id is invalid");
  }
  if (
    request.expectedInstanceId !== undefined &&
    (typeof request.expectedInstanceId !== "string" ||
      !/^[a-f0-9]{32}$/.test(request.expectedInstanceId))
  ) {
    throw new BackendRpcError("invalid_request", "Expected remote instance id is invalid");
  }
  if (!isBackendMethod(request.method)) {
    throw new BackendRpcError(
      "unknown_method",
      `Unknown backend method: ${String(request.method)}`,
    );
  }
  if (!isJsonValue(request.params)) {
    throw new BackendRpcError("invalid_request", "Remote transport params must be JSON");
  }
  return request as unknown as RemoteTransportRequest;
}

export function parseRemoteTransportResponse(
  value: unknown,
  expectedId: string,
): RemoteTransportResponse {
  const response = record(value, "Remote transport response");
  if (response.transport !== REMOTE_TRANSPORT_VERSION) {
    throw new Error(
      `Remote transport ${String(response.transport)} is unsupported; expected ${REMOTE_TRANSPORT_VERSION}`,
    );
  }
  if (response.backendProtocol !== BACKEND_PROTOCOL_VERSION) {
    throw new Error(
      `Remote backend protocol ${String(response.backendProtocol)} is unsupported; expected ${BACKEND_PROTOCOL_VERSION}`,
    );
  }
  if (response.id !== expectedId || typeof response.ok !== "boolean") {
    throw new Error("Remote Jaeger returned an invalid response envelope");
  }
  if (
    response.instanceId !== undefined &&
    (typeof response.instanceId !== "string" || !/^[a-f0-9]{32}$/.test(response.instanceId))
  ) {
    throw new Error("Remote Jaeger returned an invalid instance id");
  }
  if (response.ok) {
    if (!isJsonValue(response.result)) {
      throw new Error("Remote Jaeger returned a non-JSON result");
    }
  } else if (
    !isRecord(response.error) ||
    typeof response.error.code !== "string" ||
    typeof response.error.message !== "string"
  ) {
    throw new Error("Remote Jaeger returned an invalid error envelope");
  }
  return response as unknown as RemoteTransportResponse;
}

export function remoteSuccess(
  id: string,
  result: JsonValue,
  instanceId: string,
): RemoteTransportResponse {
  return {
    transport: REMOTE_TRANSPORT_VERSION,
    id,
    instanceId,
    backendProtocol: BACKEND_PROTOCOL_VERSION,
    ok: true,
    result,
  };
}

export function remoteFailure(
  id: string,
  error: unknown,
  instanceId?: string,
): RemoteTransportResponse {
  const rpc = error instanceof BackendRpcError ? error : undefined;
  return {
    transport: REMOTE_TRANSPORT_VERSION,
    id,
    ...(instanceId ? { instanceId } : {}),
    backendProtocol: BACKEND_PROTOCOL_VERSION,
    ok: false,
    error: {
      code: rpc?.code ?? "operation_failed",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new BackendRpcError("invalid_request", `${label} must be an object`);
  return value;
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
