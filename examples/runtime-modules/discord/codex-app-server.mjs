import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import readline from "node:readline";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 2_000;
const DEFAULT_FORCE_STOP_TIMEOUT_MS = 2_000;
const OPERATOR_PERMISSION_PROFILE = "jaeger_discord_operator";
const DISABLED_FEATURES = [
  "apps",
  "artifact",
  "auth_elicitation",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "code_mode_host",
  "computer_use",
  "enable_mcp_apps",
  "external_agent_memory_import",
  "goals",
  "hooks",
  "image_generation",
  "in_app_browser",
  "memories",
  "multi_agent",
  "multi_agent_v2",
  "plugin_sharing",
  "plugins",
  "remote_plugin",
  "shell_snapshot",
  "shell_tool",
  "skill_mcp_dependency_install",
  "skill_search",
  "tool_call_mcp_elicitation",
  "tool_suggest",
  "workspace_dependencies",
];
const APP_SERVER_ARGS = [
  "app-server",
  "--enable",
  "realtime_conversation",
  ...DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
  "-c",
  'web_search="disabled"',
  "-c",
  "mcp_servers={}",
  "-c",
  `default_permissions="${OPERATOR_PERMISSION_PROFILE}"`,
  "-c",
  `permissions.${OPERATOR_PERMISSION_PROFILE}={description="Discord voice operator with no local filesystem or network authority.",filesystem={":root"="deny"},network={enabled=false}}`,
];

export const OPERATOR_INSTRUCTIONS = `You are the read-only Jaeger Discord voice operator.

Your only operational purpose is to inspect Jaeger and report concise spoken
answers. Use the jaeger_status tool for current Jaeger status. It is a narrow,
read-only bridge to the installed Jaeger CLI. Do not use shell commands.

Never start, resume, steer, interrupt, stop, or otherwise mutate a Jaeger run or
session. Never edit files. Never install software. Never retry an uncertain
operation. If a request would mutate state, explain that this operator is
read-only. Preserve opaque IDs exactly. Keep spoken answers under 70 words unless
the operator asks for detail.`;

export class CodexAppServer extends EventEmitter {
  constructor({
    codexBin = "codex",
    cwd,
    childEnv = {},
    dynamicTools = [],
    requestHandlers = {},
    stateFile,
    spawnProcess = spawn,
    requestTimeoutMs = DEFAULT_TIMEOUT_MS,
    stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
    forceStopTimeoutMs = DEFAULT_FORCE_STOP_TIMEOUT_MS,
  }) {
    super();
    this.codexBin = codexBin;
    this.cwd = cwd;
    this.childEnv = childEnv;
    this.dynamicTools = dynamicTools;
    this.requestHandlers = requestHandlers;
    this.stateFile = stateFile;
    this.spawnProcess = spawnProcess;
    this.requestTimeoutMs = requestTimeoutMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.forceStopTimeoutMs = forceStopTimeoutMs;
    this.child = null;
    this.threadId = null;
    this.generation = 0;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.ready = false;
    this.stopping = false;
    this.realtimeStarting = false;
    this.reconnecting = null;
    this.stdoutReaders = new WeakMap();
  }

  get connected() {
    return this.ready && this.#childRunning();
  }

