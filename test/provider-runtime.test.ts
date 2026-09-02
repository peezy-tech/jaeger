import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeHarness } from "../src/harnesses/claude.js";
import { CodexHarness } from "../src/harnesses/codex.js";
import { codexRuntimeEvent, claudeRuntimeEvent } from "../src/provider-runtime.js";
import { requestSessionControl, ManagedSessionTurn, listWorkflowSessions } from "../src/sessions.js";
import type { AgentRequest, HarnessDriver, JsonValue, SessionTurn } from "../src/types.js";

test("provider identity snapshots allowlist account data and redact auth material", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-provider-identity-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));

  const codex = await createSession(root, "codex", "identity-codex");
  await codex.providerEvent(
    codexRuntimeEvent({
      method: "account/updated",
      params: {
        account: {
          id: "acct-work",
          email: "operator@example.test",
          planType: "pro",
          accessToken: "codex-secret-token",
          refreshToken: "codex-refresh-secret",
        },
      },
    })!,
  );
  const codexRecord = await readSessionRecord(root, codex.id);
  assert.deepEqual(codexRecord.runtime?.identity, {
    provider: "codex",
    driver: "codex-app-server",
    account: {
      id: "acct-work",
      email: "operator@example.test",
      label: "pro",
    },
    auth: {
      status: "authenticated",
      observedAt: codexRecord.runtime.identity.observedAt,
    },
    freshness: "fresh",
    observedAt: codexRecord.runtime.identity.observedAt,
  });
  assert.doesNotMatch(JSON.stringify(codexRecord), /codex-secret-token|codex-refresh-secret/u);

  const claude = await createSession(root, "claude", "identity-claude");
  await claude.providerEvent(
    claudeRuntimeEvent({
      type: "auth_status",
      isAuthenticating: false,
      error: "authorization: Bearer claude-secret-token; refreshToken=claude-refresh-secret",
    })!,
  );
  const claudeRecord = await readSessionRecord(root, claude.id);
  const identity = claudeRecord.runtime?.identity as {
    auth?: { status?: string; error?: string };
  };
  assert.equal(identity.auth?.status, "error");
  assert.match(identity.auth?.error ?? "", /\[REDACTED\]/u);
  assert.doesNotMatch(JSON.stringify(claudeRecord), /claude-secret-token|claude-refresh-secret/u);
});

test("native Codex usage and nested item progress are durable before turn completion", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-provider-codex-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const command = path.join(root, "fake-codex");
  await writeExecutable(command, codexLiveStateScript());

  const session = await createSession(root, "codex", "live-codex");
  const running = new CodexHarness(command).execute(agentRequest(root, "codex", session));
  try {
    const live = await waitForSession(root, session.id, (record) =>
      record.runtime?.usage !== undefined && record.runtime.progress.length === 2,
    );

    assert.equal(live.status, "running");
    assert.deepEqual(live.runtime?.usage, {
      total: {
        totalTokens: 126,
        inputTokens: 120,
        cachedInputTokens: 0,
        outputTokens: 6,
        reasoningOutputTokens: 0,
      },
    });
    assert.deepEqual(live.runtime?.progress, [
      {
        id: "agent-task-1",
        kind: "task",
        status: "running",
        label: "agentTask",
        updatedAt: live.runtime.progress[0]?.updatedAt,
      },
      {
        id: "command-1",
        kind: "tool",
        status: "running",
        label: "commandExecution",
        parentId: "agent-task-1",
        updatedAt: live.runtime.progress[1]?.updatedAt,
      },
    ]);
    assert.equal(live.runtime?.recentEvents.at(-1)?.type, "item/started");
  } finally {
    const result = await running;
    assert.equal(result.nativeSessionId, "codex-thread");
    await session.complete(result.output);
  }
});

test("native Claude result usage and auth state are projected into the durable session", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-provider-claude-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const session = await createSession(root, "claude", "live-claude");
  const factory = (): Query =>
    fakeQuery([
      systemMessage("claude-session"),
      {
        type: "auth_status",
        isAuthenticated: true,
        email: "claude@example.test",
      } as unknown as SDKMessage,
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Claude completed",
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        total_cost_usd: 0,
        modelUsage: {},
        permission_denials: [],
        stop_reason: null,
        uuid: "result-1",
        usage: { input_tokens: 8, output_tokens: 3 },
        session_id: "claude-session",
      } as unknown as SDKMessage,
    ]);

  const result = await new ClaudeHarness("claude", factory).execute(
    agentRequest(root, "claude", session),
  );
  const record = await readSessionRecord(root, session.id);
  assert.equal(result.nativeSessionId, "claude-session");
  assert.deepEqual(record.runtime?.usage, { input_tokens: 8, output_tokens: 3 });
  assert.equal(
    (record.runtime?.identity as { auth?: { status?: string } }).auth?.status,
    "authenticated",
  );
  assert.equal(record.runtime?.activity, "completed");
  await session.complete(result.output);
});

