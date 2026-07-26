import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  Options as ClaudeOptions,
  Query,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ClaudeHarness } from "../src/harnesses/claude.js";
import { CodexHarness } from "../src/harnesses/codex.js";
import type {
  AgentRequest,
  JsonSchema,
  SessionControlRequest,
  SessionTurn,
} from "../src/types.js";

const schema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: { answer: { type: "string" } },
};

test("Codex adapter uses app-server, persists the thread, and never invokes exec", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-codex-app-server-"));
  const command = path.join(root, "fake-codex");
  await executable(command, codexServerScript());
  const session = new FakeSession();
  const harness = new CodexHarness(command);
  const result = await harness.execute(request(root, "codex", session));

  assert.deepEqual(result.output, { answer: "codex" });
  assert.equal(result.nativeSessionId, "codex-thread");
  assert.equal(session.providerId, "codex-thread");
  assert.equal(session.turnId, "codex-turn");
  assert.deepEqual(result.metadata?.usage, {
    total: {
      totalTokens: 16,
      inputTokens: 12,
      cachedInputTokens: 0,
      outputTokens: 4,
      reasoningOutputTokens: 0,
    },
  });

  const args = JSON.parse(await readFile(path.join(root, "codex-args.json"), "utf8")) as string[];
  assert.deepEqual(args, ["--profile", "test-profile", "app-server", "--stdio"]);
  assert.ok(!args.includes("exec"));
  const requests = (await readFile(path.join(root, "codex-requests.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
  assert.deepEqual(
    requests.map((entry) => entry.method),
    ["initialize", "initialized", "thread/start", "turn/start"],
  );
  assert.equal(requests[2]?.params?.ephemeral, false);
  assert.equal(requests[2]?.params?.sandbox, "danger-full-access");
  assert.equal(requests[2]?.params?.approvalPolicy, "never");
  assert.deepEqual(requests[3]?.params?.sandboxPolicy, { type: "dangerFullAccess" });
});

test("Codex adapter accepts a streamed final message when completed turn items are not loaded", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-codex-streamed-final-"));
  const command = path.join(root, "fake-codex");
  await executable(command, codexServerScript({ unloadedTurnItems: true }));
  const result = await new CodexHarness(command).execute(
    request(root, "codex", new FakeSession()),
  );

  assert.deepEqual(result.output, { answer: "codex" });
});

test("Codex resumes a persisted native thread and steers the active turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-codex-steer-"));
  const command = path.join(root, "fake-codex");
  await executable(command, codexServerScript({ waitForSteer: true }));
  const session = new FakeSession("existing-thread", [
    { id: "control-1", kind: "steer", message: "Focus on the race." },
  ]);
  const result = await new CodexHarness(command).execute(request(root, "codex", session));
  assert.deepEqual(result.output, { answer: "steered" });
  assert.deepEqual(session.controlResults, [{ turnId: "codex-turn" }]);
  const requests = (await readFile(path.join(root, "codex-requests.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
  assert.deepEqual(
    requests.map((entry) => entry.method),
    ["initialize", "initialized", "thread/resume", "turn/start", "turn/steer"],
  );
  assert.equal(requests[2]?.params?.threadId, "existing-thread");
  assert.equal(requests[4]?.params?.expectedTurnId, "codex-turn");
});

test("Codex forks a read-only side-query thread without resuming the parent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-codex-fork-"));
  const command = path.join(root, "fake-codex");
  await executable(command, codexServerScript());
  const input: AgentRequest = {
    ...request(root, "codex", new FakeSession()),
    forkSessionId: "parent-thread",
    readOnly: true,
  };
  const result = await new CodexHarness(command).execute(input);

  assert.equal(result.nativeSessionId, "codex-fork");
  const requests = (await readFile(path.join(root, "codex-requests.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
  assert.deepEqual(
    requests.map((entry) => entry.method),
    ["initialize", "initialized", "thread/fork", "turn/start"],
  );
  assert.equal(requests[2]?.params?.threadId, "parent-thread");
  assert.equal(requests[2]?.params?.sandbox, "read-only");
  assert.deepEqual(requests[3]?.params?.sandboxPolicy, { type: "readOnly" });
});

test("Claude adapter uses a persistent Agent SDK streaming session and resumes by ID", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-claude-sdk-"));
  let captured:
    | { prompt: string | AsyncIterable<SDKUserMessage>; options?: ClaudeOptions }
    | undefined;
  const factory = (input: {
    prompt: string | AsyncIterable<SDKUserMessage>;
    options?: ClaudeOptions;
  }): Query => {
    captured = input;
    return fakeQuery([
      systemMessage("claude-session"),
      successResult("claude-session", { answer: "claude" }),
    ]);
  };
  const session = new FakeSession("claude-session");
  const result = await new ClaudeHarness("claude", factory).execute(
    request(root, "claude", session),
  );
  assert.deepEqual(result.output, { answer: "claude" });
  assert.equal(result.nativeSessionId, "claude-session");
  assert.equal(captured?.options?.resume, "claude-session");
  assert.equal(captured?.options?.persistSession, true);
  assert.equal(captured?.options?.permissionMode, "bypassPermissions");
  assert.equal(captured?.options?.allowDangerouslySkipPermissions, true);
  assert.deepEqual(captured?.options?.settingSources, ["user", "project", "local"]);
  assert.deepEqual(captured?.options?.systemPrompt, {
    type: "preset",
    preset: "claude_code",
  });
  assert.deepEqual(captured?.options?.tools, { type: "preset", preset: "claude_code" });
});

