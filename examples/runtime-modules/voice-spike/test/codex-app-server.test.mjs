import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  CodexAppServer,
  readThreadState,
  writeThreadState,
} from "../codex-app-server.mjs";

test("operator state is persisted owner-only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-spike-state-"));
  const stateFile = join(directory, "nested", "operator.json");
  await writeThreadState(stateFile, "thread-123");

  assert.deepEqual(await readThreadState(stateFile), { threadId: "thread-123" });
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  assert.match(await readFile(stateFile, "utf8"), /thread-123/);
});

test("reconnect resumes the exact persisted operator thread", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-spike-reconnect-"));
  const stateFile = join(directory, "operator.json");
  const processes = [];
  const spawnProcess = () => {
    const child = createMockProcess();
    processes.push(child);
    return child;
  };
  const bridge = new CodexAppServer({
    cwd: "/tmp",
    stateFile,
    spawnProcess,
    requestTimeoutMs: 1_000,
  });

  await bridge.start();
  const originalThreadId = bridge.threadId;
  const result = await bridge.reconnect();

  assert.equal(processes.length, 2);
  assert.equal(result.threadId, originalThreadId);
  assert.equal(result.generation, 2);
  const resume = processes[1].requests.find(
    ({ method }) => method === "thread/resume",
  );
  assert.equal(resume.params.threadId, originalThreadId);
  const policyTurn = processes[1].requests.find(
    ({ method }) => method === "turn/start",
  );
  assert.deepEqual(policyTurn.params.sandboxPolicy, {
    type: "readOnly",
    access: {
      type: "restricted",
      includePlatformDefaults: true,
      readableRoots: [],
    },
  });
  await bridge.stop();
});

test("the app-server disables ambient tools before exposing the status tool", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-spike-tools-"));
  let spawnedArgs;
  const bridge = new CodexAppServer({
    cwd: "/tmp",
    stateFile: join(directory, "operator.json"),
    spawnProcess: (_bin, args) => {
      spawnedArgs = args;
      return createMockProcess();
    },
    requestTimeoutMs: 1_000,
  });

  await bridge.start();

  for (const feature of [
    "shell_tool",
    "apps",
    "plugins",
    "multi_agent",
    "goals",
    "hooks",
  ]) {
    const index = spawnedArgs.findIndex(
      (argument, position) =>
        argument === feature && spawnedArgs[position - 1] === "--disable",
    );
    assert.notEqual(index, -1, feature);
  }
  assert.equal(spawnedArgs.includes('web_search="disabled"'), true);
  assert.equal(spawnedArgs.includes("mcp_servers={}"), true);
  await bridge.stop();
});

test("reconnect escalates and waits for an uncooperative app-server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-spike-force-stop-"));
  const processes = [];
  const bridge = new CodexAppServer({
    cwd: "/tmp",
    stateFile: join(directory, "operator.json"),
    spawnProcess: () => {
      const child = createMockProcess({
        exitOnKill: false,
        exitOnForceKill: true,
      });
      processes.push(child);
      return child;
    },
    requestTimeoutMs: 1_000,
    stopTimeoutMs: 10,
    forceStopTimeoutMs: 10,
  });

  await bridge.start();
  await bridge.reconnect();

  assert.deepEqual(processes[0].signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(processes.length, 2);
  await bridge.stop();
});

test("a late exit from a stopped child does not disconnect its replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-spike-late-exit-"));
  const processes = [];
  const bridge = new CodexAppServer({
    cwd: "/tmp",
    stateFile: join(directory, "operator.json"),
    spawnProcess: () => {
      const child = createMockProcess({
        exitOnKill: processes.length !== 0,
      });
      processes.push(child);
      return child;
    },
    requestTimeoutMs: 1_000,
    stopTimeoutMs: 10,
    forceStopTimeoutMs: 10,
  });

  await bridge.start();
  const stopping = bridge.stop();
  await stopping;
  await bridge.start();
  const pending = bridge.request("test/ping");
  processes[0].exitCode = 0;
  processes[0].emit("exit", 0, null);

  await stopping;
  await pending;
  assert.equal(bridge.connected, true);
  assert.equal(bridge.generation, 2);
  await bridge.stop();
});

