import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { parseStructuredOutput } from "../schema.js";
import type {
  AgentOptions,
  AgentRequest,
  HarnessAdapter,
  HarnessResult,
  JsonValue,
  SessionControlRequest,
} from "../types.js";
import {
  spawnStreamingHarnessProcess,
  type StreamingHarnessProcess,
  type StreamingHarnessProcessResult,
} from "./process.js";
import { jsonObject, nonEmptyString, stepScratchDirectory } from "./support.js";

const PI_RPC_FRAME_LIMIT_BYTES = 8 * 1024 * 1024;
const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
const PI_DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

type JsonObject = Record<string, unknown>;

export class PiHarness implements HarnessAdapter {
  readonly driver = "pi-rpc" as const;

  constructor(
    private readonly command = "pi",
    readonly name = "pi",
  ) {}

  validateOptions(options: AgentOptions): void {
    if (options.profile !== undefined) {
      throw new TypeError(`${this.name} does not support the Codex profile option`);
    }
    if (options.serviceTier !== undefined) {
      throw new TypeError(`${this.name} does not support the Codex serviceTier option`);
    }
    if (
      options.effort !== undefined &&
      !PI_THINKING_LEVELS.includes(options.effort as (typeof PI_THINKING_LEVELS)[number])
    ) {
      throw new TypeError(
        `${this.name} effort must be off, minimal, low, medium, high, or xhigh`,
      );
    }
  }

  async execute(request: AgentRequest): Promise<HarnessResult> {
    this.validateOptions(request);
    const abort = turnAbortController(request);
    const sessionDirectory = path.join(request.runDir, "harness", "pi-sessions");
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    await chmod(sessionDirectory, 0o700);
    const nativeSessionId = piSessionId(
      request.session.nativeSessionId ?? request.session.id,
    );
    const args = [
      "--mode",
      "rpc",
      request.readOnly ? "--no-approve" : "--approve",
      "--session-dir",
      sessionDirectory,
      ...(request.forkSessionId
        ? ["--fork", request.forkSessionId, "--session-id", nativeSessionId]
        : ["--session-id", nativeSessionId]),
      ...(request.label && !request.session.nativeSessionId
        ? ["--name", `Jaeger: ${request.label}`]
        : []),
      ...(request.model ? ["--model", request.model] : []),
      ...(request.effort ? ["--thinking", request.effort] : []),
      ...(request.readOnly ? ["--tools", "read,grep,find,ls"] : []),
    ];
    const processHandle = spawnStreamingHarnessProcess({
      command: this.command,
      args,
      cwd: request.cwd,
      transcriptDir: stepScratchDirectory(request.runDir, request.stepId),
      signal: abort.signal,
      // Pi message_update frames contain the full partial message and can grow
      // quadratically. The strict RPC parser below owns stdout framing instead.
      recordStdout: false,
    });
    const client = new PiRpcClient(processHandle);
    let controlAbort: AbortController | undefined;
    let interrupted = false;
    try {
      const state = await client.request("get_state");
      const stateData = requiredObject(state.data, "Pi get_state data");
      const publishedSessionId = requiredString(stateData.sessionId, "Pi session id");
      await request.session.providerStarted(publishedSessionId);

      const initialMessageCount = optionalNonNegativeInteger(stateData.messageCount) ?? 0;
      const settledGeneration = client.settledGeneration;
      await client.request("prompt", {
        message: piPrompt(request),
      });
      await request.session.turnStarted();
      const promptState = requiredObject(
        (await client.request("get_state")).data,
        "Pi post-prompt get_state data",
      );
      const promptIsStreaming = requiredBoolean(
        promptState.isStreaming,
        "Pi post-prompt streaming state",
      );
      if (
        !promptIsStreaming &&
        client.settledGeneration <= settledGeneration
      ) {
        throw new Error("Pi prompt completed without starting an agent turn");
      }

      controlAbort = new AbortController();
      const controls = request.session.processControls(async (control) => {
        const result = await handleControl(client, control);
        if (control.kind === "interrupt") interrupted = true;
        return result;
      }, controlAbort.signal);
      await client.waitForSettled(settledGeneration, abort.signal);
      controlAbort.abort();
      await controls;
      if (interrupted) {
        throw new Error("Pi session turn was interrupted by the Jaeger user");
      }

      const assistant = client.lastAssistant;
      if (assistant?.stopReason && assistant.stopReason !== "stop") {
        throw new Error(`Pi assistant stopped with reason ${assistant.stopReason}`);
      }
      let finalText = assistantText(assistant);
      if (!finalText) {
        const finalState = await client.request("get_state");
        const finalData = requiredObject(finalState.data, "Pi get_state data");
        const finalCount = optionalNonNegativeInteger(finalData.messageCount) ?? 0;
        if (finalCount <= initialMessageCount) {
          throw new Error("Pi settled without producing a new assistant message");
        }
        const last = await client.request("get_last_assistant_text");
        const lastData = requiredObject(last.data, "Pi get_last_assistant_text data");
        finalText = nonEmptyString(lastData.text);
      }
      if (!finalText) {
        throw new Error("Pi settled without a final assistant text response");
      }

      client.closeInput();
      const processResult = await processHandle.done;
      assertCleanProcessExit(this.command, args, processResult);
      const output = request.schema
        ? parseStructuredOutput(finalText.trim(), request.schema)
        : finalText.trim();
      return {
        output,
        nativeSessionId: publishedSessionId,
        metadata: {
          harness: "pi-rpc",
          surface: this.name,
          sessionDirectory,
          transcripts: { stderr: processResult.stderrPath },
          ...(typeof assistant?.provider === "string"
            ? { provider: assistant.provider }
            : {}),
          ...(typeof assistant?.model === "string" ? { model: assistant.model } : {}),
          ...(jsonValue(assistant?.usage) !== undefined
            ? { usage: jsonValue(assistant?.usage) as JsonValue }
            : {}),
        },
      };
    } catch (error) {
      controlAbort?.abort();
      client.closeInput();
      processHandle.terminate("aborted");
      const processResult = await processHandle.done.catch(() => undefined);
      if (processResult && processResult.terminationReason === "output-limit") {
        throw new Error("Pi RPC stderr exceeded Jaeger's harness output limit", {
          cause: error,
        });
      }
      throw error;
    } finally {
      abort.dispose();
    }
  }
}

