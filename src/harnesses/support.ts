import { createHash } from "node:crypto";
import path from "node:path";
import type { JsonValue } from "../types.js";

export function stepScratchDirectory(runDir: string, stepId: string): string {
  const readable = stepId
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  const digest = createHash("sha256").update(stepId).digest("hex");
  return path.join(runDir, "harness", `${readable || "step"}-${digest}`);
}

export function jsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const item of value) {
      const converted = jsonValue(item);
      if (converted === undefined) return undefined;
      result.push(converted);
    }
    return result;
  }
  if (typeof value !== "object") return undefined;
  const entries: Array<readonly [string, JsonValue]> = [];
  for (const [key, item] of Object.entries(value)) {
    const converted = jsonValue(item);
    if (converted !== undefined) entries.push([key, converted]);
  }
  return Object.fromEntries(entries) as Record<string, JsonValue>;
}

export function jsonObject(value: unknown): Record<string, JsonValue> | undefined {
  const converted = jsonValue(value);
  return converted && typeof converted === "object" && !Array.isArray(converted)
    ? converted
    : undefined;
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