  async start() {
    if (this.#childRunning()) return;
    this.ready = false;
    this.stopping = false;
    const child = this.spawnProcess(
      this.codexBin,
      APP_SERVER_ARGS,
      {
        cwd: this.cwd,
        env: { ...process.env, ...this.childEnv },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    this.generation += 1;

    const stdout = readline.createInterface({ input: child.stdout });
    this.stdoutReaders.set(child, stdout);
    stdout.on("line", (line) => this.#handleLine(child, line));
    child.stderr.on("data", (chunk) => {
      this.emit("diagnostic", String(chunk).trim());
    });
    child.stdin.on("error", (error) => {
      this.#handleExit(child, error);
      if (isChildRunning(child)) child.kill("SIGTERM");
    });
    child.once("error", (error) => this.#handleExit(child, error));
    child.once("exit", (code, signal) => {
      const reason = new Error(
        `Codex app-server exited (${signal ?? code ?? "unknown"})`,
      );
      this.#handleExit(child, reason);
    });

    try {
      await this.request("initialize", {
        clientInfo: {
          name: "jaeger_discord_voice",
          title: "Jaeger Discord Voice",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      });
      this.notify("initialized", {});
      await this.#createOrResumeThread();
      this.ready = true;
      this.emit("ready", this.snapshot());
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop() {
    this.ready = false;
    if (!this.child) return;
    this.stopping = true;
    const child = this.child;
    this.stdoutReaders.get(child)?.close();
    this.stdoutReaders.delete(child);
    this.#rejectPending(new Error("Codex app-server stopped"));
    child.stdin.end();
    if (!isChildRunning(child)) return;
    child.kill("SIGTERM");
    if (await waitForChildExit(child, this.stopTimeoutMs)) return;
    if (!isChildRunning(child)) return;
    child.kill("SIGKILL");
    if (await waitForChildExit(child, this.forceStopTimeoutMs)) return;
    throw new Error("Codex app-server did not exit after SIGKILL");
  }

  reconnect() {
    if (this.reconnecting) return this.reconnecting;
    const reconnecting = this.#reconnect();
    this.reconnecting = reconnecting;
    void reconnecting.then(
      () => {
        if (this.reconnecting === reconnecting) this.reconnecting = null;
      },
      () => {
        if (this.reconnecting === reconnecting) this.reconnecting = null;
      },
    );
    return reconnecting;
  }

  async #reconnect() {
    const expectedThreadId = this.threadId;
    if (!expectedThreadId) throw new Error("No operator thread exists");
    await this.stop();
    this.threadId = expectedThreadId;
    await this.start();
    if (this.threadId !== expectedThreadId) {
      throw new Error("App-server reconnect did not preserve the operator thread");
    }
    return this.snapshot();
  }

  async startRealtime({ sdp, voice } = {}) {
    this.#assertReady();
    if (typeof sdp !== "string" || !sdp.startsWith("v=0")) {
      throw new Error("A valid headless WebRTC SDP offer is required");
    }
    if (this.realtimeStarting) {
      throw new Error("Realtime startup is already in progress");
    }
    this.realtimeStarting = true;

    const answer = this.#realtimeSdpWaiter();
    try {
      const [, params] = await Promise.all([
        this.request("thread/realtime/start", {
          threadId: this.threadId,
          outputModality: "audio",
          transport: { type: "webrtc", sdp },
          version: "v3",
          ...(voice ? { voice } : {}),
          includeStartupContext: true,
          flushTranscriptTailOnSessionEnd: false,
        }),
        answer.promise,
      ]);
      return {
        threadId: this.threadId,
        sdp: params.sdp,
      };
    } catch (error) {
      try {
        // Replacing the app-server generation guarantees that a partially
        // opened transport cannot leak into the next Discord media session.
        await this.reconnect();
      } catch (recoveryError) {
        throw new AggregateError(
          [error, recoveryError],
          "Realtime negotiation failed and app-server recovery was unsuccessful",
        );
      }
      throw error;
    } finally {
      answer.cancel();
      this.realtimeStarting = false;
    }
  }

  async stopRealtime() {
    if (!this.connected || !this.threadId) return;
    await this.request("thread/realtime/stop", {
      threadId: this.threadId,
    });
  }

  snapshot() {
    return {
      connected: this.connected,
      generation: this.generation,
      threadId: this.threadId,
    };
  }

  request(method, params = {}) {
    if (!this.#childRunning()) {
      return Promise.reject(new Error("Codex app-server is not connected"));
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.#write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.#write({ method, params });
  }

  waitForNotification(method, predicate = () => true, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const handler = (params) => {
        if (!predicate(params)) return;
        clearTimeout(timer);
        this.off(method, handler);
        resolve(params);
      };
      const timer = setTimeout(() => {
        this.off(method, handler);
        reject(new Error(`${method} notification timed out`));
      }, timeoutMs);
      this.on(method, handler);
    });
  }

  async #createOrResumeThread() {
    const stored = await readThreadState(this.stateFile);
    if (stored) {
      const result = await this.request("thread/resume", {
        threadId: stored.threadId,
        cwd: this.cwd,
        runtimeWorkspaceRoots: [],
        approvalPolicy: "never",
        permissions: OPERATOR_PERMISSION_PROFILE,
        developerInstructions: OPERATOR_INSTRUCTIONS,
      });
      this.threadId = result.thread?.id;
      if (this.threadId !== stored.threadId) {
        throw new Error("Codex resumed an unexpected operator thread");
      }
      await this.#bootstrapThread("Re-establish the restricted voice-operator policy. Reply with READY only.");
      return;
    }

    const result = await this.request("thread/start", {
      cwd: this.cwd,
      runtimeWorkspaceRoots: [],
      approvalPolicy: "never",
      permissions: OPERATOR_PERMISSION_PROFILE,
      developerInstructions: OPERATOR_INSTRUCTIONS,
      dynamicTools: this.dynamicTools,
      environments: [],
      selectedCapabilityRoots: [],
      ephemeral: false,
      serviceName: "jaeger-discord-voice",
    });
    this.threadId = result.thread?.id;
    if (!this.threadId) throw new Error("Codex did not return an operator thread ID");
    await this.#bootstrapThread(
      "Initialize this persistent voice-operator thread. Do not inspect Jaeger yet. Reply with READY only.",
    );
    await writeThreadState(this.stateFile, this.threadId);
  }

  async #bootstrapThread(text) {
    const completed = this.#notificationWaiter(
      "turn/completed",
      (params) => params.threadId === this.threadId,
      120_000,
    );
    try {
      await this.request("turn/start", {
        threadId: this.threadId,
        input: [
          {
            type: "text",
            text,
          },
        ],
        approvalPolicy: "never",
        permissions: OPERATOR_PERMISSION_PROFILE,
        runtimeWorkspaceRoots: [],
        environments: [],
      });
      const result = await completed.promise;
      if (result.turn?.status !== "completed") {
        throw new Error(
          `Operator bootstrap turn ended with ${result.turn?.status ?? "unknown status"}`,
        );
      }
    } finally {
      completed.cancel();
    }
  }

  #notificationWaiter(method, predicate, timeoutMs) {
    let settled = false;
    let resolvePromise;
    let rejectPromise;
    let timer;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const cleanup = () => {
      clearTimeout(timer);
      this.off(method, handler);
    };
    const cancel = () => {
      if (settled) return;
      settled = true;
      cleanup();
    };
    const handler = (params) => {
      if (settled || !predicate(params)) return;
      settled = true;
      cleanup();
      resolvePromise(params);
    };
    this.on(method, handler);
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(new Error(`${method} notification timed out`));
    }, timeoutMs);
    return { promise, cancel };
  }

  #realtimeSdpWaiter() {
    let settled = false;
    let resolvePromise;
    let rejectPromise;
    let timer;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const matches = (params) => params.threadId === this.threadId;
    const cleanup = () => {
      clearTimeout(timer);
      this.off("thread/realtime/sdp", onSdp);
      this.off("thread/realtime/error", onError);
      this.off("thread/realtime/closed", onClosed);
      this.off("disconnected", onDisconnected);
    };
    const cancel = () => {
      if (settled) return;
      settled = true;
      cleanup();
    };
    const onSdp = (params) => {
      if (settled || !matches(params)) return;
      settled = true;
      cleanup();
      resolvePromise(params);
    };
    const onError = (params) => {
      if (settled || !matches(params)) return;
      settled = true;
      cleanup();
      rejectPromise(new Error(params.message));
    };
    const onClosed = (params) => {
      if (settled || !matches(params)) return;
      settled = true;
      cleanup();
      rejectPromise(
        new Error(params.reason ?? "Realtime transport closed during setup"),
      );
    };
    const onDisconnected = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(
        error instanceof Error
          ? error
          : new Error("Codex app-server disconnected during setup"),
      );
    };
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(new Error("thread/realtime/sdp notification timed out"));
    }, 45_000);
    this.on("thread/realtime/sdp", onSdp);
    this.on("thread/realtime/error", onError);
    this.on("thread/realtime/closed", onClosed);
    this.on("disconnected", onDisconnected);
    return { promise, cancel };
  }

  #childRunning() {
    return Boolean(this.child && isChildRunning(this.child));
  }

  #assertReady() {
    if (!this.connected || !this.threadId) {
      throw new Error("Codex app-server is not ready");
    }
  }

  #write(message) {
    if (!this.child?.stdin.writable) {
      throw new Error("Codex app-server input is unavailable");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(child, line) {
    if (child !== this.child) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("diagnostic", "Ignored malformed app-server output");
      return;
    }

    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(
            `${pending.method} failed: ${message.error.message ?? "unknown error"}`,
          ),
        );
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      void this.#handleServerRequest(child, message);
      return;
    }

    if (typeof message.method === "string") {
      this.emit(message.method, message.params ?? {});
      this.emit("notification", message);
    }
  }

  async #handleServerRequest(child, message) {
    if (child !== this.child) return;
    const handler = this.requestHandlers[message.method];
    if (!handler) {
      // This operator has no mutation authority. Fail closed on unknown requests.
      this.#writeToChild(child, {
        id: message.id,
        result: { decision: "decline" },
      });
      this.emit("serverRequestDeclined", { method: message.method });
      return;
    }
    try {
      const result = await handler(message.params ?? {});
      if (child !== this.child) return;
      this.#writeToChild(child, { id: message.id, result });
    } catch (error) {
      if (child !== this.child) return;
      this.#writeToChild(child, {
        id: message.id,
        error: {
          code: -32_000,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  #writeToChild(child, message) {
    if (child !== this.child || !child.stdin.writable) {
      throw new Error("Codex app-server input is unavailable");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleExit(child, error) {
    if (child !== this.child) return;
    this.ready = false;
    this.child = null;
    this.#rejectPending(error);
    if (!this.stopping) this.emit("disconnected", error);
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function isChildRunning(child) {
  return child.exitCode === null && child.signalCode == null;
}

async function waitForChildExit(child, timeoutMs) {
  if (!isChildRunning(child)) return true;
  return await new Promise((resolve) => {
    let settled = false;
    let timer;
    const onExit = () => finish(true);
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    child.once("exit", onExit);
    timer = setTimeout(() => finish(false), timeoutMs);
    if (!isChildRunning(child)) finish(true);
  });
}

export async function readThreadState(stateFile) {
  try {
    await assertOwnerOnlyFile(stateFile, "Discord operator state");
    const value = JSON.parse(await readFile(stateFile, "utf8"));
    if (typeof value.threadId !== "string" || value.threadId.length === 0) {
      throw new Error("Operator state does not contain a thread ID");
    }
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeThreadState(stateFile, threadId) {
  const directory = dirname(stateFile);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertOwnerOnlyDirectory(directory, "Discord operator state directory");
  const temporary = `${stateFile}.${process.pid}.tmp`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ threadId }, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await rename(temporary, stateFile);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("Discord operator state temporary file already exists");
    }
    throw error;
  }
}

async function assertOwnerOnlyFile(path, description) {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error(`${description} must be a regular owner-only file`);
  }
}

async function assertOwnerOnlyDirectory(path, description) {
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error(`${description} must be an owner-only directory`);
  }
}
