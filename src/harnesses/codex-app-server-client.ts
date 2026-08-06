import { createInterface } from "node:readline";
import type { JsonValue } from "../types.js";
import { jsonObject, nonEmptyString } from "./support.js";

type JsonObject = Record<string, unknown>;

export class CodexAppServerClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { readonly resolve: (value: JsonObject) => void; readonly reject: (error: Error) => void }
  >();
  private readonly notifications: JsonObject[] = [];
  private readonly notificationWaiters = new Set<() => void>();
  private readonly usageByTurn = new Map<string, Record<string, JsonValue>>();
  private readonly finalMessageByTurn = new Map<string, string>();
  private closedError: Error | undefined;

  constructor(
    private readonly child: import("node:child_process").ChildProcessWithoutNullStreams,
    private readonly onNotification?: (message: JsonObject) => void,
  ) {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.receive(line));
    child.once("close", (code, signal) => {
      const error = new Error(`Codex app-server exited (${String(code ?? signal)})`);
      this.closedError = error;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.wakeNotifications();
    });
  }

  request(method: string, params: unknown): Promise<JsonObject> {
    const id = this.nextId++;
    return new Promise<JsonObject>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ method, id, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  closeInput(): void {
    if (!this.child.stdin.destroyed) this.child.stdin.end();
  }

  latestUsageFor(turnId: string): Record<string, JsonValue> | undefined {
    return this.usageByTurn.get(turnId);
  }

  latestFinalMessageFor(turnId: string): string | undefined {
    return this.finalMessageByTurn.get(turnId);
  }

  async waitForNotification(
    predicate: (message: JsonObject) => boolean,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    while (true) {
      const index = this.notifications.findIndex(predicate);
      if (index >= 0) return this.notifications.splice(index, 1)[0] as JsonObject;
      if (this.closedError) throw this.closedError;
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Codex turn aborted");
      }
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          signal?.removeEventListener("abort", wake);
          this.notificationWaiters.delete(wake);
          resolve();
        };
        this.notificationWaiters.add(wake);
        signal?.addEventListener("abort", wake, { once: true });
      });
    }
  }

  private receive(line: string): void {
    let message: JsonObject;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      message = value as JsonObject;
    } catch {
      return;
    }
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        const detail = jsonObject(message.error);
        pending.reject(new Error(nonEmptyString(detail?.message) ?? "Codex app-server request failed"));
      } else {
        pending.resolve(jsonObject(message.result) ?? {});
      }
      return;
    }
    if (typeof message.id === "number" && typeof message.method === "string") {
      this.write({
        id: message.id,
        error: { code: -32601, message: `Jaeger cannot answer ${message.method}` },
      });
      return;
    }
    if (message.method === "thread/tokenUsage/updated") {
      const params = jsonObject(message.params);
      const turnId = nonEmptyString(params?.turnId);
      const usage = jsonObject(params?.tokenUsage);
      if (turnId && usage) this.usageByTurn.set(turnId, usage);
    }
    if (message.method === "item/completed") {
      const params = jsonObject(message.params);
      const turnId = nonEmptyString(params?.turnId);
      const item = jsonObject(params?.item);
      if (
        turnId &&
        item?.type === "agentMessage" &&
        item.phase === "final_answer" &&
        typeof item.text === "string"
      ) {
        this.finalMessageByTurn.set(turnId, item.text);
      }
    }
    this.onNotification?.(message);
    this.notifications.push(message);
    this.wakeNotifications();
  }

  private wakeNotifications(): void {
    for (const wake of [...this.notificationWaiters]) wake();
  }

  private write(message: unknown): void {
    if (this.child.stdin.destroyed) throw new Error("Codex app-server input is closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}
