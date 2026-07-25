import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  BACKEND_PROTOCOL_VERSION,
  MAX_BACKEND_FRAME_BYTES,
  BackendRpcError,
  type BackendMethod,
} from "./backend-protocol.js";
import {
  REMOTE_TRANSPORT_VERSION,
  parseRemoteTransportResponse,
} from "./remote-protocol.js";
import type { RuntimeClient } from "./runtime-client.js";
import type { SshRuntimeTarget } from "./runtime-targets.js";
import { qualifyRemoteResult } from "./runtime-view.js";
import type { JsonValue } from "./types.js";

const MAX_STDERR_BYTES = 1024 * 1024;

export class SshRuntimeClient implements RuntimeClient {
  readonly kind = "ssh-service" as const;
  readonly remote = true;
  readonly targetName: string;
  private readonly sshCommand: string;
  private readonly retryWindowMs: number;
  private readonly discoverInstance: boolean;

  constructor(
    readonly target: SshRuntimeTarget,
    options: {
      readonly sshCommand?: string;
      readonly retryWindowMs?: number;
      readonly discoverInstance?: boolean;
    } = {},
  ) {
    this.targetName = target.name;
    this.sshCommand = options.sshCommand ?? "ssh";
    this.retryWindowMs = options.retryWindowMs ?? 30_000;
    this.discoverInstance = options.discoverInstance ?? false;
  }

  async call(
    method: BackendMethod,
    params: JsonValue = {},
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const id = randomUUID();
    const request = `${JSON.stringify({
      transport: REMOTE_TRANSPORT_VERSION,
      id,
      ...(!this.discoverInstance
        ? { expectedInstanceId: this.target.instanceId }
        : {}),
      backendProtocol: BACKEND_PROTOCOL_VERSION,
      method,
      params,
    })}\n`;
    if (Buffer.byteLength(request) > MAX_BACKEND_FRAME_BYTES) {
      throw new BackendRpcError(
        "invalid_request",
        `Jaeger remote request exceeds ${MAX_BACKEND_FRAME_BYTES} bytes`,
      );
    }
    const retriable =
      method === "run.submit" ||
      method === "session.resume" ||
      method === "schedule.apply" ||
      method === "schedule.trigger";
    let deadline: number | undefined;
    let failure: unknown;
    while (true) {
      try {
        const raw = await exchangeSsh(
          this.sshCommand,
          this.target,
          request,
          signal,
          requestTimeout(method, params),
        );
        const response = parseRemoteTransportResponse(JSON.parse(raw), id);
        if (
          !this.discoverInstance &&
          response.instanceId !== undefined &&
          response.instanceId !== this.target.instanceId
        ) {
          throw new BackendRpcError(
            "runtime_identity_mismatch",
            `Remote Jaeger instance ${response.instanceId ?? "unknown"} does not match configured instance ${this.target.instanceId}`,
          );
        }
        if (!response.ok) {
          throw new BackendRpcError(
            response.error?.code ?? "operation_failed",
            response.error?.message ?? "Remote Jaeger operation failed",
          );
        }
        if (
          !this.discoverInstance &&
          response.instanceId !== this.target.instanceId
        ) {
          throw new BackendRpcError(
            "runtime_identity_mismatch",
            `Remote Jaeger instance ${response.instanceId ?? "unknown"} does not match configured instance ${this.target.instanceId}`,
          );
        }
        return qualifyRemoteResult(
          method,
          response.result as JsonValue,
          this.target,
        );
      } catch (error) {
        if (error instanceof BackendRpcError || signal?.aborted) throw error;
        failure = error;
        if (!retriable) break;
        deadline ??= Date.now() + this.retryWindowMs;
        if (Date.now() >= deadline) break;
        await abortableDelay(100, signal);
      }
    }
    throw new BackendRpcError(
      "backend_unavailable",
      `Jaeger runtime ${this.target.name} is unavailable through SSH destination ${this.target.destination}: ${errorMessage(failure)}.${recoveryHint(method, params, this.target.name)}`,
    );
  }
}

async function exchangeSsh(
  command: string,
  target: SshRuntimeTarget,
  request: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<string> {
  if (signal?.aborted) throw abortReason(signal);
  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "NumberOfPasswordPrompts=0",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "RemoteCommand=none",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    `ConnectTimeout=${target.connectTimeoutSeconds}`,
    "--",
    target.destination,
    target.command,
    "__rpc-stdio",
  ];
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            finish(() =>
              reject(new Error(`SSH Jaeger request timed out after ${timeoutMs}ms`)),
            );
          }, timeoutMs)
        : undefined;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (!child.killed) child.kill("SIGTERM");
      operation();
    };
    const onAbort = (): void => finish(() => reject(abortReason(signal as AbortSignal)));
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => finish(() => reject(error)));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_BACKEND_FRAME_BYTES) {
        finish(() => reject(new Error("Remote Jaeger response exceeds size limit")));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > MAX_STDERR_BYTES) {
        finish(() => reject(new Error("SSH diagnostics exceed size limit")));
      }
    });
    child.once("close", (code, closeSignal) => {
      if (settled) return;
      if (code !== 0) {
        const detail = stderr.trim();
        finish(() =>
          reject(
            new Error(
              `SSH exited ${code === null ? `on ${String(closeSignal)}` : `with status ${code}`}${detail ? `: ${detail}` : ""}`,
            ),
          ),
        );
        return;
      }
      const lines = stdout.split("\n").filter((line) => line.length > 0);
      if (lines.length !== 1) {
        finish(() =>
          reject(
            new Error(
              "Remote Jaeger produced unexpected stdout; noninteractive shell startup files must not print output",
            ),
          ),
        );
        return;
      }
      finish(() => resolve(lines[0] as string));
    });
    child.stdin.once("error", (error) => finish(() => reject(error)));
    child.stdin.end(request);
  });
}

function requestTimeout(method: BackendMethod, params: JsonValue): number {
  if (method === "run.wait" || method === "session.turn.wait") return 0;
  if (
    method === "session.resume" &&
    (!params ||
      typeof params !== "object" ||
      Array.isArray(params) ||
      params.detach !== true)
  ) {
    return 0;
  }
  return 30_000;
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortReason(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function recoveryHint(
  method: BackendMethod,
  params: JsonValue,
  runtime: string,
): string {
  if (!params || typeof params !== "object" || Array.isArray(params)) return "";
  if (method === "run.submit" && typeof params.submissionId === "string") {
    return ` Submission id ${params.submissionId} is reusable; retry the same run command with --submission-id ${params.submissionId}, or inspect it with 'jaeger --runtime ${runtime} submission ${params.submissionId}'.`;
  }
  if (
    method === "session.resume" &&
    typeof params.runId === "string" &&
    typeof params.turnId === "string"
  ) {
    return ` Session turn ${params.turnId} may already be accepted; retry with --request-id ${params.turnId}, or inspect it with 'jaeger --runtime ${runtime} session turn inspect ${params.runId} ${params.turnId}'.`;
  }
  if (
    method === "schedule.trigger" &&
    typeof params.name === "string" &&
    typeof params.requestId === "string"
  ) {
    return ` Schedule trigger ${params.requestId} may already be accepted; retry 'jaeger --runtime ${runtime} schedule trigger ${params.name} --request-id ${params.requestId}'.`;
  }
  return "";
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("SSH request aborted");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
