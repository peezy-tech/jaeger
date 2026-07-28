import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { UncertainAgentRunError } from "../src/errors.js";
import { builtinHarnessDefinitions } from "../src/harnesses/registry.js";
import { prepareWorkflowRun, runWorkflow } from "../src/runtime.js";
import type { AgentRequest, HarnessAdapter, HarnessResult } from "../src/types.js";

class FakeHarness implements HarnessAdapter {
  readonly calls: AgentRequest[] = [];

  constructor(
    readonly name: string,
    private readonly executeCall: (request: AgentRequest) => Promise<HarnessResult>,
  ) {}

  readonly driver = "codex-app-server" as const;

  async execute(request: AgentRequest): Promise<HarnessResult> {
    this.calls.push(request);
    return await this.executeCall(request);
  }
}

test("pinned controller source paths remain opaque on a Linux runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-controller-source-"));
  const workflowPath = "C:\\Users\\operator\\workflows\\remote.js";
  const prepared = await prepareWorkflowRun({
    workflowPath,
    workflowPathPinned: true,
    workflowSource: `
export const meta = { name: "windows controller source" }
return "ok"
`,
    cwd: root,
    stateDir: path.join(root, "state"),
    stageOnly: true,
  });
  assert.equal(prepared.scriptPath, workflowPath);
  assert.equal(prepared.staged?.record.workflowPath, workflowPath);
});

test("workflow admission accepts a pinned registry with unavailable built-ins omitted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-partial-registry-"));
  const workflowPath = path.join(root, "workflow.js");
  await writeFile(
    workflowPath,
    `
export const meta = { name: "partial registry" }
return "ok"
`,
  );
  const codex = builtinHarnessDefinitions().find((definition) => definition.name === "codex");
  assert.ok(codex);
  const prepared = await prepareWorkflowRun({
    workflowPath,
    cwd: root,
    stateDir: path.join(root, "state"),
    harnessDefinitions: [{ ...codex, command: process.execPath }],
    stageOnly: true,
  });
  const record = prepared.staged?.record;
  assert.equal(record?.version, 4);
  if (!record || record.version !== 4) assert.fail("expected a version 4 run record");
  assert.deepEqual(
    record.harnesses.map((definition) => definition.name),
    ["codex"],
  );
});

test("mixes harnesses, preserves parallel order, and replays a completed run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-runtime-"));
  const workflowPath = path.join(root, "workflow.js");
  await writeFile(
    workflowPath,
    `
export const meta = { name: "mixed" }
const results = await parallel([
  () => agent("codex prompt", { harness: "codex", label: "first" }),
  () => agent("claude prompt", { harness: "claude", label: "second" }),
])
return results
`,
  );
  const codex = new FakeHarness("codex", async () => ({ output: { from: "codex" } }));
  const claude = new FakeHarness("claude", async () => ({ output: { from: "claude" } }));
  const harnesses = new Map<string, HarnessAdapter>([
    ["codex", codex],
    ["claude", claude],
  ]);

  const first = await runWorkflow({
    workflowPath,
    cwd: root,
    stateDir: path.join(root, "state"),
    harnesses,
  });
  assert.deepEqual(first.result, [{ from: "codex" }, { from: "claude" }]);
  assert.equal(codex.calls.length, 1);
  assert.equal(claude.calls.length, 1);

  const replayCodex = new FakeHarness("codex", async () => {
    throw new Error("must not execute");
  });
  const replay = await runWorkflow({
    workflowPath,
    cwd: root,
    stateDir: path.join(root, "state"),
    resumeRunId: first.runId,
    harnesses: new Map([["codex", replayCodex]]),
  });
  assert.deepEqual(replay.result, first.result);
  assert.equal(replayCodex.calls.length, 0);
});

test("does not retry an agent whose prior run may have had side effects", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-uncertain-"));
  const workflowPath = path.join(root, "workflow.js");
  await writeFile(
    workflowPath,
    `
export const meta = { name: "uncertain" }
await agent("first", { harness: "codex" })
await agent("second", { harness: "claude" })
return "done"
`,
  );
  const codex = new FakeHarness("codex", async () => ({ output: "first complete" }));
  const claude = new FakeHarness("claude", async () => {
    throw new Error("provider connection closed");
  });
  let runId = "";
  try {
    await runWorkflow({
      workflowPath,
      cwd: root,
      stateDir: path.join(root, "state"),
      harnesses: new Map([
        ["codex", codex],
        ["claude", claude],
      ]),
    });
    assert.fail("workflow should fail");
  } catch {
    const entries = await import("node:fs/promises").then(async ({ readdir }) =>
      (await readdir(path.join(root, "state"))).filter((entry) =>
        /^\d{14}-[a-f0-9]{10}$/.test(entry),
      ),
    );
    runId = entries[0] ?? "";
  }
  assert.ok(runId);

  const replayCodex = new FakeHarness("codex", async () => ({ output: "wrong" }));
  const replayClaude = new FakeHarness("claude", async () => ({ output: "wrong" }));
  await assert.rejects(
    runWorkflow({
      workflowPath,
      cwd: root,
      stateDir: path.join(root, "state"),
      resumeRunId: runId,
      harnesses: new Map([
        ["codex", replayCodex],
        ["claude", replayClaude],
      ]),
    }),
    UncertainAgentRunError,
  );
  assert.equal(replayCodex.calls.length, 0);
  assert.equal(replayClaude.calls.length, 0);
});
