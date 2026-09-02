import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { describeLocalWorkspace } from "../src/admission.js";
import { BackendRpcError } from "../src/backend-protocol.js";
import { LocalRuntimeService } from "../src/local-runtime-service.js";
import { RunJournal } from "../src/journal.js";
import { stopRun, waitForRun } from "../src/lifecycle.js";
import { ensurePrivateDirectory } from "../src/paths.js";
import { inspectRun } from "../src/run-state.js";
import { ServiceRuntimeClient } from "../src/runtime-client.js";
import { prepareWorkflowRun, publishPreparedWorkflowRun } from "../src/runtime.js";
import {
  claimSubmission,
  reconcileClaimedRun,
  submissionClaimFor,
} from "../src/submission-index.js";
import type {
  SessionTurnSummary,
  WorkflowRunSummary,
  WorkflowSessionSummary,
} from "../src/types.js";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.js");

test(
  "the persistent backend owns runs across clients and service restarts",
  { skip: process.platform !== "linux" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-backend-service-"));
    const stateDir = path.join(root, "state");
    const socketPath = path.join(root, "runtime", "backend.sock");
    const otherCwd = path.join(root, "other-client");
    const workspaceDir = path.join(root, "workspace");
    const binDir = path.join(root, "bin");
    const workflowPath = path.join(root, "workflow.js");
    await Promise.all([mkdir(otherCwd), mkdir(workspaceDir), mkdir(binDir)]);
    await writeFile(
      workflowPath,
      `
export const meta = { name: "persistent backend fixture" }
phase("Run")
return await agent("SLOW", {
  harness: "codex",
  label: "backend",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["answer"],
    properties: { answer: { type: "string" } },
  },
})
`,
      "utf8",
    );
    await installHarnessCommands(binDir, fakeCodexSource());

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAEGER_SOCKET: socketPath,
      JAEGER_STATE_DIR: stateDir,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    };
    delete env.JAEGER_RUNTIME;
    let backend: ChildProcess | undefined;
    let runId: string | undefined;
    t.after(async () => {
      if (backend) await stopBackend(backend);
      if (runId) await stopRun(stateDir, runId).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    });

    backend = await startBackend(socketPath, stateDir, env);
    const doctor = parseJson<{
      ready: boolean;
      backend: { kind: string; stateDir: string };
    }>((await cli(["doctor"], env, root)).stdout);
    assert.equal(doctor.ready, true);
    assert.equal(doctor.backend.kind, "local-service");
    assert.equal(doctor.backend.stateDir, stateDir);

    const launched = parseJson<WorkflowRunSummary & { schemaVersion: number }>(
      (
        await cli(
          ["run", workflowPath, "--cwd", workspaceDir, "--detach"],
          env,
          root,
        )
      ).stdout,
    );
    runId = launched.runId;
    assert.equal(launched.schemaVersion, 1);
    assert.ok(["running", "completed"].includes(launched.status));
    assert.doesNotMatch(launched.inspect, /--state-dir/);
    await waitForAgentStart(runId, env, otherCwd);

    const record = JSON.parse(
      await readFile(path.join(stateDir, runId, "run.json"), "utf8"),
    ) as {
      version: number;
      submissionId: string;
      submissionHash: string;
      runtime: { backend: string; abi: number };
      workspace: { root: string; identity: string };
    };
    assert.equal(record.version, 4);
    assert.equal(record.runtime.backend, "local-service");
    assert.equal(record.runtime.abi, 1);
    assert.match(record.submissionHash, /^[a-f0-9]{64}$/);
    assert.equal(record.workspace.root, workspaceDir);
    assert.match(record.workspace.identity, /^[a-f0-9]{64}$/);

    const duplicate = await new ServiceRuntimeClient(socketPath).call("run.submit", {
      submissionId: record.submissionId,
      workflowPath,
      workflowSource: await readFile(workflowPath, "utf8"),
      cwd: workspaceDir,
      inputs: {},
    });
    assert.equal(runIdFrom(duplicate), runId, "a retried submission must return the same run");
    await assert.rejects(
      new ServiceRuntimeClient(socketPath).call("run.submit", {
        submissionId: record.submissionId,
        workflowPath,
        workflowSource: `${await readFile(workflowPath, "utf8")}\n`,
        cwd: workspaceDir,
        inputs: {},
      }),
      (error: unknown) =>
        error instanceof BackendRpcError && error.code === "idempotency_conflict",
    );

    await stopBackend(backend);
    backend = undefined;
    assert.equal(
      (await inspectRun(stateDir, runId)).status,
      "running",
      "the transient worker must outlive a control-plane restart",
    );

    backend = await startBackend(socketPath, stateDir, env);
    const fromSecondClient = parseJson<WorkflowRunSummary>(
      (await cli(["inspect", runId, "--summary", "--json"], env, otherCwd)).stdout,
    );
    assert.ok(["running", "completed"].includes(fromSecondClient.status));
    const completed = parseJson<WorkflowRunSummary>(
      (await cli(["wait", runId], env, otherCwd)).stdout,
    );
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.result, { answer: "ok" });
    await rename(workflowPath, `${workflowPath}.moved`);
    const retriedWithoutSource = parseJson<WorkflowRunSummary>(
      (
        await cli(
          [
            "run",
            workflowPath,
            "--cwd",
            workspaceDir,
            "--detach",
            "--submission-id",
            record.submissionId,
          ],
          env,
          otherCwd,
        )
      ).stdout,
    );
    assert.equal(
      retriedWithoutSource.runId,
      runId,
      "an explicit accepted submission must resolve even after its authored source moves",
    );

    const [session] = parseJson<WorkflowSessionSummary[]>(
      (await cli(["session", "list", runId, "--json"], env, otherCwd)).stdout,
    );
    assert.ok(session);
    const turnId = "turn-service-restart-0001";
    const acceptedTurn = parseJson<SessionTurnSummary>(
      (
        await cli(
          [
            "session",
            "resume",
            runId,
            session.id,
            "--message",
            "continue through restart",
            "--request-id",
            turnId,
            "--detach",
          ],
          env,
          otherCwd,
        )
      ).stdout,
    );
    assert.equal(acceptedTurn.turnId, turnId);
    assert.ok(["queued", "running", "completed"].includes(acceptedTurn.status));
    const retriedWhileRunning = parseJson<SessionTurnSummary>(
      (
        await cli(
          [
            "session",
            "resume",
            runId,
            session.id,
            "--message",
            "continue through restart",
            "--request-id",
            turnId,
            "--detach",
          ],
          env,
          otherCwd,
        )
      ).stdout,
    );
    assert.equal(retriedWhileRunning.turnId, turnId);
    assert.ok(["running", "completed"].includes(retriedWhileRunning.status));
    await stopBackend(backend);
    backend = undefined;
    backend = await startBackend(socketPath, stateDir, env);
    const completedTurn = parseJson<SessionTurnSummary>(
      (
        await cli(
          ["session", "turn", "wait", runId, turnId, "--json"],
          env,
          otherCwd,
        )
      ).stdout,
    );
    assert.equal(completedTurn.status, "completed");
    assert.equal(completedTurn.turn, 2);
    const retriedAfterCompletion = parseJson<SessionTurnSummary>(
      (
        await cli(
          [
            "session",
            "resume",
            runId,
            session.id,
            "--message",
            "continue through restart",
            "--request-id",
            turnId,
            "--detach",
          ],
          env,
          otherCwd,
        )
      ).stdout,
    );
    assert.equal(retriedAfterCompletion.status, "completed");
    assert.equal(retriedAfterCompletion.turnId, turnId);

    const laterTurnId = "turn-service-restart-0002";
    const laterTurn = parseJson<SessionTurnSummary>(
      (
        await cli(
          [
            "session",
            "resume",
            runId,
            session.id,
            "--message",
            "one more continuation",
            "--request-id",
            laterTurnId,
            "--detach",
          ],
          env,
          otherCwd,
        )
      ).stdout,
    );
    assert.equal(laterTurn.turn, 3);
    const completedLaterTurn = parseJson<SessionTurnSummary>(
      (
        await cli(
          ["session", "turn", "wait", runId, laterTurnId, "--json"],
          env,
          otherCwd,
        )
      ).stdout,
    );
    assert.equal(completedLaterTurn.status, "completed");
    const copiedInspect = parseJson<SessionTurnSummary>(
      (
        await cli(
          ["session", "turn", "inspect", runId, turnId, "--json"],
          env,
          root,
        )
      ).stdout,
    );
    assert.equal(copiedInspect.status, "completed");
    assert.equal(copiedInspect.turn, 2, "historical inspection must not re-finalize turn 2");

    const oldRequest = parseJson<{
      requestHash: string;
      createdAt: string;
    }>(
      await readFile(
        path.join(
          stateDir,
          runId,
          "session-turns",
          createHash("sha256").update(`session-turn\0${turnId}`).digest("hex"),
          "request.json",
        ),
        "utf8",
      ),
    );
    await writeFile(
      path.join(stateDir, runId, "sessions", session.id, "active-turn.json"),
      `${JSON.stringify({
        version: 1,
        turnId,
        requestHash: oldRequest.requestHash,
        createdAt: oldRequest.createdAt,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const contenders = [
      { turnId: "turn-concurrent-next-0001", message: "left contender" },
      { turnId: "turn-concurrent-next-0002", message: "right contender" },
    ] as const;
    const concurrent = await Promise.allSettled(
      contenders.map(
        async (contender) =>
          await new ServiceRuntimeClient(socketPath).call("session.resume", {
            runId,
            selector: session.id,
            message: contender.message,
            turnId: contender.turnId,
            detach: true,
          }),
      ),
    );
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
    const rejectedTurn = concurrent.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    assert.ok(rejectedTurn);
    assert.ok(rejectedTurn.reason instanceof BackendRpcError);
    assert.equal((rejectedTurn.reason as BackendRpcError).code, "session_busy");
    const rejectedIndex = concurrent.findIndex((result) => result.status === "rejected");
    const rejectedContender = contenders[rejectedIndex];
    assert.ok(rejectedContender);
    const rejectedSummary = parseJson<SessionTurnSummary>(
      (
        await cli(
          ["session", "turn", "inspect", runId, rejectedContender.turnId, "--json"],
          env,
          otherCwd,
        )
      ).stdout,
    );
    assert.equal(rejectedSummary.status, "rejected");
    assert.match(rejectedSummary.error ?? "", /not accepted/i);
    assert.equal(rejectedSummary.wait, undefined, "a rejected turn must not remain queued");
    const winnerIndex = concurrent.findIndex((result) => result.status === "fulfilled");
    const winner = contenders[winnerIndex];
    assert.ok(winner);
    const completedWinner = parseJson<SessionTurnSummary>(
      (
        await cli(
          ["session", "turn", "wait", runId, winner.turnId, "--json"],
          env,
          otherCwd,
        )
      ).stdout,
    );
    assert.equal(completedWinner.status, "completed");
    const retriedRejected = (await new ServiceRuntimeClient(socketPath).call("session.resume", {
      runId,
      selector: session.id,
      message: rejectedContender.message,
      turnId: rejectedContender.turnId,
      detach: true,
    })) as unknown as SessionTurnSummary;
    assert.equal(retriedRejected.status, "rejected");

    const runs = parseJson<Array<WorkflowRunSummary>>(
      (await cli(["list", "--json"], env, otherCwd)).stdout,
    );
    assert.equal(runs.filter((run) => run.runId === runId).length, 1);

    await rm(workspaceDir, { recursive: true });
    const terminalRetry = await new ServiceRuntimeClient(socketPath).call("run.submit", {
      submissionId: record.submissionId,
      workflowPath,
      workflowSource: await readFile(`${workflowPath}.moved`, "utf8"),
      cwd: workspaceDir,
      inputs: {},
    });
    assert.equal(
      runIdFrom(terminalRetry),
      runId,
      "readback of an accepted terminal submission must not require its old workspace",
    );
  },
);

test("an unavailable configured backend fails closed without embedded fallback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-backend-unavailable-"));
  const socketPath = path.join(root, "missing", "backend.sock");
  const env: NodeJS.ProcessEnv = { ...process.env, JAEGER_SOCKET: socketPath };
  delete env.JAEGER_RUNTIME;
  try {
    await assert.rejects(
      cli(["doctor"], env, root),
      /Jaeger backend is unavailable.*jaeger backend install/,
    );
    await assert.rejects(access(path.join(root, ".jaeger")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "durable submission claims arbitrate concurrent backend instances",
  { skip: process.platform !== "linux" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-submission-index-"));
    const stateDir = path.join(root, "state");
    const binDir = path.join(root, "bin");
    const workflowPath = path.join(root, "workflow.js");
    const source = `export const meta = { name: "atomic claim" }\nreturn { winner: true }\n`;
    await mkdir(binDir);
    await installHarnessCommands(binDir);
    await writeFile(workflowPath, source, "utf8");
    t.after(async () => await rm(root, { recursive: true, force: true }));
    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    };
    const first = new LocalRuntimeService({
      stateDir,
      entrypoint: cliPath,
      env,
      backendKind: "local-service",
    });
    const second = new LocalRuntimeService({
      stateDir,
      entrypoint: cliPath,
      env,
      backendKind: "local-service",
    });
    const params = {
      submissionId: "submission-concurrent-same",
      workflowPath,
      workflowSource: source,
      cwd: root,
      inputs: {},
    } as const;
    const [left, right] = await Promise.all([
      first.dispatch("run.submit", params),
      second.dispatch("run.submit", params),
    ]);
    assert.equal(runIdFrom(left), runIdFrom(right));
    const runId = runIdFrom(left);
    assert.ok(runId);
    assert.equal(
      (await readdir(stateDir)).filter((entry) => /^\d{14}-[a-f0-9]{10}$/.test(entry)).length,
      1,
    );
    assert.equal(
      runIdFrom(
        await first.dispatch("run.lookup", {
          submissionId: "submission-concurrent-same",
        }),
      ),
      runId,
    );
    await waitForRun(stateDir, runId);

    const conflictId = "submission-concurrent-conflict";
    const conflicting = await Promise.allSettled([
      first.dispatch("run.submit", {
        ...params,
        submissionId: conflictId,
        workflowSource: `${source}\nlog("left")\n`,
      }),
      second.dispatch("run.submit", {
        ...params,
        submissionId: conflictId,
        workflowSource: `${source}\nlog("right")\n`,
      }),
    ]);
    assert.equal(conflicting.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = conflicting.find((result) => result.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.ok(rejected.reason instanceof BackendRpcError);
    assert.equal((rejected.reason as BackendRpcError).code, "idempotency_conflict");
    const conflictWinner = conflicting.find((result) => result.status === "fulfilled");
    if (conflictWinner?.status === "fulfilled") {
      const winnerRunId = runIdFrom(conflictWinner.value);
      if (winnerRunId) await waitForRun(stateDir, winnerRunId);
    }
    await assert.rejects(
      first.dispatch("run.list", { stateDir: path.join(root, "other-state") }),
      (error: unknown) =>
        error instanceof BackendRpcError && error.code === "invalid_request",
    );
  },
);

test("submission admission rejects a workspace rebound after request normalization", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-workspace-binding-"));
  const stateDir = path.join(root, "state");
  const workflowPath = path.join(root, "workflow.js");
  const workspace = path.join(root, "workspace");
  const displaced = path.join(root, "workspace-old");
  try {
    await mkdir(workspace);
    await writeFile(
      workflowPath,
      `export const meta = { name: "workspace binding" }\nreturn true\n`,
      "utf8",
    );
    const descriptor = await describeLocalWorkspace(workspace);
    await rename(workspace, displaced);
    await mkdir(workspace);

    await assert.rejects(
      prepareWorkflowRun({
        workflowPath,
        cwd: workspace,
        stateDir,
        backend: "local-service",
        workspace: descriptor,
      }),
      /workspace identity changed while admitting/,
    );
    await assert.rejects(access(stateDir), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("claimed stages verify source and empty journal integrity before publication", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-staged-integrity-"));
  const stateDir = path.join(root, "state");
  const workflowPath = path.join(root, "workflow.js");
  const source = `export const meta = { name: "staged integrity" }\nreturn true\n`;
  await writeFile(workflowPath, source, "utf8");
  try {
    const createClaimedStage = async (submissionId: string, hashByte: string) => {
      const prepared = await prepareWorkflowRun({
        workflowPath,
        workflowSource: source,
        cwd: root,
        stateDir,
        backend: "local-service",
        submissionId,
        submissionHash: hashByte.repeat(64),
        stageOnly: true,
      });
      assert.ok(prepared.staged);
      const claim = submissionClaimFor(
        prepared.staged,
        submissionId,
        hashByte.repeat(64),
        "local-service",
      );
      await claimSubmission(stateDir, claim);
      return {
        runId: prepared.runId,
        staged: prepared.staged,
        claim,
        publish: async () => await publishPreparedWorkflowRun(prepared),
      };
    };

    const sourceMutation = await createClaimedStage("submission-source-corrupt", "a");
    await writeFile(
      path.join(sourceMutation.staged.stagingDir, "workflow.source"),
      `${source}\n// changed after staging\n`,
      "utf8",
    );
    await assert.rejects(
      sourceMutation.publish(),
      /Staged workflow source does not match/,
    );

    const eventMutation = await createClaimedStage("submission-events-corrupt", "b");
    await writeFile(
      path.join(eventMutation.staged.stagingDir, "events.jsonl"),
      `${JSON.stringify({ type: "workflow.started", at: new Date().toISOString() })}\n`,
      "utf8",
    );
    await assert.rejects(
      reconcileClaimedRun(stateDir, eventMutation.claim),
      /already contains journal events/,
    );

    const renameWinner = await createClaimedStage("submission-rename-winner", "c");
    const journals = await Promise.all([
      reconcileClaimedRun(stateDir, renameWinner.claim),
      reconcileClaimedRun(stateDir, renameWinner.claim),
      reconcileClaimedRun(stateDir, renameWinner.claim),
    ]);
    assert.deepEqual(
      journals.map((journal) => journal.record.runId),
      [renameWinner.runId, renameWinner.runId, renameWinner.runId],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backend recovery refuses a run whose durable claim did not verify", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-recovery-claim-gate-"));
  const stateDir = path.join(root, "state");
  const workflowPath = path.join(root, "workflow.js");
  const source = `export const meta = { name: "claim gate" }\nreturn true\n`;
  const submissionId = "submission-recovery-claim-gate";
  const submissionHash = "d".repeat(64);
  await writeFile(workflowPath, source, "utf8");
  let runId: string | undefined;
  try {
    const prepared = await prepareWorkflowRun({
      workflowPath,
      workflowSource: source,
      cwd: root,
      stateDir,
      backend: "local-service",
      submissionId,
      submissionHash,
      stageOnly: true,
    });
    assert.ok(prepared.staged);
    await claimSubmission(
      stateDir,
      submissionClaimFor(prepared.staged, submissionId, submissionHash, "local-service"),
    );
    const published = await publishPreparedWorkflowRun(prepared);
    runId = published.runId;
    const recordPath = path.join(stateDir, runId, "run.json");
    await writeFile(recordPath, `${await readFile(recordPath, "utf8")}\n`, "utf8");

    const service = new LocalRuntimeService({
      stateDir,
      entrypoint: cliPath,
      backendKind: "local-service",
    });
    const recovery = await service.recover();
    assert.equal(recovery.considered, 1);
    assert.equal(recovery.eligible, 0);
    assert.deepEqual(recovery.relaunched, []);
    assert.ok(
      recovery.errors.some(({ error }) => error.includes("run record hash does not match")),
    );
    assert.ok(
      recovery.errors.some(({ error }) => error.includes("verified durable submission claim")),
    );
    assert.equal((await inspectRun(stateDir, runId)).status, "pending");
  } finally {
    if (runId) await stopRun(stateDir, runId).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "submission request identity survives backend configuration changes",
  { skip: process.platform !== "linux" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-request-identity-"));
    const stateDir = path.join(root, "state");
    const binDir = path.join(root, "bin");
    const workflowPath = path.join(root, "workflow.js");
    const firstConfig = path.join(root, "harnesses-first.json");
    const secondConfig = path.join(root, "harnesses-second.json");
    const source = `export const meta = { name: "stable request" }\nreturn true\n`;
    await mkdir(binDir);
    await installHarnessCommands(binDir);
    await Promise.all([
      writeFile(workflowPath, source, "utf8"),
      writeFile(
        firstConfig,
        `${JSON.stringify({
          version: 1,
          harnesses: {
            alpha: { driver: "claude-agent-sdk", command: process.execPath },
          },
        })}\n`,
        "utf8",
      ),
      writeFile(
        secondConfig,
        `${JSON.stringify({
          version: 1,
          harnesses: {
            beta: { driver: "claude-agent-sdk", command: process.execPath },
          },
        })}\n`,
        "utf8",
      ),
    ]);
    let runId: string | undefined;
    t.after(async () => {
      if (runId) await stopRun(stateDir, runId).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    });
    const first = new LocalRuntimeService({
      stateDir,
      entrypoint: cliPath,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      harnessConfigPath: firstConfig,
      backendKind: "local-service",
    });
    const second = new LocalRuntimeService({
      stateDir,
      entrypoint: cliPath,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      harnessConfigPath: secondConfig,
      backendKind: "local-service",
    });
    const params = {
      submissionId: "submission-stable-across-upgrade",
      workflowPath,
      workflowSource: source,
      cwd: root,
      inputs: {},
    } as const;

    const accepted = await first.dispatch("run.submit", params);
    runId = runIdFrom(accepted);
    assert.ok(runId);
    const retried = await second.dispatch("run.submit", params);
    assert.equal(runIdFrom(retried), runId);
    const record = JSON.parse(
      await readFile(path.join(stateDir, runId, "run.json"), "utf8"),
    ) as { harnesses: Array<{ name: string }> };
    assert.ok(record.harnesses.some(({ name }) => name === "alpha"));
    assert.ok(!record.harnesses.some(({ name }) => name === "beta"));
    assert.equal((await waitForRun(stateDir, runId)).status, "completed");
  },
);

