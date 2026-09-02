import {
  providerIdentityUpdateFromClaudeMessage,
  providerIdentityUpdateFromCodexMessage,
  redactSensitiveText,
} from "./provider-identity.js";
import { jsonObject, nonEmptyString } from "./harnesses/support.js";
import type { HarnessDriver, JsonValue, ProviderRuntimeEvent, ProviderRuntimeProgress } from "./types.js";

const MAX_LABEL = 256;
const MAX_NATIVE_ID = 256;

export function codexRuntimeEvent(message: unknown): ProviderRuntimeEvent | undefined {
  const record = jsonObject(message);
  const method = nonEmptyString(record?.method);
  if (!method) return undefined;
  const params = jsonObject(record?.params);
  const at = eventAt(record ?? {}, params);
  const correlation = codexCorrelation(params);
  const identity = providerIdentityUpdateFromCodexMessage(message);
  if (method === "thread/tokenUsage/updated") {
    const usage = codexUsage(params?.tokenUsage);
    return {
      ...eventBase(method, "codex-app-server", at, correlation),
      type: method,
      activity: "running",
      ...(usage ? { usage } : {}),
    };
  }
  if (method === "account/rateLimits/updated") {
    const rateLimits = codexRateLimits(params?.rateLimits);
    return {
      ...eventBase(method, "codex-app-server", at, correlation),
      type: method,
      ...(rateLimits ? { rateLimits } : {}),
    };
  }
  if (identity) {
    return { ...eventBase(method, "codex-app-server", at, correlation), type: method, identity };
  }
  if (method === "item/started" || method === "item/completed") {
    const item = jsonObject(params?.item);
    const progress = itemProgress(item, method === "item/completed", at);
    return progress
      ? { ...eventBase(method, "codex-app-server", at, correlation), type: method, activity: "running", progress }
      : { ...eventBase(method, "codex-app-server", at, correlation), type: method, activity: "running" };
  }
  if (method === "turn/completed") {
    const turn = jsonObject(params?.turn);
    const status = nonEmptyString(turn?.status);
    return {
      ...eventBase(method, "codex-app-server", at, correlation),
      type: method,
      activity: status === "completed" ? "completed" : "failed",
      ...(status && status !== "completed" ? { error: redactSensitiveText(`Codex turn ${status}`) } : {}),
    };
  }
  return undefined;
}

export function claudeRuntimeEvent(message: unknown): ProviderRuntimeEvent | undefined {
  const record = jsonObject(message);
  const type = nonEmptyString(record?.type);
  if (!type) return undefined;
  const at = eventAt(record ?? {});
  const identity = providerIdentityUpdateFromClaudeMessage(message);
  const correlation = claudeCorrelation(record ?? {});
  const eventType = `claude.${type}`.slice(0, MAX_LABEL);
  if (identity) {
    return { ...eventBase(eventType, "claude-agent-sdk", at, correlation), type: eventType, identity };
  }
  if (type === "result") {
    const usage = claudeUsage(record?.usage);
    const isError = record?.is_error === true;
    const subtype = nonEmptyString(record?.subtype);
    return {
      ...eventBase(eventType, "claude-agent-sdk", at, correlation),
      type: eventType,
      activity: isError || subtype !== "success" ? "failed" : "completed",
      ...(usage ? { usage } : {}),
      ...(isError ? { error: "Claude turn failed" } : {}),
    };
  }
  const parentId = nonEmptyString(record?.parent_tool_use_id);
  const taskId = nonEmptyString(record?.task_id) ?? nonEmptyString(record?.taskId) ?? parentId;
  const taskStatus = type === "task_completed" ? "completed" : type === "task_failed" ? "failed" : "running";
  const progress: ProviderRuntimeProgress | undefined = taskId && (parentId || type.startsWith("task_") || type.includes("workflow"))
    ? {
        id: taskId.slice(0, MAX_NATIVE_ID),
        kind: type.includes("workflow") ? "workflow" : "task",
        status: taskStatus,
        label: type.slice(0, MAX_LABEL),
        ...(parentId && taskId !== parentId
          ? { parentId: parentId.slice(0, MAX_NATIVE_ID) }
          : {}),
        updatedAt: at,
      }
    : undefined;
  return {
    ...eventBase(eventType, "claude-agent-sdk", at, correlation),
    type: eventType,
    activity: "running",
    ...(progress ? { progress } : {}),
  };
}

function eventBase(
  type: string,
  source: HarnessDriver,
  at: string,
  correlation: { nativeSessionId?: string; nativeTurnId?: string; nativeItemId?: string },
): Pick<ProviderRuntimeEvent, "id" | "source" | "at" | "nativeSessionId" | "nativeTurnId" | "nativeItemId"> {
  const nativeSessionId = boundedString(correlation.nativeSessionId, MAX_NATIVE_ID);
  const nativeTurnId = boundedString(correlation.nativeTurnId, MAX_NATIVE_ID);
  const nativeItemId = boundedString(correlation.nativeItemId, MAX_NATIVE_ID);
  const native = [nativeSessionId, nativeTurnId, nativeItemId]
    .filter((value): value is string => Boolean(value))
    .join(":");
  return {
    id: `${source}:${type.slice(0, MAX_LABEL)}:${native || at}`,
    source,
    at,
    ...(nativeSessionId ? { nativeSessionId } : {}),
    ...(nativeTurnId ? { nativeTurnId } : {}),
    ...(nativeItemId ? { nativeItemId } : {}),
  };
}

