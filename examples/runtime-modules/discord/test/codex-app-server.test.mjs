import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  CodexAppServer,
  readThreadState,
  writeThreadState,
} from "../codex-app-server.mjs";

test("operator state persists only the thread ID with owner-only mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "discord-operator-state-"));
  const stateFile = join(directory, "nested", "operator.json");
  await writeThreadState(stateFile, "thread-123");

  assert.deepEqual(await readThreadState(stateFile), { threadId: "thread-123" });
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  assert.deepEqual(
    Object.keys(JSON.parse(await readFile(stateFile, "utf8"))),
    ["threadId"],
  );
});

test("operator state rejects permissive files and directories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "discord-operator-permissions-"));
  const stateFile = join(directory, "operator.json");
  await writeFile(stateFile, '{"threadId":"thread-123"}\n', { mode: 0o600 });
  await chmod(stateFile, 0o644);
  await assert.rejects(readThreadState(stateFile), /owner-only file/);

  await chmod(stateFile, 0o600);
  assert.deepEqual(await readThreadState(stateFile), { threadId: "thread-123" });
  await chmod(directory, 0o755);
  await assert.rejects(
    writeThreadState(join(directory, "next.json"), "thread-456"),
    /owner-only directory/,
  );
});

test("app-server disables ambient authority and uses a deny-all permission profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "discord-operator-tools-"));
  let spawnedArgs;
  const child = createMockProcess();
  const bridge = new CodexAppServer({
    cwd: "/tmp",
    stateFile: join(directory, "operator.json"),
    spawnProcess: (_bin, args) => {
      spawnedArgs = args;
      return child;
    },
    requestTimeoutMs: 1_000,
  });

  await bridge.start();

  for (const feature of [
    "apps",
    "browser_use",
    "computer_use",
    "image_generation",
    "memories",
    "multi_agent",
    "hooks",
    "plugins",
    "shell_tool",
    "skill_search",
    "tool_suggest",
    "workspace_dependencies",
  ]) {
    assert.notEqual(
      spawnedArgs.findIndex(
        (argument, index) =>
          argument === feature && spawnedArgs[index - 1] === "--disable",
      ),
      -1,
      feature,
    );
  }
  assert.equal(spawnedArgs.includes('web_search="disabled"'), true);
  assert.equal(spawnedArgs.includes("mcp_servers={}"), true);
  assert.equal(
    spawnedArgs.includes(
      'permissions.jaeger_discord_operator={description="Discord voice operator with no local filesystem or network authority.",filesystem={":root"="deny"},network={enabled=false}}',
    ),
    true,
  );
  const policyTurn = child.requests.find(({ method }) => method === "turn/start");
  assert.equal(policyTurn.params.permissions, "jaeger_discord_operator");
  assert.deepEqual(policyTurn.params.runtimeWorkspaceRoots, []);
  assert.deepEqual(policyTurn.params.environments, []);
  assert.equal("sandboxPolicy" in policyTurn.params, false);
  await bridge.stop();
});

test("headless WebRTC negotiates SDP and emits no local transcript writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "discord-operator-audio-"));
  const child = createMockProcess();
  const bridge = new CodexAppServer({
    cwd: "/tmp",
    stateFile: join(directory, "operator.json"),
    spawnProcess: () => child,
    requestTimeoutMs: 1_000,
  });

  await bridge.start();
  const started = await bridge.startRealtime({ sdp: "v=0\r\noffer\r\n" });

  const start = child.requests.find(
    ({ method }) => method === "thread/realtime/start",
  );
  assert.deepEqual(start.params.transport, {
    type: "webrtc",
    sdp: "v=0\r\noffer\r\n",
  });
  assert.equal(start.params.version, "v3");
  assert.equal(start.params.outputModality, "audio");
  assert.equal("voice" in start.params, false);
  assert.equal(start.params.flushTranscriptTailOnSessionEnd, false);
  assert.equal(started.sdp, "v=0\r\nanswer\r\n");
  assert.deepEqual(
    Object.keys(JSON.parse(await readFile(join(directory, "operator.json"), "utf8"))),
    ["threadId"],
  );
  await bridge.stop();
});

