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
import { PiHarness } from "../src/harnesses/pi.js";
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

test("Pi adapter uses strict RPC, persists its session, and validates structured output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-pi-rpc-"));
  const command = path.join(root, "fake-pi");
  await executable(command, piRpcScript());
  const session = new FakeSession();
  const result = await new PiHarness(command).execute(
    request(root, "pi", session),
  );

  assert.deepEqual(result.output, { answer: "pi\u2028rpc" });
  assert.equal(result.nativeSessionId, "session-test");
  assert.equal(session.providerId, "session-test");
  assert.equal(session.turnStartedCount, 1);
  assert.equal(result.metadata?.harness, "pi-rpc");
  assert.equal(
    result.metadata?.sessionDirectory,
    path.join(root, "run", "harness", "pi-sessions"),
  );
  const transcripts = result.metadata?.transcripts as
    | Record<string, unknown>
    | undefined;
  assert.equal(typeof transcripts?.stderr, "string");
  assert.equal("stdout" in (transcripts ?? {}), false);

  const args = JSON.parse(
    await readFile(path.join(root, "pi-args.json"), "utf8"),
  ) as string[];
  assert.deepEqual(args, [
    "--mode",
    "rpc",
    "--approve",
    "--session-dir",
    path.join(root, "run", "harness", "pi-sessions"),
    "--session-id",
    "session-test",
    "--model",
    "test-model",
    "--thinking",
    "low",
  ]);
  const requests = (await readFile(path.join(root, "pi-requests.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    requests.map((entry) => entry.type),
    ["get_state", "prompt"],
  );
  assert.match(String(requests[1]?.message), /Return only one JSON value/);
  assert.match(String(requests[1]?.message), /Return an answer/);
});

test("Pi resumes a native session and maps Jaeger steer to RPC steer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-pi-steer-"));
  const command = path.join(root, "fake-pi");
  await executable(command, piRpcScript({ waitForSteer: true }));
  const session = new FakeSession("pi-existing", [
    { id: "control-1", kind: "steer", message: "Take the safer approach." },
  ]);
  const result = await new PiHarness(command).execute(
    request(root, "pi", session),
  );

  assert.deepEqual(result.output, { answer: "steered" });
  assert.equal(session.controlResults[0]?.steered, true);
  const args = JSON.parse(
    await readFile(path.join(root, "pi-args.json"), "utf8"),
  ) as string[];
  assert.equal(args[args.indexOf("--session-id") + 1], "pi-existing");
  const requests = (await readFile(path.join(root, "pi-requests.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    requests.map((entry) => entry.type),
    ["get_state", "prompt", "steer"],
  );
  assert.equal(requests[2]?.message, "Take the safer approach.");
});

test("Pi forks a read-only side-query with a distinct deterministic session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-pi-fork-"));
  const command = path.join(root, "fake-pi");
  await executable(command, piRpcScript());
  const input: AgentRequest = {
    ...request(root, "pi", new FakeSession()),
    forkSessionId: "pi-parent",
    readOnly: true,
  };
  const result = await new PiHarness(command).execute(input);

  assert.equal(result.nativeSessionId, "session-test");
  const args = JSON.parse(
    await readFile(path.join(root, "pi-args.json"), "utf8"),
  ) as string[];
  assert.equal(args[args.indexOf("--fork") + 1], "pi-parent");
  assert.equal(args[args.indexOf("--session-id") + 1], "session-test");
  assert.equal(args.includes("--no-approve"), true);
  assert.equal(args.includes("--approve"), false);
  assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls");
});

test("Pi cancels blocking extension UI dialogs instead of hanging headless RPC", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-pi-ui-"));
  const command = path.join(root, "fake-pi");
  await executable(command, piRpcScript({ requestUi: true }));
  const result = await new PiHarness(command).execute(
    request(root, "pi", new FakeSession()),
  );

  assert.deepEqual(result.output, { answer: "pi\u2028rpc" });
  const requests = (await readFile(path.join(root, "pi-requests.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(requests.at(-1), {
    type: "extension_ui_response",
    id: "dialog-1",
    cancelled: true,
  });
});

test("Pi RPC ignores accumulated partial-message volume in bounded transcripts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-pi-volume-"));
  const command = path.join(root, "fake-pi");
  await executable(command, piRpcScript({ floodUpdates: true }));
  const result = await new PiHarness(command).execute(
    request(root, "pi", new FakeSession()),
  );

  assert.deepEqual(result.output, { answer: "pi\u2028rpc" });
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

