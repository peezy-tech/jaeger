import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  assertRunExecutionAdmission,
  describeLocalWorkspace,
  sameLocalWorkspace,
  type LocalWorkspaceDescriptor,
  type RuntimeBackendKind,
} from "./admission.js";
import { hostRuntimeBoundaryDescriptor } from "./boundary.js";
import { compileWorkflowSource } from "./compiler.js";
import {
  HarnessExecutionError,
  JournalCorruptionError,
  RunStoppedError,
  RunTerminalError,
  UncertainAgentRunError,
  WorkflowChangedError,
} from "./errors.js";
import {
  builtinHarnessDefinitions,
  harnessesForRun,
  validateHarnessDefinitions,
  validateHarnessName,
} from "./harnesses/registry.js";
import { RunJournal, type JournalEvent } from "./journal.js";
import { RunLease, type RunOwnerKind } from "./lease.js";
import { analyzeJournal, type AgentJournalState, type JournalAnalysis } from "./run-state.js";
import { compileStructuredOutputValidator } from "./schema.js";
import { ManagedSessionTurn, workflowSessionId } from "./sessions.js";
import type {
  AgentOptions,
  AgentRequest,
  HarnessAdapter,
  HarnessDefinition,
  JsonValue,
  RuntimeReporter,
  WorkflowTriggerMetadata,
  WorkflowContext,
  WorkflowMeta,
  WorkflowRunResult,
} from "./types.js";
import { JAEGER_VERSION, WORKFLOW_RUNTIME_ABI } from "./version.js";

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1_000;
const DEFAULT_MAX_CONCURRENCY = 4;
const MAX_CONCURRENCY = 64;
const AGENT_OPTION_KEYS = new Set([
  "harness",
  "label",
  "model",
  "effort",
  "serviceTier",
  "cwd",
  "schema",
  "profile",
  "timeoutMs",
]);

type StepScope = {
  readonly path: string;
  agentCount: number;
  parallelCount: number;
  phaseCount: number;
  logCount: number;
};

export interface RunWorkflowOptions {
  readonly workflowPath: string;
  readonly cwd?: string;
  readonly inputs?: unknown;
  readonly trigger?: WorkflowTriggerMetadata;
  readonly stateDir?: string;
  readonly resumeRunId?: string;
  readonly maxConcurrency?: number;
  readonly harnesses?: ReadonlyMap<string, HarnessAdapter>;
  readonly harnessDefinitions?: readonly HarnessDefinition[];
  readonly reporter?: RuntimeReporter;
  readonly signal?: AbortSignal;
}

export interface PrepareWorkflowOptions {
  readonly workflowPath: string;
  readonly workflowSource?: string;
  readonly workflowPathPinned?: boolean;
  readonly cwd?: string;
  readonly inputs?: unknown;
  readonly trigger?: WorkflowTriggerMetadata;
  readonly stateDir?: string;
  readonly maxConcurrency?: number;
  readonly harnessDefinitions?: readonly HarnessDefinition[];
  readonly backend?: "embedded" | "local-service";
  readonly submissionId?: string;
  readonly submissionHash?: string;
  readonly workspace?: LocalWorkspaceDescriptor;
  readonly stageOnly?: boolean;
}

export interface PreparedWorkflowRun {
  readonly runId: string;
  readonly runDir: string;
  readonly stateDir: string;
  readonly scriptPath: string;
  readonly isResume: boolean;
  readonly backend: RuntimeBackendKind;
  readonly staged?: import("./journal.js").StagedRunJournal;
}

export interface ExecutePreparedRunOptions {
  readonly stateDir: string;
  readonly runId: string;
  readonly ownerKind?: RunOwnerKind;
  readonly resumeRequested?: boolean;
  readonly harnesses?: ReadonlyMap<string, HarnessAdapter>;
  readonly reporter?: RuntimeReporter;
  readonly signal?: AbortSignal;
  readonly expectedBackend?: RuntimeBackendKind;
}

