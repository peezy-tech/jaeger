import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { describeLocalWorkspace } from "../src/admission.js";
import { BackendRpcError } from "../src/backend-protocol.js";
import { LocalRuntimeService } from "../src/local-runtime-service.js";
import { runWorkflow } from "../src/runtime.js";
import { waitForRun } from "../src/lifecycle.js";
import {
  ScheduleStore,
  cronMatches,
  loadScheduleApplication,
} from "../src/schedules.js";
import type {
  HarnessDefinition,
  JsonValue,
  WorkflowRunStatus,
} from "../src/types.js";

const harnesses: readonly HarnessDefinition[] = [
  {
    name: "codex",
    driver: "codex-app-server",
    command: "/bin/true",
  },
  {
    name: "claude",
    driver: "claude-agent-sdk",
    command: "/bin/true",
  },
];
const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.js");

test("schedule manifests resolve file-first launch policy and validate cron semantics", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-schedule-manifest-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "workflow"));
  await writeFile(
    path.join(root, "workflow", "daily.js"),
    `
export const meta = { name: "daily" }
return { inputs, trigger }
`,
  );
  await writeFile(path.join(root, "input.json"), JSON.stringify({ scope: "repo" }));
  const manifestPath = path.join(root, "daily.toml");
  await writeFile(
    manifestPath,
    `
version = 1
name = "daily_triage"
workflow = "./workflow/daily.js"
cwd = "."
input = "./input.json"
max_concurrency = 2

[trigger]
type = "cron"
expression = "*/15 9-17 * * 1-5"
timezone = "America/New_York"

[policy]
misfire = "latest"
pause_after_failures = 4
`,
  );

  const application = await loadScheduleApplication(manifestPath);
  assert.equal(application.name, "daily_triage");
  assert.equal(application.workflowPath, path.join(root, "workflow", "daily.js"));
  assert.equal(application.cwd, root);
  assert.deepEqual(application.inputs, { scope: "repo" });
  assert.equal(application.maxConcurrency, 2);
  assert.equal(application.policy.overlap, "forbid");
  assert.equal(application.policy.misfire, "latest");
  assert.equal(application.policy.pauseOnUncertain, true);
  assert.equal(application.policy.pauseAfterFailures, 4);
  assert.equal(
    cronMatches(
      application.trigger.expression,
      application.trigger.timezone,
      new Date("2026-07-23T13:15:00.000Z"),
    ),
    true,
  );
  assert.equal(
    cronMatches(
      application.trigger.expression,
      application.trigger.timezone,
      new Date("2026-07-23T13:16:00.000Z"),
    ),
    false,
  );
});

