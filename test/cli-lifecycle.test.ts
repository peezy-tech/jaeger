import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  discoverRunHarnessProcesses,
  harnessContainmentState,
  listActiveHarnessProcesses,
  runOwnerContainment,
  signalActiveHarnessProcess,
  type ActiveHarnessProcess,
} from "../src/harnesses/active-process.js";
import type { WorkflowRunSummary } from "../src/types.js";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.js");

test("detached CLI launch survives its parent and supports compact inspect, wait, events, and transcripts", async () => {
  const fixture = await cliFixture("detached-complete", "SLOW");
  const launchedAt = Date.now();
  const launch = await cli(
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
  );
  const running = parseJson<WorkflowRunSummary>(launch.stdout);
  assert.equal(running.status, "running");
  assert.ok(Date.now() - launchedAt < 5_000, "detached launch should return after ownership starts");
  assert.equal(running.boundary.kind, "host");
  assert.equal(running.boundary.isolated, false);
  assert.match(running.inspect, /--summary --json/);
  assert.ok(running.wait);
  assert.ok(running.stop);

  const inspected = parseJson<WorkflowRunSummary>(
    (
      await cli(
        ["inspect", running.runId, "--state-dir", fixture.stateDir, "--summary", "--json"],
        fixture.env,
      )
    ).stdout,
  );
  assert.ok(["running", "completed"].includes(inspected.status));

  const waited = parseJson<WorkflowRunSummary>(
    (await cli(["wait", running.runId, "--state-dir", fixture.stateDir], fixture.env)).stdout,
  );
  assert.equal(waited.status, "completed");
  assert.deepEqual(waited.result, { answer: "ok" });
  assert.equal(waited.stop, undefined);

  const detail = parseJson<{
    summary: WorkflowRunSummary;
    events: Array<Record<string, unknown>>;
    scratchDir: string;
  }>(
    (
      await cli(
        [
          "inspect",
          running.runId,
          "--state-dir",
          fixture.stateDir,
          "--events",
          "--step",
          "root/agent:1:fixture",
        ],
        fixture.env,
      )
    ).stdout,
  );
  assert.equal(detail.events.at(-1)?.type, "agent.completed");
  const completed = detail.events.find((event) => event.type === "agent.completed");
  assert.deepEqual(
    (completed?.metadata as { usage?: unknown } | undefined)?.usage,
    { total: { inputTokens: 3, outputTokens: 2 } },
  );
  assert.ok(detail.scratchDir.startsWith(waited.runDir));

  const transcript = parseJson<{ transcript: { path: string; contents: string } }>(
    (
      await cli(
        [
          "inspect",
          running.runId,
          "--state-dir",
          fixture.stateDir,
          "--step",
          "root/agent:1:fixture",
          "--transcript",
          "stdout",
        ],
        fixture.env,
      )
    ).stdout,
  );
  assert.match(transcript.transcript.contents, /turn\/completed/);
  assert.equal(harnessContainmentState(runOwnerContainment(waited.runId)), "inactive");
  assert.equal(
    discoverRunHarnessProcesses(waited.runDir, waited.runId).filter(
      (record) => harnessContainmentState(record) !== "inactive",
    ).length,
    0,
  );
});

test("a blocking CLI failure reports its durable run ID and actionable uncertainty summary", async () => {
  const fixture = await cliFixture("blocking-failure-summary", "FAIL");
  await assert.rejects(
    cli(
      [
        "run",
        fixture.workflowPath,
        "--cwd",
        fixture.root,
        "--state-dir",
        fixture.stateDir,
      ],
      fixture.env,
    ),
    (error: unknown) => {
      const stderr =
        typeof error === "object" && error !== null && "stderr" in error
          ? String((error as { readonly stderr?: unknown }).stderr ?? "")
          : "";
      const line = stderr
        .split("\n")
        .find((candidate) => candidate.startsWith("jaeger run summary: "));
      assert.ok(line, stderr);
      const summary = parseJson<WorkflowRunSummary>(line.slice("jaeger run summary: ".length));
      assert.match(summary.runId, /^\d{14}-[a-f0-9]{10}$/);
      assert.equal(summary.status, "uncertain");
      assert.equal(summary.uncertainty?.stepId, "root/agent:1:fixture");
      assert.match(summary.inspect, /jaeger --runtime embedded inspect/);
      return true;
    },
  );
});