export async function prepareWorkflowRun(
  options: PrepareWorkflowOptions,
): Promise<PreparedWorkflowRun> {
  if ((options.submissionId === undefined) !== (options.submissionHash === undefined)) {
    throw new TypeError("submissionId and submissionHash must be supplied together");
  }
  if (
    options.submissionId !== undefined &&
    (!/^[A-Za-z0-9._:-]{8,128}$/.test(options.submissionId) ||
      !/^[a-f0-9]{64}$/.test(options.submissionHash as string))
  ) {
    throw new TypeError("submissionId or submissionHash is invalid");
  }
  const workflowPath =
    options.workflowPathPinned === true
      ? options.workflowPath
      : await realpath(options.workflowPath);
  const source = options.workflowSource ?? (await readFile(workflowPath, "utf8"));
  compileWorkflowSource(source, workflowPath);
  const cwd = await realpath(path.resolve(options.cwd ?? process.cwd()));
  const stateDir = path.resolve(options.stateDir ?? path.join(cwd, ".jaeger", "runs"));
  const inputs = toJsonValue(options.inputs ?? {}, "inputs");
  const maxConcurrency = checkedConcurrency(options.maxConcurrency);
  const harnesses = validateHarnessDefinitions(
    options.harnessDefinitions ?? builtinHarnessDefinitions(),
    options.harnessDefinitions ? { allowPinnedBuiltins: true } : {},
  );
  const backend = options.backend ?? "embedded";
  const observedWorkspace = await describeLocalWorkspace(cwd);
  if (options.workspace && !sameLocalWorkspace(options.workspace, observedWorkspace)) {
    throw new WorkflowChangedError(
      `Workflow workspace identity changed while admitting ${cwd}`,
    );
  }
  const workspace = options.workspace ?? observedWorkspace;
  const record = {
    version: 4 as const,
    workflowPath,
    workflowHash: sha256(source),
    cwd,
    inputs,
    ...(options.trigger ? { trigger: structuredClone(options.trigger) } : {}),
    maxConcurrency,
    harnesses,
    runtime: {
      abi: WORKFLOW_RUNTIME_ABI,
      version: JAEGER_VERSION,
      backend,
    },
    workspace,
    ...(options.submissionId ? { submissionId: options.submissionId } : {}),
    ...(options.submissionHash ? { submissionHash: options.submissionHash } : {}),
    boundary: hostRuntimeBoundaryDescriptor,
    createdAt: new Date().toISOString(),
  };
  const staged = options.stageOnly
    ? await RunJournal.stage(stateDir, record, source)
    : undefined;
  const journal = staged ?? (await RunJournal.create(
    stateDir,
    record,
    source,
  ));
  return {
    runId: journal.record.runId,
    runDir: staged?.runDir ?? journal.runDir,
    stateDir,
    scriptPath: workflowPath,
    isResume: false,
    backend,
    ...(staged ? { staged } : {}),
  };
}

export async function publishPreparedWorkflowRun(
  prepared: PreparedWorkflowRun,
): Promise<PreparedWorkflowRun> {
  if (!prepared.staged) return prepared;
  await RunJournal.publish(prepared.staged);
  const { staged: _staged, ...published } = prepared;
  return published;
}

export async function discardPreparedWorkflowRun(prepared: PreparedWorkflowRun): Promise<void> {
  if (prepared.staged) await RunJournal.discard(prepared.staged);
}

export async function openPreparedRunForResume(options: {
  readonly stateDir: string;
  readonly runId: string;
  readonly expectedBackend?: RuntimeBackendKind;
}): Promise<PreparedWorkflowRun> {
  const stateDir = path.resolve(options.stateDir);
  const journal = await RunJournal.open(stateDir, options.runId);
  const backend = options.expectedBackend ?? "embedded";
  assertRunExecutionAdmission(journal.record, backend);
  const read = await journal.readEvents();
  const history = analyzeJournal(read.events, read.truncatedTail);
  return {
    runId: journal.record.runId,
    runDir: journal.runDir,
    stateDir,
    scriptPath: journal.record.workflowPath,
    isResume: history.workflowStarted !== undefined,
    backend,
  };
}