test("Claude preserves xhigh effort and applies its native session label", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-claude-compat-"));
  let captured:
    | { prompt: string | AsyncIterable<SDKUserMessage>; options?: ClaudeOptions }
    | undefined;
  const renamed: Array<{
    sessionId: string;
    title: string;
    options: { dir?: string } | undefined;
  }> = [];
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
  const input: AgentRequest = {
    ...request(root, "claude", new FakeSession()),
    label: "test",
    effort: "xhigh",
  };

  await new ClaudeHarness(
    "claude",
    factory,
    "claude",
    async (sessionId, title, options) => {
      renamed.push({ sessionId, title, options });
    },
  ).execute(input);

  assert.equal((captured?.options as { effort?: string } | undefined)?.effort, "xhigh");
  assert.ok(!("title" in (captured?.options ?? {})));
  assert.deepEqual(renamed, [
    {
      sessionId: "claude-session",
      title: "Jaeger: test",
      options: { dir: root },
    },
  ]);
});

test("Claude session label failures do not abort a successful turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-claude-label-failure-"));
  const session = new FakeSession();
  let renameAttempts = 0;
  const factory = (): Query =>
    fakeQuery([
      systemMessage("claude-session"),
      successResult("claude-session", { answer: "claude" }),
    ]);
  const input: AgentRequest = {
    ...request(root, "claude", session),
    label: "test",
  };

  const result = await new ClaudeHarness(
    "claude",
    factory,
    "claude",
    async () => {
      renameAttempts++;
      throw new Error("Session not found in project directory");
    },
  ).execute(input);

  assert.deepEqual(result.output, { answer: "claude" });
  assert.equal(result.nativeSessionId, "claude-session");
  assert.equal(renameAttempts, 1);
  assert.equal(session.providerId, "claude-session");
  assert.equal(session.turnStartedCount, 1);
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
  nativeSessionId: string | undefined;
  providerId: string | undefined;
  turnId: string | undefined;
  turnStartedCount = 0;
  readonly controlResults: Array<Record<string, unknown>> = [];

  constructor(
    nativeSessionId?: string,
    private readonly controls: SessionControlRequest[] = [],
  ) {
    this.nativeSessionId = nativeSessionId;
  }

  async providerStarted(nativeSessionId: string): Promise<void> {
    this.providerId = nativeSessionId;
    this.nativeSessionId = nativeSessionId;
  }

  async turnStarted(nativeTurnId?: string): Promise<void> {
    this.turnStartedCount++;
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

function piRpcScript(
  options: {
    waitForSteer?: boolean;
    requestUi?: boolean;
    floodUpdates?: boolean;
  } = {},
): string {
  return `
const fs = require("node:fs")
const path = require("node:path")
const readline = require("node:readline")
const args = process.argv.slice(2)
fs.writeFileSync(path.join(process.cwd(), "pi-args.json"), JSON.stringify(args))
const requests = path.join(process.cwd(), "pi-requests.jsonl")
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n")
const sessionIndex = args.indexOf("--session-id")
const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : "pi-session"
const complete = (answer) => {
  const message = {
    role: "assistant",
    content: [{ type: "text", text: JSON.stringify({ answer }) }],
    provider: "test-provider",
    model: "test-model",
    usage: { input: 3, output: 2 },
    stopReason: "stop"
  }
  send({ type: "message_end", message })
  send({ type: "agent_settled" })
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line)
  fs.appendFileSync(requests, JSON.stringify(message) + "\\n")
  if (message.type === "get_state") {
    send({
      id: message.id,
      type: "response",
      command: "get_state",
      success: true,
      data: {
        sessionId,
        thinkingLevel: "low",
        isStreaming: false,
        isCompacting: false,
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
        autoCompactionEnabled: true,
        messageCount: 0,
        pendingMessageCount: 0
      }
    })
    return
  }
  if (message.type === "prompt") {
    send({ id: message.id, type: "response", command: "prompt", success: true })
    ${options.floodUpdates ? 'for (let index = 0; index < 18; index++) send({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(1024 * 1024) }] } })' : ""}
    ${options.requestUi ? 'send({ type: "extension_ui_request", id: "dialog-1", method: "confirm", title: "Continue?", message: "Approve" })' : options.waitForSteer ? "" : 'setImmediate(() => complete("pi\\u2028rpc"))'}
    return
  }
  if (message.type === "extension_ui_response") {
    setImmediate(() => complete("pi\\u2028rpc"))
    return
  }
  if (message.type === "steer") {
    send({ id: message.id, type: "response", command: "steer", success: true })
    setImmediate(() => complete("steered"))
  }
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