test("a detached launcher failure is handled and reports the prepared run summary", async () => {
  const fixture = await cliFixture("detached-launcher-failure", "SLOW");
  const env = { ...fixture.env, PATH: path.join(fixture.root, "bin") };
  await assert.rejects(
    cli(
      [
        "run",
        fixture.workflowPath,
        "--cwd",
        fixture.root,
        "--state-dir",
        fixture.stateDir,
        "--detach",
      ],
      env,
    ),
    (error: unknown) => {
      const stderr =
        typeof error === "object" && error !== null && "stderr" in error
          ? String((error as { readonly stderr?: unknown }).stderr ?? "")
          : "";
      assert.doesNotMatch(stderr, /Unhandled 'error' event|node:events/);
      assert.match(stderr, /spawn systemd-run ENOENT/);
      const line = stderr
        .split("\n")
        .find((candidate) => candidate.startsWith("jaeger run summary: "));
      assert.ok(line, stderr);
      const summary = parseJson<WorkflowRunSummary>(line.slice("jaeger run summary: ".length));
      assert.equal(summary.status, "pending");
      assert.match(summary.runId, /^\d{14}-[a-f0-9]{10}$/);
      assert.match(summary.inspect, /jaeger --runtime embedded inspect/);
      assert.match(summary.resume ?? "", /^jaeger --runtime embedded resume /);
      return true;
    },
  );
});

