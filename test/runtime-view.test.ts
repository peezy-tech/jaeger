import assert from "node:assert/strict";
import test from "node:test";
import { qualifyRemoteResult } from "../src/runtime-view.js";
import type { SshRuntimeTarget } from "../src/runtime-targets.js";

const target: SshRuntimeTarget = {
  name: "build",
  transport: "ssh",
  kind: "ssh-service",
  destination: "build-host",
  command: "jaeger",
  instanceId: "a".repeat(32),
  connectTimeoutSeconds: 10,
};

test("remote run, session, turn, and schedule views retain their runtime target", () => {
  const run = qualifyRemoteResult(
    "run.inspect",
    {
      schemaVersion: 1,
      runId: "20260724120000-0123456789",
      status: "running",
      inspect: "jaeger inspect 20260724120000-0123456789",
      wait: "jaeger wait 20260724120000-0123456789",
      stop: "jaeger stop 20260724120000-0123456789",
    },
    target,
  ) as Record<string, unknown>;
  assert.equal(run.runRef, "build:20260724120000-0123456789");
  assert.equal(run.wait, "jaeger wait build:20260724120000-0123456789");

  const [session] = qualifyRemoteResult(
    "session.list",
    [
      {
        runId: "20260724120000-0123456789",
        id: "agent-1",
        status: "idle",
        inspect: "local",
        resume: "local",
      },
    ],
    target,
  ) as Array<Record<string, unknown>>;
  assert.equal(
    session?.resume,
    "jaeger session resume build:20260724120000-0123456789 agent-1 --message -",
  );

  const turn = qualifyRemoteResult(
    "session.turn.wait",
    {
      runId: "20260724120000-0123456789",
      sessionId: "agent-1",
      turnId: "turn-abcdefgh",
      status: "running",
      inspect: "local",
      wait: "local",
      interrupt: "local",
    },
    target,
  ) as Record<string, unknown>;
  assert.equal(
    turn.inspect,
    "jaeger session turn inspect build:20260724120000-0123456789 turn-abcdefgh",
  );
  assert.equal(
    turn.interrupt,
    "jaeger session interrupt build:20260724120000-0123456789 agent-1",
  );

  const query = qualifyRemoteResult(
    "session.query.wait",
    {
      runId: "20260724120000-0123456789",
      sessionId: "agent-1",
      queryId: "query-abcdefgh",
      status: "running",
      inspect: "local",
      wait: "local",
    },
    target,
  ) as Record<string, unknown>;
  assert.equal(
    query.wait,
    "jaeger session query wait build:20260724120000-0123456789 query-abcdefgh",
  );

  const [occurrence] = qualifyRemoteResult(
    "schedule.history",
    [
      {
        id: "manual-1",
        runId: "20260724120000-0123456789",
        inspect: "local",
        wait: "local",
      },
    ],
    target,
  ) as Array<Record<string, unknown>>;
  assert.equal(occurrence?.runRef, "build:20260724120000-0123456789");
  assert.equal(
    occurrence?.inspect,
    "jaeger inspect build:20260724120000-0123456789 --summary --json",
  );
});
