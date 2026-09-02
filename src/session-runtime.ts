import path from "node:path";
import { assertRunExecutionAdmission, type RuntimeBackendKind } from "./admission.js";
import { harnessesForRun } from "./harnesses/registry.js";
import { RunJournal } from "./journal.js";
import { ManagedSessionTurn, resolveSession } from "./sessions.js";
import type { AgentRequest, JsonValue } from "./types.js";

const DEFAULT_SESSION_TIMEOUT_MS = 60 * 60 * 1_000;

export interface SessionResumeResult {
  readonly sessionId: string;
  readonly nativeSessionId: string;
  readonly turn: number;
  readonly output: JsonValue;
  readonly metadata?: Record<string, JsonValue>;
}

export async function resumeSession(input: {
  readonly stateDir: string;
  readonly runId: string;
  readonly selector: string;
  readonly message: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly expectedBackend?: RuntimeBackendKind;
  readonly turnId?: string;
  readonly beforeComplete?: (result: SessionResumeResult) => Promise<void>;
}): Promise<SessionResumeResult> {
  if (input.message.trim().length === 0) throw new TypeError("session message must be non-empty");
  const timeoutMs = checkedTimeout(input.timeoutMs);
  const journal = await RunJournal.open(path.resolve(input.stateDir), input.runId);
  assertRunExecutionAdmission(journal.record, input.expectedBackend ?? "embedded");
  const existing = await resolveSession(journal.runDir, input.selector);
  if (!existing.nativeSessionId) {
    throw new Error(`Jaeger session ${existing.id} has no native provider session to resume`);
  }
  const adapter = harnessesForRun(journal.record).get(existing.harness);
  if (!adapter) throw new Error(`No session adapter is installed for ${existing.harness}`);
  const session = await ManagedSessionTurn.resume(journal.runDir, existing.id, adapter.driver);
  const request: AgentRequest = {
    harness: existing.harness,
    prompt: input.message,
    cwd: existing.cwd,
    timeoutMs,
    runDir: journal.runDir,
    stepId: input.turnId
      ? `${existing.stepId}/turn:${input.turnId}`
      : `${existing.stepId}/turn:${existing.turnCount + 1}`,
    session,
    ...(existing.label ? { label: existing.label } : {}),
    ...(existing.model ? { model: existing.model } : {}),
    ...(existing.effort ? { effort: existing.effort } : {}),
    ...(existing.serviceTier ? { serviceTier: existing.serviceTier } : {}),
    ...(existing.profile ? { profile: existing.profile } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  };
  try {
    const execution = await adapter.execute(request);
    const output = toJsonValue(execution.output, "session output");
    const result: SessionResumeResult = {
      sessionId: existing.id,
      nativeSessionId: execution.nativeSessionId ?? existing.nativeSessionId,
      turn: existing.turnCount + 1,
      output,
      ...(execution.metadata ? { metadata: execution.metadata } : {}),
    };
    if (input.beforeComplete) await input.beforeComplete(result);
    await session.complete(output, execution.metadata);
    return result;
  } catch (error) {
    await session.fail(error);
    throw error;
  }
}

function checkedTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_SESSION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 24 * 60 * 60 * 1_000) {
    throw new TypeError("session timeout must be a positive integer no greater than 24 hours");
  }
  return timeout;
}

function toJsonValue(value: unknown, label: string): JsonValue {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${label} must be JSON-serializable`, { cause: error });
  }
  if (serialized === undefined) throw new TypeError(`${label} must be JSON-serializable`);
  return JSON.parse(serialized) as JsonValue;
}
