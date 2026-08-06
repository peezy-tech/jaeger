import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  archiveCodexThread,
  CodexThreadArchiveManager,
  type CodexThreadTarget,
} from "../src/codex-thread-lifecycle.js";
import { readCodexThreadArchiveRecord } from "../src/codex-thread-state.js";
import { LocalRuntimeService } from "../src/local-runtime-service.js";
import { executePreparedRun, prepareWorkflowRun } from "../src/runtime.js";
import {
  ManagedSessionTurn,
  listWorkflowSessions,
  withSessionProviderLifecycle,
} from "../src/sessions.js";
import type { AgentRequest, HarnessAdapter, HarnessResult } from "../src/types.js";

class PersistedCodexHarness implements HarnessAdapter {
  readonly name = "codex";
  readonly driver = "codex-app-server" as const;

  async execute(request: AgentRequest): Promise<HarnessResult> {
    await request.session.providerStarted("codex-thread-owned-by-jaeger");
    await request.session.turnStarted("codex-turn");
    return { output: "done", nativeSessionId: "codex-thread-owned-by-jaeger" };
  }
}

test("completed runs archive idle Codex threads once and defer active session turns", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-thread-archive-run-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const workflowPath = path.join(root, "workflow.js");
  const stateDir = path.join(root, "state");
  await writeFile(
    workflowPath,
    `export const meta = { name: "archive fixture" }\nreturn await agent("work", { harness: "codex" })\n`,
  );
  const prepared = await prepareWorkflowRun({
    workflowPath,
    cwd: root,
    stateDir,
    backend: "local-service",
  });
  const completed = await executePreparedRun({
    stateDir,
    runId: prepared.runId,
    expectedBackend: "local-service",
    harnesses: new Map([["codex", new PersistedCodexHarness()]]),
  });
  const [session] = await listWorkflowSessions(completed.runDir);
  assert.ok(session);
  const active = await ManagedSessionTurn.resume(completed.runDir, session.id);
  const calls: CodexThreadTarget[] = [];
  const manager = new CodexThreadArchiveManager({
    stateDir,
    archive: async (target) => {
      calls.push(target);
      return { status: "archived" };
    },
  });

  await manager.tick();
  assert.equal(calls.length, 0, "an active continuation must keep its thread visible");
  await active.complete("continued");
  await manager.tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.nativeSessionId, "codex-thread-owned-by-jaeger");
  assert.equal(
    (await readCodexThreadArchiveRecord(
      completed.runDir,
      "codex-thread-owned-by-jaeger",
    ))?.status,
    "archived",
  );

  await manager.tick();
  assert.equal(calls.length, 1, "a durable archive result must suppress duplicate mutation");
  const service = new LocalRuntimeService({
    stateDir,
    entrypoint: path.join(root, "unused-entrypoint.js"),
    backendKind: "local-service",
  });
  const listed = await service.dispatch("session.list", { runId: completed.runId });
  assert.ok(Array.isArray(listed));
  assert.equal(
    (listed[0] as { threadArchive?: { status?: string } } | undefined)?.threadArchive?.status,
    "archived",
  );
});

test("archive delivery retries independently without changing a completed run", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-thread-archive-retry-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const workflowPath = path.join(root, "workflow.js");
  const stateDir = path.join(root, "state");
  await writeFile(
    workflowPath,
    `export const meta = { name: "retry fixture" }\nreturn await agent("work", { harness: "codex" })\n`,
  );
  const prepared = await prepareWorkflowRun({
    workflowPath,
    cwd: root,
    stateDir,
    backend: "local-service",
  });
  const completed = await executePreparedRun({
    stateDir,
    runId: prepared.runId,
    expectedBackend: "local-service",
    harnesses: new Map([["codex", new PersistedCodexHarness()]]),
  });
  let now = new Date("2026-08-05T00:00:00.000Z");
  let calls = 0;
  const manager = new CodexThreadArchiveManager({
    stateDir,
    now: () => now,
    archive: async () => {
      calls++;
      if (calls === 1) throw new Error("temporary app-server failure");
      return { status: "archived" };
    },
  });

  await manager.tick();
  const retrying = await readCodexThreadArchiveRecord(
    completed.runDir,
    "codex-thread-owned-by-jaeger",
  );
  assert.equal(retrying?.status, "retrying");
  assert.match(retrying?.lastError ?? "", /temporary app-server failure/);
  await manager.tick();
  assert.equal(calls, 1);

  now = new Date("2026-08-05T00:00:01.000Z");
  await manager.tick();
  assert.equal(calls, 2);
  assert.equal(
    (await readCodexThreadArchiveRecord(
      completed.runDir,
      "codex-thread-owned-by-jaeger",
    ))?.status,
    "archived",
  );
});