export async function openWorkflowForResume(
  options: PrepareWorkflowOptions & { readonly runId: string },
): Promise<PreparedWorkflowRun> {
  const requestedCwd = await realpath(path.resolve(options.cwd ?? process.cwd()));
  const stateDir = path.resolve(options.stateDir ?? path.join(requestedCwd, ".jaeger", "runs"));
  const journal = await RunJournal.open(stateDir, options.runId);
  const backend = options.backend ?? "embedded";
  assertRunExecutionAdmission(journal.record, backend);
  const workflowPath = await realpath(options.workflowPath);
  const source = await readFile(workflowPath, "utf8");
  if (
    journal.record.workflowPath !== workflowPath ||
    journal.record.workflowHash !== sha256(source)
  ) {
    throw new WorkflowChangedError("Workflow source changed since this Jaeger run started");
  }
  if (options.cwd !== undefined && journal.record.cwd !== requestedCwd) {
    throw new WorkflowChangedError("Workflow working directory changed since this Jaeger run started");
  }
  if (options.inputs !== undefined) {
    const inputs = toJsonValue(options.inputs, "inputs");
    if (stableJson(inputs) !== stableJson(journal.record.inputs)) {
      throw new WorkflowChangedError("Workflow inputs changed since this Jaeger run started");
    }
  }
  if (
    options.maxConcurrency !== undefined &&
    checkedConcurrency(options.maxConcurrency) !== journal.record.maxConcurrency
  ) {
    throw new WorkflowChangedError("Workflow concurrency policy changed since this Jaeger run started");
  }
  if (options.harnessDefinitions !== undefined) {
    const requested = validateHarnessDefinitions(options.harnessDefinitions);
    const pinned =
      journal.record.version === 3 || journal.record.version === 4
        ? validateHarnessDefinitions(journal.record.harnesses, {
            allowPinnedBuiltins: true,
          })
        : builtinHarnessDefinitions();
    if (
      stableJson(toJsonValue(requested, "harness definitions")) !==
      stableJson(toJsonValue(pinned, "harness definitions"))
    ) {
      throw new WorkflowChangedError(
        "Workflow harness definitions changed since this Jaeger run started",
      );
    }
  }
  return {
    runId: journal.record.runId,
    runDir: journal.runDir,
    stateDir,
    scriptPath: workflowPath,
    isResume: true,
    backend,
  };
}

export async function runWorkflow(options: RunWorkflowOptions): Promise<WorkflowRunResult> {
  const prepared = options.resumeRunId
    ? await openWorkflowForResume({
        workflowPath: options.workflowPath,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.inputs !== undefined ? { inputs: options.inputs } : {}),
        ...(options.stateDir ? { stateDir: options.stateDir } : {}),
        ...(options.maxConcurrency !== undefined ? { maxConcurrency: options.maxConcurrency } : {}),
        ...(options.harnessDefinitions
          ? { harnessDefinitions: options.harnessDefinitions }
          : {}),
        runId: options.resumeRunId,
      })
    : await prepareWorkflowRun({
        workflowPath: options.workflowPath,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.inputs !== undefined ? { inputs: options.inputs } : {}),
        ...(options.trigger ? { trigger: options.trigger } : {}),
        ...(options.stateDir ? { stateDir: options.stateDir } : {}),
        ...(options.maxConcurrency !== undefined ? { maxConcurrency: options.maxConcurrency } : {}),
        ...(options.harnessDefinitions
          ? { harnessDefinitions: options.harnessDefinitions }
          : {}),
      });
  return await executePreparedRun({
    stateDir: prepared.stateDir,
    runId: prepared.runId,
    ownerKind: "foreground",
    resumeRequested: prepared.isResume,
    ...(options.harnesses ? { harnesses: options.harnesses } : {}),
    ...(options.reporter ? { reporter: options.reporter } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    expectedBackend: "embedded",
  });
}

