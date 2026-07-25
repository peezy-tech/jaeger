import { BackendRpcError, MAX_BACKEND_FRAME_BYTES } from "./backend-protocol.js";
import { readBackendInstallConfig } from "./paths.js";
import {
  parseRemoteTransportRequest,
  remoteFailure,
  remoteSuccess,
} from "./remote-protocol.js";
import { ServiceRuntimeClient } from "./runtime-client.js";

export async function runStdioBridge(): Promise<void> {
  let id = "invalid";
  let instanceId: string | undefined;
  const controller = new AbortController();
  const abort = (): void => controller.abort(new Error("SSH transport disconnected"));
  process.once("SIGHUP", abort);
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  try {
    const raw = JSON.parse(await readFrame()) as unknown;
    if (
      raw &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      "id" in raw &&
      typeof (raw as { readonly id?: unknown }).id === "string"
    ) {
      id = (raw as { readonly id: string }).id;
    }
    const request = parseRemoteTransportRequest(raw);
    id = request.id;
    const profile = readBackendInstallConfig();
    if (!profile) {
      throw new Error(
        "The remote Jaeger backend is not installed; run 'jaeger backend install' on the remote host",
      );
    }
    if (!profile.instanceId) {
      throw new Error(
        "The remote Jaeger backend predates remote identity support; run 'jaeger backend install' on the remote host",
      );
    }
    instanceId = profile.instanceId;
    if (
      request.expectedInstanceId !== undefined &&
      request.expectedInstanceId !== instanceId
    ) {
      throw new BackendRpcError(
        "runtime_identity_mismatch",
        `Remote Jaeger instance ${instanceId} does not match configured instance ${request.expectedInstanceId}`,
      );
    }
    const client = new ServiceRuntimeClient(profile.socketPath, {
      ...(profile.generation ? { expectedGeneration: profile.generation } : {}),
      expectedInstanceId: profile.instanceId,
    });
    const result = await client.call(request.method, request.params, controller.signal);
    await writeFrame(remoteSuccess(id, result, instanceId));
  } catch (error) {
    await writeFrame(remoteFailure(id, error, instanceId));
  } finally {
    process.removeListener("SIGHUP", abort);
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
  }
}

async function readFrame(): Promise<string> {
  process.stdin.setEncoding("utf8");
  return await new Promise<string>((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("error", onError);
      operation();
    };
    const onData = (chunk: string): void => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_BACKEND_FRAME_BYTES) {
        finish(() => reject(new Error("Remote transport request exceeds size limit")));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline >= 0) finish(() => resolve(buffer.slice(0, newline)));
    };
    const onEnd = (): void => {
      if (!settled) finish(() => reject(new Error("Remote transport closed without a request")));
    };
    const onError = (error: Error): void => finish(() => reject(error));
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onError);
    process.stdin.resume();
  });
}

async function writeFrame(value: unknown): Promise<void> {
  const frame = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(frame) > MAX_BACKEND_FRAME_BYTES) {
    throw new Error("Remote transport response exceeds size limit");
  }
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(frame, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
