import { createHash, randomBytes } from "node:crypto";
import { open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { syncDirectory } from "./durable-json.js";
import type { CodexAppServerClient } from "./harnesses/codex-app-server-client.js";
import { ensurePrivateDirectory } from "./paths.js";

export type CodexThreadArchiveStatus =
  | "visible"
  | "retrying"
  | "archived"
  | "retained";

export interface CodexThreadArchiveRecord {
  readonly version: 1;
  readonly runId: string;
  readonly nativeSessionId: string;
  readonly status: CodexThreadArchiveStatus;
  readonly activityVersion: string;
  readonly attempts: number;
  readonly updatedAt: string;
  readonly archivedAt?: string;
  readonly nextAttemptAt?: string;
  readonly reason?: string;
  readonly lastError?: string;
}

export async function prepareCodexThreadForUse(
  runDir: string,
  nativeSessionId: string,
  client: Pick<CodexAppServerClient, "request">,
): Promise<void> {
  const prior = await readCodexThreadArchiveRecord(runDir, nativeSessionId);
  if (prior?.status !== "archived") return;
  const {
    archivedAt: _archivedAt,
    lastError: _lastError,
    nextAttemptAt: _nextAttemptAt,
    ...visible
  } = prior;
  await writeCodexThreadArchiveRecord(runDir, {
    ...visible,
    status: "visible",
    updatedAt: new Date().toISOString(),
    reason: "Jaeger resumed or forked the provider session",
  });
  try {
    await client.request("thread/unarchive", { threadId: nativeSessionId });
  } catch (error) {
    if (!errorMessage(error).includes("no archived rollout found")) throw error;
  }
}

export async function readCodexThreadArchiveRecord(
  runDir: string,
  nativeSessionId: string,
): Promise<CodexThreadArchiveRecord | undefined> {
  try {
    return parseArchiveRecord(
      JSON.parse(await readFile(archiveRecordPath(runDir, nativeSessionId), "utf8")),
      nativeSessionId,
    );
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

export async function writeCodexThreadArchiveRecord(
  runDir: string,
  value: CodexThreadArchiveRecord,
): Promise<void> {
  const root = path.join(runDir, "codex-threads");
  await ensurePrivateDirectory(root, "Jaeger Codex thread lifecycle directory");
  const target = archiveRecordPath(runDir, value.nativeSessionId);
  const temporary = path.join(
    root,
    `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
  await syncDirectory(root);
}

function archiveRecordPath(runDir: string, nativeSessionId: string): string {
  const digest = createHash("sha256").update(nativeSessionId).digest("hex");
  return path.join(runDir, "codex-threads", `${digest}.json`);
}

function parseArchiveRecord(
  value: unknown,
  nativeSessionId: string,
): CodexThreadArchiveRecord {
  const candidate = record(value);
  if (
    candidate.version !== 1 ||
    candidate.nativeSessionId !== nativeSessionId ||
    typeof candidate.runId !== "string" ||
    !["visible", "retrying", "archived", "retained"].includes(String(candidate.status)) ||
    typeof candidate.activityVersion !== "string" ||
    !Number.isSafeInteger(candidate.attempts) ||
    typeof candidate.updatedAt !== "string"
  ) {
    throw new Error(`Invalid Jaeger Codex thread lifecycle state for ${nativeSessionId}`);
  }
  return candidate as unknown as CodexThreadArchiveRecord;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object");
  }
  return value as Record<string, unknown>;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
