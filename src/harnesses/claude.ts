import {
  query as claudeQuery,
  type Options as ClaudeOptions,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { validateStructuredOutput } from "../schema.js";
import { StructuredOutputError } from "../errors.js";
import type {
  AgentOptions,
  AgentRequest,
  HarnessAdapter,
  HarnessResult,
  JsonValue,
} from "../types.js";
import {
  spawnStreamingHarnessProcess,
  type StreamingHarnessProcess,
} from "./process.js";
import { jsonValue, stepScratchDirectory } from "./support.js";

type QueryFactory = (input: {
  readonly prompt: string | AsyncIterable<SDKUserMessage>;
  readonly options?: ClaudeOptions;
}) => Query;

export class ClaudeHarness implements HarnessAdapter {
  readonly driver = "claude-agent-sdk" as const;

  constructor(
    private readonly command = "claude",
    private readonly queryFactory: QueryFactory = claudeQuery,
    readonly name = "claude",
  ) {}

  validateOptions(options: AgentOptions): void {
    if (options.profile !== undefined) {
      throw new TypeError(`${this.name} does not support the Codex profile option`);
    }
    if (options.serviceTier !== undefined) {
      throw new TypeError(`${this.name} does not support the Codex serviceTier option`);
    }
  }

  async execute(request: AgentRequest): Promise<HarnessResult> {
    this.validateOptions(request);
    const abort = turnAbortController(request);
    const messages = new AsyncMessageQueue();
    messages.push(userMessage(request.prompt));
    let processHandle: StreamingHarnessProcess | undefined;
    let pendingInterruptedResult = 0;
    let explicitlyInterrupted = false;
    let sessionPublished = false;
    let result: SDKResultMessage | undefined;
    const scratch = stepScratchDirectory(request.runDir, request.stepId);

    const queryHandle = this.queryFactory({
      prompt: messages,
      options: {
        cwd: request.cwd,
        permissionMode: request.readOnly ? "plan" : "bypassPermissions",
        allowDangerouslySkipPermissions: !request.readOnly,
        persistSession: true,
        settingSources: ["user", "project", "local"],
        systemPrompt: { type: "preset", preset: "claude_code" },
        tools: { type: "preset", preset: "claude_code" },
        pathToClaudeCodeExecutable: this.command,
        abortController: abort.controller,
        includePartialMessages: true,
        ...(request.session.nativeSessionId
          ? { resume: request.session.nativeSessionId }
          : request.forkSessionId
            ? { resume: request.forkSessionId, forkSession: true }
          : {}),
        ...(request.model ? { model: request.model } : {}),
        ...(request.effort ? { effort: claudeEffort(request.effort) } : {}),
        ...(request.schema
          ? { outputFormat: { type: "json_schema", schema: request.schema } }
          : {}),
        ...(request.label ? { title: `Jaeger: ${request.label}` } : {}),
        spawnClaudeCodeProcess: (options) => {
          processHandle = spawnStreamingHarnessProcess({
            command: options.command,
            args: options.args,
            cwd: options.cwd ?? request.cwd,
            transcriptDir: scratch,
            env: options.env,
            signal: options.signal,
          });
          return processHandle.child;
        },
      },
    });

    const controlAbort = new AbortController();
    const controls = request.session.processControls(async (control) => {
      if (control.kind === "interrupt") {
        explicitlyInterrupted = true;
        const receipt = await queryHandle.interrupt();
        return {
          interrupted: true,
          ...(receipt ? { receipt: toJsonValue(receipt) } : {}),
        };
      }
      if (!control.message) throw new Error("steer requires a message");
      pendingInterruptedResult++;
      try {
        const receipt = await queryHandle.interrupt();
        messages.push(userMessage(control.message));
        return {
          steered: true,
          ...(receipt ? { receipt: toJsonValue(receipt) } : {}),
        };
      } catch (error) {
        pendingInterruptedResult--;
        throw error;
      }
    }, controlAbort.signal);

    try {
      for await (const message of queryHandle) {
        if (!sessionPublished) {
          const sessionId = sessionIdOf(message);
          if (sessionId) {
            await request.session.providerStarted(sessionId);
            await request.session.turnStarted();
            sessionPublished = true;
          }
        }
        if (message.type !== "result") continue;
        if (explicitlyInterrupted) {
          throw new Error("Claude session turn was interrupted by the Jaeger user");
        }
        if (pendingInterruptedResult > 0) {
          pendingInterruptedResult--;
          continue;
        }
        result = message;
        break;
      }
      if (!result) throw new Error("Claude session ended without a result message");
      if (!sessionPublished) {
        await request.session.providerStarted(result.session_id);
        await request.session.turnStarted();
      }
      if (result.subtype !== "success" || result.is_error) {
        throw new Error(
          `Claude session failed: ${
            result.subtype === "success" ? result.result : result.errors.join("; ")
          }`,
        );
      }
      const output = claudeOutput(result, request);
      const processResult = await closeQuery(queryHandle, processHandle);
      return {
        output,
        nativeSessionId: result.session_id,
        metadata: {
          harness: "claude-agent-sdk",
          surface: this.name,
          usage: toJsonValue(result.usage),
          modelUsage: toJsonValue(result.modelUsage),
          total_cost_usd: result.total_cost_usd,
          duration_ms: result.duration_ms,
          duration_api_ms: result.duration_api_ms,
          num_turns: result.num_turns,
          ...(processResult
            ? {
                transcripts: {
                  stdout: processResult.stdoutPath,
                  stderr: processResult.stderrPath,
                },
              }
            : {}),
        },
      };
    } finally {
      controlAbort.abort();
      messages.close();
      await controls;
      queryHandle.close();
      await processHandle?.done.catch(() => undefined);
      abort.dispose();
    }
  }
}

class AsyncMessageQueue implements AsyncIterable<SDKUserMessage> {
  private readonly values: SDKUserMessage[] = [];
  private readonly waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(value: SDKUserMessage): void {
    if (this.closed) throw new Error("Claude session input is closed");
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value) return { value, done: false };
        if (this.closed) return { value: undefined, done: true };
        return await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

function userMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    origin: { kind: "human" },
  };
}