test("a custom Claude surface uses its launcher while preserving Agent SDK sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-custom-claude-sdk-"));
  let captured:
    | { prompt: string | AsyncIterable<SDKUserMessage>; options?: ClaudeOptions }
    | undefined;
  const factory = (input: {
    prompt: string | AsyncIterable<SDKUserMessage>;
    options?: ClaudeOptions;
  }): Query => {
    captured = input;
    return fakeQuery([
      systemMessage("gateway-session"),
      successResult("gateway-session", { answer: "gateway" }),
    ]);
  };
  const result = await new ClaudeHarness("gateway-launcher", factory, "gateway-claude").execute(
    request(root, "gateway-claude", new FakeSession()),
  );

  assert.deepEqual(result.output, { answer: "gateway" });
  assert.equal(result.nativeSessionId, "gateway-session");
  assert.equal(captured?.options?.pathToClaudeCodeExecutable, "gateway-launcher");
  assert.equal(captured?.options?.persistSession, true);
  assert.equal(result.metadata?.harness, "claude-agent-sdk");
  assert.equal(result.metadata?.surface, "gateway-claude");
});

test("Claude forks a read-only side-query session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-claude-fork-"));
  let captured:
    | { prompt: string | AsyncIterable<SDKUserMessage>; options?: ClaudeOptions }
    | undefined;
  const factory = (input: {
    prompt: string | AsyncIterable<SDKUserMessage>;
    options?: ClaudeOptions;
  }): Query => {
    captured = input;
    return fakeQuery([
      systemMessage("claude-fork"),
      successResult("claude-fork", { answer: "forked" }),
    ]);
  };
  const input: AgentRequest = {
    ...request(root, "claude", new FakeSession()),
    forkSessionId: "claude-parent",
    readOnly: true,
  };
  const result = await new ClaudeHarness("claude", factory).execute(input);

  assert.equal(result.nativeSessionId, "claude-fork");
  assert.equal(captured?.options?.resume, "claude-parent");
  assert.equal(captured?.options?.forkSession, true);
  assert.equal(captured?.options?.permissionMode, "plan");
  assert.equal(captured?.options?.allowDangerouslySkipPermissions, false);
});

test("Claude maps Jaeger steer to interrupt plus a queued message in the same session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-claude-steer-"));
  let interrupted = 0;
  let streamedPrompt: string | undefined;
  const factory = (input: {
    prompt: string | AsyncIterable<SDKUserMessage>;
    options?: ClaudeOptions;
  }): Query => {
    void (async () => {
      const messages: SDKUserMessage[] = [];
      for await (const message of input.prompt as AsyncIterable<SDKUserMessage>) {
        messages.push(message);
        if (messages.length === 2) {
          const content = messages[1]?.message.content;
          streamedPrompt = typeof content === "string" ? content : undefined;
          break;
        }
      }
    })();
    return fakeQuery(
      [
        systemMessage("claude-session"),
        errorResult("claude-session", "interrupted"),
        successResult("claude-session", { answer: "steered" }),
      ],
      async () => {
        interrupted++;
      },
    );
  };
  const session = new FakeSession(undefined, [
    { id: "control-1", kind: "steer", message: "Take the safer approach." },
  ]);
  const result = await new ClaudeHarness("claude", factory).execute(
    request(root, "claude", session),
  );
  assert.deepEqual(result.output, { answer: "steered" });
  assert.equal(interrupted, 1);
  assert.equal(streamedPrompt, "Take the safer approach.");
  assert.equal(session.controlResults[0]?.steered, true);
});

test("Claude requires the dedicated structured output field when a schema is requested", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-claude-missing-structured-"));
  const result = successResult("claude-session", undefined);
  delete (result as { structured_output?: unknown }).structured_output;
  const factory = (): Query => fakeQuery([systemMessage("claude-session"), result]);
  await assert.rejects(
    new ClaudeHarness("claude", factory).execute(
      request(root, "claude", new FakeSession()),
    ),
    /missing structured_output for the requested schema/,
  );
});

class FakeSession implements SessionTurn {
  readonly id = "session-test";
  providerId: string | undefined;
  turnId: string | undefined;
  readonly controlResults: Array<Record<string, unknown>> = [];

  constructor(
    readonly nativeSessionId?: string,
    private readonly controls: SessionControlRequest[] = [],
  ) {}

