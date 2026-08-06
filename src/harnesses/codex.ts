import { HarnessExecutionError } from "../errors.js";
import { parseStructuredOutput } from "../schema.js";
import type {
  AgentRequest,
  HarnessAdapter,
  HarnessResult,
  JsonValue,
  SessionControlRequest,
} from "../types.js";
import { codexRuntimeEvent } from "../provider-runtime.js";
import { JAEGER_VERSION } from "../version.js";
import { prepareCodexThreadForUse } from "../codex-thread-state.js";
import { CodexAppServerClient } from "./codex-app-server-client.js";
import { spawnStreamingHarnessProcess } from "./process.js";
import { NativeRuntimeReporter } from "./runtime-events.js";
import { jsonObject, nonEmptyString, stepScratchDirectory } from "./support.js";

type JsonObject = Record<string, unknown>;

export class CodexHarness implements HarnessAdapter {
  readonly driver = "codex-app-server" as const;

  constructor(
    private readonly command = "codex",
    readonly name = "codex",
  ) {}

  async execute(request: AgentRequest): Promise<HarnessResult> {
    const controller = turnAbortController(request);
    const args = [
      ...(request.profile ? ["--profile", request.profile] : []),
      "app-server",
      "--stdio",
    ];
    const processHandle = spawnStreamingHarnessProcess({
      command: this.command,
      args,
      cwd: request.cwd,
      transcriptDir: stepScratchDirectory(request.runDir, request.stepId),
      signal: controller.signal,
    });
    const runtime = new NativeRuntimeReporter(request.session, codexRuntimeEvent);
    const client = new CodexAppServerClient(processHandle.child, (message) =>
      runtime.observe(message),
    );
    let completed = false;
    let controlAbort: AbortController | undefined;
    try {
      await client.request("initialize", {
        clientInfo: { name: "jaeger", title: "Jaeger", version: JAEGER_VERSION },
      });
      client.notify("initialized", {});

      const existingThreadId = request.forkSessionId ?? request.session.nativeSessionId;
      if (existingThreadId) {
        await prepareCodexThreadForUse(request.runDir, existingThreadId, client);
      }

      const threadResponse = await client.request(
        request.forkSessionId
          ? "thread/fork"
          : request.session.nativeSessionId
            ? "thread/resume"
            : "thread/start",
        request.forkSessionId
          ? {
              threadId: request.forkSessionId,
              cwd: request.cwd,
              approvalPolicy: "never",
              sandbox: request.readOnly ? "read-only" : "danger-full-access",
              ephemeral: false,
              ...(request.model ? { model: request.model } : {}),
              ...(request.serviceTier ? { serviceTier: request.serviceTier } : {}),
            }
          : request.session.nativeSessionId
            ? {
                threadId: request.session.nativeSessionId,
                cwd: request.cwd,
                approvalPolicy: "never",
                sandbox: request.readOnly ? "read-only" : "danger-full-access",
                ...(request.model ? { model: request.model } : {}),
                ...(request.serviceTier ? { serviceTier: request.serviceTier } : {}),
              }
            : {
                cwd: request.cwd,
                approvalPolicy: "never",
                sandbox: request.readOnly ? "read-only" : "danger-full-access",
                ephemeral: false,
                serviceName: "jaeger",
                ...(request.model ? { model: request.model } : {}),
                ...(request.serviceTier ? { serviceTier: request.serviceTier } : {}),
              },
      );
      const thread = objectField(threadResponse, "thread");
      const threadId = stringField(thread, "id");
      await runtime.flush();
      await request.session.providerStarted(threadId);

      const turnResponse = await client.request("turn/start", {
        threadId,
        input: [textInput(request.prompt)],
        cwd: request.cwd,
        approvalPolicy: "never",
        sandboxPolicy: request.readOnly
          ? { type: "readOnly" }
          : { type: "dangerFullAccess" },
        ...(request.model ? { model: request.model } : {}),
        ...(request.serviceTier ? { serviceTier: request.serviceTier } : {}),
        ...(request.effort ? { effort: request.effort } : {}),
        ...(request.schema ? { outputSchema: request.schema } : {}),
      });
      const turnId = stringField(objectField(turnResponse, "turn"), "id");
      await runtime.flush();
      await request.session.turnStarted(turnId);

      controlAbort = new AbortController();
      const controls = request.session.processControls(
        async (control) => await handleControl(client, threadId, turnId, control),
        controlAbort.signal,
      );
      const completion = await client.waitForNotification(
        (message) =>
          message.method === "turn/completed" &&
          stringField(objectField(message.params, "turn"), "id") === turnId,
        controller.signal,
      );
      completed = true;
      controlAbort.abort();
      await controls;

      const turn = objectField(completion.params, "turn");
      const status = stringField(turn, "status");
      if (status !== "completed") {
        throw new Error(`Codex turn ${turnId} ended with status ${status}`);
      }
      const finalMessage =
        finalAgentMessage(turn) ?? client.latestFinalMessageFor(turnId);
      if (!finalMessage) {
        throw new Error("Codex app-server turn completed without a final agent message");
      }
      const output = request.schema
        ? parseStructuredOutput(finalMessage.trim(), request.schema)
        : finalMessage.trim();
      const usage = client.latestUsageFor(turnId);
      await runtime.flush();

      client.closeInput();
      const processResult = await processHandle.done;
      if (processResult.exitCode !== 0 && processResult.exitCode !== null) {
        throw processFailure(this.command, args, processResult);
      }
      return {
        output,
        nativeSessionId: threadId,
        metadata: {
          harness: "codex-app-server",
          turnId,
          transcripts: {
            stdout: processResult.stdoutPath,
            stderr: processResult.stderrPath,
          },
          ...(usage ? { usage } : {}),
        },
      };
    } catch (error) {
      controlAbort?.abort();
      client.closeInput();
      await runtime.flush().catch(() => undefined);
      if (!completed) processHandle.terminate("aborted");
      const processResult = await processHandle.done.catch(() => undefined);
      if (
        processResult &&
        processResult.exitCode !== 0 &&
        !(error instanceof Error && error.message.includes("turn"))
      ) {
        throw processFailure(this.command, args, processResult, error);
      }
      throw error;
    } finally {
      controller.dispose();
    }
  }
}