export async function executePreparedRun(
  options: ExecutePreparedRunOptions,
): Promise<WorkflowRunResult> {
  const journal = await RunJournal.open(path.resolve(options.stateDir), options.runId);
  assertRunExecutionAdmission(journal.record, options.expectedBackend ?? "embedded");
  const beforeLease = await journal.readEvents();
  const beforeAnalysis = analyzeJournal(beforeLease.events, beforeLease.truncatedTail);
  const completed = beforeLease.truncatedTail
    ? undefined
    : completedResult(journal, beforeAnalysis);
  if (completed) return completed;

  const lease = await RunLease.acquire(
    journal.runDir,
    journal.record.runId,
    options.ownerKind ?? "foreground",
  );
  try {
    let read = await journal.readEvents();
    if (read.truncatedTail) {
      const completePrefix = analyzeJournal(read.events, false);
      const uncertainAgent = [...completePrefix.agents.values()].some(
        (agent) => agent.state !== "completed",
      );
      if (!completePrefix.corruption && !uncertainAgent) {
        await journal.discardTruncatedTail();
        read = await journal.readEvents();
      }
    }
    const history = analyzeJournal(read.events, read.truncatedTail);
    const completedAfterLease = completedResult(journal, history);
    if (completedAfterLease) return completedAfterLease;
    assertRunnable(history, journal.runDir);
    const pinnedSource = await journal.source();
    if (sha256(pinnedSource) !== journal.record.workflowHash) {
      throw new JournalCorruptionError(
        `Pinned workflow source no longer matches the immutable run record: ${journal.runDir}/workflow.source`,
      );
    }
    throwIfAborted(options.signal);
    const stopRequest = await journal.stopRequest();
    if (stopRequest?.ownerToken === lease.owner.token) {
      throw new RunStoppedError(`Jaeger run ${journal.record.runId} was stopped before execution`);
    }
    if (stopRequest) {
      if (!options.resumeRequested) {
        throw new RunStoppedError(
          `Jaeger run ${journal.record.runId} is stopped; use its explicit resume command to start a new ownership attempt`,
        );
      }
      await journal.clearStopRequest();
    }
    await journal.append({
      type: history.workflowStarted ? "workflow.resumed" : "workflow.started",
      ownerKind: options.ownerKind ?? "foreground",
    });
    return await runPinnedWorkflow(journal, pinnedSource, history, options);
  } finally {
    await lease.release();
  }
}