test("stopping an in-flight detached agent is terminal and reports its uncertainty boundary", async () => {
  const fixture = await cliFixture("detached-stop", "HANG");
  const launch = parseJson<WorkflowRunSummary>(
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
  await waitForAgentStart(launch.runId, fixture);

  const stopped = parseJson<WorkflowRunSummary>(
    (await cli(["stop", launch.runId, "--state-dir", fixture.stateDir], fixture.env)).stdout,
  );
  assert.equal(stopped.status, "uncertain");
  assert.equal(stopped.uncertainty?.stepId, "root/agent:1:fixture");
  assert.equal(stopped.resume, undefined);
  assert.equal(stopped.stop, undefined);

  const repeated = parseJson<WorkflowRunSummary>(
    (await cli(["stop", launch.runId, "--state-dir", fixture.stateDir], fixture.env)).stdout,
  );
  assert.equal(repeated.status, "uncertain");
});

test(
  "stop escalates through a frozen owner and proves the provider tree is gone",
  { skip: process.platform === "win32" },
  async () => {
    const fixture = await cliFixture("detached-frozen-stop", "HANG");
    const launch = parseJson<WorkflowRunSummary>(
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
    await waitForAgentStart(launch.runId, fixture);
    const owner = parseJson<{ pid: number }>(
      await readFile(path.join(launch.runDir, "owner.json"), "utf8"),
    );
    const provider = await waitForProviderRecord(launch.runDir);
    await waitForFileSize(fixture.effectsPath, 1);

    process.kill(owner.pid, "SIGSTOP");
    try {
      const stopped = parseJson<WorkflowRunSummary>(
        (await cli(["stop", launch.runId, "--state-dir", fixture.stateDir], fixture.env)).stdout,
      );
      assert.equal(stopped.status, "uncertain");
      assert.equal(harnessContainmentState(provider), "inactive");
      const stoppedSize = (await stat(fixture.effectsPath)).size;
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal((await stat(fixture.effectsPath)).size, stoppedSize);
    } finally {
      try {
        process.kill(owner.pid, "SIGCONT");
      } catch {}
      try {
        process.kill(owner.pid, "SIGKILL");
      } catch {}
      try {
        await signalActiveHarnessProcess(provider, "SIGKILL");
      } catch {}
    }
  },
);

test(
  "stop discovers and terminates a provider tree after its owner crashes",
  { skip: process.platform === "win32" },
  async () => {
    const fixture = await cliFixture("detached-crashed-stop", "HANG");
    const launch = parseJson<WorkflowRunSummary>(
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
    await waitForAgentStart(launch.runId, fixture);
    const owner = parseJson<{ pid: number }>(
      await readFile(path.join(launch.runDir, "owner.json"), "utf8"),
    );
    const provider = await waitForProviderRecord(launch.runDir);
    await waitForFileSize(fixture.effectsPath, 1);

    process.kill(owner.pid, "SIGKILL");
    try {
      await waitForProcessExit(owner.pid);
      const containmentAfterCrash = harnessContainmentState(provider);
      assert.ok(
        containmentAfterCrash === "active" || containmentAfterCrash === "inactive",
        `provider containment became ${containmentAfterCrash}`,
      );
      const orphaned = parseJson<WorkflowRunSummary>(
        (
          await cli(
            ["inspect", launch.runId, "--state-dir", fixture.stateDir, "--summary", "--json"],
            fixture.env,
          )
        ).stdout,
      );
      assert.equal(orphaned.status, "uncertain");
      assert.match(orphaned.stop ?? "", /jaeger --runtime embedded stop/);
      const stopped = parseJson<WorkflowRunSummary>(
        (await cli(["stop", launch.runId, "--state-dir", fixture.stateDir], fixture.env)).stdout,
      );
      assert.equal(stopped.status, "uncertain");
      assert.equal(harnessContainmentState(provider), "inactive");
      const stoppedSize = (await stat(fixture.effectsPath)).size;
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal((await stat(fixture.effectsPath)).size, stoppedSize);
    } finally {
      try {
        await signalActiveHarnessProcess(provider, "SIGKILL");
      } catch {}
    }
  },
);

test(
  "stop discovers the deterministic systemd scope after provider-writable intent deletion",
  { skip: process.platform !== "linux" },
  async () => {
    const fixture = await cliFixture("detached-deleted-intent", "HANG DELETE_REGISTRY");
    const launch = parseJson<WorkflowRunSummary>(
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
    await waitForAgentStart(launch.runId, fixture);
    const owner = parseJson<{ pid: number }>(
      await readFile(path.join(launch.runDir, "owner.json"), "utf8"),
    );
    await waitForFileSize(fixture.effectsPath, 1);
    await waitForIntentRemoval(launch.runDir);
    process.kill(owner.pid, "SIGKILL");
    await waitForProcessExit(owner.pid);

    const stopped = parseJson<WorkflowRunSummary>(
      (await cli(["stop", launch.runId, "--state-dir", fixture.stateDir], fixture.env)).stdout,
    );
    assert.equal(stopped.status, "uncertain");
    const stoppedSize = (await stat(fixture.effectsPath)).size;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal((await stat(fixture.effectsPath)).size, stoppedSize);
  },
);

test(
  "stop ignores corrupt provider-writable intent and controls the deterministic systemd scope",
  { skip: process.platform !== "linux" },
  async () => {
    const fixture = await cliFixture("detached-corrupt-intent", "HANG CORRUPT_REGISTRY");
    const launch = parseJson<WorkflowRunSummary>(
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
    await waitForAgentStart(launch.runId, fixture);
    const owner = parseJson<{ pid: number }>(
      await readFile(path.join(launch.runDir, "owner.json"), "utf8"),
    );
    await waitForFileSize(fixture.effectsPath, 1);
    await waitForIntentCorruption(launch.runDir);
    process.kill(owner.pid, "SIGKILL");
    await waitForProcessExit(owner.pid);

    const stopped = parseJson<WorkflowRunSummary>(
      (await cli(["stop", launch.runId, "--state-dir", fixture.stateDir], fixture.env)).stdout,
    );
    assert.equal(stopped.status, "uncertain");
    const stoppedSize = (await stat(fixture.effectsPath)).size;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal((await stat(fixture.effectsPath)).size, stoppedSize);
  },
);

test(
  "stop terminates deterministic run and provider scopes after the entire durable run directory is deleted",
  { skip: process.platform !== "linux" },
  async () => {
    const fixture = await cliFixture("detached-deleted-run-dir", "HANG DELETE_RUN_DIR");
    const launch = parseJson<WorkflowRunSummary>(
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
    await waitForFileSize(fixture.effectsPath, 1);
    await waitForPathRemoval(launch.runDir);

    await assert.rejects(
      cli(["stop", launch.runId, "--state-dir", fixture.stateDir], fixture.env),
      (error: unknown) => {
        const stderr =
          typeof error === "object" && error !== null && "stderr" in error
            ? String((error as { readonly stderr?: unknown }).stderr ?? "")
            : "";
        assert.match(stderr, /Stopped OS containment.*durable run state is unavailable/);
        return true;
      },
    );
    const stoppedSize = (await stat(fixture.effectsPath)).size;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal((await stat(fixture.effectsPath)).size, stoppedSize);
  },
);

test(
  "corrupt owner metadata cannot prevent deterministic scope termination",
  { skip: process.platform !== "linux" },
  async () => {
    const fixture = await cliFixture("detached-corrupt-owner", "HANG");
    const launch = parseJson<WorkflowRunSummary>(
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
    await waitForAgentStart(launch.runId, fixture);
    await waitForFileSize(fixture.effectsPath, 1);
    await writeFile(path.join(launch.runDir, "owner.json"), "{invalid-owner", "utf8");

    await assert.rejects(
      cli(["stop", launch.runId, "--state-dir", fixture.stateDir], fixture.env),
      (error: unknown) => {
        const stderr =
          typeof error === "object" && error !== null && "stderr" in error
            ? String((error as { readonly stderr?: unknown }).stderr ?? "")
            : "";
        assert.match(stderr, /Invalid Jaeger owner record/);
        return true;
      },
    );
    const stoppedSize = (await stat(fixture.effectsPath)).size;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal((await stat(fixture.effectsPath)).size, stoppedSize);
  },
);

async function cliFixture(name: string, prompt: string): Promise<{
  readonly root: string;
  readonly workflowPath: string;
  readonly stateDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly effectsPath: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), `jaeger-cli-${name}-`));
  const binDir = path.join(root, "bin");
  const stateDir = path.join(root, "state");
  const workflowPath = path.join(root, "workflow.js");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(binDir));
  await writeFile(
    workflowPath,
    `
export const meta = { name: ${JSON.stringify(name)} }
phase("Run")
return await agent(${JSON.stringify(prompt)}, {
  harness: "codex",
  label: "fixture",
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
  const codexPath = path.join(binDir, "codex");
  await writeFile(
    codexPath,
    `#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
const readline = require("node:readline")
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n")
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line)
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fixture" } })
    return
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: "fixture-session" } } })
    return
  }
  if (message.method !== "turn/start") return
  const prompt = message.params.input[0].text
  send({ id: message.id, result: { turn: { id: "fixture-turn" } } })
  if (prompt.includes("HANG")) {
    if (prompt.includes("DELETE_REGISTRY")) {
      const stateDir = path.join(process.cwd(), "state")
      for (const runId of fs.readdirSync(stateDir)) {
        const harnessDir = path.join(stateDir, runId, "harness")
        if (!fs.existsSync(harnessDir)) continue
        for (const step of fs.readdirSync(harnessDir)) {
          for (const name of ["pid.json", "process.json"]) {
            try { fs.unlinkSync(path.join(harnessDir, step, name)) } catch {}
          }
        }
      }
    }
    if (prompt.includes("CORRUPT_REGISTRY")) {
      const stateDir = path.join(process.cwd(), "state")
      for (const runId of fs.readdirSync(stateDir)) {
        const harnessDir = path.join(stateDir, runId, "harness")
        if (!fs.existsSync(harnessDir)) continue
        for (const step of fs.readdirSync(harnessDir)) {
          try { fs.writeFileSync(path.join(harnessDir, step, "process.json"), "{invalid") } catch {}
        }
      }
    }
    if (prompt.includes("DELETE_RUN_DIR")) {
      const stateDir = path.join(process.cwd(), "state")
      setTimeout(() => {
        for (const runId of fs.readdirSync(stateDir)) {
          fs.rmSync(path.join(stateDir, runId), { recursive: true, force: true })
        }
      }, 100)
    }
    const effectsPath = path.join(process.cwd(), "provider-effects.log")
    setInterval(() => fs.appendFileSync(effectsPath, "effect\\n"), 25)
    setInterval(() => send({ method: "heartbeat", params: {} }), 100)
    return
  }
  if (prompt.includes("FAIL")) {
    process.stderr.write("fixture provider failed\\n")
    process.exit(7)
    return
  }
  setTimeout(() => {
    send({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "fixture-session",
        turnId: "fixture-turn",
        tokenUsage: { total: { inputTokens: 3, outputTokens: 2 } },
      },
    })
    send({
      method: "turn/completed",
      params: {
        threadId: "fixture-session",
        turn: {
          id: "fixture-turn",
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
    })
  }, prompt.includes("SLOW") ? 800 : 0)
})
`,
    "utf8",
  );
  await chmod(codexPath, 0o755);
  const claudePath = path.join(binDir, "claude");
  await writeFile(claudePath, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(claudePath, 0o755);
  const piPath = path.join(binDir, "pi");
  await writeFile(piPath, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(piPath, 0o755);
  return {
    root,
    workflowPath,
    stateDir,
    env: {
      ...process.env,
      JAEGER_RUNTIME: "embedded",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
    effectsPath: path.join(root, "provider-effects.log"),
  };
}

async function waitForProviderRecord(runDir: string): Promise<ActiveHarnessProcess> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const [record] = listActiveHarnessProcesses(runDir);
      if (record) return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("provider process record did not appear");
}

async function waitForFileSize(filePath: string, minimum: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await stat(filePath)).size >= minimum) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`file did not reach ${minimum} bytes: ${filePath}`);
}

async function waitForIntentRemoval(runDir: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const harnessDir = path.join(runDir, "harness");
    let present = false;
    try {
      for (const step of await readdir(harnessDir)) {
        try {
          await stat(path.join(harnessDir, step, "process.json"));
          present = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!present) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("provider containment intent was not deleted by the fixture");
}

async function waitForIntentCorruption(runDir: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const harnessDir = path.join(runDir, "harness");
    try {
      for (const step of await readdir(harnessDir)) {
        try {
          if ((await readFile(path.join(harnessDir, step, "process.json"), "utf8")) === "{invalid") {
            return;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("provider containment intent was not corrupted by the fixture");
}

async function waitForPathRemoval(target: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await stat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`path was not removed: ${target}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`process ${pid} did not exit`);
}

async function waitForAgentStart(
  runId: string,
  fixture: { readonly stateDir: string; readonly env: NodeJS.ProcessEnv },
): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const detail = parseJson<{ events: Array<Record<string, unknown>> }>(
      (
        await cli(
          ["inspect", runId, "--state-dir", fixture.stateDir, "--events"],
          fixture.env,
        )
      ).stdout,
    );
    if (detail.events.some((event) => event.type === "agent.started")) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("detached agent did not start");
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