test(
  "backend recovery relaunches only safe service-owned runs",
  { skip: process.platform !== "linux" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-backend-recovery-"));
    const stateDir = path.join(root, "state");
    const workflowPath = path.join(root, "workflow.js");
    await writeFile(
      workflowPath,
      `export const meta = { name: "recovery" }\nreturn { recovered: true }\n`,
      "utf8",
    );
    const serviceCandidate = await prepareWorkflowRun({
      workflowPath,
      cwd: root,
      stateDir,
      backend: "local-service",
      submissionId: "submission-safe-recovery",
      submissionHash: "e".repeat(64),
      stageOnly: true,
    });
    assert.ok(serviceCandidate.staged);
    await claimSubmission(
      stateDir,
      submissionClaimFor(
        serviceCandidate.staged,
        "submission-safe-recovery",
        "e".repeat(64),
        "local-service",
      ),
    );
    const serviceRun = await publishPreparedWorkflowRun(serviceCandidate);
    const embeddedRun = await prepareWorkflowRun({
      workflowPath,
      cwd: root,
      stateDir,
      backend: "embedded",
    });
    const unclaimedRun = await prepareWorkflowRun({
      workflowPath,
      cwd: root,
      stateDir,
      backend: "local-service",
    });
    t.after(async () => {
      await stopRun(stateDir, serviceRun.runId).catch(() => undefined);
      await stopRun(stateDir, unclaimedRun.runId).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    });

    const service = new LocalRuntimeService({
      stateDir,
      entrypoint: cliPath,
      backendKind: "local-service",
    });
    const embeddedService = new LocalRuntimeService({
      stateDir,
      entrypoint: cliPath,
      backendKind: "embedded",
    });
    await assert.rejects(
      service.dispatch("run.resume", { runId: embeddedRun.runId }),
      /owned by the embedded backend/,
    );
    await assert.rejects(
      embeddedService.dispatch("run.resume", { runId: serviceRun.runId }),
      /owned by the local-service backend/,
    );
    const recovery = await service.recover();
    assert.equal(recovery.considered, 3);
    assert.equal(recovery.eligible, 1);
    assert.deepEqual(recovery.relaunched, [serviceRun.runId]);
    assert.ok(
      recovery.errors.some(
        ({ runId, error }) =>
          runId === unclaimedRun.runId && error.includes("verified durable submission claim"),
      ),
    );
    assert.equal((await waitForRun(stateDir, serviceRun.runId)).status, "completed");
    assert.equal((await inspectRun(stateDir, embeddedRun.runId)).status, "pending");
    assert.equal((await inspectRun(stateDir, unclaimedRun.runId)).status, "pending");
  },
);