async function runPinnedWorkflow(
  journal: RunJournal,
  source: string,
  history: JournalAnalysis,
  options: ExecutePreparedRunOptions,
): Promise<WorkflowRunResult> {
  const compiled = compileWorkflowSource(source, journal.record.workflowPath);
  const harnesses = options.harnesses ?? harnessesForRun(journal.record);
  const reporter = options.reporter ?? silentReporter;
  const scopes = new AsyncLocalStorage<StepScope>();
  const rootScope: StepScope = {
    path: "root",
    agentCount: 0,
    parallelCount: 0,
    phaseCount: 0,
    logCount: 0,
  };
  const semaphore = new Semaphore(journal.record.maxConcurrency);
  const inFlight = new Set<Promise<unknown>>();
  const workFailures = new Set<unknown>();
  let workGeneration = 0;
  let meta: WorkflowMeta | undefined;

  const context: WorkflowContext = {
    inputs: cloneJson(journal.record.inputs),
    trigger:
      journal.record.version === 4 && journal.record.trigger
        ? structuredClone(journal.record.trigger)
        : undefined,
    setMeta(value) {
      const next = validateMeta(value);
      if (
        meta &&
        stableJson(toJsonValue(meta, "workflow meta")) !==
          stableJson(toJsonValue(next, "workflow meta"))
      ) {
        throw new WorkflowChangedError("Workflow declared different metadata during replay");
      }
      meta = next;
    },
    phase(name) {
      throwIfAborted(options.signal);
      if (typeof name !== "string" || name.trim().length === 0) {
        throw new TypeError("phase name must be non-empty");
      }
      const scope = scopes.getStore() ?? rootScope;
      const stepId = `${scope.path}/phase:${++scope.phaseCount}`;
      const prior = history.phases.get(stepId);
      if (prior) {
        if (prior.name !== name) {
          throw new WorkflowChangedError(`Phase changed during replay at ${stepId}`);
        }
      } else {
        observeJournalAppend(journal.append({ type: "phase", stepId, name }));
      }
      reporter.phase(name);
    },
    log(message) {
      throwIfAborted(options.signal);
      const rendered =
        typeof message === "string"
          ? message
          : stableJson(toJsonValue(message, "workflow log message"));
      const scope = scopes.getStore() ?? rootScope;
      const stepId = `${scope.path}/log:${++scope.logCount}`;
      const prior = history.logs.get(stepId);
      if (prior) {
        if (prior.message !== rendered) {
          throw new WorkflowChangedError(`Log message changed during replay at ${stepId}`);
        }
      } else {
        observeJournalAppend(journal.append({ type: "log", stepId, message: rendered }));
      }
      reporter.log(rendered);
    },
    parallel(tasks) {
      workGeneration++;
      const promise = (async () => {
        if (!Array.isArray(tasks)) throw new TypeError("parallel tasks must be an array");
        const parent = scopes.getStore() ?? rootScope;
        const parallelIndex = ++parent.parallelCount;
        const settled = await withAbort(
          Promise.allSettled(
            tasks.map((task, index) => {
              if (typeof task !== "function") {
                return Promise.reject(new TypeError(`parallel task ${index} must be a function`));
              }
              return scopes.run(
                {
                  path: `${parent.path}/parallel:${parallelIndex}:${index}`,
                  agentCount: 0,
                  parallelCount: 0,
                  phaseCount: 0,
                  logCount: 0,
                },
                async () => await task(),
              );
            }),
          ),
          options.signal,
        );
        const failures = settled.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failures.length > 0) {
          throw new AggregateError(
            failures.map((failure) => failure.reason),
            `${failures.length} parallel workflow task(s) failed`,
          );
        }
        return settled.map((result) => (result as PromiseFulfilledResult<unknown>).value) as never;
      })();
      trackInFlight(promise, inFlight, workFailures);
      return promise;
    },
    agent(prompt, rawOptions) {
      workGeneration++;
      const promise = executeAgent(
        prompt,
        rawOptions,
        journal,
        history.agents,
        harnesses,
        reporter,
        scopes.getStore() ?? rootScope,
        semaphore,
        options.signal,
      );
      trackInFlight(promise, inFlight, workFailures);
      return promise;
    },
  };

  let workflowResult: unknown;
  let workflowError: unknown;
  try {
    workflowResult = await scopes.run(rootScope, async () => await compiled.run(context));
  } catch (error) {
    workflowError = error;
  }

  await waitForWorkflowQuiescence(inFlight, () => workGeneration);
  if (workFailures.size > 0) {
    const failures = [...workFailures];
    const errors = failures.filter((candidate, index) => {
      if (workflowError !== undefined && errorContains(workflowError, candidate)) return false;
      return !failures.some(
        (container, containerIndex) =>
          containerIndex !== index && errorContains(container, candidate),
      );
    });
    if (errors.length > 0) {
      workflowError = workflowError
        ? new AggregateError([workflowError, ...errors], "Workflow execution failed")
        : errors.length === 1
          ? errors[0]
          : new AggregateError(errors, `${errors.length} workflow operations failed`);
    }
  }

  if (workflowError !== undefined) {
    await journal.append({
      type: options.signal?.aborted === true ? "workflow.interrupted" : "workflow.failed",
      error: errorMessage(workflowError),
    });
    await journal.flush();
    throw workflowError;
  }

  try {
    if (!meta) throw new Error("Workflow did not initialize its metadata");
    const durableResult = toJsonValue(workflowResult ?? null, "workflow result");
    const durableMeta = toJsonValue(meta, "workflow meta");
    await journal.append({ type: "workflow.completed", meta: durableMeta, result: durableResult });
    await journal.flush();
    return {
      runId: journal.record.runId,
      meta,
      result: durableResult,
      runDir: journal.runDir,
    };
  } catch (error) {
    await journal.append({ type: "workflow.failed", error: errorMessage(error), stopped: false });
    await journal.flush();
    throw error;
  }
}