function piSessionId(value: string): string {
  if (/^[A-Za-z0-9._-]+$/.test(value)) return value;
  return `jaeger-${createHash("sha256").update(value).digest("hex")}`;
}

class PiRpcClient {
  private nextId = 1;
  private readonly pending = new Map<
    string,
    { readonly resolve: (value: JsonObject) => void; readonly reject: (error: Error) => void }
  >();
  private readonly settledWaiters = new Set<() => void>();
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private bufferedBytes = 0;
  private closedError: Error | undefined;
  settledGeneration = 0;
  lastAssistant: JsonObject | undefined;

  constructor(private readonly processHandle: StreamingHarnessProcess) {
    processHandle.child.stdout.on("data", (chunk: Buffer) => this.receiveChunk(chunk));
    processHandle.child.stdout.once("end", () => {
      const tail = this.decoder.end();
      if (tail) this.receiveText(tail);
      if (this.buffer.length > 0 && !this.closedError) {
        this.fail(new Error("Pi RPC stdout ended with an unterminated JSONL frame"));
      }
    });
    processHandle.child.once("close", (code, signal) => {
      this.fail(new Error(`Pi RPC exited (${String(code ?? signal)})`));
    });
  }

  request(type: string, fields: JsonObject = {}): Promise<JsonObject> {
    const id = `jaeger-${this.nextId++}`;
    return new Promise<JsonObject>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, type, ...fields });
    });
  }

  async waitForSettled(generation: number, signal?: AbortSignal): Promise<void> {
    while (this.settledGeneration <= generation) {
      if (this.closedError) throw this.closedError;
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Pi turn aborted");
      }
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          signal?.removeEventListener("abort", wake);
          this.settledWaiters.delete(wake);
          resolve();
        };
        this.settledWaiters.add(wake);
        signal?.addEventListener("abort", wake, { once: true });
      });
    }
  }

  closeInput(): void {
    if (!this.processHandle.child.stdin.destroyed) this.processHandle.child.stdin.end();
  }

  private receiveChunk(chunk: Buffer): void {
    if (this.closedError) return;
    this.bufferedBytes += chunk.length;
    if (this.bufferedBytes > PI_RPC_FRAME_LIMIT_BYTES && !chunk.includes(0x0a)) {
      this.fail(new Error("Pi RPC emitted a JSONL frame larger than 8 MiB"));
      this.processHandle.terminate("output-monitor-error");
      return;
    }
    this.receiveText(this.decoder.write(chunk));
  }

  private receiveText(text: string): void {
    this.buffer += text;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) {
        this.bufferedBytes = Buffer.byteLength(this.buffer);
        if (this.bufferedBytes > PI_RPC_FRAME_LIMIT_BYTES) {
          this.fail(new Error("Pi RPC emitted a JSONL frame larger than 8 MiB"));
          this.processHandle.terminate("output-monitor-error");
        }
        return;
      }
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.bufferedBytes = Buffer.byteLength(this.buffer);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length === 0) continue;
      if (Buffer.byteLength(line) > PI_RPC_FRAME_LIMIT_BYTES) {
        this.fail(new Error("Pi RPC emitted a JSONL frame larger than 8 MiB"));
        this.processHandle.terminate("output-monitor-error");
        return;
      }
      let message: JsonObject;
      try {
        message = requiredObject(JSON.parse(line), "Pi RPC frame");
      } catch (error) {
        this.fail(new Error("Pi RPC emitted invalid JSONL", { cause: error }));
        this.processHandle.terminate("output-monitor-error");
        return;
      }
      this.receiveMessage(message);
    }
  }

  private receiveMessage(message: JsonObject): void {
    if (message.type === "response" && typeof message.id === "string") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.success === false) {
        pending.reject(
          new Error(nonEmptyString(message.error) ?? "Pi RPC request failed"),
        );
      } else {
        pending.resolve(message);
      }
      return;
    }
    if (message.type === "extension_ui_request") {
      const id = nonEmptyString(message.id);
      if (id && PI_DIALOG_METHODS.has(String(message.method))) {
        this.write({ type: "extension_ui_response", id, cancelled: true });
      }
      return;
    }
    if (message.type === "agent_settled") {
      this.settledGeneration++;
      this.wakeSettled();
      return;
    }
    const candidate =
      message.type === "message_end"
        ? jsonObject(message.message)
        : message.type === "turn_end"
          ? jsonObject(message.message)
          : undefined;
    if (candidate?.role === "assistant") this.lastAssistant = candidate;
    if (message.type === "agent_end" && Array.isArray(message.messages)) {
      for (const entry of message.messages) {
        const candidate = jsonObject(entry);
        if (candidate?.role === "assistant") this.lastAssistant = candidate;
      }
    }
  }

  private write(message: JsonObject): void {
    if (this.processHandle.child.stdin.destroyed) {
      throw new Error("Pi RPC input is closed");
    }
    this.processHandle.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private fail(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.wakeSettled();
  }

  private wakeSettled(): void {
    for (const wake of [...this.settledWaiters]) wake();
  }
}

