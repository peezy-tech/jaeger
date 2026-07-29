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
  assert.equal(processes[1].requests.at(-1).method, "thread/resume");
  assert.equal(
    processes[1].requests.at(-1).params.threadId,
    originalThreadId,
  );
  await bridge.stop();
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

test("a rejected realtime start cancels its SDP waiter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-spike-webrtc-reject-"));
  const child = createMockProcess();
  child.rejectRealtimeStart = true;
  const bridge = new CodexAppServer({
    cwd: "/tmp",
    stateFile: join(directory, "operator.json"),
    spawnProcess: () => child,
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
  await bridge.stop();
});

function createMockProcess() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.requests = [];
  child.rejectRealtimeStart = false;
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
          !child.rejectRealtimeStart
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
    }
  });
  child.kill = () => {
    child.exitCode = 0;
    queueMicrotask(() => child.emit("exit", 0, null));
    return true;
  };
  return child;
}
