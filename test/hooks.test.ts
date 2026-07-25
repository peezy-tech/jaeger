import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadHookConfig, type HookConfig } from "../src/hook-config.js";
import { HookManager } from "../src/hooks.js";
import { inspectRun } from "../src/run-state.js";
import { runWorkflow } from "../src/runtime.js";
import type {
  AgentRequest,
  HarnessAdapter,
  HarnessResult,
  JsonValue,
} from "../src/types.js";

class FakeHarness implements HarnessAdapter {
  readonly name = "codex";
  readonly driver = "codex-app-server" as const;

  async execute(_request: AgentRequest): Promise<HarnessResult> {
    return {
      output: {
        summary: "safe summary",
        secret: "must-not-enter-hook-event",
      },
    };
  }
}

test("validates lifecycle hook TOML strictly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-hook-config-"));
  try {
    const configPath = path.join(root, "hooks.toml");
    await writeFile(
      configPath,
      `
version = 1

[[hooks]]
name = "hq-markdown"
events = ["run.accepted", "phase.changed", "agent.completed", "run.terminal"]
command = ["node", "/tmp/projector.mjs"]
timeout_ms = 5000
`,
      "utf8",
    );
    const config = await loadHookConfig(configPath);
    assert.equal(config.hooks.length, 1);
    assert.equal(config.hooks[0]?.name, "hq-markdown");
    assert.equal(config.hooks[0]?.timeoutMs, 5_000);
    assert.match(config.digest, /^[a-f0-9]{64}$/);

    await writeFile(
      configPath,
      `
version = 1
[[hooks]]
name = "bad"
events = ["provider.tool"]
command = ["node"]
`,
      "utf8",
    );
    await assert.rejects(loadHookConfig(configPath), /unsupported event/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delivers normalized lifecycle events once per stable id without exposing outputs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-hooks-"));
  const stateDir = path.join(root, "state");
  const workflowPath = path.join(root, "workflow.js");
  const hookScript = path.join(root, "hook.mjs");
  const hookLog = path.join(root, "events.jsonl");
  try {
    await writeFile(
      workflowPath,
      `
export const meta = { name: "hook fixture" }
phase("Observe")
const result = await agent("PRIVATE PROMPT", { harness: "codex", label: "proof" })
return result
`,
      "utf8",
    );
    await writeFile(
      hookScript,
      `
import { appendFile } from "node:fs/promises"
let body = ""
for await (const chunk of process.stdin) body += chunk
await appendFile(process.env.HOOK_LOG, body)
`,
      "utf8",
    );
    const result = await runWorkflow({
      workflowPath,
      cwd: root,
      stateDir,
      harnesses: new Map([["codex", new FakeHarness()]]),
    });
    const config = hookConfig(hookScript, [
      "run.accepted",
      "phase.changed",
      "agent.completed",
      "run.terminal",
    ]);
    const manager = new HookManager({
      stateDir,
      configPath: config.path,
      config,
      env: { ...process.env, HOOK_LOG: hookLog },
    });
    for (let index = 0; index < 8; index++) await manager.tick();

    const first = await readHookLog(hookLog);
    assert.deepEqual(
      first.map((event) => event.type).sort(),
      ["agent.completed", "phase.changed", "run.accepted", "run.terminal"],
    );
    assert.equal(new Set(first.map((event) => event.id)).size, first.length);
    const serialized = JSON.stringify(first);
    assert.doesNotMatch(serialized, /PRIVATE PROMPT/);
    assert.doesNotMatch(serialized, /must-not-enter-hook-event/);
    assert.equal((await inspectRun(stateDir, result.runId)).status, "completed");

    const restarted = new HookManager({
      stateDir,
      configPath: config.path,
      config,
      env: { ...process.env, HOOK_LOG: hookLog },
    });
    for (let index = 0; index < 4; index++) await restarted.tick();
    assert.equal((await readHookLog(hookLog)).length, first.length);

    const eventFiles = await readdir(path.join(stateDir, ".hooks", "events"));
    assert.equal(eventFiles.length, first.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed terminal hook retries independently of a completed workflow", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-hook-failure-"));
  const stateDir = path.join(root, "state");
  const workflowPath = path.join(root, "workflow.js");
  const hookScript = path.join(root, "fail.mjs");
  const attemptFile = path.join(root, "attempt.txt");
  let now = new Date("2026-07-24T00:00:00.000Z");
  try {
    await writeFile(
      workflowPath,
      `
export const meta = { name: "terminal hook failure" }
phase("Finish")
return { status: "done" }
`,
      "utf8",
    );
    await writeFile(
      hookScript,
      `
import { readFileSync, writeFileSync } from "node:fs"
const attemptFile = process.env.HOOK_ATTEMPT_FILE
let attempt = 0
try {
  attempt = Number(readFileSync(attemptFile, "utf8"))
} catch {}
attempt++
writeFileSync(attemptFile, String(attempt))
if (attempt === 1) process.exitCode = 17
`,
      "utf8",
    );
    const result = await runWorkflow({ workflowPath, cwd: root, stateDir });
    const config = hookConfig(hookScript, ["run.terminal"]);
    const manager = new HookManager({
      stateDir,
      configPath: config.path,
      config,
      env: { ...process.env, HOOK_ATTEMPT_FILE: attemptFile },
      now: () => now,
    });
    await manager.tick();
    let history = (await manager.history()) as JsonValue[];
    assert.equal((history[0] as Record<string, JsonValue>).status, "retrying");
    assert.equal((history[0] as Record<string, JsonValue>).exitCode, 17);
    assert.equal((await inspectRun(stateDir, result.runId)).status, "completed");

    now = new Date(now.getTime() + 2_000);
    await manager.tick();
    history = (await manager.history()) as JsonValue[];
    const delivered = history[0] as Record<string, JsonValue>;
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.attempts, 2);
    assert.equal(delivered.exitCode, 0);
    assert.equal(delivered.lastError, undefined);
    assert.equal(delivered.signal, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounds hook time and output without changing terminal run state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-hook-bounds-"));
  const stateDir = path.join(root, "state");
  const workflowPath = path.join(root, "workflow.js");
  const hookScript = path.join(root, "bounds.mjs");
  try {
    await writeFile(
      workflowPath,
      `
export const meta = { name: "bounded hooks" }
return "complete"
`,
      "utf8",
    );
    await writeFile(
      hookScript,
      `
if (process.argv[2] === "output") {
  process.stdout.write("x".repeat(70 * 1024))
} else {
  setInterval(() => {}, 1000)
}
`,
      "utf8",
    );
    const result = await runWorkflow({ workflowPath, cwd: root, stateDir });
    const config: HookConfig = {
      version: 1,
      path: path.join(root, "hooks.toml"),
      digest: "b".repeat(64),
      hooks: [
        {
          name: "timeout",
          events: ["run.terminal"],
          command: [process.execPath, hookScript, "timeout"],
          timeoutMs: 100,
        },
        {
          name: "output",
          events: ["run.terminal"],
          command: [process.execPath, hookScript, "output"],
          timeoutMs: 5_000,
        },
      ],
    };
    const manager = new HookManager({ stateDir, configPath: config.path, config });
    await manager.tick();
    const history = (await manager.history()) as Array<Record<string, JsonValue>>;
    assert.equal(history.length, 2);
    assert.ok(history.every((delivery) => delivery.status === "retrying"));
    assert.ok(
      history.some((delivery) => String(delivery.lastError).includes("timed out")),
    );
    assert.ok(
      history.some((delivery) => String(delivery.lastError).includes("output exceeded")),
    );
    assert.equal((await inspectRun(stateDir, result.runId)).status, "completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("projects durable schedule state and occurrence transitions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-hook-schedule-"));
  const stateDir = path.join(root, "state");
  const scheduleDir = path.join(stateDir, ".schedules", "daily");
  const hookScript = path.join(root, "hook.mjs");
  const hookLog = path.join(root, "events.jsonl");
  const at = "2026-07-24T00:00:00.000Z";
  try {
    await mkdir(path.join(scheduleDir, "occurrences"), { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(scheduleDir, "schedule.json"),
      `${JSON.stringify({
        version: 1,
        id: "daily",
        activeRevision: 1,
        latestRevision: 1,
        enabled: true,
        createdAt: at,
        updatedAt: at,
      })}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      path.join(scheduleDir, "occurrences", "manual-proof.json"),
      `${JSON.stringify({
        version: 1,
        id: "manual-proof",
        scheduleId: "daily",
        revision: 1,
        kind: "manual",
        scheduledFor: at,
        submissionId: "schedule:proof",
        status: "completed",
        createdAt: at,
        updatedAt: at,
        runId: "20260724000000-aaaaaaaaaa",
      })}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      hookScript,
      `
import { appendFile } from "node:fs/promises"
let body = ""
for await (const chunk of process.stdin) body += chunk
await appendFile(process.env.HOOK_LOG, body)
`,
      "utf8",
    );
    const config = hookConfig(hookScript, [
      "schedule.changed",
      "schedule.occurrence",
    ]);
    const manager = new HookManager({
      stateDir,
      configPath: config.path,
      config,
      env: { ...process.env, HOOK_LOG: hookLog },
    });
    await manager.tick();
    await manager.tick();
    const events = await readHookLog(hookLog);
    assert.deepEqual(
      events.map((event) => event.type).sort(),
      ["schedule.changed", "schedule.occurrence"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function hookConfig(
  hookScript: string,
  events: HookConfig["hooks"][number]["events"],
): HookConfig {
  return {
    version: 1,
    path: path.join(path.dirname(hookScript), "hooks.toml"),
    digest: "a".repeat(64),
    hooks: [
      {
        name: "proof",
        events,
        command: [process.execPath, hookScript],
        timeoutMs: 5_000,
      },
    ],
  };
}

async function readHookLog(
  target: string,
): Promise<Array<{ id: string; type: string }>> {
  const contents = await readFile(target, "utf8");
  return contents
    .split(/\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { id: string; type: string });
}