test("late output and server responses stay bound to their child generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-spike-late-output-"));
  const processes = [];
  let releaseHandler;
  let handlerStarted;
  const started = new Promise((resolve) => {
    handlerStarted = resolve;
  });
  const bridge = new CodexAppServer({
    cwd: "/tmp",
    stateFile: join(directory, "operator.json"),
    spawnProcess: () => {
      const child = createMockProcess({
        exitOnKill: processes.length !== 0,
      });
      processes.push(child);
      return child;
    },
    requestHandlers: {
      "test/slow": async () => {
        handlerStarted();
        await new Promise((resolve) => {
          releaseHandler = resolve;
        });
        return { accepted: true };
      },
    },
    requestTimeoutMs: 1_000,
    stopTimeoutMs: 10,
    forceStopTimeoutMs: 10,
  });
  let staleNotifications = 0;
  bridge.on("test/stale", () => {
    staleNotifications += 1;
  });

  await bridge.start();
  processes[0].stdout.write(
    `${JSON.stringify({ id: 700, method: "test/slow", params: {} })}\n`,
  );
  await started;

  const stopping = bridge.stop();
  await stopping;
  await bridge.start();
  processes[0].stdout.write(
    `${JSON.stringify({ method: "test/stale", params: {} })}\n`,
  );
  processes[0].stdout.write(
    `${JSON.stringify({ id: 701, method: "test/slow", params: {} })}\n`,
  );
  releaseHandler();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(staleNotifications, 0);
  assert.equal(
    processes[1].requests.some(
      ({ id, method }) => (id === 700 || id === 701) && method === undefined,
    ),
    false,
  );
  processes[0].exitCode = 0;
  processes[0].emit("exit", 0, null);
  assert.equal(bridge.connected, true);
  await bridge.stop();
});

test("a replacement stays unavailable until initialize and resume complete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-spike-reconnect-ready-"));
  const processes = [];
  const bridge = new CodexAppServer({
    cwd: "/tmp",
    stateFile: join(directory, "operator.json"),
    spawnProcess: () => {
      const child = createMockProcess({
        deferredMethods: processes.length === 0
          ? []
          : ["initialize", "thread/resume"],
      });
      processes.push(child);
      return child;
    },
    requestTimeoutMs: 1_000,
  });
  let readyEvents = 0;
  bridge.on("ready", () => {
    readyEvents += 1;
  });

  await bridge.start();
  const reconnecting = bridge.reconnect();
  const concurrentReconnect = bridge.reconnect();
  assert.equal(concurrentReconnect, reconnecting);
  await waitForProcess(processes, 1);
  await waitForRequest(processes[1], "initialize");
  assert.equal(bridge.connected, false);
  assert.equal(bridge.snapshot().connected, false);
  assert.equal(readyEvents, 1);

  processes[1].release("initialize");
  await waitForRequest(processes[1], "thread/resume");
  assert.equal(bridge.connected, false);
  assert.equal(readyEvents, 1);

  processes[1].release("thread/resume");
  await reconnecting;
  assert.equal(bridge.connected, true);
  assert.equal(readyEvents, 2);
  await bridge.stop();
});

test("stdin EPIPE disconnects the bridge and rejects pending requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-spike-epipe-"));
  const child = createMockProcess({ deferredMethods: ["test/pending"] });
  const bridge = new CodexAppServer({
    cwd: "/tmp",
    stateFile: join(directory, "operator.json"),
    spawnProcess: () => child,
    requestTimeoutMs: 1_000,
  });
  let disconnected = 0;
  bridge.on("disconnected", () => {
    disconnected += 1;
  });

  await bridge.start();
  const pending = bridge.request("test/pending");
  await waitForRequest(child, "test/pending");
  const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  assert.doesNotThrow(() => child.stdin.emit("error", error));

  await assert.rejects(pending, /write EPIPE/);
  assert.equal(bridge.connected, false);
  assert.equal(disconnected, 1);
});