test(
  "explicit backend resume clears a stop recorded before the first attempt",
  { skip: process.platform !== "linux" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-backend-prestart-resume-"));
    const stateDir = path.join(root, "state");
    const workflowPath = path.join(root, "workflow.js");
    await writeFile(
      workflowPath,
      `export const meta = { name: "prestart resume" }\nreturn "resumed"\n`,
      "utf8",
    );
    const prepared = await prepareWorkflowRun({
      workflowPath,
      cwd: root,
      stateDir,
      backend: "local-service",
    });
    const journal = await RunJournal.open(stateDir, prepared.runId);
    await journal.requestStop(process.pid, 0);
    t.after(async () => {
      await stopRun(stateDir, prepared.runId).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    });

    const service = new LocalRuntimeService({
      stateDir,
      entrypoint: cliPath,
      backendKind: "local-service",
    });
    const resumed = await service.dispatch("run.resume", { runId: prepared.runId });
    assert.ok(["running", "completed"].includes(statusFrom(resumed) ?? ""));
    assert.equal((await waitForRun(stateDir, prepared.runId)).status, "completed");
  },
);

test("private runtime directories are refused without mutating their permissions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-private-directory-"));
  const shared = path.join(root, "shared");
  try {
    await mkdir(shared, { mode: 0o755 });
    await chmod(shared, 0o755);
    await assert.rejects(
      ensurePrivateDirectory(shared, "test runtime directory"),
      /must not be accessible by group or other users/,
    );
    assert.equal((await stat(shared)).mode & 0o777, 0o755);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function startBackend(
  socketPath: string,
  stateDir: string,
  env: NodeJS.ProcessEnv,
): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [cliPath, "__backend", "--socket", socketPath, "--state-dir", stateDir],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const client = new ServiceRuntimeClient(socketPath);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Backend exited before readiness (${child.exitCode}): ${stderr}`);
    }
    try {
      await client.call("ping");
      return child;
    } catch {
      await delay(25);
    }
  }
  child.kill("SIGTERM");
  throw new Error(`Backend did not become ready: ${stderr}`);
}

async function stopBackend(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function waitForAgentStart(
  runId: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const detail = parseJson<{ events: Array<{ type?: string }> }>(
      (await cli(["inspect", runId, "--events"], env, cwd)).stdout,
    );
    if (detail.events.some((event) => event.type === "agent.started")) return;
    await delay(25);
  }
  assert.fail("service-owned agent did not start");
}

async function cli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync(process.execPath, [cliPath, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function runIdFrom(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return typeof (value as { runId?: unknown }).runId === "string"
    ? (value as { runId: string }).runId
    : undefined;
}

function statusFrom(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return typeof (value as { status?: unknown }).status === "string"
    ? (value as { status: string }).status
    : undefined;
}

async function installHarnessCommands(
  binDir: string,
  source = "#!/bin/sh\nexit 0\n",
): Promise<void> {
  await Promise.all(
    ["codex", "claude", "pi"].map(async (name) => {
      const commandPath = path.join(binDir, name);
      await writeFile(commandPath, source, "utf8");
      await chmod(commandPath, 0o755);
    }),
  );
}

function fakeCodexSource(): string {
  return `#!/usr/bin/env node
const readline = require("node:readline")
if (process.argv.includes("--version") || process.argv.includes("--help")) {
  process.stdout.write("codex fixture 1.0\\n")
  process.exit(0)
}
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n")
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line)
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "backend-fixture" } })
    return
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: "backend-session" } } })
    return
  }
  if (message.method !== "turn/start") return
  send({ id: message.id, result: { turn: { id: "backend-turn" } } })
  setTimeout(() => send({
    method: "turn/completed",
    params: {
      threadId: "backend-session",
      turn: {
        id: "backend-turn",
        status: "completed",
        items: [{
          type: "agentMessage",
          id: "message-1",
          text: JSON.stringify({ answer: "ok" }),
          phase: "final_answer",
          memoryCitation: null,
        }],
      },
    },
  }), 4000)
})
`;
}

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
