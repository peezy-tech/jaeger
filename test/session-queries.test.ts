import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { builtinHarnessDefinitions } from "../src/harnesses/registry.js";
import { HookManager } from "../src/hooks.js";
import {
  executeSessionQueryWorker,
  inspectSessionQuery,
  submitSessionQuery,
} from "../src/session-queries.js";
import {
  submitSessionTurn,
  waitForSessionTurn,
} from "../src/session-turns.js";
import { runWorkflow } from "../src/runtime.js";
import { listWorkflowSessions } from "../src/sessions.js";

test("a forked session query is durable and leaves its parent unchanged", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-session-query-"));
  const stateDir = path.join(root, "state");
  const workflowPath = path.join(root, "workflow.js");
  const fakeCodex = path.join(root, "fake-codex");
  try {
    await writeFile(
      workflowPath,
      `
export const meta = { name: "session query fixture" }
const answer = await agent("Do the work", { harness: "codex", label: "worker" })
return answer
`,
    );
    await writeFile(fakeCodex, `#!/usr/bin/env node\n${fakeCodexScript()}\n`);
    await chmod(fakeCodex, 0o755);
    const definitions = builtinHarnessDefinitions().map((definition) =>
      definition.name === "codex"
        ? { ...definition, command: fakeCodex }
        : { ...definition, command: process.execPath },
    );
    const run = await runWorkflow({
      workflowPath,
      cwd: root,
      stateDir,
      harnessDefinitions: definitions,
    });
    const before = (await listWorkflowSessions(run.runDir, stateDir))[0];
    assert.ok(before?.nativeSessionId);

    const queued = await submitSessionQuery({
      stateDir,
      entrypoint: process.argv[1] as string,
      env: process.env,
      backend: "embedded",
      runId: run.runId,
      selector: before.id,
      message: "What is happening?",
      model: "small-model",
      queryId: "query-0000000000000001",
      launch: false,
    });
    assert.equal(queued.status, "queued");

    await executeSessionQueryWorker({
      stateDir,
      runId: run.runId,
      queryId: queued.queryId,
      backend: "embedded",
    });
    const completed = await inspectSessionQuery({
      stateDir,
      runId: run.runId,
      queryId: queued.queryId,
      backend: "embedded",
    });
    assert.equal(completed.status, "completed");
    assert.equal(completed.output, "query answer");
    assert.equal(completed.nativeSessionId, "query-thread");
    assert.equal(completed.parentNativeSessionId, before.nativeSessionId);
    assert.equal(completed.model, "small-model");

    const after = (await listWorkflowSessions(run.runDir, stateDir))[0];
    assert.deepEqual(after, before);

    const events = new HookManager({ stateDir, collectEvents: true });
    await events.tick();
    const eventNames = await import("node:fs/promises").then(async ({ readdir, readFile }) =>
      await Promise.all(
        (await readdir(path.join(stateDir, ".hooks", "events"))).map(async (name) => {
          const event = JSON.parse(
            await readFile(path.join(stateDir, ".hooks", "events", name), "utf8"),
          ) as { type: string };
          return event.type;
        }),
      ),
    );
    assert.ok(eventNames.includes("session.available"));
    assert.ok(eventNames.includes("session.query.completed"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi queries reserve an idle parent until the fork is terminal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-pi-query-reservation-"));
  const stateDir = path.join(root, "state");
  const workflowPath = path.join(root, "workflow.js");
  const fakePi = path.join(root, "fake-pi");
  const entrypoint = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  try {
    await writeFile(
      workflowPath,
      `
export const meta = { name: "Pi query reservation" }
return await agent("Do the work", { harness: "pi", label: "worker" })
`,
    );
    await writeFile(fakePi, `#!/usr/bin/env node\n${fakePiScript()}\n`);
    await chmod(fakePi, 0o755);
    const definitions = builtinHarnessDefinitions().map((definition) =>
      definition.name === "pi"
        ? { ...definition, command: fakePi }
        : { ...definition, command: process.execPath },
    );
    const run = await runWorkflow({
      workflowPath,
      cwd: root,
      stateDir,
      harnessDefinitions: definitions,
    });
    const parent = (await listWorkflowSessions(run.runDir, stateDir))[0];
    assert.equal(parent?.status, "idle");
    assert.ok(parent.nativeSessionId);

    const query = await submitSessionQuery({
      stateDir,
      entrypoint,
      env: process.env,
      backend: "embedded",
      runId: run.runId,
      selector: parent.id,
      message: "Inspect the parent",
      queryId: "query-reserved:0001",
      launch: false,
    });
    assert.equal(query.status, "queued");
    await assert.rejects(
      submitSessionTurn({
        stateDir,
        entrypoint,
        env: process.env,
        backend: "embedded",
        runId: run.runId,
        selector: parent.id,
        message: "Continue concurrently",
        turnId: "turn-blocked-by-query-0001",
      }),
      /unresolved query query-reserved:0001/,
    );

    await executeSessionQueryWorker({
      stateDir,
      runId: run.runId,
      queryId: query.queryId,
      backend: "embedded",
    });
    const submittedTurn = await submitSessionTurn({
      stateDir,
      entrypoint,
      env: process.env,
      backend: "embedded",
      runId: run.runId,
      selector: parent.id,
      message: "Continue after the query",
      turnId: "turn-after-query-0000001",
    });
    const turn =
      submittedTurn.status === "completed"
        ? submittedTurn
        : await waitForSessionTurn({
            stateDir,
            runId: run.runId,
            turnId: submittedTurn.turnId,
            backend: "embedded",
          });
    assert.equal(turn.status, "completed");

    const sessionPath = path.join(run.runDir, "sessions", parent.id, "session.json");
    const starting = JSON.parse(await readFile(sessionPath, "utf8")) as Record<string, unknown>;
    starting.status = "starting";
    await writeFile(sessionPath, `${JSON.stringify(starting)}\n`);
    await assert.rejects(
      submitSessionQuery({
        stateDir,
        entrypoint,
        env: process.env,
        backend: "embedded",
        runId: run.runId,
        selector: parent.id,
        message: "Do not fork a starting parent",
        queryId: "query-starting:0001",
        launch: false,
      }),
      /must be idle/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function fakeCodexScript(): string {
  return `
const readline = require("node:readline")
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n")
let threadId = "parent-thread"
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line)
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake" } })
    return
  }
  if (message.method === "thread/start") {
    threadId = "parent-thread"
    send({ id: message.id, result: { thread: { id: threadId } } })
    return
  }
  if (message.method === "thread/fork") {
    if (message.params.threadId !== "parent-thread") process.exit(41)
    if (message.params.model !== "small-model") process.exit(42)
    if (message.params.sandbox !== "read-only") process.exit(43)
    threadId = "query-thread"
    send({ id: message.id, result: { thread: { id: threadId } } })
    return
  }
  if (message.method === "turn/start") {
    const turnId = threadId === "query-thread" ? "query-turn" : "parent-turn"
    const text = threadId === "query-thread" ? "query answer" : "parent answer"
    send({ id: message.id, result: { turn: { id: turnId } } })
    setImmediate(() => send({
      method: "turn/completed",
      params: {
        threadId,
        turn: {
          id: turnId,
          status: "completed",
          items: [{ type: "agentMessage", id: "message", text, phase: "final_answer", memoryCitation: null }]
        }
      }
    }))
  }
})
`;
}

function fakePiScript(): string {
  return `
const readline = require("node:readline")
const args = process.argv.slice(2)
const sessionIndex = args.indexOf("--session-id")
const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : "pi-session"
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n")
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line)
  if (message.type === "get_state") {
    send({
      id: message.id,
      type: "response",
      command: "get_state",
      success: true,
      data: { sessionId, messageCount: 0 }
    })
    return
  }
  if (message.type === "prompt") {
    send({ id: message.id, type: "response", command: "prompt", success: true })
    setImmediate(() => {
      send({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "pi answer" }],
          stopReason: "stop"
        }
      })
      send({ type: "agent_settled" })
    })
  }
})
`;
}