test("WebRTC start forwards the SDP offer and returns the matching answer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-spike-webrtc-"));
  const child = createMockProcess();
  const bridge = new CodexAppServer({
    cwd: "/tmp",
    stateFile: join(directory, "operator.json"),
    spawnProcess: () => child,
    requestTimeoutMs: 1_000,
  });

  await bridge.start();
  const answer = await bridge.startRealtime({
    sdp: "v=0\r\nmock-offer",
    voice: "juniper",
  });

  const request = child.requests.find(
    ({ method }) => method === "thread/realtime/start",
  );
  assert.equal(request.params.transport.type, "webrtc");
  assert.equal(request.params.transport.sdp, "v=0\r\nmock-offer");
  assert.equal(request.params.version, "v3");
  assert.equal(request.params.outputModality, "audio");
  assert.equal(answer.sdp, "v=0\r\nmock-answer");
  await bridge.stop();
});

test("a concurrent WebRTC start is rejected before it can share an SDP waiter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-spike-webrtc-concurrent-"));
  const child = createMockProcess();
  child.deferRealtimeSdp = true;
  const bridge = new CodexAppServer({
    cwd: "/tmp",
    stateFile: join(directory, "operator.json"),
    spawnProcess: () => child,
    requestTimeoutMs: 1_000,
  });

  await bridge.start();
  const first = bridge.startRealtime({ sdp: "v=0\r\nfirst-offer" });
  await assert.rejects(
    bridge.startRealtime({ sdp: "v=0\r\nsecond-offer" }),
    /Realtime negotiation is already in progress/,
  );
  child.stdout.write(
    `${JSON.stringify({
      method: "thread/realtime/sdp",
      params: {
        threadId: bridge.threadId,
        sdp: "v=0\r\nfirst-answer",
      },
    })}\n`,
  );

  assert.equal((await first).sdp, "v=0\r\nfirst-answer");
  assert.equal(
    child.requests.filter(
      ({ method }) => method === "thread/realtime/start",
    ).length,
    1,
  );
  await bridge.stop();
});

test("an early realtime error is observed while the start RPC is still pending", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-spike-webrtc-early-error-"));
  const processes = [];
  const bridge = new CodexAppServer({
    cwd: "/tmp",
    stateFile: join(directory, "operator.json"),
    spawnProcess: () => {
      const child = createMockProcess({
        deferredMethods:
          processes.length === 0 ? ["thread/realtime/start"] : [],
      });
      processes.push(child);
      return child;
    },
    requestTimeoutMs: 5_000,
  });

  await bridge.start();
  const realtime = bridge.startRealtime({
    sdp: "v=0\r\nearly-error-offer",
  }).then(
    () => ({ status: "fulfilled" }),
    (error) => ({ status: "rejected", error }),
  );
  await waitForRequest(processes[0], "thread/realtime/start");
  processes[0].stdout.write(
    `${JSON.stringify({
      method: "thread/realtime/error",
      params: {
        threadId: bridge.threadId,
        message: "early realtime failure",
      },
    })}\n`,
  );

  let timer;
  const outcome = await Promise.race([
    realtime,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ status: "timed-out" }), 1_000);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
  assert.equal(outcome.status, "rejected");
  assert.match(outcome.error.message, /early realtime failure/);
  assert.equal(bridge.connected, true);
  assert.equal(bridge.generation, 2);
  await bridge.stop();
});

test("a rejected realtime start cancels its SDP waiter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-spike-webrtc-reject-"));
  const processes = [];
  const bridge = new CodexAppServer({
    cwd: "/tmp",
    stateFile: join(directory, "operator.json"),
    spawnProcess: () => {
      const child = createMockProcess();
      child.rejectRealtimeStart = processes.length === 0;
      processes.push(child);
      return child;
    },
    requestTimeoutMs: 1_000,
  });

  await bridge.start();
  await assert.rejects(
    bridge.startRealtime({ sdp: "v=0\r\nmock-offer" }),
    /thread\/realtime\/start failed: rejected for test/,
  );
  assert.equal(bridge.listenerCount("thread/realtime/sdp"), 0);
  assert.equal(bridge.listenerCount("thread/realtime/error"), 0);
  assert.equal(bridge.listenerCount("thread/realtime/closed"), 0);
  assert.equal(bridge.generation, 2);
  processes[0].stdout.write(
    `${JSON.stringify({
      method: "thread/realtime/sdp",
      params: {
        threadId: bridge.threadId,
        sdp: "v=0\r\nstale-answer",
      },
    })}\n`,
  );
  const retry = await bridge.startRealtime({
    sdp: "v=0\r\nretry-offer",
  });
  assert.equal(retry.sdp, "v=0\r\nmock-answer");
  await bridge.stop();
});