async function handleControl(
  client: CodexAppServerClient,
  threadId: string,
  turnId: string,
  control: SessionControlRequest,
): Promise<Record<string, JsonValue>> {
  if (control.kind === "steer") {
    if (!control.message) throw new Error("steer requires a message");
    const result = await client.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: [textInput(control.message)],
    });
    return { turnId: nonEmptyString(result.turnId) ?? turnId };
  }
  await client.request("turn/interrupt", { threadId, turnId });
  return { turnId, interrupted: true };
}

function textInput(text: string): JsonObject {
  return { type: "text", text, text_elements: [] };
}

function finalAgentMessage(turn: JsonObject): string | undefined {
  const items = Array.isArray(turn.items) ? turn.items : [];
  const messages = items.filter(
    (item): item is JsonObject =>
      Boolean(item && typeof item === "object" && !Array.isArray(item)) &&
      (item as JsonObject).type === "agentMessage",
  );
  const final = messages.at(-1);
  return final && typeof final.text === "string" ? final.text : undefined;
}

function objectField(value: unknown, key: string): JsonObject {
  const object = jsonObject(value);
  const field = object?.[key];
  const result = jsonObject(field);
  if (!result) throw new Error(`Codex app-server response is missing ${key}`);
  return result;
}

function stringField(value: unknown, key: string): string {
  const object = jsonObject(value);
  const result = nonEmptyString(object?.[key]);
  if (!result) throw new Error(`Codex app-server response is missing ${key}`);
  return result;
}

function turnAbortController(request: AgentRequest): {
  readonly signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(`Codex turn timed out after ${request.timeoutMs}ms`)),
    request.timeoutMs,
  );
  timeout.unref();
  const onAbort = (): void =>
    controller.abort(request.signal?.reason ?? new Error("Codex turn aborted"));
  request.signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
    },
  };
}

function processFailure(
  command: string,
  args: readonly string[],
  result: Awaited<ReturnType<typeof spawnStreamingHarnessProcess>["done"]>,
  cause?: unknown,
): HarnessExecutionError {
  return new HarnessExecutionError({
    command: [command, ...args].join(" "),
    exitCode: result.exitCode,
    signal: result.signal,
    stderr: result.stderr,
    message:
      cause instanceof Error
        ? `Codex app-server failed: ${cause.message}`
        : `Codex app-server exited with ${String(result.exitCode ?? result.signal)}`,
  });
}