test("remote schedule admission pins local source paths and resolves only the target workspace", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-remote-schedule-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const remoteWorkspace = path.join(root, "remote-workspace");
  const binDir = path.join(root, "bin");
  await Promise.all([mkdir(remoteWorkspace), mkdir(binDir)]);
  for (const name of ["codex", "claude"]) {
    const command = path.join(binDir, name);
    await writeFile(command, "#!/bin/sh\nexit 0\n");
    await chmod(command, 0o755);
  }
  const workflowPath = path.join(root, "workflow.js");
  const manifestPath = path.join(root, "schedule.toml");
  await writeFile(
    workflowPath,
    `
export const meta = { name: "remote scheduled" }
return trigger
`,
  );
  await writeFile(
    manifestPath,
    `
version = 1
name = "remote_scheduled"
workflow = "./workflow.js"
cwd = ${JSON.stringify(remoteWorkspace)}

[trigger]
type = "cron"
expression = "* * * * *"
timezone = "UTC"
`,
  );
  const application = await loadScheduleApplication(manifestPath, {
    remoteWorkspace: true,
  });
  assert.equal(application.cwd, remoteWorkspace);
  assert.equal(application.sourcePathsPinned, true);
  await Promise.all([
    rename(workflowPath, `${workflowPath}.moved`),
    rename(manifestPath, `${manifestPath}.moved`),
  ]);
  const service = new LocalRuntimeService({
    stateDir: path.join(root, "runs"),
    entrypoint: cliPath,
    backendKind: "local-service",
    env: {
      ...process.env,
      PATH: `${binDir}:/usr/local/bin:/usr/bin:/bin`,
    },
  });
  const applied = asRecord(
    await service.dispatch("schedule.apply", {
      application: {
        ...application,
        manifestPath: "C:\\Users\\operator\\schedule.toml",
        workflowPath: "C:\\Users\\operator\\workflow.js",
      } as unknown as JsonValue,
    }),
  );
  assert.equal(applied.id, "remote_scheduled");
  assert.equal(applied.cwd, remoteWorkspace);
  assert.equal(applied.manifestPath, "C:\\Users\\operator\\schedule.toml");
  assert.equal(applied.workflowPath, "C:\\Users\\operator\\workflow.js");

  await writeFile(
    manifestPath,
    `
version = 1
name = "invalid_remote"
workflow = "./workflow.js.moved"
cwd = "."

[trigger]
type = "cron"
expression = "* * * * *"
timezone = "UTC"
`,
  );
  await assert.rejects(
    loadScheduleApplication(manifestPath, { remoteWorkspace: true }),
    /Remote schedule cwd must be an absolute path/,
  );
  await writeFile(
    manifestPath,
    `
version = 1
name = "windows_controller_path"
workflow = "./workflow.js.moved"
cwd = 'C:\\workspaces\\project'

[trigger]
type = "cron"
expression = "* * * * *"
timezone = "UTC"
`,
  );
  await assert.rejects(
    loadScheduleApplication(manifestPath, { remoteWorkspace: true }),
    /Remote schedule cwd must be an absolute path/,
  );
});

test("schedule revisions are immutable and manual occurrences are idempotent", async (t) => {
  const fixture = await scheduleFixture(t);
  const launches: Array<{
    readonly request: Parameters<ConstructorParameters<typeof ScheduleStore>[0]["submit"]>[0];
    readonly runId: string;
  }> = [];
  const statuses = new Map<string, WorkflowRunStatus>();
  let run = 0;
  const store = new ScheduleStore({
    stateDir: fixture.stateDir,
    now: () => fixture.now,
    submit: async (request) => {
      const runId = `2026072312000${run++}-000000000${run}`;
      launches.push({ request, runId });
      statuses.set(runId, "running");
      return { runId } as JsonValue;
    },
    inspectRun: async (runId) => ({ status: statuses.get(runId) ?? "running" }),
  });

  const first = asRecord(
    await store.apply(
      fixture.application,
      harnesses,
      await describeLocalWorkspace(fixture.root),
    ),
  );
  assert.equal(first.enabled, false);
  assert.equal(first.activeRevision, 1);
  assert.equal(first.changed, true);
  const unchanged = asRecord(
    await store.apply(
      fixture.application,
      harnesses,
      await describeLocalWorkspace(fixture.root),
    ),
  );
  assert.equal(unchanged.activeRevision, 1);
  assert.equal(unchanged.changed, false);

  await store.enable(fixture.application.name);
  const admitted = asRecord(await store.trigger(fixture.application.name, "request-0001"));
  assert.equal(admitted.status, "admitted");
  assert.match(String(admitted.inspect), /^jaeger inspect /);
  assert.match(String(admitted.wait), /^jaeger wait /);
  assert.equal(launches.length, 1);
  assert.deepEqual(launches[0]?.request.trigger, {
    type: "schedule",
    scheduleId: fixture.application.name,
    revision: 1,
    occurrenceId: admitted.id,
    kind: "manual",
    scheduledFor: fixture.now.toISOString(),
    admittedAt: fixture.now.toISOString(),
  });
  const retry = asRecord(await store.trigger(fixture.application.name, "request-0001"));
  assert.equal(retry.runId, admitted.runId);
  assert.equal(launches.length, 1);
  await assert.rejects(
    store.trigger(fixture.application.name, "request-0002"),
    /forbids overlap/,
  );

  statuses.set(String(admitted.runId), "completed");
  await store.history(fixture.application.name);
  await store.trigger(fixture.application.name, "request-0002");
  assert.equal(launches.length, 2);

  const changedApplication = {
    ...fixture.application,
    workflowSource: `${fixture.application.workflowSource}\n`,
  };
  const revisionTwo = asRecord(
    await store.apply(
      changedApplication,
      harnesses,
      await describeLocalWorkspace(fixture.root),
    ),
  );
  assert.equal(revisionTwo.activeRevision, 2);
  assert.equal(revisionTwo.enabled, false);
  assert.equal(revisionTwo.changed, true);
  const oldRetry = asRecord(
    await store.trigger(fixture.application.name, "request-0001"),
  );
  assert.equal(oldRetry.revision, 1);
  assert.equal(oldRetry.runId, admitted.runId);
  assert.equal(launches.length, 2);
});

