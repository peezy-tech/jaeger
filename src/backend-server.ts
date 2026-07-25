import { chmod, lstat, unlink } from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import path from "node:path";
import {
  BACKEND_PROTOCOL_VERSION,
  MAX_BACKEND_FRAME_BYTES,
  errorResponse,
  BackendRpcError,
  parseBackendRequest,
  successResponse,
} from "./backend-protocol.js";
import { LocalRuntimeService } from "./local-runtime-service.js";
import { ensurePrivateDirectory } from "./paths.js";

export interface BackendServerOptions {
  readonly socketPath: string;
  readonly compatibilitySocketPaths?: readonly string[];
  readonly service: LocalRuntimeService;
}

export async function serveBackend(options: BackendServerOptions): Promise<void> {
  const primarySocketPath = path.resolve(options.socketPath);
  // Bind compatibility endpoints first and the advertised primary last. The
  // installer probes only the primary, so readiness cannot race a later alias
  // bind failure.
  const socketPaths = [...new Set([
    ...(options.compatibilitySocketPaths ?? [])
      .map((candidate) => path.resolve(candidate))
      .filter((candidate) => candidate !== primarySocketPath),
    primarySocketPath,
  ])];
  await ensurePrivateDirectory(options.service.stateDir, "Jaeger backend state directory");
  for (const socketPath of socketPaths) await prepareSocketPath(socketPath);
  const sockets = new Set<Socket>();
  const inFlight = new Set<Promise<void>>();
  const servers = socketPaths.map(() => backendServer(options.service, sockets, inFlight));

  await options.service.initializeModules();
  const recovery = options.service.admissionReady()
    ? await options.service.recover()
    : { considered: 0, eligible: 0, relaunched: [], errors: [] };
  if (recovery.relaunched.length > 0 || recovery.errors.length > 0) {
    process.stderr.write(`jaeger backend recovery: ${JSON.stringify(recovery)}\n`);
  }
  const listening: Array<{ server: Server; socketPath: string }> = [];
  try {
    for (let index = 0; index < servers.length; index++) {
      const server = servers[index] as Server;
      const socketPath = socketPaths[index] as string;
      await listen(server, socketPath);
      await chmod(socketPath, 0o600);
      listening.push({ server, socketPath });
    }
  } catch (error) {
    await Promise.allSettled(listening.map(async ({ server }) => await closeServer(server)));
    await Promise.allSettled(listening.map(async ({ socketPath }) => await unlink(socketPath)));
    throw error;
  }
  process.stdout.write(
    `${JSON.stringify({
      ready: true,
      protocol: BACKEND_PROTOCOL_VERSION,
      socketPath: primarySocketPath,
      socketPaths,
      stateDir: options.service.stateDir,
      pid: process.pid,
      recovery,
    })}\n`,
  );
  options.service.startRuntimeServices();

  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      let remaining = servers.length;
      const closed = (): void => {
        remaining--;
        if (remaining === 0) resolve();
      };
      for (const server of servers) server.close(closed);
      for (const socket of sockets) socket.destroy();
      setTimeout(resolve, 1_000).unref();
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
  await options.service.stopRuntimeServices();
  await Promise.allSettled([...inFlight]);
  await Promise.all(
    socketPaths.map(async (socketPath) => {
      await unlink(socketPath).catch((error: unknown) => {
        if (!hasCode(error, "ENOENT")) throw error;
      });
    }),
  );
}

function backendServer(
  service: LocalRuntimeService,
  sockets: Set<Socket>,
  inFlight: Set<Promise<void>>,
): Server {
  const server = net.createServer({ allowHalfOpen: false });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    handleConnection(socket, service, inFlight);
  });
  server.on("error", (error) => {
    process.stderr.write(`jaeger backend server error: ${errorMessage(error)}\n`);
  });
  return server;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function handleConnection(
  socket: Socket,
  service: LocalRuntimeService,
  inFlight: Set<Promise<void>>,
): void {
  socket.setEncoding("utf8");
  const controller = new AbortController();
  let buffer = "";
  let handled = false;
  socket.on("close", () => controller.abort(new Error("Backend client disconnected")));
  socket.on("error", () => controller.abort(new Error("Backend client connection failed")));
  socket.on("data", (chunk: string) => {
    if (handled) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_BACKEND_FRAME_BYTES) {
      handled = true;
      socket.end(
        `${JSON.stringify(errorResponse("invalid", new Error("Backend request exceeds size limit")))}\n`,
      );
      return;
    }
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    handled = true;
    const frame = buffer.slice(0, newline);
    const operation = respond(socket, frame, service, controller.signal).finally(() => {
      inFlight.delete(operation);
    });
    inFlight.add(operation);
    void operation;
  });
}

async function respond(
  socket: Socket,
  frame: string,
  service: LocalRuntimeService,
  signal: AbortSignal,
): Promise<void> {
  let id = "invalid";
  try {
    const raw = JSON.parse(frame) as unknown;
    if (
      raw &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      "id" in raw &&
      typeof (raw as { id?: unknown }).id === "string"
    ) {
      id = (raw as { id: string }).id;
    }
    const request = parseBackendRequest(raw);
    id = request.id;
    if (
      service.installGeneration !== undefined &&
      request.method !== "ping" &&
      request.generation !== service.installGeneration
    ) {
      throw new BackendRpcError(
        "backend_generation_required",
        `Jaeger backend requires generation ${service.installGeneration}; use the committed local profile or run 'jaeger backend install' to reconcile it`,
      );
    }
    if (request.generation !== undefined && request.generation !== service.installGeneration) {
      throw new BackendRpcError(
        "backend_generation_mismatch",
        `Jaeger backend generation ${service.installGeneration ?? "unmanaged"} does not match installed profile ${request.generation}; run 'jaeger backend install' to reconcile the local service`,
      );
    }
    if (
      service.installInstanceId !== undefined &&
      request.method !== "ping" &&
      request.instanceId !== service.installInstanceId
    ) {
      throw new BackendRpcError(
        "backend_instance_required",
        `Jaeger backend requires instance ${service.installInstanceId}; use the committed local profile`,
      );
    }
    if (
      request.instanceId !== undefined &&
      request.instanceId !== service.installInstanceId
    ) {
      throw new BackendRpcError(
        "backend_instance_mismatch",
        `Jaeger backend instance ${service.installInstanceId ?? "unmanaged"} does not match configured instance ${request.instanceId}`,
      );
    }
    const result = await service.dispatch(request.method, request.params, signal);
    if (!socket.destroyed) {
      const response = `${JSON.stringify(successResponse(id, result))}\n`;
      if (Buffer.byteLength(response) > MAX_BACKEND_FRAME_BYTES) {
        throw new Error(
          `Backend response exceeds ${MAX_BACKEND_FRAME_BYTES} bytes; request a narrower inspection`,
        );
      }
      socket.end(response);
    }
  } catch (error) {
    if (!socket.destroyed) socket.end(`${JSON.stringify(errorResponse(id, error))}\n`);
  }
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  const directory = path.dirname(socketPath);
  await ensurePrivateDirectory(directory, "Jaeger backend socket directory");
  let stat;
  try {
    stat = await lstat(socketPath);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  if (!stat.isSocket()) {
    throw new Error(`Refusing to replace non-socket backend path: ${socketPath}`);
  }
  if (await socketAcceptsConnections(socketPath)) {
    throw new Error(`A Jaeger backend is already listening at ${socketPath}`);
  }
  await unlink(socketPath);
}

async function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 250);
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      socket.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
      else reject(error);
    });
  });
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
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