function eventAt(record: Record<string, JsonValue>, params?: Record<string, JsonValue>): string {
  const milliseconds = [record.emittedAtMs, params?.emittedAtMs]
    .find((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  if (milliseconds !== undefined) {
    const date = new Date(milliseconds);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

function codexCorrelation(params: Record<string, JsonValue> | undefined): {
  nativeSessionId?: string;
  nativeTurnId?: string;
  nativeItemId?: string;
} {
  const item = jsonObject(params?.item);
  const nativeSessionId = nonEmptyString(params?.threadId);
  const nativeTurnId = nonEmptyString(params?.turnId);
  const nativeItemId = nonEmptyString(item?.id);
  return {
    ...(nativeSessionId ? { nativeSessionId } : {}),
    ...(nativeTurnId ? { nativeTurnId } : {}),
    ...(nativeItemId ? { nativeItemId } : {}),
  };
}

function claudeCorrelation(record: Record<string, JsonValue>): {
  nativeSessionId?: string;
  nativeItemId?: string;
} {
  const nativeSessionId = nonEmptyString(record.session_id);
  const nativeItemId = nonEmptyString(record.uuid);
  return {
    ...(nativeSessionId ? { nativeSessionId } : {}),
    ...(nativeItemId ? { nativeItemId } : {}),
  };
}

function itemProgress(
  item: Record<string, JsonValue> | undefined,
  completed: boolean,
  updatedAt: string,
): ProviderRuntimeProgress | undefined {
  const id = nonEmptyString(item?.id);
  const type = nonEmptyString(item?.type);
  if (!id || !type) return undefined;
  const parentId = nonEmptyString(item?.parentId);
  return {
    id: id.slice(0, MAX_NATIVE_ID),
    kind: type === "commandExecution" ? "tool" : "task",
    status: completed ? "completed" : "running",
    label: type.slice(0, MAX_LABEL),
    ...(parentId ? { parentId: parentId.slice(0, MAX_NATIVE_ID) } : {}),
    updatedAt,
  };
}

function codexUsage(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  const record = jsonObject(value);
  if (!record) return undefined;
  const total = tokenBreakdown(record.total);
  const last = tokenBreakdown(record.last);
  const modelContextWindow = safeNumber(record.modelContextWindow);
  if (!total && !last && modelContextWindow === undefined) return undefined;
  return {
    ...(total ? { total } : {}),
    ...(last ? { last } : {}),
    ...(modelContextWindow !== undefined ? { modelContextWindow } : {}),
  };
}

function tokenBreakdown(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  const record = jsonObject(value);
  if (!record) return undefined;
  return numericProjection(record, [
    "totalTokens",
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
  ]);
}

function claudeUsage(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  const record = jsonObject(value);
  if (!record) return undefined;
  const usage = numericProjection(record, [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ]) ?? {};
  const serverToolUse = jsonObject(record.server_tool_use);
  const safeServerToolUse = serverToolUse
    ? numericProjection(serverToolUse, ["web_search_requests", "web_fetch_requests"])
    : undefined;
  return Object.keys(usage).length > 0 || safeServerToolUse
    ? { ...usage, ...(safeServerToolUse ? { server_tool_use: safeServerToolUse } : {}) }
    : undefined;
}

function codexRateLimits(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  const record = jsonObject(value);
  if (!record) return undefined;
  const result: Record<string, JsonValue> = {};
  copySafeStrings(record, result, ["limitId", "limitName", "planType", "rateLimitReachedType"]);
  if (typeof record.spendControlReached === "boolean") {
    result.spendControlReached = record.spendControlReached;
  }
  const primary = rateLimitWindow(record.primary);
  const secondary = rateLimitWindow(record.secondary);
  const credits = creditsSnapshot(record.credits);
  const individualLimit = spendControlLimit(record.individualLimit);
  if (primary) result.primary = primary;
  if (secondary) result.secondary = secondary;
  if (credits) result.credits = credits;
  if (individualLimit) result.individualLimit = individualLimit;
  return Object.keys(result).length > 0 ? result : undefined;
}

function rateLimitWindow(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  const record = jsonObject(value);
  return record
    ? numericProjection(record, ["usedPercent", "resetsAt", "windowDurationMins"])
    : undefined;
}

function creditsSnapshot(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  const record = jsonObject(value);
  if (!record) return undefined;
  const result: Record<string, JsonValue> = {};
  copySafeStrings(record, result, ["balance"]);
  if (typeof record.hasCredits === "boolean") result.hasCredits = record.hasCredits;
  if (typeof record.unlimited === "boolean") result.unlimited = record.unlimited;
  return Object.keys(result).length > 0 ? result : undefined;
}

function spendControlLimit(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  const record = jsonObject(value);
  if (!record) return undefined;
  const result = numericProjection(record, ["remainingPercent", "resetsAt"]) ?? {};
  copySafeStrings(record, result, ["limit", "used"]);
  return Object.keys(result).length > 0 ? result : undefined;
}

function numericProjection(
  record: Record<string, JsonValue>,
  keys: readonly string[],
): Record<string, JsonValue> | undefined {
  const result: Record<string, JsonValue> = {};
  for (const key of keys) {
    const value = safeNumber(record[key]);
    if (value !== undefined) result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function safeNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function copySafeStrings(
  source: Record<string, JsonValue>,
  target: Record<string, JsonValue>,
  keys: readonly string[],
): void {
  for (const key of keys) {
    const value = boundedString(source[key], MAX_LABEL);
    if (value) target[key] = redactSensitiveText(value);
  }
}

function boundedString(value: JsonValue | undefined, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}