test("cron occurrences survive scheduler restarts without duplicate admission", async (t) => {
  const fixture = await scheduleFixture(t);
  let launches = 0;
  const statuses = new Map<string, WorkflowRunStatus>();
  const submit = async (): Promise<JsonValue> => {
    launches++;
    const runId = `2026072312000${launches}-111111111${launches}`;
    statuses.set(runId, "completed");
    return { runId };
  };
  const options = {
    stateDir: fixture.stateDir,
    now: () => fixture.now,
    submit,
    inspectRun: async (runId: string) => ({
      status: statuses.get(runId) ?? ("completed" as const),
    }),
  };
  const first = new ScheduleStore(options);
  await first.apply(
    fixture.application,
    harnesses,
    await describeLocalWorkspace(fixture.root),
    true,
  );
  fixture.now = new Date("2026-07-23T12:01:00.000Z");
  await first.tick();
  assert.equal(launches, 1);

  const restarted = new ScheduleStore(options);
  await restarted.tick();
  assert.equal(launches, 1);
  const history = asArray(await restarted.history(fixture.application.name));
  assert.equal(history.length, 1);
  assert.equal(asRecord(history[0]).status, "completed");
});

test("an uncertain scheduled run pauses future authority", async (t) => {
  const fixture = await scheduleFixture(t);
  const statuses = new Map<string, WorkflowRunStatus>();
  const store = new ScheduleStore({
    stateDir: fixture.stateDir,
    now: () => fixture.now,
    submit: async () => {
      const runId = "20260723120100-2222222222";
      statuses.set(runId, "running");
      return { runId };
    },
    inspectRun: async (runId) => ({ status: statuses.get(runId) ?? "running" }),
  });
  await store.apply(
    fixture.application,
    harnesses,
    await describeLocalWorkspace(fixture.root),
    true,
  );
  const occurrence = asRecord(await store.trigger(fixture.application.name, "request-0001"));
  statuses.set(String(occurrence.runId), "uncertain");
  const inspected = asRecord(await store.inspect(fixture.application.name));
  assert.equal(inspected.enabled, false);
  assert.match(String(inspected.pausedReason), /uncertain/);
});

test("trigger metadata is pinned into a run and exposed as a deterministic global", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-trigger-global-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const workflowPath = path.join(root, "workflow.js");
  await writeFile(
    workflowPath,
    `
export const meta = { name: "trigger global" }
return trigger
`,
  );
  const trigger = {
    type: "schedule" as const,
    scheduleId: "daily",
    revision: 2,
    occurrenceId: "cron-202607231200z",
    kind: "cron" as const,
    scheduledFor: "2026-07-23T12:00:00.000Z",
    admittedAt: "2026-07-23T12:00:01.000Z",
  };
  const result = await runWorkflow({
    workflowPath,
    cwd: root,
    stateDir: path.join(root, "runs"),
    trigger,
  });
  assert.deepEqual(result.result, trigger);
  const record = JSON.parse(
    await readFile(path.join(root, "runs", result.runId, "run.json"), "utf8"),
  ) as { trigger: unknown };
  assert.deepEqual(record.trigger, trigger);
});