  async providerStarted(nativeSessionId: string): Promise<void> {
    this.providerId = nativeSessionId;
  }

  async turnStarted(nativeTurnId?: string): Promise<void> {
    this.turnId = nativeTurnId;
  }

  async processControls(
    handler: (request: SessionControlRequest) => Promise<Record<string, JsonValue> | void>,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const control of this.controls) {
      const result = await handler(control);
      this.controlResults.push(result ?? {});
    }
    if (!signal?.aborted) {
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
    }
  }
}

type JsonValue = import("../src/types.js").JsonValue;

function request(
  root: string,
  harness: string,
  session: SessionTurn,
): AgentRequest {
  return {
    harness,
    prompt: "Return an answer",
    label: "test",
    model: "test-model",
    effort: "low",
    ...(harness === "codex" ? { serviceTier: "default", profile: "test-profile" } : {}),
    cwd: root,
    schema,
    timeoutMs: 10_000,
    runDir: path.join(root, "run"),
    stepId: "root/agent:1:test",
    session,
  };
}

function codexServerScript(
  options: { waitForSteer?: boolean; unloadedTurnItems?: boolean } = {},
): string {
  return `
const fs = require("node:fs")
const path = require("node:path")
const readline = require("node:readline")
fs.writeFileSync(path.join(process.cwd(), "codex-args.json"), JSON.stringify(process.argv.slice(2)))
const requests = path.join(process.cwd(), "codex-requests.jsonl")
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n")
const complete = (answer) => {
  send({ method: "thread/tokenUsage/updated", params: { threadId: "codex-thread", turnId: "codex-turn", tokenUsage: { total: { totalTokens: 16, inputTokens: 12, cachedInputTokens: 0, outputTokens: 4, reasoningOutputTokens: 0 } } } })
  const finalMessage = { type: "agentMessage", id: "message-1", text: JSON.stringify({ answer }), phase: "final_answer", memoryCitation: null }
  ${options.unloadedTurnItems ? 'send({ method: "item/completed", params: { threadId: "codex-thread", turnId: "codex-turn", item: finalMessage } })' : ""}
  send({ method: "turn/completed", params: { threadId: "codex-thread", turn: { id: "codex-turn", status: "completed", items: ${options.unloadedTurnItems ? "[]" : "[finalMessage]"}${options.unloadedTurnItems ? ', itemsView: "notLoaded"' : ""} } } })
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line)
  fs.appendFileSync(requests, JSON.stringify(message) + "\\n")
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fake" } })
  if (message.method === "thread/start" || message.method === "thread/resume" || message.method === "thread/fork") send({ id: message.id, result: { thread: { id: message.method === "thread/resume" ? message.params.threadId : message.method === "thread/fork" ? "codex-fork" : "codex-thread" } } })
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "codex-turn" } } })
    ${options.waitForSteer ? "" : 'setImmediate(() => complete("codex"))'}
  }
  if (message.method === "turn/steer") {
    send({ id: message.id, result: { turnId: "codex-turn" } })
    setImmediate(() => complete("steered"))
  }
  if (message.method === "turn/interrupt") send({ id: message.id, result: {} })
})
`;
}

function fakeQuery(
  messages: SDKMessage[],
  interrupt: Query["interrupt"] = async () => undefined,
): Query {
  const generator = (async function* (): AsyncGenerator<SDKMessage, void> {
    for (const message of messages) {
      await new Promise((resolve) => setImmediate(resolve));
      yield message;
    }
  })();
  return Object.assign(generator, {
    interrupt,
    close() {},
  }) as unknown as Query;
}

function systemMessage(sessionId: string): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    uuid: "00000000-0000-4000-8000-000000000001",
    session_id: sessionId,
    apiKeySource: "none",
    cwd: "/tmp",
    tools: [],
    mcp_servers: [],
    model: "claude-test",
    permissionMode: "bypassPermissions",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    claude_code_version: "2.1.212",
  } as unknown as SDKMessage;
}

function successResult(sessionId: string, structuredOutput: unknown): SDKResultMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 420,
    duration_api_ms: 300,
    is_error: false,
    num_turns: 2,
    result: "ok",
    stop_reason: null,
    total_cost_usd: 0.012,
    usage: { input_tokens: 8, output_tokens: 3 },
    modelUsage: {},
    permission_denials: [],
    uuid: "00000000-0000-4000-8000-000000000002",
    session_id: sessionId,
    structured_output: structuredOutput,
  } as unknown as SDKResultMessage;
}

function errorResult(sessionId: string, error: string): SDKResultMessage {
  return {
    type: "result",
    subtype: "error_during_execution",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: true,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    errors: [error],
    uuid: "00000000-0000-4000-8000-000000000003",
    session_id: sessionId,
  } as unknown as SDKResultMessage;
}

async function executable(filePath: string, body: string): Promise<void> {
  await writeFile(filePath, `#!/usr/bin/env node\n${body}\n`);
  await chmod(filePath, 0o755);
}