async function handleControl(
  client: PiRpcClient,
  control: SessionControlRequest,
): Promise<Record<string, JsonValue>> {
  if (control.kind === "steer") {
    if (!control.message) throw new Error("steer requires a message");
    await client.request("steer", { message: control.message });
    return { steered: true };
  }
  await client.request("abort");
  return { interrupted: true };
}

function piPrompt(request: AgentRequest): string {
  if (!request.schema) return request.prompt;
  return [
    "Return only one JSON value matching the supplied JSON Schema.",
    "Do not wrap it in Markdown or include any other text.",
    `JSON Schema: ${JSON.stringify(request.schema)}`,
    "",
    request.prompt,
  ].join("\n");
}

function assistantText(message: JsonObject | undefined): string | undefined {
  const content = message?.content;
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((entry) => {
      const block = jsonObject(entry);
      return block?.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .join("");
  return text.trim() || undefined;
}

function requiredObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function requiredString(value: unknown, label: string): string {
  const result = nonEmptyString(value);
  if (!result) throw new Error(`${label} must be a non-empty string`);
  return result;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function jsonValue(value: unknown): JsonValue | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value as JsonValue;
  }
  if (Array.isArray(value)) {
    const converted = value.map(jsonValue);
    return converted.every((entry) => entry !== undefined)
      ? (converted as JsonValue[])
      : undefined;
  }
  const object = jsonObject(value);
  if (!object) return undefined;
  const result: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(object)) {
    const converted = jsonValue(entry);
    if (converted === undefined) return undefined;
    result[key] = converted;
  }
  return result;
}

function assertCleanProcessExit(
  command: string,
  args: readonly string[],
  result: StreamingHarnessProcessResult,
): void {
  if (
    result.exitCode === 0 &&
    result.signal === null &&
    result.terminationReason === undefined
  ) {
    return;
  }
  const detail = result.stderr.trim();
  throw new Error(
    `${command} ${args.join(" ")} exited with ${String(
      result.exitCode ?? result.signal ?? result.terminationReason,
    )}${
      detail ? `: ${detail}` : ""
    }`,
  );
}

function turnAbortController(request: AgentRequest): {
  readonly signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(`Pi turn timed out after ${request.timeoutMs}ms`)),
    request.timeoutMs,
  );
  timeout.unref();
  const onAbort = (): void =>
    controller.abort(request.signal?.reason ?? new Error("Pi turn aborted"));
  request.signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
    },
  };
}
