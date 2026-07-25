import { randomUUID } from "node:crypto";
import net, { type Socket } from "node:net";
import {
  BACKEND_PROTOCOL_VERSION,
  MAX_BACKEND_FRAME_BYTES,
  BackendRpcError,
  type BackendMethod,
  parseBackendResponse,
} from "./backend-protocol.js";
import { LocalRuntimeService } from "./local-runtime-service.js";
import type { JsonValue } from "./types.js";

export interface RuntimeClient {
  readonly kind: "embedded" | "local-service" | "ssh-service";
  readonly targetName?: string;
  readonly remote?: boolean;
  call(method: BackendMethod, params?: JsonValue, signal?: AbortSignal): Promise<JsonValue>;
}

export class EmbeddedRuntimeClient implements RuntimeClient {
  readonly kind = "embedded" as const;
  readonly targetName = "embedded";
  readonly remote = false;

  constructor(private readonly service: LocalRuntimeService) {}

  async call(
    method: BackendMethod,
    params: JsonValue = {},
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    return await this.service.dispatch(method, params, signal);
  }
}

export class ServiceRuntimeClient implements RuntimeClient {
  readonly kind = "local-service" as const;
  readonly targetName = "local";
  readonly remote = false;
  private readonly timeoutMs: number;
  private readonly retryWindowMs: number;
  private readonly expectedGeneration: string | undefined;
  private readonly expectedInstanceId: string | undefined;

  constructor(
    readonly socketPath: string,
    options: {
      readonly timeoutMs?: number;
      readonly retryWindowMs?: number;
      readonly expectedGeneration?: string;
      readonly expectedInstanceId?: string;
    } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retryWindowMs = options.retryWindowMs ?? 30_000;
    this.expectedGeneration = options.expectedGeneration;
    this.expectedInstanceId = options.expectedInstanceId;
  }

  async call(
    method: BackendMethod,
    params: JsonValue = {},
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const id = randomUUID();
    const request = `${JSON.stringify({
      protocol: BACKEND_PROTOCOL_VERSION,
      id,
      ...(this.expectedGeneration ? { generation: this.expectedGeneration } : {}),
      ...(this.expectedInstanceId ? { instanceId: this.expectedInstanceId } : {}),
      method,
      params,
    })}\n`;
    if (Buffer.byteLength(request) > MAX_BACKEND_FRAME_BYTES) {
      throw new BackendRpcError(
        "invalid_request",
        `Jaeger backend request exceeds ${MAX_BACKEND_FRAME_BYTES} bytes`,
      );
    }
    const retriable =
      method === "run.submit" ||
      method === "session.resume" ||
      method === "schedule.apply" ||
      method === "schedule.trigger";
    const attachedSessionResume =
      method === "session.resume" &&
      (!params || typeof params !== "object" || Array.isArray(params) || params.detach !== true);
    let retryDeadline: number | undefined;
    let failure: unknown;
    while (true) {
      try {
        const response = parseBackendResponse(
          JSON.parse(
            await exchange(
              this.socketPath,
              request,
              signal,
              method === "run.wait" ||
                attachedSessionResume ||
                method === "session.turn.wait"
                ? 0
                : method === "run.submit"
                  ? 10_000
                  : this.timeoutMs,
            ),
          ),
          id,
        );
        if (!response.ok) {
          throw new BackendRpcError(
            response.error?.code ?? "operation_failed",
            response.error?.message ?? "Jaeger backend operation failed",
          );
        }
        return response.result as JsonValue;
      } catch (error) {
        if (error instanceof BackendRpcError || signal?.aborted) throw error;
        failure = error;
        if (!retriable) break;
        retryDeadline ??= Date.now() + this.retryWindowMs;
        if (Date.now() >= retryDeadline) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const submissionHint =
      method === "run.submit" &&
      params &&
      typeof params === "object" &&
      !Array.isArray(params) &&
      typeof params.submissionId === "string"
        ? ` Submission id ${params.submissionId} is reusable; retry the same run command with --submission-id ${params.submissionId}, or inspect it with 'jaeger submission ${params.submissionId}'.`
        : "";
    const sessionTurnHint =
      method === "session.resume" &&
      params &&
      typeof params === "object" &&
      !Array.isArray(params) &&
      typeof params.runId === "string" &&
      /^\d{14}-[a-f0-9]{10}$/.test(params.runId) &&
      typeof params.turnId === "string" &&
      /^turn-[A-Za-z0-9._:-]{8,123}$/.test(params.turnId)
        ? ` Session turn ${params.turnId} may already be accepted; retry the original session resume command with --request-id ${params.turnId}, or inspect it with 'jaeger session turn inspect ${params.runId} ${params.turnId}'.`
        : "";
    const scheduleTriggerHint =
      method === "schedule.trigger" &&
      params &&
      typeof params === "object" &&
      !Array.isArray(params) &&
      typeof params.name === "string" &&
      typeof params.requestId === "string"
        ? ` Schedule trigger ${params.requestId} may already be accepted; retry 'jaeger schedule trigger ${params.name} --request-id ${params.requestId}'.`
        : "";
    throw new BackendRpcError(
      "backend_unavailable",
      `Jaeger backend is unavailable at ${this.socketPath}: ${errorMessage(failure)}. Run 'jaeger backend install'.${submissionHint}${sessionTurnHint}${scheduleTriggerHint}`,
    );
  }
}

async function exchange(
  socketPath: string,
  request: string,
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<string> {
  if (signal?.aborted) throw abortReason(signal);
  return await new Promise<string>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      operation();
    };
    const onAbort = (): void => finish(() => reject(abortReason(signal as AbortSignal)));
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.setEncoding("utf8");
    if (timeoutMs > 0) {
      socket.setTimeout(timeoutMs, () =>
        finish(() => reject(new Error(`Jaeger backend request timed out after ${timeoutMs}ms`))),
      );
    }
    socket.once("connect", () => socket.write(request));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_BACKEND_FRAME_BYTES) {
        finish(() => reject(new Error("Jaeger backend response exceeds size limit")));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline >= 0) finish(() => resolve(buffer.slice(0, newline)));
    });
    socket.once("error", (error) => finish(() => reject(error)));
    socket.once("end", () => {
      if (!settled) finish(() => reject(new Error("Jaeger backend closed without a response")));
    });
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Backend request aborted");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