function executeAgent(
  prompt: string,
  rawOptions: AgentOptions,
  journal: RunJournal,
  history: ReadonlyMap<string, AgentJournalState>,
  harnesses: ReadonlyMap<string, HarnessAdapter>,
  reporter: RuntimeReporter,
  scope: StepScope,
  semaphore: Semaphore,
  signal?: AbortSignal,
): Promise<unknown> {
  return (async () => {
    throwIfAborted(signal);
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      throw new TypeError("agent prompt must be non-empty");
    }
    const agentOptions = validateAgentOptions(rawOptions);
    const adapter = harnesses.get(agentOptions.harness);
    if (!adapter) throw new TypeError(`Unknown harness: ${agentOptions.harness}`);
    adapter.validateOptions?.(agentOptions);
    const validator = agentOptions.schema
      ? compileStructuredOutputValidator(agentOptions.schema)
      : undefined;
    const agentIndex = ++scope.agentCount;
    const label = agentOptions.label ? `:${slug(agentOptions.label)}` : "";
    const stepId = `${scope.path}/agent:${agentIndex}${label}`;
    const cwd = await realpath(path.resolve(journal.record.cwd, agentOptions.cwd ?? journal.record.cwd));
    const timeoutMs = checkedTimeout(agentOptions.timeoutMs);
    const requestBase: Omit<AgentRequest, "session"> = {
      ...agentOptions,
      prompt,
      harness: agentOptions.harness,
      cwd,
      timeoutMs,
      runDir: journal.runDir,
      stepId,
      ...(signal ? { signal } : {}),
    };
    const requestHash = sha256(stableJson(requestFingerprint(requestBase)));
    const prior = history.get(stepId);
    if (prior?.state === "completed" && prior.terminal) {
      if (prior.requestHash !== requestHash) {
        throw new WorkflowChangedError(`Agent request changed during replay at ${stepId}`);
      }
      const output = cloneJson(prior.terminal.output as JsonValue);
      if (validator) validator(output);
      reporter.agentCompleted(stepId, true);
      return output;
    }
    if (prior) {
      throw new UncertainAgentRunError(
        `Agent ${stepId} previously started without one durable completion; inspect ${journal.runDir}`,
      );
    }

    const release = await semaphore.acquire(signal);
    try {
      throwIfAborted(signal);
      reporter.agentStarted(stepId, agentOptions);
      const started = process.hrtime.bigint();
      let session: ManagedSessionTurn | undefined;
      try {
        const sessionId = workflowSessionId(stepId, agentOptions.harness);
        await journal.append({
          type: "agent.started",
          stepId,
          requestHash,
          sessionId,
          harness: agentOptions.harness,
          ...(agentOptions.label ? { label: agentOptions.label } : {}),
          ...(agentOptions.model ? { model: agentOptions.model } : {}),
        });
        session = await ManagedSessionTurn.create(
          journal.runDir,
          journal.record.runId,
          stepId,
          agentOptions,
          cwd,
        );
        const request: AgentRequest = { ...requestBase, session };
        const execution = await adapter.execute(request);
        const output = toJsonValue(execution.output, `agent output at ${stepId}`);
        if (validator) validator(output);
        await session.complete(output, execution.metadata);
        const durationMs = elapsedMilliseconds(started);
        await journal.append({
          type: "agent.completed",
          stepId,
          requestHash,
          output,
          durationMs,
          sessionId: session.id,
          ...(execution.nativeSessionId
            ? { nativeSessionId: execution.nativeSessionId }
            : {}),
          ...(execution.metadata
            ? { metadata: toJsonValue(execution.metadata, "harness metadata") }
            : {}),
        });
        reporter.agentCompleted(stepId, false);
        return cloneJson(output);
      } catch (error) {
        await session?.fail(error);
        await journal.append({
          type: "agent.failed",
          stepId,
          requestHash,
          error: errorMessage(error),
          ...(error instanceof HarnessExecutionError
            ? {
                exitCode: error.exitCode,
                signal: error.signal,
                stderr: error.stderr,
              }
            : {}),
          uncertain: true,
          durationMs: elapsedMilliseconds(started),
        });
        throw error;
      }
    } finally {
      release();
    }
  })();
}

