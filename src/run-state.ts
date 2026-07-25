import path from "node:path";
import { JournalCorruptionError } from "./errors.js";
import {
  discoverRunHarnessProcesses,
  harnessContainmentState,
  runOwnerContainment,
} from "./harnesses/active-process.js";
import { RunJournal, type JournalEvent } from "./journal.js";
import { readRunOwner, type RunOwnerState } from "./lease.js";
import { listWorkflowSessions } from "./sessions.js";
import type {
  JsonValue,
  WorkflowRunSummary,
  WorkflowRunStatus,
  WorkflowSessionRecord,
} from "./types.js";

export type AgentJournalState = {
  readonly stepId: string;
  readonly requestHash: string;
  readonly started: JournalEvent;
  readonly terminal?: JournalEvent;
  readonly state: "started" | "completed" | "failed";
};

export interface JournalAnalysis {
  readonly agents: ReadonlyMap<string, AgentJournalState>;
  readonly phases: ReadonlyMap<string, JournalEvent>;
  readonly logs: ReadonlyMap<string, JournalEvent>;
  readonly workflowStarted?: JournalEvent;
  readonly workflowTerminal?: JournalEvent;
  readonly workflowInterruption?: JournalEvent;
  readonly stopRequested?: JournalEvent;
  readonly currentPhase?: string;
  readonly corruption?: {
    readonly reason: string;
    readonly stepId?: string;
  };
}