function sessionIdOf(message: SDKMessage): string | undefined {
  return "session_id" in message && typeof message.session_id === "string"
    ? message.session_id
    : undefined;
}

function claudeOutput(result: Extract<SDKResultMessage, { subtype: "success" }>, request: AgentRequest): unknown {
  if (!request.schema) return result.result;
  if (!("structured_output" in result)) {
    throw new StructuredOutputError("Claude result is missing structured_output for the requested schema");
  }
  validateStructuredOutput(result.structured_output, request.schema);
  return result.structured_output;
}

async function closeQuery(
  queryHandle: Query,
  processHandle: StreamingHarnessProcess | undefined,
): Promise<Awaited<StreamingHarnessProcess["done"]> | undefined> {
  queryHandle.close();
  return await processHandle?.done;
}

function claudeEffort(value: string): "low" | "medium" | "high" | "xhigh" | "max" {
  if (["low", "medium", "high", "xhigh", "max"].includes(value)) {
    return value as "low" | "medium" | "high" | "xhigh" | "max";
  }
  throw new TypeError("Claude effort must be low, medium, high, xhigh, or max");
}

function toJsonValue(value: unknown): JsonValue {
  const converted = jsonValue(value);
  if (converted === undefined) throw new TypeError("Claude SDK metadata is not JSON-serializable");
  return converted;
}

function turnAbortController(request: AgentRequest): {
  readonly controller: AbortController;
  dispose(): void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(`Claude turn timed out after ${request.timeoutMs}ms`)),
    request.timeoutMs,
  );
  timeout.unref();
  const onAbort = (): void =>
    controller.abort(request.signal?.reason ?? new Error("Claude turn aborted"));
  request.signal?.addEventListener("abort", onAbort, { once: true });
  return {
    controller,
    dispose() {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
    },
  };
}