function validateAgentOptions(value: unknown): AgentOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("agent options must be an object");
  }
  const candidate = value as Record<string, unknown>;
  for (const key of Object.keys(candidate)) {
    if (!AGENT_OPTION_KEYS.has(key)) {
      if (key === "access" || key === "fresh") {
        throw new TypeError(
          `agent option ${key} was removed; every worker session is persisted and has full non-interactive authority`,
        );
      }
      throw new TypeError(`Unknown agent option: ${key}`);
    }
  }
  validateHarnessName(candidate.harness);
  for (const key of ["label", "model", "effort", "serviceTier", "cwd", "profile"] as const) {
    const field = candidate[key];
    if (field !== undefined && (typeof field !== "string" || field.trim().length === 0)) {
      throw new TypeError(`agent ${key} must be a non-empty string`);
    }
  }
  if (
    candidate.schema !== undefined &&
    (!candidate.schema || typeof candidate.schema !== "object" || Array.isArray(candidate.schema))
  ) {
    throw new TypeError("agent schema must be a JSON Schema object");
  }
  if (candidate.timeoutMs !== undefined) checkedTimeout(candidate.timeoutMs as number);
  return candidate as unknown as AgentOptions;
}

function requestFingerprint(request: Omit<AgentRequest, "session">): JsonValue {
  return toJsonValue(
    {
      harness: request.harness,
      prompt: request.prompt,
      label: request.label ?? null,
      cwd: request.cwd,
      model: request.model ?? null,
      effort: request.effort ?? null,
      serviceTier: request.serviceTier ?? null,
      profile: request.profile ?? null,
      schema: request.schema ?? null,
      timeoutMs: request.timeoutMs,
    },
    "agent request",
  );
}

function completedResult(
  journal: RunJournal,
  analysis: JournalAnalysis,
): WorkflowRunResult | undefined {
  if (analysis.corruption || analysis.workflowTerminal?.type !== "workflow.completed") return undefined;
  const meta = analysis.workflowTerminal.meta as unknown as WorkflowMeta;
  return {
    runId: journal.record.runId,
    meta,
    result: cloneJson(analysis.workflowTerminal.result as JsonValue),
    runDir: journal.runDir,
  };
}

function assertRunnable(analysis: JournalAnalysis, runDir: string): void {
  const uncertainAgent = [...analysis.agents.values()].find((agent) => agent.state !== "completed");
  if (analysis.corruption || uncertainAgent) {
    const stepId = analysis.corruption?.stepId ?? uncertainAgent?.stepId;
    throw new UncertainAgentRunError(
      `Jaeger run has an uncertain boundary${stepId ? ` at ${stepId}` : ""}; inspect ${runDir} before starting a new run`,
    );
  }
  if (analysis.workflowTerminal?.type === "workflow.failed") {
    throw new RunTerminalError("A deterministically failed Jaeger run cannot resume; start a new run");
  }
}

function checkedTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 24 * 60 * 60 * 1_000) {
    throw new TypeError("agent timeoutMs must be a positive integer no greater than 24 hours");
  }
  return timeout;
}