test("runtime projections discard provider payload fields that are not explicitly public", () => {
  const usage = codexRuntimeEvent({
    method: "thread/tokenUsage/updated",
    params: {
      tokenUsage: {
        total: { inputTokens: 12, outputTokens: 4, accessToken: "usage-secret" },
        authorization: "Bearer usage-secret",
      },
    },
  });
  assert.deepEqual(usage?.usage, { total: { inputTokens: 12, outputTokens: 4 } });

  const rateLimits = codexRuntimeEvent({
    method: "account/rateLimits/updated",
    params: {
      rateLimits: {
        limitName: "primary",
        primary: { usedPercent: 25, resetsAt: 1234, token: "rate-secret" },
        refreshToken: "rate-secret",
      },
    },
  });
  assert.deepEqual(rateLimits?.rateLimits, {
    limitName: "primary",
    primary: { usedPercent: 25, resetsAt: 1234 },
  });

  const command = codexRuntimeEvent({
    method: "item/started",
    params: {
      item: {
        id: "command-1",
        type: "commandExecution",
        command: "curl -H 'Authorization: Bearer command-secret'",
      },
    },
  });
  assert.equal(command?.progress?.label, "commandExecution");
  assert.doesNotMatch(JSON.stringify(command), /command-secret/u);

  const claude = claudeRuntimeEvent({
    type: "result",
    subtype: "success",
    is_error: false,
    usage: { input_tokens: 8, output_tokens: 3, api_key: "claude-secret" },
  });
  assert.deepEqual(claude?.usage, { input_tokens: 8, output_tokens: 3 });

  const claudeFailure = claudeRuntimeEvent({
    type: "result",
    subtype: "error",
    is_error: true,
    result: "private output containing claude-result-secret",
  });
  assert.equal(claudeFailure?.error, "Claude turn failed");
  assert.doesNotMatch(JSON.stringify(claudeFailure), /claude-result-secret/u);

  const receivedAt = Date.now();
  const eventWithLifecycleTime = codexRuntimeEvent({
    method: "item/started",
    params: {
      startedAtMs: 1,
      item: { id: "task-1", type: "agentTask" },
    },
  });
  assert.ok(Date.parse(eventWithLifecycleTime?.at ?? "") >= receivedAt);
});

test("custom harness sessions persist and enforce the adapter driver", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-provider-custom-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const session = await createSession(
    root,
    "kimex",
    "custom-driver",
    "claude-agent-sdk",
  );
  await session.providerStarted("kimex-native-session");
  await session.providerEvent(
    claudeRuntimeEvent({ type: "auth_status", isAuthenticated: true })!,
  );
  await session.complete("first turn");

  let record = await readSessionRecord(root, session.id);
  assert.equal(record.driver, "claude-agent-sdk");
  assert.equal(record.runtime?.identity?.provider, "kimex");
  assert.equal(record.runtime?.identity?.driver, "claude-agent-sdk");

  const resumed = await ManagedSessionTurn.resume(
    path.join(root, "run"),
    session.id,
    "claude-agent-sdk",
  );
  record = await readSessionRecord(root, session.id);
  assert.equal(record.runtime?.identity?.freshness, "stale");
  await assert.rejects(
    resumed.providerEvent({
      id: "wrong-driver",
      type: "fixture.wrong-driver",
      source: "codex-app-server",
      at: new Date(Date.now() + 1_000).toISOString(),
    }),
    /does not match session driver claude-agent-sdk/u,
  );
  await resumed.fail("test cleanup");
});

test("provider runtime history and progress remain bounded", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-provider-history-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const session = await createSession(root, "codex", "bounded-history");

  const startedAt = Date.now() + 60_000;
  for (let index = 0; index < 60; index++) {
    await session.providerEvent({
      id: `fixture-event-${index}`,
      type: `fixture.${index}`,
      source: "codex-app-server",
      at: new Date(startedAt + index).toISOString(),
      activity: "running",
      progress: {
        id: `task-${index}`,
        kind: "task",
        status: "running",
        updatedAt: new Date(startedAt + index).toISOString(),
      },
    });
  }

  const record = await readSessionRecord(root, session.id);
  assert.equal(record.runtime?.recentEvents.length, 48);
  assert.equal(record.runtime?.recentEvents[0]?.type, "fixture.12");
  assert.equal(record.runtime?.recentEvents.at(-1)?.type, "fixture.59");
  assert.equal(record.runtime?.progress.length, 48);
  assert.equal(record.runtime?.progress[0]?.id, "task-12");
  assert.equal(record.runtime?.progress.at(-1)?.id, "task-59");
});

