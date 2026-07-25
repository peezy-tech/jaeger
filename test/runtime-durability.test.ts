import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hostRuntimeBoundary } from "../src/boundary.js";
import {
  RunOwnedError,
  RunStoppedError,
  UncertainAgentRunError,
  WorkflowChangedError,
} from "../src/errors.js";
import { RunJournal } from "../src/journal.js";
import { readRunOwner, RunLease } from "../src/lease.js";
import { inspectRun } from "../src/run-state.js";
import {
  executePreparedRun,
  prepareWorkflowRun,
  runWorkflow,
} from "../src/runtime.js";
import type {
  AgentRequest,
  HarnessAdapter,
  HarnessResult,
  RuntimeReporter,
} from "../src/types.js";

class FakeHarness implements HarnessAdapter {
  readonly name = "codex" as const;
  readonly driver = "codex-app-server" as const;
  readonly calls: AgentRequest[] = [];

  constructor(private readonly implementation: (request: AgentRequest) => Promise<HarnessResult>) {}

  async execute(request: AgentRequest): Promise<HarnessResult> {
    this.calls.push(request);
    return await this.implementation(request);
  }
}

test("an exclusive lease prevents concurrent owners from duplicating an agent effect", async () => {
  const root = await workspace("exclusive-owner", `
export const meta = { name: "exclusive-owner" }
return await agent("one", { harness: "codex" })
`);
  const prepared = await prepareWorkflowRun({
    workflowPath: path.join(root, "workflow.js"),
    cwd: root,
    stateDir: path.join(root, "state"),
  });
  const harness = new FakeHarness(async () => {
    await delay(120);
    return { output: "done" };
  });
  const harnesses = new Map<string, HarnessAdapter>([["codex", harness]]);

  const settled = await Promise.allSettled([
    executePreparedRun({ stateDir: prepared.stateDir, runId: prepared.runId, harnesses }),
    executePreparedRun({ stateDir: prepared.stateDir, runId: prepared.runId, harnesses }),
  ]);
  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.ok(rejected?.reason instanceof RunOwnedError);
  assert.equal(harness.calls.length, 1);
  assert.equal((await inspectRun(prepared.stateDir, prepared.runId)).status, "completed");
});