test("archival and new Codex work serialize on the provider lifecycle lease", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-thread-archive-lease-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const workflowPath = path.join(root, "workflow.js");
  const stateDir = path.join(root, "state");
  await writeFile(
    workflowPath,
    `export const meta = { name: "lease fixture" }\nreturn await agent("work", { harness: "codex" })\n`,
  );
  const prepared = await prepareWorkflowRun({
    workflowPath,
    cwd: root,
    stateDir,
    backend: "local-service",
  });
  const completed = await executePreparedRun({
    stateDir,
    runId: prepared.runId,
    expectedBackend: "local-service",
    harnesses: new Map([["codex", new PersistedCodexHarness()]]),
  });
  const [session] = await listWorkflowSessions(completed.runDir);
  assert.ok(session);
  let archiveCalls = 0;
  const manager = new CodexThreadArchiveManager({
    stateDir,
    archive: async () => {
      archiveCalls++;
      return { status: "archived" };
    },
  });

  await withSessionProviderLifecycle(
    completed.runDir,
    session.id,
    async () => {
      await manager.tick();
      assert.equal(archiveCalls, 0, "housekeeping must defer while provider work owns the lease");
    },
  );
  await manager.tick();
  assert.equal(archiveCalls, 1);
});

test("Codex archival respects pins and refuses to cascade into non-Jaeger descendants", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-thread-archive-policy-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));

  const pinnedCommand = await fakeCodexAdmin(root, "pinned", {
    pinned: true,
    descendants: [],
  });
  const pinned = await archiveCodexThread(
    target(root, pinnedCommand, new Set()),
    process.env,
  );
  assert.deepEqual(pinned, { status: "retained", reason: "Codex thread is pinned" });

  const forkedCommand = await fakeCodexAdmin(root, "forked", {
    pinned: false,
    descendants: ["user-fork"],
  });
  const forked = await archiveCodexThread(
    target(root, forkedCommand, new Set()),
    process.env,
  );
  assert.deepEqual(forked, {
    status: "retained",
    reason: "Codex thread has non-Jaeger descendants: user-fork",
  });

  const ownedCommand = await fakeCodexAdmin(root, "owned", {
    pinned: false,
    descendants: ["jaeger-query"],
  });
  const owned = await archiveCodexThread(
    target(root, ownedCommand, new Set(["jaeger-query"])),
    process.env,
  );
  assert.deepEqual(owned, { status: "archived" });
  const requests = (await readFile(path.join(root, "owned-requests.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { method?: string });
  assert.ok(requests.some(({ method }) => method === "thread/archive"));

  const pinnedChildCommand = await fakeCodexAdmin(root, "pinned-child", {
    pinned: false,
    descendants: ["jaeger-query"],
    pinnedDescendants: ["jaeger-query"],
  });
  const pinnedChild = await archiveCodexThread(
    target(root, pinnedChildCommand, new Set(["jaeger-query"])),
    process.env,
  );
  assert.deepEqual(pinnedChild, {
    status: "retained",
    reason: "Codex descendant is pinned: jaeger-query",
  });
});

function target(
  root: string,
  command: string,
  ownedDescendantIds: ReadonlySet<string>,
): CodexThreadTarget {
  return {
    runId: "20260805000000-aaaaaaaaaa",
    runDir: path.join(root, "run"),
    ownerSessionId: "session-aaaaaaaaaaaaaaaa",
    nativeSessionId: "provider-thread",
    command,
    cwd: root,
    activityVersion: "2026-08-05T00:00:00.000Z",
    busy: false,
    ownedDescendantIds,
  };
}

async function fakeCodexAdmin(
  root: string,
  name: string,
  options: {
    pinned: boolean;
    descendants: readonly string[];
    pinnedDescendants?: readonly string[];
  },
): Promise<string> {
  const command = path.join(root, `fake-codex-${name}`);
  await writeFile(
    command,
    `#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
const readline = require("node:readline")
const requests = path.join(process.cwd(), ${JSON.stringify(`${name}-requests.jsonl`)})
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n")
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line)
  fs.appendFileSync(requests, JSON.stringify(message) + "\\n")
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fixture" } })
  if (message.method === "thread/read") send({ id: message.id, result: { thread: { id: message.params.threadId, isPinned: ${String(options.pinned)}, status: { type: "notLoaded" } } } })
  if (message.method === "thread/list" && message.params.archived === true) send({ id: message.id, result: { data: [], nextCursor: null } })
  if (message.method === "thread/list" && message.params.ancestorThreadId) send({ id: message.id, result: { data: ${JSON.stringify(options.descendants.map((id) => ({ id, isPinned: options.pinnedDescendants?.includes(id) ?? false, status: { type: "notLoaded" } })))}, nextCursor: null } })
  if (message.method === "thread/archive") send({ id: message.id, result: {} })
})
`,
    "utf8",
  );
  await chmod(command, 0o755);
  return command;
}