export async function inspectRun(
  stateDir: string,
  runId: string,
): Promise<WorkflowRunSummary> {
  const journal = await RunJournal.open(path.resolve(stateDir), runId);
  let read = await journal.readEvents();
  let owner = await readRunOwner(journal.runDir, runId);
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = owner;
    read = await journal.readEvents();
    owner = await readRunOwner(journal.runDir, runId);
    if (sameOwner(before, owner) && !(read.truncatedTail && owner.active)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const analysis = analyzeJournal(read.events, read.truncatedTail);
  const stopRequest = await journal.stopRequest();
  const effectiveAnalysis = stopRequest
    ? {
        ...analysis,
        stopRequested: {
          type: "workflow.stop_requested",
          at: stopRequest.requestedAt,
          ownerPid: stopRequest.ownerPid,
          requestedByPid: stopRequest.requestedByPid,
        },
      }
    : analysis;
  const activeContainment = owner.active
    ? false
    : hasActiveOrUnverifiableContainment(journal.runDir, runId);
  const sessions = await listWorkflowSessions(journal.runDir, path.dirname(journal.runDir));
  return summarizeRun(journal, effectiveAnalysis, owner, activeContainment, sessions);
}

export function analyzeJournal(
  events: readonly JournalEvent[],
  truncatedTail = false,
): JournalAnalysis {
  const agents = new Map<string, AgentJournalState>();
  const phases = new Map<string, JournalEvent>();
  const logs = new Map<string, JournalEvent>();
  let workflowStarted: JournalEvent | undefined;
  let workflowTerminal: JournalEvent | undefined;
  let workflowInterruption: JournalEvent | undefined;
  let stopRequested: JournalEvent | undefined;
  let currentPhase: string | undefined;
  let corruption: JournalAnalysis["corruption"];

  const markCorrupt = (reason: string, stepId?: string): void => {
    if (corruption) return;
    corruption = { reason, ...(stepId ? { stepId } : {}) };
  };

  for (const event of events) {
    if (event.type === "workflow.stop_requested") {
      stopRequested = event;
      continue;
    }
    if (workflowTerminal) {
      markCorrupt(`Event ${event.type} appears after ${workflowTerminal.type}`);
      continue;
    }

    if (event.type === "workflow.started" || event.type === "workflow.resumed") {
      if (event.type === "workflow.resumed" && !workflowStarted) {
        markCorrupt("workflow.resumed appears before workflow.started");
      }
      if (event.type === "workflow.started" && workflowStarted) {
        markCorrupt("Journal contains more than one workflow.started event");
      }
      workflowStarted ??= event;
      workflowInterruption = undefined;
      // A resume is a new ownership attempt. A stop request applies only to the
      // attempt that was active when it was recorded.
      stopRequested = undefined;
      continue;
    }
    if (event.type === "workflow.completed" || event.type === "workflow.failed") {
      if (!workflowStarted) markCorrupt(`${event.type} appears before workflow.started`);
      if (workflowTerminal) markCorrupt("Journal contains more than one workflow terminal event");
      workflowTerminal = event;
      continue;
    }
    if (event.type === "workflow.interrupted") {
      if (!workflowStarted) markCorrupt("workflow.interrupted appears before workflow.started");
      workflowInterruption = event;
      continue;
    }
    if (event.type === "phase" || event.type === "log") {
      if (!workflowStarted) markCorrupt(`${event.type} appears before workflow.started`);
      const stepId = stringField(event, "stepId");
      if (!stepId) {
        markCorrupt(`${event.type} event is missing its deterministic stepId`);
        continue;
      }
      const target = event.type === "phase" ? phases : logs;
      if (target.has(stepId)) {
        markCorrupt(`Journal contains a duplicate ${event.type} event at ${stepId}`, stepId);
        continue;
      }
      target.set(stepId, event);
      if (event.type === "phase") currentPhase = stringField(event, "name") ?? currentPhase;
      continue;
    }
    if (!event.type.startsWith("agent.")) continue;

    if (!workflowStarted) markCorrupt(`${event.type} appears before workflow.started`);

    const stepId = stringField(event, "stepId");
    const requestHash = stringField(event, "requestHash");
    if (!stepId || !requestHash) {
      markCorrupt(`${event.type} event is missing stepId or requestHash`, stepId);
      continue;
    }
    const prior = agents.get(stepId);
    if (event.type === "agent.started") {
      if (prior) {
        markCorrupt(`Agent ${stepId} started more than once`, stepId);
        continue;
      }
      agents.set(stepId, {
        stepId,
        requestHash,
        started: event,
        state: "started",
      });
      continue;
    }
    if (event.type === "agent.completed" || event.type === "agent.failed") {
      if (!prior || prior.state !== "started") {
        markCorrupt(`Agent ${stepId} has ${event.type} without one unmatched start`, stepId);
        continue;
      }
      if (prior.requestHash !== requestHash) {
        markCorrupt(`Agent ${stepId} changed request hash inside the journal`, stepId);
        continue;
      }
      agents.set(stepId, {
        ...prior,
        terminal: event,
        state: event.type === "agent.completed" ? "completed" : "failed",
      });
    }
  }

  if (workflowTerminal?.type === "workflow.completed") {
    const unfinished = [...agents.values()].find((agent) => agent.state !== "completed");
    if (unfinished) {
      markCorrupt(
        `Workflow completed while agent ${unfinished.stepId} was ${unfinished.state}`,
        unfinished.stepId,
      );
    }
  }
  if (truncatedTail) {
    const pending = [...agents.values()].find((agent) => agent.state !== "completed");
    if (pending) {
      markCorrupt(
        "Journal has a truncated final event after an uncertain agent checkpoint",
        pending.stepId,
      );
    }
  }

  return {
    agents,
    phases,
    logs,
    ...(workflowStarted ? { workflowStarted } : {}),
    ...(workflowTerminal ? { workflowTerminal } : {}),
    ...(workflowInterruption ? { workflowInterruption } : {}),
    ...(stopRequested ? { stopRequested } : {}),
    ...(currentPhase ? { currentPhase } : {}),
    ...(corruption ? { corruption } : {}),
  };
}

export function summarizeRun(
  journal: RunJournal,
  analysis: JournalAnalysis,
  owner: RunOwnerState,
  activeContainment = false,
  sessions: readonly WorkflowSessionRecord[] = [],
): WorkflowRunSummary {
  const agents = [...analysis.agents.values()];
  const uncertainAgent = agents.find((agent) => agent.state !== "completed");
  const uncertainty = owner.active
    ? undefined
    : analysis.corruption
      ? analysis.corruption
      : uncertainAgent
        ? {
            stepId: uncertainAgent.stepId,
            reason:
              uncertainAgent.state === "failed"
                ? `Agent ${uncertainAgent.stepId} failed after it may have produced external effects`
                : `Agent ${uncertainAgent.stepId} started without a durable completion`,
          }
        : undefined;
  const status = runStatus(analysis, owner, uncertainty !== undefined);
  const stateDir = path.dirname(journal.runDir);
  const serviceOwned =
    journal.record.version === 4 && journal.record.runtime.backend === "local-service";
  const command = serviceOwned ? "jaeger" : "jaeger --runtime embedded";
  const stateArgument = serviceOwned ? "" : ` --state-dir ${shellQuote(stateDir)}`;
  const inspect = `${command} inspect ${shellQuote(journal.record.runId)}${stateArgument} --summary --json`;
  const terminal = analysis.workflowTerminal;
  const attemptEnd = terminal ?? analysis.workflowInterruption;
  const result = terminal?.type === "workflow.completed" ? terminal.result : undefined;
  const error =
    terminal?.type === "workflow.failed"
      ? stringField(terminal, "error")
      : analysis.workflowInterruption
        ? stringField(analysis.workflowInterruption, "error")
        : undefined;
  const resume =
    status === "pending" || status === "interrupted" || status === "stopped"
      ? `${command} resume ${shellQuote(journal.record.runId)}${stateArgument}`
      : undefined;

  return {
    runId: journal.record.runId,
    ...(journal.record.version === 4 && journal.record.submissionId
      ? { submissionId: journal.record.submissionId }
      : {}),
    ...(journal.record.version === 4 && journal.record.trigger
      ? { trigger: journal.record.trigger }
      : {}),
    status,
    scriptPath: journal.record.workflowPath,
    runDir: journal.runDir,
    cwd: journal.record.cwd,
    boundary: journal.record.boundary,
    createdAt: journal.record.createdAt,
    ...(analysis.workflowStarted ? { startedAt: analysis.workflowStarted.at } : {}),
    ...(attemptEnd ? { finishedAt: attemptEnd.at } : {}),
    ...(analysis.currentPhase ? { currentPhase: analysis.currentPhase } : {}),
    agents: {
      started: agents.length,
      completed: agents.filter((agent) => agent.state === "completed").length,
      failed: agents.filter((agent) => agent.state === "failed").length,
    },
    sessions: {
      total: sessions.length,
      running: sessions.filter(
        (session) => session.status === "running" || session.status === "starting",
      ).length,
      idle: sessions.filter((session) => session.status === "idle").length,
    },
    ...(isJsonValue(result) ? { result } : {}),
    ...(error ? { error } : {}),
    ...(uncertainty ? { uncertainty } : {}),
    inspect,
    ...(status === "running" || status === "stopping"
      ? { wait: `${command} wait ${shellQuote(journal.record.runId)}${stateArgument}` }
      : {}),
    ...(owner.active || activeContainment
      ? { stop: `${command} stop ${shellQuote(journal.record.runId)}${stateArgument}` }
      : {}),
    ...(resume ? { resume } : {}),
  };
}

function hasActiveOrUnverifiableContainment(runDir: string, runId: string): boolean {
  try {
    if (harnessContainmentState(runOwnerContainment(runId)) !== "inactive") return true;
    const providers = discoverRunHarnessProcesses(runDir, runId);
    // An immutable launch intent that survived its owner is itself unfinished
    // lifecycle work. Offer stop even if the scope disappeared between probes;
    // stop will reconcile and clear the stale intent after proving inactivity.
    return (
      providers.length > 0 ||
      providers.some((record) => harnessContainmentState(record) !== "inactive")
    );
  } catch {
    // A compact status must never claim a run is terminal while lifecycle
    // containment cannot be inspected. Offering the deterministic stop command
    // is the safe, actionable fallback.
    return true;
  }
}

export function assertRunnableAnalysis(analysis: JournalAnalysis, runDir: string): void {
  if (analysis.workflowTerminal?.type === "workflow.completed") return;
  const uncertainAgent = [...analysis.agents.values()].find((agent) => agent.state !== "completed");
  if (analysis.corruption || uncertainAgent) {
    const stepId = analysis.corruption?.stepId ?? uncertainAgent?.stepId;
    const detail = stepId ? ` at ${stepId}` : "";
    throw new JournalCorruptionError(
      `Jaeger run cannot safely resume${detail}; inspect the uncertainty boundary in ${runDir}`,
    );
  }
  if (analysis.workflowTerminal?.type === "workflow.failed") {
    throw new JournalCorruptionError(
      `Jaeger run already failed deterministically and cannot be resumed; start a new run`,
    );
  }
}

function runStatus(
  analysis: JournalAnalysis,
  owner: RunOwnerState,
  uncertain: boolean,
): WorkflowRunStatus {
  if (analysis.workflowTerminal?.type === "workflow.completed" && !analysis.corruption) {
    return "completed";
  }
  if (owner.active) return analysis.stopRequested ? "stopping" : "running";
  if (uncertain) return "uncertain";
  if (analysis.workflowTerminal?.type === "workflow.failed") return "failed";
  if (analysis.stopRequested) return "stopped";
  if (analysis.workflowStarted) return "interrupted";
  return "pending";
}

function stringField(event: JournalEvent, key: string): string | undefined {
  const value = event[key];
  return typeof value === "string" ? value : undefined;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!value || typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
}

function sameOwner(left: RunOwnerState, right: RunOwnerState): boolean {
  return (
    left.active === right.active &&
    left.owner?.token === right.owner?.token &&
    left.owner?.pid === right.owner?.pid
  );
}