test("concurrent realtime starts fail before sharing startup state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "discord-realtime-concurrent-"));
  const child = createMockProcess({ deferRealtimeSdp: true });
  const bridge = new CodexAppServer({
    cwd: "/tmp",
    stateFile: join(directory, "operator.json"),
    spawnProcess: () => child,
    requestTimeoutMs: 1_000,
  });

  await bridge.start();
  const first = bridge.startRealtime({ sdp: "v=0\r\noffer\r\n" });
  await assert.rejects(
    bridge.startRealtime({ sdp: "v=0\r\noffer\r\n" }),
    /already in progress/,
  );
  child.emitRealtimeSdp(bridge.threadId);
  await first;
  assert.equal(
    child.requests.filter(
      ({ method }) => method === "thread/realtime/start",
    ).length,
    1,
  );
  await bridge.stop();
});

test("reconnect resumes the exact dedicated operator thread", async () => {
  const directory = await mkdtemp(join(tmpdir(), "discord-operator-reconnect-"));
  const children = [];
  const bridge = new CodexAppServer({
    cwd: "/tmp",
    stateFile: join(directory, "operator.json"),
    spawnProcess: () => {
      const child = createMockProcess();
      children.push(child);
      return child;
    },
    requestTimeoutMs: 1_000,
  });

  await bridge.start();
  const threadId = bridge.threadId;
  const result = await bridge.reconnect();

  assert.equal(result.threadId, threadId);
  assert.equal(result.generation, 2);
  assert.equal(
    children[1].requests.find(({ method }) => method === "thread/resume").params
      .threadId,
    threadId,
  );
  await bridge.stop();
});

test("unknown app-server requests are declined", async () => {
  const directory = await mkdtemp(join(tmpdir(), "discord-operator-decline-"));
  const child = createMockProcess();
  const bridge = new CodexAppServer({
    cwd: "/tmp",
    stateFile: join(directory, "operator.json"),
    spawnProcess: () => child,
    requestTimeoutMs: 1_000,
  });
  await bridge.start();

  child.stdout.write(
    `${JSON.stringify({ id: 999, method: "item/tool/call", params: {} })}\n`,
  );
  await new Promise((resolve) => setImmediate(resolve));

  const response = child.requests.find(({ id, method }) => id === 999 && !method);
  assert.deepEqual(response.result, { decision: "decline" });
  await bridge.stop();
});

function createMockProcess({ deferRealtimeSdp = false } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.requests = [];
  child.emitRealtimeSdp = (threadId) => {
    child.stdout.write(
      `${JSON.stringify({
        method: "thread/realtime/sdp",
        params: {
          threadId,
          sdp: "v=0\r\nanswer\r\n",
        },
      })}\n`,
    );
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
      queueMicrotask(() => {
        child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
        if (request.method === "turn/start") {
          child.stdout.write(
            `${JSON.stringify({
              method: "turn/completed",
              params: {
                threadId: request.params.threadId,
                turn: { id: "turn-bootstrap", status: "completed", items: [] },
              },
            })}\n`,
          );
        }
        if (
          request.method === "thread/realtime/start" &&
          !deferRealtimeSdp
        ) {
          child.emitRealtimeSdp(request.params.threadId);
        }
        if (request.method === "thread/realtime/stop") {
          child.stdout.write(
            `${JSON.stringify({
              method: "thread/realtime/closed",
              params: { threadId: request.params.threadId, reason: "stopped" },
            })}\n`,
          );
        }
      });
    }
  });
  child.kill = (signal) => {
    child.signalCode = signal;
    queueMicrotask(() => child.emit("exit", null, signal));
    return true;
  };
  return child;
}