test("embedded operation rejects standing schedules", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-schedule-embedded-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const service = new LocalRuntimeService({
    stateDir: path.join(root, "runs"),
    entrypoint: process.execPath,
    backendKind: "embedded",
  });
  await assert.rejects(
    service.dispatch("schedule.list", {}),
    (error: unknown) =>
      error instanceof BackendRpcError && error.code === "unsupported_capability",
  );
});

test(
  "the local service admits a scheduled occurrence as an ordinary durable run",
  { skip: process.platform !== "linux" },
  async (t) => {
    const fixture = await scheduleFixture(t);
    const binDir = path.join(fixture.root, "bin");
    await mkdir(binDir);
    for (const name of ["codex", "claude"]) {
      const command = path.join(binDir, name);
      await writeFile(command, "#!/bin/sh\nexit 0\n");
      await chmod(command, 0o755);
    }
    const service = new LocalRuntimeService({
      stateDir: fixture.stateDir,
      entrypoint: cliPath,
      backendKind: "local-service",
      env: {
        ...process.env,
        PATH: `${binDir}:/usr/local/bin:/usr/bin:/bin`,
      },
    });
    const applied = asRecord(
      await service.dispatch("schedule.apply", {
        application: fixture.application as unknown as JsonValue,
        activate: true,
      }),
    );
    assert.equal(applied.enabled, true);
    await rename(
      fixture.application.workflowPath,
      `${fixture.application.workflowPath}.moved-after-apply`,
    );
    const occurrence = asRecord(
      await service.dispatch("schedule.trigger", {
        name: fixture.application.name,
        requestId: "service-request-0001",
      }),
    );
    const runId = String(occurrence.runId);
    const completed = await waitForRun(fixture.stateDir, runId);
    assert.equal(completed.status, "completed");
    assert.equal(completed.trigger?.scheduleId, fixture.application.name);
    assert.equal(completed.trigger?.occurrenceId, occurrence.id);
    assert.deepEqual(completed.result, {
      type: "schedule",
      scheduleId: fixture.application.name,
      revision: 1,
      occurrenceId: occurrence.id,
      kind: "manual",
      scheduledFor: occurrence.scheduledFor,
      admittedAt: occurrence.admittedAt,
    });
    const history = asArray(
      await service.dispatch("schedule.history", {
        name: fixture.application.name,
      }),
    );
    assert.equal(asRecord(history[0]).status, "completed");
  },
);

async function scheduleFixture(t: test.TestContext): Promise<{
  readonly root: string;
  readonly stateDir: string;
  readonly application: Awaited<ReturnType<typeof loadScheduleApplication>>;
  now: Date;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-schedule-store-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const workflowPath = path.join(root, "workflow.js");
  await writeFile(
    workflowPath,
    `
export const meta = { name: "scheduled" }
return trigger
`,
  );
  const manifestPath = path.join(root, "schedule.toml");
  await writeFile(
    manifestPath,
    `
version = 1
name = "scheduled_test"
workflow = "./workflow.js"
cwd = "."

[trigger]
type = "cron"
expression = "* * * * *"
timezone = "UTC"
`,
  );
  return {
    root,
    stateDir: path.join(root, "runs"),
    application: await loadScheduleApplication(manifestPath),
    now: new Date("2026-07-23T12:00:00.000Z"),
  };
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value;
}

function asArray(value: JsonValue): JsonValue[] {
  assert.ok(Array.isArray(value));
  return value;
}