test("the OS releases a crashed owner's SQLite lease for immediate reacquisition", async () => {
  const root = await workspace("crashed-sqlite-lease", `
export const meta = { name: "crashed-sqlite-lease" }
return "ok"
`);
  const prepared = await prepareWorkflowRun({
    workflowPath: path.join(root, "workflow.js"),
    cwd: root,
    stateDir: path.join(root, "state"),
  });
  const leaseModule = new URL("../src/lease.js", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { RunLease } from ${JSON.stringify(leaseModule)};
       await RunLease.acquire(${JSON.stringify(prepared.runDir)}, ${JSON.stringify(prepared.runId)}, "detached");
       process.stdout.write("ready\\n");
       setInterval(() => {}, 1000);`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    await waitForChildText(child, "ready\n");
    assert.equal((await readRunOwner(prepared.runDir, prepared.runId)).active, true);
    const closed = once(child, "close");
    child.kill("SIGKILL");
    await closed;
    assert.equal((await readRunOwner(prepared.runDir, prepared.runId)).active, false);
    const replacement = await RunLease.acquire(prepared.runDir, prepared.runId, "foreground");
    await replacement.release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("a stale owner record with a live recycled PID is not authoritative", async () => {
  const root = await workspace("stale-owner-pid", `
export const meta = { name: "stale-owner-pid" }
return "ok"
`);
  const prepared = await prepareWorkflowRun({
    workflowPath: path.join(root, "workflow.js"),
    cwd: root,
    stateDir: path.join(root, "state"),
  });
  await writeFile(
    path.join(prepared.runDir, "owner.json"),
    `${JSON.stringify({
      version: 1,
      runId: prepared.runId,
      token: "a".repeat(32),
      pid: process.pid,
      kind: "detached",
      acquiredAt: new Date().toISOString(),
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const owner = await readRunOwner(prepared.runDir, prepared.runId);
  assert.equal(owner.owner?.pid, process.pid);
  assert.equal(owner.active, false, "only the held SQLite transaction establishes ownership");
});

test("concurrent read-only owner probes cannot steal or false-block the lease", async () => {
  const root = await workspace("lease-probe-contention", `
export const meta = { name: "lease-probe-contention" }
return "ok"
`);
  const prepared = await prepareWorkflowRun({
    workflowPath: path.join(root, "workflow.js"),
    cwd: root,
    stateDir: path.join(root, "state"),
  });
  const seed = await RunLease.acquire(prepared.runDir, prepared.runId, "foreground");
  await seed.release();
  const leaseModule = new URL("../src/lease.js", import.meta.url).href;
  const probeScript = `
    import { readRunOwner } from ${JSON.stringify(leaseModule)};
    process.stdout.write("ready\\n");
    const deadline = Date.now() + 1200;
    while (Date.now() < deadline) {
      await readRunOwner(${JSON.stringify(prepared.runDir)}, ${JSON.stringify(prepared.runId)});
    }
  `;
  const probes = [
    spawn(process.execPath, ["--input-type=module", "-e", probeScript], {
      stdio: ["ignore", "pipe", "pipe"],
    }),
    spawn(process.execPath, ["--input-type=module", "-e", probeScript], {
      stdio: ["ignore", "pipe", "pipe"],
    }),
  ];
  try {
    await Promise.all(probes.map(async (probe) => await waitForChildText(probe, "ready\n")));
    for (let index = 0; index < 20; index++) {
      const lease = await RunLease.acquire(prepared.runDir, prepared.runId, "foreground");
      await lease.release();
    }
    await Promise.all(
      probes.map(async (probe) => {
        if (probe.exitCode === null && probe.signalCode === null) await once(probe, "close");
      }),
    );
  } finally {
    for (const probe of probes) {
      if (probe.exitCode === null && probe.signalCode === null) probe.kill("SIGKILL");
    }
  }
});

test("run-level concurrency bounds agent processes while preserving parallel result order", async () => {
  const root = await workspace("bounded-concurrency", `
export const meta = { name: "bounded-concurrency" }
return await parallel([
  () => agent("1", { harness: "codex" }),
  () => agent("2", { harness: "codex" }),
  () => agent("3", { harness: "codex" }),
  () => agent("4", { harness: "codex" }),
  () => agent("5", { harness: "codex" }),
])
`);
  let active = 0;
  let maximum = 0;
  const harness = new FakeHarness(async (request) => {
    active++;
    maximum = Math.max(maximum, active);
    await delay(35);
    active--;
    return { output: request.prompt };
  });
  const result = await runWorkflow({
    workflowPath: path.join(root, "workflow.js"),
    cwd: root,
    stateDir: path.join(root, "state"),
    maxConcurrency: 2,
    harnesses: new Map([["codex", harness]]),
  });
  assert.equal(maximum, 2);
  assert.deepEqual(result.result, ["1", "2", "3", "4", "5"]);
});

test("unawaited agents settle before the workflow terminal event", async () => {
  const root = await workspace("orphan-agent", `
export const meta = { name: "orphan-agent" }
void agent("background", { harness: "codex" })
return "coordinator-returned"
`);
  const harness = new FakeHarness(async () => {
    await delay(100);
    return { output: "agent-returned" };
  });
  const started = Date.now();
  const result = await runWorkflow({
    workflowPath: path.join(root, "workflow.js"),
    cwd: root,
    stateDir: path.join(root, "state"),
    harnesses: new Map([["codex", harness]]),
  });
  assert.ok(Date.now() - started >= 80);
  const events = await RunJournal.open(path.join(root, "state"), result.runId).then((journal) =>
    journal.events(),
  );
  assert.equal(events.at(-1)?.type, "workflow.completed");
  assert.equal(events.filter((event) => event.type === "agent.completed").length, 1);
});

test("chained unawaited agents reach quiescence before workflow completion", async () => {
  const root = await workspace("chained-orphan-agent", `
export const meta = { name: "chained-orphan-agent" }
void parallel([async () => {
  await agent("one", { harness: "codex" })
  return await agent("two", { harness: "codex" })
}])
return "coordinator-returned"
`);
  const harness = new FakeHarness(async (request) => {
    await delay(25);
    return { output: request.prompt };
  });
  const result = await runWorkflow({
    workflowPath: path.join(root, "workflow.js"),
    cwd: root,
    stateDir: path.join(root, "state"),
    harnesses: new Map([["codex", harness]]),
  });
  assert.equal(harness.calls.length, 2);
  const events = await RunJournal.open(path.join(root, "state"), result.runId).then((journal) =>
    journal.events(),
  );
  assert.equal(events.filter((event) => event.type === "agent.completed").length, 2);
  assert.equal(events.at(-1)?.type, "workflow.completed");
  assert.equal((await inspectRun(path.join(root, "state"), result.runId)).status, "completed");
});

test("an unawaited parallel rejection fails the workflow before its terminal event", async () => {
  const root = await workspace("orphan-parallel-failure", `
export const meta = { name: "orphan-parallel-failure" }
void parallel([() => { throw new Error("parallel failed") }])
return "coordinator-returned"
`);
  const stateDir = path.join(root, "state");
  await assert.rejects(
    runWorkflow({
      workflowPath: path.join(root, "workflow.js"),
      cwd: root,
      stateDir,
      harnesses: new Map(),
    }),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.some((nested: unknown) => /parallel failed/.test(String(nested))),
  );
  const [runId] = await import("node:fs/promises").then(async ({ readdir }) =>
    (await readdir(stateDir)).filter((entry) => /^\d{14}-[a-f0-9]{10}$/.test(entry)),
  );
  const events = await RunJournal.open(stateDir, runId ?? "").then((journal) => journal.events());
  assert.equal(events.some((event) => event.type === "workflow.completed"), false);
  assert.equal(events.at(-1)?.type, "workflow.failed");
});

test("legacy, unknown, invalid-schema, and unsupported options fail before an agent starts", async () => {
  const cases = [
    ["legacy-access", '{ harness: "codex", access: "read-only" }'],
    ["legacy-fresh", '{ harness: "codex", fresh: false }'],
    ["unknown", '{ harness: "codex", surprise: true }'],
    ["invalid-schema", '{ harness: "codex", schema: { type: 42 } }'],
    ["async-schema", '{ harness: "codex", schema: { $async: true, type: "string" } }'],
    ["claude-tier", '{ harness: "claude", serviceTier: "default" }'],
    ["claude-profile", '{ harness: "claude", profile: "review" }'],
    ["invalid-harness-case", '{ harness: "Claude" }'],
    ["invalid-harness-shape", '{ harness: "claude/gateway" }'],
  ] as const;
  for (const [name, options] of cases) {
    const root = await workspace(name, `
export const meta = { name: ${JSON.stringify(name)} }
return await agent("must not launch", ${options})
`);
    const harness = new FakeHarness(async () => ({ output: "wrong" }));
    await assert.rejects(
      runWorkflow({
        workflowPath: path.join(root, "workflow.js"),
        cwd: root,
        stateDir: path.join(root, "state"),
        harnesses: new Map([
          ["codex", harness],
        ]),
      }),
    );
    assert.equal(harness.calls.length, 0, name);
    const [runId] = await import("node:fs/promises").then(async ({ readdir }) =>
      (await readdir(path.join(root, "state"))).filter((entry) =>
        /^\d{14}-[a-f0-9]{10}$/.test(entry),
      ),
    );
    const events = await RunJournal.open(path.join(root, "state"), runId ?? "").then((journal) =>
      journal.events(),
    );
    assert.equal(events.some((event) => event.type === "agent.started"), false, name);
    assert.equal(events.at(-1)?.type, "workflow.failed", name);
  }
});

test("runtime centrally rejects schema-invalid adapter output and marks the effect uncertain", async () => {
  const root = await workspace("central-schema", `
export const meta = { name: "central-schema" }
return await agent("return a string", {
  harness: "codex",
  schema: { type: "string" },
})
`);
  const harness = new FakeHarness(async () => ({ output: 42 }));
  await assert.rejects(
    runWorkflow({
      workflowPath: path.join(root, "workflow.js"),
      cwd: root,
      stateDir: path.join(root, "state"),
      harnesses: new Map([["codex", harness]]),
    }),
  );
  const [runId] = await import("node:fs/promises").then(async ({ readdir }) =>
    (await readdir(path.join(root, "state"))).filter((entry) =>
      /^\d{14}-[a-f0-9]{10}$/.test(entry),
    ),
  );
  const summary = await inspectRun(path.join(root, "state"), runId ?? "");
  assert.equal(summary.status, "uncertain");
  assert.match(summary.uncertainty?.reason ?? "", /external effects|durable completion/);
  assert.equal(summary.resume, undefined);
});

test("phase, log, and completed agent checkpoints replay without duplicate journal effects", async () => {
  const root = await workspace("replay-effects", `
export const meta = { name: "replay-effects" }
phase("Review")
log({ z: 1, a: 2 })
return await agent("once", { harness: "codex" })
`);
  const firstHarness = new FakeHarness(async () => ({ output: { ok: true } }));
  const first = await runWorkflow({
    workflowPath: path.join(root, "workflow.js"),
    cwd: root,
    stateDir: path.join(root, "state"),
    harnesses: new Map([["codex", firstHarness]]),
  });
  const journalPath = path.join(first.runDir, "events.jsonl");
  const rows = (await readFile(journalPath, "utf8")).trimEnd().split("\n");
  assert.equal(JSON.parse(rows.at(-1) ?? "{}").type, "workflow.completed");
  await writeFile(journalPath, `${rows.slice(0, -1).join("\n")}\n`, "utf8");

  const replayHarness = new FakeHarness(async () => {
    throw new Error("completed agent must replay");
  });
  const replay = await runWorkflow({
    workflowPath: path.join(root, "workflow.js"),
    cwd: root,
    stateDir: path.join(root, "state"),
    resumeRunId: first.runId,
    harnesses: new Map([["codex", replayHarness]]),
  });
  assert.deepEqual(replay.result, { ok: true });
  assert.equal(replayHarness.calls.length, 0);
  const events = await RunJournal.open(path.join(root, "state"), first.runId).then((journal) =>
    journal.events(),
  );
  assert.equal(events.filter((event) => event.type === "phase").length, 1);
  assert.equal(events.filter((event) => event.type === "log").length, 1);
  assert.equal(events.filter((event) => event.type === "agent.started").length, 1);
  assert.equal(events.filter((event) => event.type === "agent.completed").length, 1);
  assert.equal(events.at(-1)?.type, "workflow.completed");
});

test("malformed ordering and truncated tails fail closed at the uncertainty boundary", async () => {
  const root = await workspace("truncated", `
export const meta = { name: "truncated" }
return "ok"
`);
  const prepared = await prepareWorkflowRun({
    workflowPath: path.join(root, "workflow.js"),
    cwd: root,
    stateDir: path.join(root, "state"),
  });
  const journal = await RunJournal.open(prepared.stateDir, prepared.runId);
  await journal.append({ type: "workflow.started", ownerKind: "foreground" });
  await journal.append({
    type: "agent.started",
    stepId: "root/agent:1",
    requestHash: "hash",
    harness: "codex",
  });
  await writeFile(path.join(prepared.runDir, "events.jsonl"), '{"type":"agent.completed"', {
    encoding: "utf8",
    flag: "a",
  });
  const summary = await inspectRun(prepared.stateDir, prepared.runId);
  assert.equal(summary.status, "uncertain");
  assert.equal(summary.uncertainty?.stepId, "root/agent:1");
  await assert.rejects(
    executePreparedRun({ stateDir: prepared.stateDir, runId: prepared.runId }),
    UncertainAgentRunError,
  );
});

test("safe truncated coordinator and terminal rows are repaired under the lease and replayed", async () => {
  for (const mode of ["log", "terminal"] as const) {
    const root = await workspace(`safe-truncated-${mode}`, `
export const meta = { name: ${JSON.stringify(`safe-truncated-${mode}`)} }
phase("safe")
log("coordinator")
return ${JSON.stringify(mode)}
`);
    const prepared = await prepareWorkflowRun({
      workflowPath: path.join(root, "workflow.js"),
      cwd: root,
      stateDir: path.join(root, "state"),
    });
    const journal = await RunJournal.open(prepared.stateDir, prepared.runId);
    await journal.append({ type: "workflow.started", ownerKind: "detached" });
    await journal.append({ type: "phase", stepId: "root/phase:1", name: "safe" });
    if (mode === "terminal") {
      await journal.append({ type: "log", stepId: "root/log:1", message: "coordinator" });
    }
    await writeFile(
      path.join(prepared.runDir, "events.jsonl"),
      mode === "log"
        ? '{"type":"log","at":"truncated"'
        : '{"type":"workflow.completed","at":"truncated"',
      { encoding: "utf8", flag: "a" },
    );

    const interrupted = await inspectRun(prepared.stateDir, prepared.runId);
    assert.equal(interrupted.status, "interrupted", mode);
    assert.match(interrupted.resume ?? "", /^jaeger --runtime embedded resume /, mode);
    const resumed = await runWorkflow({
      workflowPath: path.join(root, "workflow.js"),
      cwd: root,
      stateDir: prepared.stateDir,
      resumeRunId: prepared.runId,
    });
    assert.equal(resumed.result, mode);
    const repaired = await journal.readEvents();
    assert.equal(repaired.truncatedTail, false, mode);
    assert.equal(repaired.events.filter((event) => event.type === "phase").length, 1, mode);
    assert.equal(repaired.events.filter((event) => event.type === "log").length, 1, mode);
    assert.equal(repaired.events.at(-1)?.type, "workflow.completed", mode);
  }
});

test("a stop request cannot interleave with a multi-megabyte journal checkpoint", async () => {
  const root = await workspace("stop-journal-race", `
export const meta = { name: "stop-journal-race" }
return "ok"
`);
  const prepared = await prepareWorkflowRun({
    workflowPath: path.join(root, "workflow.js"),
    cwd: root,
    stateDir: path.join(root, "state"),
  });
  const ownerJournal = await RunJournal.open(prepared.stateDir, prepared.runId);
  const controllerJournal = await RunJournal.open(prepared.stateDir, prepared.runId);
  await ownerJournal.append({ type: "workflow.started", ownerKind: "detached" });
  await ownerJournal.append({
    type: "agent.started",
    stepId: "root/agent:1",
    requestHash: "large",
    harness: "codex",
  });
  await Promise.all([
    ownerJournal.append({
      type: "agent.completed",
      stepId: "root/agent:1",
      requestHash: "large",
      output: "x".repeat(4 * 1024 * 1024),
    }),
    controllerJournal.requestStop(process.pid, process.pid),
  ]);
  const read = await ownerJournal.readEvents();
  assert.equal(read.truncatedTail, false);
  assert.deepEqual(read.events.map((event) => event.type), [
    "workflow.started",
    "agent.started",
    "agent.completed",
  ]);
  assert.equal((await controllerJournal.stopRequest())?.requestedByPid, process.pid);
});

test("a live owner suppresses transient partial-append uncertainty until ownership ends", async () => {
  const root = await workspace("live-partial-tail", `
export const meta = { name: "live-partial-tail" }
return "ok"
`);
  const prepared = await prepareWorkflowRun({
    workflowPath: path.join(root, "workflow.js"),
    cwd: root,
    stateDir: path.join(root, "state"),
  });
  const journal = await RunJournal.open(prepared.stateDir, prepared.runId);
  const lease = await RunLease.acquire(prepared.runDir, prepared.runId, "foreground");
  await journal.append({ type: "workflow.started", ownerKind: "foreground" });
  await journal.append({
    type: "agent.started",
    stepId: "root/agent:1",
    requestHash: "hash",
    harness: "codex",
  });
  await writeFile(path.join(prepared.runDir, "events.jsonl"), '{"type":"agent.completed"', {
    encoding: "utf8",
    flag: "a",
  });
  try {
    const active = await inspectRun(prepared.stateDir, prepared.runId);
    assert.equal(active.status, "running");
    assert.equal(active.uncertainty, undefined);
  } finally {
    await lease.release();
  }
  const interrupted = await inspectRun(prepared.stateDir, prepared.runId);
  assert.equal(interrupted.status, "uncertain");
  assert.match(interrupted.uncertainty?.reason ?? "", /truncated final event/);
});

test("a dead owner with no in-flight agent is reported and resumed safely", async () => {
  const root = await workspace("safe-interruption", `
export const meta = { name: "safe-interruption" }
phase("Resume")
return await agent("resume", { harness: "codex" })
`);
  const prepared = await prepareWorkflowRun({
    workflowPath: path.join(root, "workflow.js"),
    cwd: root,
    stateDir: path.join(root, "state"),
  });
  const journal = await RunJournal.open(prepared.stateDir, prepared.runId);
  await journal.append({ type: "workflow.started", ownerKind: "detached" });
  await journal.append({ type: "workflow.stop_requested", ownerPid: 1, requestedByPid: 2 });
  await mkdir(path.join(prepared.runDir, "sessions", "session-0000000000000000"), {
    recursive: true,
  });

  const interrupted = await inspectRun(prepared.stateDir, prepared.runId);
  assert.equal(interrupted.status, "stopped");
  assert.match(interrupted.resume ?? "", /^jaeger --runtime embedded resume /);
  const harness = new FakeHarness(async () => {
    await delay(100);
    return { output: { resumed: true } };
  });
  const resumePromise = runWorkflow({
    workflowPath: path.join(root, "workflow.js"),
    cwd: root,
    stateDir: prepared.stateDir,
    resumeRunId: prepared.runId,
    harnesses: new Map([["codex", harness]]),
  });
  await delay(30);
  assert.equal((await inspectRun(prepared.stateDir, prepared.runId)).status, "running");
  const resumed = await resumePromise;
  assert.deepEqual(resumed.result, { resumed: true });
  const events = await RunJournal.open(prepared.stateDir, prepared.runId).then((opened) =>
    opened.events(),
  );
  assert.equal(events.filter((event) => event.type === "workflow.resumed").length, 1);
  assert.equal(events.at(-1)?.type, "workflow.completed");
});

test("an explicit resume starts a new attempt after a pre-start stop request", async () => {
  const root = await workspace("prestart-stop-resume", `
export const meta = { name: "prestart-stop-resume" }
return "resumed"
`);
  const prepared = await prepareWorkflowRun({
    workflowPath: path.join(root, "workflow.js"),
    cwd: root,
    stateDir: path.join(root, "state"),
  });
  const journal = await RunJournal.open(prepared.stateDir, prepared.runId);
  const stoppedAttempt = await RunLease.acquire(
    prepared.runDir,
    prepared.runId,
    "detached",
  );
  await journal.requestStop(
    process.pid,
    stoppedAttempt.owner.pid,
    stoppedAttempt.owner.token,
  );
  await stoppedAttempt.release();

  const stopped = await inspectRun(prepared.stateDir, prepared.runId);
  assert.equal(stopped.status, "stopped");
  assert.match(stopped.resume ?? "", /^jaeger --runtime embedded resume /);
  await assert.rejects(
    executePreparedRun({ stateDir: prepared.stateDir, runId: prepared.runId }),
    RunStoppedError,
  );

  const resumed = await runWorkflow({
    workflowPath: path.join(root, "workflow.js"),
    cwd: root,
    stateDir: prepared.stateDir,
    resumeRunId: prepared.runId,
  });
  assert.equal(resumed.result, "resumed");
  assert.equal((await inspectRun(prepared.stateDir, prepared.runId)).status, "completed");
  assert.equal(await journal.stopRequest(), undefined);
});

test("a graceful stop at a coordinator primitive is resumable and not a terminal failure", async () => {
  const root = await workspace("graceful-safe-stop", `
export const meta = { name: "graceful-safe-stop" }
phase("checkpoint")
log("after-checkpoint")
return "completed-after-resume"
`);
  const stateDir = path.join(root, "state");
  const controller = new AbortController();
  const reporter: RuntimeReporter = {
    phase() {
      controller.abort(new RunStoppedError("test requested a graceful stop"));
    },
    log() {},
    agentStarted() {},
    agentCompleted() {},
  };
  await assert.rejects(
    runWorkflow({
      workflowPath: path.join(root, "workflow.js"),
      cwd: root,
      stateDir,
      reporter,
      signal: controller.signal,
    }),
    RunStoppedError,
  );
  const [runId] = await import("node:fs/promises").then(async ({ readdir }) =>
    (await readdir(stateDir)).filter((entry) => /^\d{14}-[a-f0-9]{10}$/.test(entry)),
  );
  assert.ok(runId);
  const interrupted = await inspectRun(stateDir, runId);
  assert.equal(interrupted.status, "interrupted");
  assert.match(interrupted.resume ?? "", /^jaeger --runtime embedded resume /);
  const journal = await RunJournal.open(stateDir, runId);
  assert.equal((await journal.events()).at(-1)?.type, "workflow.interrupted");

  const resumed = await runWorkflow({
    workflowPath: path.join(root, "workflow.js"),
    cwd: root,
    stateDir,
    resumeRunId: runId,
  });
  assert.equal(resumed.result, "completed-after-resume");
  assert.equal((await inspectRun(stateDir, runId)).status, "completed");
});

test("resume pins source, inputs, and concurrency policy", async () => {
  const root = await workspace("pinned", `
export const meta = { name: "pinned" }
return inputs
`);
  const first = await runWorkflow({
    workflowPath: path.join(root, "workflow.js"),
    cwd: root,
    inputs: { value: 1 },
    maxConcurrency: 3,
    stateDir: path.join(root, "state"),
  });
  await assert.rejects(
    runWorkflow({
      workflowPath: path.join(root, "workflow.js"),
      cwd: root,
      inputs: { value: 2 },
      stateDir: path.join(root, "state"),
      resumeRunId: first.runId,
    }),
    WorkflowChangedError,
  );
  await assert.rejects(
    runWorkflow({
      workflowPath: path.join(root, "workflow.js"),
      cwd: root,
      maxConcurrency: 4,
      stateDir: path.join(root, "state"),
      resumeRunId: first.runId,
    }),
    WorkflowChangedError,
  );
  await writeFile(
    path.join(root, "workflow.js"),
    'export const meta = { name: "changed" }\nreturn inputs\n',
  );
  await assert.rejects(
    runWorkflow({
      workflowPath: path.join(root, "workflow.js"),
      cwd: root,
      stateDir: path.join(root, "state"),
      resumeRunId: first.runId,
    }),
    WorkflowChangedError,
  );
});

test("execution verifies the pinned source snapshot against the immutable record", async () => {
  const root = await workspace("snapshot-integrity", `
export const meta = { name: "snapshot-integrity" }
return "original"
`);
  const prepared = await prepareWorkflowRun({
    workflowPath: path.join(root, "workflow.js"),
    cwd: root,
    stateDir: path.join(root, "state"),
  });
  await writeFile(
    path.join(prepared.runDir, "workflow.source"),
    'export const meta = { name: "tampered" }\nreturn "tampered"\n',
    "utf8",
  );
  await assert.rejects(
    executePreparedRun({ stateDir: prepared.stateDir, runId: prepared.runId }),
    /Pinned workflow source no longer matches/,
  );
  const events = await RunJournal.open(prepared.stateDir, prepared.runId).then((journal) =>
    journal.events(),
  );
  assert.equal(events.length, 0, "integrity failure must precede workflow execution");
});

test("run records cannot claim an unverified isolated runtime boundary", async () => {
  assert.throws(() => {
    (hostRuntimeBoundary.descriptor as { isolated: boolean }).isolated = true;
  }, TypeError);
  assert.throws(() => {
    (hostRuntimeBoundary as unknown as { descriptor: unknown }).descriptor = {
      kind: "pretend-container",
      isolated: true,
      description: "not verified",
    };
  }, TypeError);
  assert.deepEqual(hostRuntimeBoundary.descriptor, {
    kind: "host",
    isolated: false,
    description:
      "Runs with full authority on the current host; wrap the Jaeger process in a constrained workspace, sandbox, container, or VM when isolation is required.",
  });
  const root = await workspace("boundary-attestation", `
export const meta = { name: "boundary-attestation" }
return "must-not-run"
`);
  const stateDir = path.join(root, "state");
  const prepared = await prepareWorkflowRun({
    workflowPath: path.join(root, "workflow.js"),
    cwd: root,
    stateDir,
    // JavaScript callers may supply extra object fields; preparation must not
    // turn an arbitrary descriptor into an isolation claim.
    boundary: {
      kind: "pretend-container",
      isolated: true,
      description: "not verified",
    },
  } as Parameters<typeof prepareWorkflowRun>[0]);
  assert.equal((await inspectRun(stateDir, prepared.runId)).boundary.isolated, false);

  const runRecordPath = path.join(prepared.runDir, "run.json");
  const record = JSON.parse(await readFile(runRecordPath, "utf8")) as Record<string, unknown>;
  record.boundary = {
    kind: "pretend-container",
    isolated: true,
    description: "not verified",
  };
  await writeFile(runRecordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await assert.rejects(
    executePreparedRun({ stateDir, runId: prepared.runId }),
    /claims an unverified runtime boundary/,
  );
  assert.equal(
    (await readFile(path.join(prepared.runDir, "events.jsonl"), "utf8")).length,
    0,
  );
});

test("execution rejects a replacement directory at the pinned workspace path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-workspace-identity-"));
  const workspaceDir = path.join(root, "workspace");
  const movedWorkspace = path.join(root, "original-workspace");
  const stateDir = path.join(root, "state");
  await mkdir(workspaceDir);
  const workflowPath = path.join(workspaceDir, "workflow.js");
  await writeFile(
    workflowPath,
    `export const meta = { name: "workspace identity" }\nreturn "must not run"\n`,
    "utf8",
  );
  const prepared = await prepareWorkflowRun({ workflowPath, cwd: workspaceDir, stateDir });
  await rename(workspaceDir, movedWorkspace);
  await mkdir(workspaceDir);
  await assert.rejects(
    executePreparedRun({ stateDir, runId: prepared.runId }),
    /workspace identity changed/,
  );
  assert.equal(
    (await readFile(path.join(prepared.runDir, "events.jsonl"), "utf8")).length,
    0,
  );
});

test("legacy version 2 run records continue with built-in harness definitions", async () => {
  const root = await workspace("legacy-run-record", `
export const meta = { name: "legacy-run-record" }
return "ok"
`);
  const stateDir = path.join(root, "state");
  const prepared = await prepareWorkflowRun({
    workflowPath: path.join(root, "workflow.js"),
    cwd: root,
    stateDir,
  });
  const runRecordPath = path.join(prepared.runDir, "run.json");
  const record = JSON.parse(await readFile(runRecordPath, "utf8")) as Record<string, unknown>;
  record.version = 2;
  delete record.harnesses;
  await writeFile(runRecordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  const result = await executePreparedRun({ stateDir, runId: prepared.runId });
  assert.equal(result.result, "ok");
});

test("run journal rejects traversal-like run ids", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "jaeger-run-id-"));
  await assert.rejects(RunJournal.open(stateDir, "."), /Invalid Jaeger run id/);
  await assert.rejects(RunJournal.open(stateDir, ".."), /Invalid Jaeger run id/);
});

async function workspace(name: string, source: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `jaeger-${name}-`));
  await writeFile(path.join(root, "workflow.js"), source, "utf8");
  return root;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForChildText(
  child: ReturnType<typeof spawn>,
  expected: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes(expected)) resolve();
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (!stdout.includes(expected)) {
        reject(
          new Error(
            `lease child exited before readiness (code ${String(code)}, signal ${String(signal)}): ${stderr}`,
          ),
        );
      }
    });
  });
}