function checkedConcurrency(value: number | undefined): number {
  const concurrency = value ?? DEFAULT_MAX_CONCURRENCY;
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0 || concurrency > MAX_CONCURRENCY) {
    throw new TypeError(`max concurrency must be an integer between 1 and ${MAX_CONCURRENCY}`);
  }
  return concurrency;
}

function validateMeta(value: unknown): WorkflowMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("workflow meta must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.name !== "string" || candidate.name.trim().length === 0) {
    throw new TypeError("workflow meta.name must be a non-empty string");
  }
  return toJsonValue(candidate, "workflow meta") as unknown as WorkflowMeta;
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

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key] as JsonValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function slug(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) throw new TypeError("agent label must contain a letter or number");
  return normalized.slice(0, 100);
}

function elapsedMilliseconds(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}

function errorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    return `${error.message}: ${error.errors.map(errorMessage).join("; ")}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new RunStoppedError("Jaeger run was stopped");
}

function observeJournalAppend(promise: Promise<void>): void {
  // The journal retains the rejection in its serialized pending chain, so the
  // next awaited append/flush still fails the run. This handler only prevents a
  // synchronous phase()/log() call from producing an unhandled rejection first.
  void promise.catch(() => undefined);
}

function trackInFlight(
  promise: Promise<unknown>,
  inFlight: Set<Promise<unknown>>,
  failures: Set<unknown>,
): void {
  inFlight.add(promise);
  void promise.then(
    () => {
      inFlight.delete(promise);
    },
    (error: unknown) => {
      failures.add(error);
      inFlight.delete(promise);
    },
  );
}

function errorContains(container: unknown, candidate: unknown): boolean {
  if (container === candidate) return true;
  return (
    container instanceof AggregateError &&
    container.errors.some((nested: unknown) => errorContains(nested, candidate))
  );
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : new RunStoppedError("Jaeger run was stopped"),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new RunStoppedError("Jaeger run was stopped"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function waitForWorkflowQuiescence(
  inFlight: ReadonlySet<Promise<unknown>>,
  generation: () => number,
): Promise<void> {
  // Realm promise continuations can launch another operation just after its direct
  // host-side promise settles. Require two complete event-loop turns with
  // no new generation and no in-flight work before writing a workflow terminal
  // event. Coordinator timers/network are unavailable, so all legal future
  // launches must drain through these promise continuations.
  let observedGeneration = generation();
  let stableTurns = 0;
  while (stableTurns < 2) {
    if (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const nextGeneration = generation();
    if (inFlight.size === 0 && nextGeneration === observedGeneration) {
      stableTurns++;
    } else {
      observedGeneration = nextGeneration;
      stableTurns = 0;
    }
  }
}

class Semaphore {
  private active = 0;
  private readonly waiting: Array<{
    readonly resolve: (release: () => void) => void;
    readonly reject: (error: unknown) => void;
    readonly signal?: AbortSignal;
    readonly onAbort?: () => void;
  }> = [];

  constructor(private readonly limit: number) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(
        signal.reason instanceof Error ? signal.reason : new RunStoppedError("Jaeger run was stopped"),
      );
    }
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(this.releaseFunction());
    }
    return new Promise((resolve, reject) => {
      const waiter: {
        resolve: (release: () => void) => void;
        reject: (error: unknown) => void;
        signal?: AbortSignal;
        onAbort?: () => void;
      } = { resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiting.indexOf(waiter);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new RunStoppedError("Jaeger run was stopped"),
          );
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiting.push(waiter);
    });
  }

  private releaseFunction(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      while (this.waiting.length > 0) {
        const next = this.waiting.shift();
        if (!next) break;
        if (next.onAbort && next.signal) {
          next.signal.removeEventListener("abort", next.onAbort);
        }
        if (next.signal?.aborted) continue;
        this.active++;
        next.resolve(this.releaseFunction());
        break;
      }
    };
  }
}

const silentReporter: RuntimeReporter = {
  phase() {},
  log() {},
  agentStarted() {},
  agentCompleted() {},
};
