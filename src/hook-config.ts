import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

export const HOOK_EVENT_TYPES = [
  "run.accepted",
  "phase.changed",
  "session.available",
  "agent.completed",
  "run.terminal",
  "schedule.changed",
  "schedule.occurrence",
  "session.query.completed",
] as const;

export type HookEventType = (typeof HOOK_EVENT_TYPES)[number];

export interface HookDefinition {
  readonly name: string;
  readonly events: readonly HookEventType[];
  readonly command: readonly string[];
  readonly timeoutMs: number;
}

export interface HookConfig {
  readonly version: 1;
  readonly path: string;
  readonly digest: string;
  readonly hooks: readonly HookDefinition[];
}

const HOOK_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_COMMAND_PARTS = 64;
const MAX_COMMAND_PART_BYTES = 16 * 1024;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 300_000;

export async function loadHookConfig(configPath: string): Promise<HookConfig> {
  const resolved = path.resolve(configPath);
  const contents = await readFile(resolved, "utf8");
  let raw: unknown;
  try {
    raw = parseToml(contents);
  } catch (error) {
    throw new Error(`Invalid Jaeger hooks configuration ${resolved}`, { cause: error });
  }
  const root = record(raw, "hooks configuration");
  rejectUnknown(root, ["version", "hooks"], "hooks configuration");
  if (root.version !== 1) throw new Error("Jaeger hooks configuration version must be 1");
  if (!Array.isArray(root.hooks)) throw new Error("Jaeger hooks configuration requires [[hooks]]");
  const hooks = root.hooks.map((value, index) => parseHook(value, index));
  const names = new Set<string>();
  for (const hook of hooks) {
    if (names.has(hook.name)) throw new Error(`Jaeger hook name is duplicated: ${hook.name}`);
    names.add(hook.name);
  }
  return {
    version: 1,
    path: resolved,
    digest: createHash("sha256").update(contents).digest("hex"),
    hooks,
  };
}

function parseHook(value: unknown, index: number): HookDefinition {
  const label = `hooks[${index}]`;
  const hook = record(value, label);
  rejectUnknown(hook, ["name", "events", "command", "timeout_ms"], label);
  const name = stringValue(hook.name, `${label}.name`);
  if (!HOOK_NAME.test(name)) {
    throw new Error(`${label}.name must match ${HOOK_NAME}`);
  }
  if (!Array.isArray(hook.events) || hook.events.length === 0) {
    throw new Error(`${label}.events must be a non-empty array`);
  }
  const events = hook.events.map((event, eventIndex): HookEventType => {
    const candidate = stringValue(event, `${label}.events[${eventIndex}]`);
    if (!HOOK_EVENT_TYPES.includes(candidate as HookEventType)) {
      throw new Error(`${label}.events contains an unsupported event: ${candidate}`);
    }
    return candidate as HookEventType;
  });
  if (new Set(events).size !== events.length) {
    throw new Error(`${label}.events must not contain duplicates`);
  }
  if (
    !Array.isArray(hook.command) ||
    hook.command.length === 0 ||
    hook.command.length > MAX_COMMAND_PARTS
  ) {
    throw new Error(`${label}.command must contain 1-${MAX_COMMAND_PARTS} arguments`);
  }
  const command = hook.command.map((part, partIndex) => {
    const candidate = stringValue(part, `${label}.command[${partIndex}]`);
    if (Buffer.byteLength(candidate) > MAX_COMMAND_PART_BYTES || candidate.includes("\0")) {
      throw new Error(`${label}.command[${partIndex}] is too large or contains NUL`);
    }
    return candidate;
  });
  const timeoutMs =
    hook.timeout_ms === undefined
      ? 5_000
      : integerValue(hook.timeout_ms, `${label}.timeout_ms`);
  if (timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(
      `${label}.timeout_ms must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`,
    );
  }
  return { name, events, command, timeoutMs };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a table`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function integerValue(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be an integer`);
  return value as number;
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
  }
}