test("provider failure becomes uncertain, redacts the cause, and exposes no resume/control path", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-provider-uncertain-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const session = await createSession(root, "codex", "uncertain-provider");
  await session.providerStarted("native-thread");
  await session.fail("provider disconnected with Bearer failed-provider-token");

  const record = (await listWorkflowSessions(path.join(root, "run")))[0];
  assert.ok(record);
  assert.equal(record.status, "uncertain");
  assert.equal(record.runtime?.activity, "failed");
  assert.match(record.runtime?.lastError ?? "", /\[REDACTED\]/u);
  assert.doesNotMatch(JSON.stringify(record.runtime), /failed-provider-token/u);
  assert.doesNotMatch(JSON.stringify(record.lastError), /failed-provider-token/u);
  assert.equal(record.resume, undefined);
  await assert.rejects(
    requestSessionControl(path.join(root, "run"), session.id, "interrupt"),
    /is not running; use session resume to continue it/u,
  );
});

async function createSession(
  root: string,
  harness: string,
  step: string,
  explicitDriver?: HarnessDriver,
): Promise<ManagedSessionTurn> {
  const driver: HarnessDriver = explicitDriver ?? (harness === "claude"
    ? "claude-agent-sdk"
    : harness === "pi"
      ? "pi-rpc"
      : "codex-app-server");
  return await ManagedSessionTurn.create(
    path.join(root, "run"),
    "20260807195000-0123456789",
    `root/agent:1:${step}`,
    { harness, cwd: root },
    root,
    driver,
  );
}

async function readSessionRecord(root: string, sessionId: string): Promise<any> {
  return JSON.parse(
    await readFile(path.join(root, "run", "sessions", sessionId, "session.json"), "utf8"),
  ) as any;
}

async function waitForSession(
  root: string,
  sessionId: string,
  predicate: (record: any) => boolean,
): Promise<any> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const record = await readSessionRecord(root, sessionId);
    if (predicate(record)) return record;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for provider runtime state for ${sessionId}`);
}

function agentRequest(root: string, harness: string, session: SessionTurn): AgentRequest {
  return {
    harness,
    prompt: "Return a short answer",
    cwd: root,
    timeoutMs: 5_000,
    runDir: path.join(root, "run"),
    stepId: `root/agent:1:${harness}`,
    session,
  };
}

function codexLiveStateScript(): string {
  return `
const readline = require("node:readline")
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n")
const baseTime = Date.now() + 1000
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line)
  if (message.method === "initialize") send({ id: message.id, result: {} })
  if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "codex-thread" } } })
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "codex-turn" } } })
    setImmediate(() => {
      send({ method: "account/updated", params: { threadId: "codex-thread", turnId: "codex-turn", emittedAtMs: baseTime, account: { id: "acct-1", email: "codex@example.test", accessToken: "native-secret" } } })
      send({ method: "thread/tokenUsage/updated", params: { threadId: "codex-thread", turnId: "codex-turn", emittedAtMs: baseTime + 1, tokenUsage: { total: { totalTokens: 126, inputTokens: 120, cachedInputTokens: 0, outputTokens: 6, reasoningOutputTokens: 0 } } } })
      send({ method: "item/started", params: { threadId: "codex-thread", turnId: "codex-turn", emittedAtMs: baseTime + 2, item: { type: "agentTask", id: "agent-task-1", name: "Research" } } })
      send({ method: "item/started", params: { threadId: "codex-thread", turnId: "codex-turn", emittedAtMs: baseTime + 3, item: { type: "commandExecution", id: "command-1", command: "git status", parentId: "agent-task-1" } } })
      setTimeout(() => send({ method: "turn/completed", params: { threadId: "codex-thread", turnId: "codex-turn", emittedAtMs: baseTime + 4, turn: { id: "codex-turn", status: "completed", items: [{ type: "agentMessage", id: "answer-1", text: "done", phase: "final_answer" }] } } }), 200)
    })
  }
})
`;
}

function fakeQuery(messages: SDKMessage[]): Query {
  const generator = (async function* (): AsyncGenerator<SDKMessage, void> {
    for (const message of messages) {
      await new Promise((resolve) => setImmediate(resolve));
      yield message;
    }
  })();
  return Object.assign(generator, { interrupt: async () => undefined, close() {} }) as unknown as Query;
}

function systemMessage(sessionId: string): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
  } as unknown as SDKMessage;
}

async function writeExecutable(filePath: string, body: string): Promise<void> {
  await writeFile(filePath, `#!/usr/bin/env node\n${body}\n`);
  await chmod(filePath, 0o755);
}

type _JsonValueCompileGuard = JsonValue;