test("an app-server disconnect rejects a pending realtime SDP waiter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-spike-webrtc-disconnect-"));
  const processes = [];
  const bridge = new CodexAppServer({
    cwd: "/tmp",
    stateFile: join(directory, "operator.json"),
    spawnProcess: () => {
      const child = createMockProcess();
      child.deferRealtimeSdp = processes.length === 0;
      processes.push(child);
      return child;
    },
    requestTimeoutMs: 1_000,
  });

  await bridge.start();
  const realtime = bridge.startRealtime({ sdp: "v=0\r\nmock-offer" });
  await waitForRequest(processes[0], "thread/realtime/start");
  await new Promise((resolve) => setImmediate(resolve));
  processes[0].exitCode = 1;
  processes[0].emit("exit", 1, null);

  await assert.rejects(realtime, /Codex app-server exited \(1\)/);
  assert.equal(bridge.listenerCount("thread/realtime/sdp"), 0);
  assert.equal(bridge.listenerCount("thread/realtime/error"), 0);
  assert.equal(bridge.listenerCount("thread/realtime/closed"), 0);
  assert.equal(bridge.listenerCount("disconnected"), 0);
  assert.equal(bridge.connected, true);
  assert.equal(bridge.generation, 2);
  await bridge.stop();
});

async function waitForRequest(child, method) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.requests.some((request) => request.method === method)) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${method}`);
}

async function waitForProcess(processes, index) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (processes[index]) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for process ${index}`);
}

function createMockProcess({
  exitOnKill = true,
  exitOnForceKill = true,
  deferredMethods = [],
} = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.requests = [];
  child.signals = [];
  child.rejectRealtimeStart = false;
  child.deferRealtimeSdp = false;
  child.deferredMethods = new Set(deferredMethods);
  child.deferredResponses = new Map();
  child.release = (method) => {
    const responses = child.deferredResponses.get(method) ?? [];
    child.deferredResponses.delete(method);
    for (const respond of responses) respond();
  };
  child.stdin.on("data", (chunk) => {
    for (const line of String(chunk).trim().split("\n")) {
      if (!line) continue;
      const request = JSON.parse(line);
      child.requests.push(request);
      if (request.id === undefined) continue;

      let result = {};
      if (request.method === "initialize") {
        result = { userAgent: "mock" };
      } else if (request.method === "thread/start") {
        result = { thread: { id: "thread-persistent" } };
      } else if (request.method === "thread/resume") {
        result = { thread: { id: request.params.threadId } };
      } else if (request.method === "turn/start") {
        result = {
          turn: { id: "turn-bootstrap", status: "inProgress", items: [] },
        };
      }
      const respond = () => queueMicrotask(() => {
        child.stdout.write(
          `${JSON.stringify(
            request.method === "thread/realtime/start" && child.rejectRealtimeStart
              ? { id: request.id, error: { message: "rejected for test" } }
              : { id: request.id, result },
          )}\n`,
        );
        if (request.method === "turn/start") {
          child.stdout.write(
            `${JSON.stringify({
              method: "turn/completed",
              params: {
                threadId: request.params.threadId,
                turn: {
                  id: "turn-bootstrap",
                  status: "completed",
                  items: [],
                },
              },
            })}\n`,
          );
        }
        if (
          request.method === "thread/realtime/start" &&
          !child.rejectRealtimeStart &&
          !child.deferRealtimeSdp
        ) {
          child.stdout.write(
            `${JSON.stringify({
              method: "thread/realtime/sdp",
              params: {
                threadId: request.params.threadId,
                sdp: "v=0\r\nmock-answer",
              },
            })}\n`,
          );
        }
      });
      if (child.deferredMethods.has(request.method)) {
        const responses = child.deferredResponses.get(request.method) ?? [];
        responses.push(respond);
        child.deferredResponses.set(request.method, responses);
      } else {
        respond();
      }
    }
  });
  child.kill = (signal) => {
    child.signals.push(signal);
    if (signal === "SIGTERM" ? exitOnKill : exitOnForceKill) {
      child.exitCode = 0;
      queueMicrotask(() => child.emit("exit", 0, null));
    }
    return true;
  };
  return child;
}
