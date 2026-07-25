import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import type { WorkflowRunResult, WorkflowSessionSummary } from "../src/types.js";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.js");

test("an idle workflow session is listed, inspected, and resumed for another turn", async () => {
  const fixture = await sessionFixture("initial response");
  const workflow = parseJson<WorkflowRunResult>(
    (
      await cli(
        [
          "run",
          fixture.workflowPath,
          "--cwd",
          fixture.root,
          "--state-dir",
          fixture.stateDir,
        ],
        fixture.env,
      )
    ).stdout,
  );
  const [session] = parseJson<WorkflowSessionSummary[]>(
    (
      await cli(
        ["session", "list", workflow.runId, "--state-dir", fixture.stateDir, "--json"],
        fixture.env,
      )
    ).stdout,
  );
  assert.ok(session);
  assert.equal(session.status, "idle");
  assert.equal(session.nativeSessionId, "native-session");
  assert.equal(session.turnCount, 1);
  assert.match(session.resume ?? "", /session resume/);
  const events = (await readFile(path.join(workflow.runDir, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const started = events.find((event) => event.type === "agent.started");
  const completed = events.find((event) => event.type === "agent.completed");
  assert.equal(started?.sessionId, session.id);
  assert.equal(completed?.sessionId, session.id);
  assert.equal(completed?.nativeSessionId, "native-session");

  const inspected = parseJson<WorkflowSessionSummary>(
    (
      await cli(
        [
          "session",
          "inspect",
          workflow.runId,
          session.id,
          "--state-dir",
          fixture.stateDir,
        ],
        fixture.env,
      )
    ).stdout,
  );
  assert.equal(inspected.stepId, "root/agent:1:worker");

  const followUp = parseJson<{ output: string; nativeSessionId: string; turn: number }>(
    (
      await cli(
        [
          "session",
          "resume",
          workflow.runId,
          session.id,
          "--state-dir",
          fixture.stateDir,
          "--message",
          "follow up",
        ],
        fixture.env,
      )
    ).stdout,
  );
  assert.equal(followUp.output, "follow-up complete");
  assert.equal(followUp.nativeSessionId, "native-session");
  assert.equal(followUp.turn, 2);

  const [resumedSession] = parseJson<WorkflowSessionSummary[]>(
    (
      await cli(
        ["session", "list", workflow.runId, "--state-dir", fixture.stateDir, "--json"],
        fixture.env,
      )
    ).stdout,
  );
  assert.equal(resumedSession?.turnCount, 2);
  assert.equal(resumedSession?.lastOutput, "follow-up complete");

  await assert.rejects(
    cli(
      ["session", "send", workflow.runId, session.id, "--state-dir", fixture.stateDir],
      fixture.env,
    ),
    /session requires list, inspect, resume, steer, interrupt, or query/,
  );

  const requests = await protocolRequests(fixture.requestsPath);
  assert.equal(requests.filter((request) => request.method === "thread/start").length, 1);
  assert.equal(requests.filter((request) => request.method === "thread/resume").length, 1);
  const resume = requests.find((request) => request.method === "thread/resume");
  assert.equal(resume?.params?.threadId, "native-session");

  const sessionDir = path.join(workflow.runDir, "sessions", session.id);
  const sessionPath = path.join(sessionDir, "session.json");
  const stored = JSON.parse(await readFile(sessionPath, "utf8")) as Record<string, unknown>;
  const staleController = {
    pid: 999_999_999,
    processStartId: "0",
    token: "0".repeat(32),
  };
  await writeFile(
    sessionPath,
    `${JSON.stringify({
      ...stored,
      status: "running",
      activeTurnId: "lost-turn",
      controller: staleController,
    })}\n`,
    "utf8",
  );
  await mkdir(path.join(sessionDir, "turn.lock"));
  await writeFile(
    path.join(sessionDir, "turn.lock", "owner.json"),
    `${JSON.stringify(staleController)}\n`,
    "utf8",
  );
  await assert.rejects(
    cli(
      [
        "session",
        "resume",
        workflow.runId,
        session.id,
        "--state-dir",
        fixture.stateDir,
        "--message",
        "must not duplicate",
      ],
      fixture.env,
    ),
    /uncertain stale turn and cannot be safely resumed/,
  );
});

test("a Jaeger user can steer an active workflow turn through its session", async () => {
  const fixture = await sessionFixture("WAIT_FOR_STEER");
  const launched = parseJson<{ runId: string }>(
    (
      await cli(
        [
          "run",
          fixture.workflowPath,
          "--cwd",
          fixture.root,
          "--state-dir",
          fixture.stateDir,
          "--detach",
        ],
        fixture.env,
      )
    ).stdout,
  );
  const session = await waitForRunningSession(launched.runId, fixture);
  assert.ok(session.activeTurnId);
  assert.match(session.steer ?? "", /session steer/);

  const steered = parseJson<{ action: string; acknowledged: boolean; turnId: string }>(
    (
      await cli(
        [
          "session",
          "steer",
          launched.runId,
          session.id,
          "--state-dir",
          fixture.stateDir,
          "--message",
          "Use the safer approach",
        ],
        fixture.env,
      )
    ).stdout,
  );
  assert.equal(steered.action, "steer");
  assert.equal(steered.acknowledged, true);
  assert.ok(steered.turnId);

  const completed = parseJson<{ status: string; result: unknown }>(
    (
      await cli(["wait", launched.runId, "--state-dir", fixture.stateDir], fixture.env)
    ).stdout,
  );
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.result, { answer: "steered" });
  const requests = await protocolRequests(fixture.requestsPath);
  const steer = requests.find((request) => request.method === "turn/steer");
  assert.equal(steer?.params?.expectedTurnId, steered.turnId);
});

test("a custom harness is pinned for detached execution and later session resume", async () => {
  const fixture = await sessionFixture("initial response", "gateway-codex");
  const workflow = parseJson<{ runId: string; runDir: string }>(
    (
      await cli(
        [
          "run",
          fixture.workflowPath,
          "--cwd",
          fixture.root,
          "--state-dir",
          fixture.stateDir,
          "--harness-config",
          fixture.harnessConfigPath,
          "--detach",
        ],
        fixture.env,
      )
    ).stdout,
  );
  const completed = parseJson<{ status: string }>(
    (
      await cli(
        ["wait", workflow.runId, "--state-dir", fixture.stateDir, "--json"],
        fixture.env,
      )
    ).stdout,
  );
  assert.equal(completed.status, "completed");
  const record = JSON.parse(
    await readFile(path.join(workflow.runDir, "run.json"), "utf8"),
  ) as { version?: number; harnesses?: Array<{ name?: string; driver?: string }> };
  assert.equal(record.version, 4);
  assert.deepEqual(
    record.harnesses?.find((definition) => definition.name === "gateway-codex"),
    {
      name: "gateway-codex",
      driver: "codex-app-server",
      command: fixture.codexPath,
      description: "test gateway",
    },
  );

  await writeFile(fixture.harnessConfigPath, "not valid JSON\n", "utf8");
  const [session] = parseJson<WorkflowSessionSummary[]>(
    (
      await cli(
        ["session", "list", workflow.runId, "--state-dir", fixture.stateDir, "--json"],
        fixture.env,
      )
    ).stdout,
  );
  assert.ok(session);
  const followUp = parseJson<{ output: string; turn: number }>(
    (
      await cli(
        [
          "session",
          "resume",
          workflow.runId,
          session.id,
          "--state-dir",
          fixture.stateDir,
          "--message",
          "follow up",
        ],
        fixture.env,
      )
    ).stdout,
  );
  assert.equal(followUp.output, "follow-up complete");
  assert.equal(followUp.turn, 2);
});

async function sessionFixture(prompt: string, harness = "codex"): Promise<{
  readonly root: string;
  readonly workflowPath: string;
  readonly stateDir: string;
  readonly requestsPath: string;
  readonly codexPath: string;
  readonly harnessConfigPath: string;
  readonly env: NodeJS.ProcessEnv;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-session-cli-"));
  const binDir = path.join(root, "bin");
  const stateDir = path.join(root, "state");
  const workflowPath = path.join(root, "workflow.js");
  const requestsPath = path.join(root, "provider-requests.jsonl");
  const harnessConfigPath = path.join(root, "harnesses.json");
  await mkdir(binDir);
  await writeFile(
    workflowPath,
    `
export const meta = { name: "session fixture" }
return await agent(${JSON.stringify(prompt)}, {
  harness: ${JSON.stringify(harness)},
  label: "worker",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["answer"],
    properties: { answer: { type: "string" } },
  },
})
`,
  );
  const codexPath = path.join(binDir, "codex");
  await writeFile(
    codexPath,
    `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")
const requestsPath = ${JSON.stringify(requestsPath)}
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n")
let activeTurn = "turn-" + process.pid
let prompt = ""
const complete = (text) => send({
  method: "turn/completed",
  params: {
    threadId: "native-session",
    turn: {
      id: activeTurn,
      status: "completed",
      items: [{ type: "agentMessage", id: "message", text, phase: "final_answer", memoryCitation: null }],
    },
  },
})
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line)
  fs.appendFileSync(requestsPath, JSON.stringify(message) + "\\n")
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fixture" } })
  if (message.method === "thread/start" || message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: "native-session" } } })
  }
  if (message.method === "turn/start") {
    prompt = message.params.input[0].text
    send({ id: message.id, result: { turn: { id: activeTurn } } })
    if (prompt !== "WAIT_FOR_STEER") {
      setImmediate(() => complete(prompt === "follow up" ? "follow-up complete" : JSON.stringify({ answer: "initial" })))
    }
  }
  if (message.method === "turn/steer") {
    send({ id: message.id, result: { turnId: activeTurn } })
    setImmediate(() => complete(JSON.stringify({ answer: "steered" })))
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} })
    send({ method: "turn/completed", params: { threadId: "native-session", turn: { id: activeTurn, status: "interrupted", items: [] } } })
  }
})
`,
  );
  await chmod(codexPath, 0o755);
  await writeFile(
    harnessConfigPath,
    `${JSON.stringify({
      version: 1,
      harnesses: harness === "codex"
        ? {}
        : {
            [harness]: {
              driver: "codex-app-server",
              command: codexPath,
              description: "test gateway",
            },
          },
    })}\n`,
  );
  return {
    root,
    workflowPath,
    stateDir,
    requestsPath,
    codexPath,
    harnessConfigPath,
    env: {
      ...process.env,
      JAEGER_RUNTIME: "embedded",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  };
}

async function waitForRunningSession(
  runId: string,
  fixture: { readonly stateDir: string; readonly env: NodeJS.ProcessEnv },
): Promise<WorkflowSessionSummary> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const sessions = parseJson<WorkflowSessionSummary[]>(
      (
        await cli(
          ["session", "list", runId, "--state-dir", fixture.stateDir, "--json"],
          fixture.env,
        )
      ).stdout,
    );
    const running = sessions.find(
      (session) => session.status === "running" && session.activeTurnId,
    );
    if (running) return running;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("workflow session did not expose an active turn");
}

async function protocolRequests(
  requestsPath: string,
): Promise<Array<{ method?: string; params?: Record<string, unknown> }>> {
  return (await readFile(requestsPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
}

async function cli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync(process.execPath, [cliPath, ...args], {
    env,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}
