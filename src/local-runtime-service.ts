import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertRunExecutionAdmission,
  describeLocalWorkspace,
  type LocalWorkspaceDescriptor,
} from "./admission.js";
import type { BackendMethod } from "./backend-protocol.js";
import { BackendRpcError } from "./backend-protocol.js";
import { doctor } from "./doctor.js";
import { loadHarnessDefinitions, pinHarnessDefinitions } from "./harnesses/registry.js";
import { stepScratchDirectory } from "./harnesses/support.js";
import { RunJournal } from "./journal.js";
import { launchDetachedRun, stopRun, waitForRun } from "./lifecycle.js";
import { inspectRun } from "./run-state.js";
import { resumeSession } from "./session-runtime.js";
import {
  inspectSessionTurn,
  recoverSessionTurns,
  submitSessionTurn,
  waitForSessionTurn,
} from "./session-turns.js";
import {
  createSessionQueryId,
  inspectSessionQuery,
  recoverSessionQueries,
  submitSessionQuery,
  waitForSessionQuery,
} from "./session-queries.js";
import {
  listWorkflowSessions,
  requestSessionControl,
} from "./sessions.js";
import {
  discardPreparedWorkflowRun,
  openPreparedRunForResume,
  prepareWorkflowRun,
  publishPreparedWorkflowRun,
  type PreparedWorkflowRun,
} from "./runtime.js";
import {
  claimSubmission,
  listSubmissionClaims,
  readSubmissionClaim,
  reconcileClaimedRun,
  submissionClaimFor,
  type SubmissionClaim,
} from "./submission-index.js";
import type {
  HarnessDefinition,
  JsonValue,
  WorkflowRunSummary,
  WorkflowSessionSummary,
} from "./types.js";
import { JAEGER_VERSION, WORKFLOW_RUNTIME_ABI } from "./version.js";
import { readBackendInstallConfigFile } from "./paths.js";
import {
  ScheduleStore,
  validateCronExpression,
  type CronTrigger,
  type ScheduleApplication,
  type ScheduleLaunchRequest,
  type SchedulePolicy,
} from "./schedules.js";
import { compileWorkflowSource } from "./compiler.js";
import type { HookConfig } from "./hook-config.js";
import { HookManager } from "./hooks.js";
import {
  RuntimeModuleHost,
  type RuntimeModuleConfig,
} from "./runtime-modules.js";

const RUN_ID_PATTERN = /^\d{14}-[a-f0-9]{10}$/;

interface SubmissionIntent {
  readonly stateDir: string;
  readonly submissionId: string;
  readonly submissionHash: string;
  readonly requestedWorkflowPath: string;
  readonly requestedCwd: string;
  readonly workflowSource: string;
  readonly inputs: JsonValue;
  readonly maxConcurrency: number;
  readonly requestedHarnessConfigPath?: string;
  readonly trigger?: import("./types.js").WorkflowTriggerMetadata;
  readonly pinnedHarnessDefinitions?: readonly HarnessDefinition[];
  readonly pinnedWorkspace?: LocalWorkspaceDescriptor;
  readonly pinnedWorkflowPath?: boolean;
}

interface NormalizedSubmission extends SubmissionIntent {
  readonly workflowPath: string;
  readonly cwd: string;
  readonly harnessDefinitions: readonly HarnessDefinition[];
  readonly workspace: LocalWorkspaceDescriptor;
}

export interface LocalRuntimeServiceOptions {
  readonly stateDir: string;
  readonly entrypoint: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly harnessConfigPath?: string;
  readonly backendKind?: "embedded" | "local-service";
  readonly installGeneration?: string;
  readonly installInstanceId?: string;
  readonly installProfilePath?: string;
  readonly installPending?: boolean;
  readonly hooksConfigPath?: string;
  readonly hooksConfig?: HookConfig;
  readonly hooksConfigError?: string;
  readonly runtimeModuleConfig?: RuntimeModuleConfig;
  readonly runtimeModuleConfigPath?: string;
}

export class LocalRuntimeService {
  readonly stateDir: string;
  readonly backendKind: "embedded" | "local-service";
  readonly installGeneration: string | undefined;
  readonly installInstanceId: string | undefined;
  private readonly entrypoint: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly harnessConfigPath: string | undefined;
  private readonly hooksConfigPath: string | undefined;
  private readonly runtimeModuleConfigPath: string | undefined;
  private readonly installProfilePath: string | undefined;
  private readonly installPending: boolean;
  private readonly schedules: ScheduleStore;
  private readonly hooks: HookManager;
  private readonly modules: RuntimeModuleHost;
  private scheduleTimer: NodeJS.Timeout | undefined;
  private scheduleTick: Promise<void> | undefined;
  private readonly submissions = new Map<
    string,
    { readonly hash: string; readonly promise: Promise<JsonValue> }
  >();

  constructor(options: LocalRuntimeServiceOptions) {
    this.stateDir = path.resolve(options.stateDir);
    this.entrypoint = path.resolve(options.entrypoint);
    this.env = { ...process.env, ...options.env };
    this.harnessConfigPath = options.harnessConfigPath;
    this.hooksConfigPath = options.hooksConfigPath;
    this.runtimeModuleConfigPath = options.runtimeModuleConfigPath;
    this.backendKind = options.backendKind ?? "local-service";
    this.installGeneration = options.installGeneration;
    this.installInstanceId = options.installInstanceId;
    this.installProfilePath = options.installProfilePath;
    this.installPending = options.installPending ?? false;
    this.schedules = new ScheduleStore({
      stateDir: this.stateDir,
      submit: async (request) => await this.submitScheduled(request),
      inspectRun: async (runId) => await inspectRun(this.stateDir, runId),
    });
    this.hooks = new HookManager({
      stateDir: this.stateDir,
      ...(options.hooksConfigPath ? { configPath: options.hooksConfigPath } : {}),
      ...(options.hooksConfig ? { config: options.hooksConfig } : {}),
      ...(options.hooksConfigError ? { configError: options.hooksConfigError } : {}),
      env: this.env,
      collectEvents: Boolean(options.runtimeModuleConfig?.modules.length),
    });
    this.modules = new RuntimeModuleHost({
      stateDir: this.stateDir,
      ...(options.runtimeModuleConfig ? { config: options.runtimeModuleConfig } : {}),
      operations: {
        listRuns: async () => await this.list({}),
        inspectRun: async (runId) => await this.inspect({ runId }),
        listSessions: async (runId) => await this.sessionList({ runId }),
        inspectSession: async (runId, selector) =>
          await this.sessionInspect({ runId, selector }),
        querySession: async (runId, selector, queryOptions) =>
          await this.sessionQuerySubmit(
            {
              runId,
              selector,
              message: queryOptions.message,
              queryId: queryOptions.queryId ?? createSessionQueryId(),
              ...(queryOptions.model ? { model: queryOptions.model } : {}),
              ...(queryOptions.timeoutMs ? { timeoutMs: queryOptions.timeoutMs } : {}),
            },
          ),
        inspectSessionQuery: async (runId, queryId) =>
          await this.sessionQueryInspect({ runId, queryId }),
        waitSessionQuery: async (runId, queryId) =>
          await this.sessionQueryWait({ runId, queryId }),
      },
    });
  }

  async dispatch(method: BackendMethod, rawParams: JsonValue, signal?: AbortSignal): Promise<JsonValue> {
    const params = recordParams(rawParams);
    if (method !== "ping" && !this.installationCommitted()) {
      throw new BackendRpcError(
        "backend_install_pending",
        "Jaeger backend installation is not committed; run 'jaeger backend install' to reconcile the local service",
      );
    }
    switch (method) {
      case "ping":
        return this.backendDescriptor();
      case "doctor":
        return await this.doctor(optionalString(params.harnessConfigPath, "harnessConfigPath"));
      case "run.submit":
        return await this.submit(params);
      case "run.lookup":
        return await this.lookupSubmission(params);
      case "run.inspect":
        return await this.inspect(params);
      case "run.wait":
        return await this.wait(params, signal);
      case "run.stop":
        return await this.stop(params);
      case "run.resume":
        return await this.resume(params);
      case "run.list":
        return await this.list(params);
      case "run.details":
        return await this.details(params);
      case "schedule.apply":
        return await this.scheduleApply(params);
      case "schedule.list":
        return await this.scheduleList();
      case "schedule.inspect":
        return await this.scheduleInspect(params);
      case "schedule.enable":
        return await this.scheduleEnable(params);
      case "schedule.disable":
        return await this.scheduleDisable(params);
      case "schedule.remove":
        return await this.scheduleRemove(params);
      case "schedule.history":
        return await this.scheduleHistory(params);
      case "schedule.trigger":
        return await this.scheduleTrigger(params);
      case "hooks.status":
        return await this.hooks.status();
      case "hooks.history":
        return await this.hooks.history({
          ...(params.hook !== undefined
            ? { hook: requiredString(params.hook, "hook") }
            : {}),
          ...(params.eventId !== undefined
            ? { eventId: requiredString(params.eventId, "eventId") }
            : {}),
          ...(params.limit !== undefined
            ? { limit: positiveInteger(params.limit, "limit") }
            : {}),
        });
      case "modules.status":
        return this.modules.status();
      case "session.list":
        return await this.sessionList(params);
      case "session.inspect":
        return await this.sessionInspect(params);
      case "session.resume":
        return await this.sessionResume(params, signal);
      case "session.query.submit":
        return await this.sessionQuerySubmit(params, signal);
      case "session.query.inspect":
        return await this.sessionQueryInspect(params);
      case "session.query.wait":
        return await this.sessionQueryWait(params, signal);
      case "session.turn.inspect":
        return await this.sessionTurnInspect(params);
      case "session.turn.wait":
        return await this.sessionTurnWait(params, signal);
      case "session.control":
        return await this.sessionControl(params);
    }
  }

  async recover(): Promise<{
    readonly considered: number;
    readonly eligible: number;
    readonly relaunched: readonly string[];
    readonly errors: readonly { readonly runId: string; readonly error: string }[];
  }> {
    const claims = await listSubmissionClaims(this.stateDir);
    const verifiedClaims = new Map<string, SubmissionClaim>();
    const invalidClaimedRuns = new Set<string>();
    const errors: Array<{ runId: string; error: string }> = [];
    for (const claim of claims) {
      try {
        await reconcileClaimedRun(this.stateDir, claim);
        if (invalidClaimedRuns.has(claim.runId) || verifiedClaims.has(claim.runId)) {
          throw new Error(`Run ${claim.runId} is named by more than one submission claim`);
        }
        verifiedClaims.set(claim.runId, claim);
      } catch (error) {
        invalidClaimedRuns.add(claim.runId);
        verifiedClaims.delete(claim.runId);
        errors.push({ runId: claim.runId, error: errorMessage(error) });
      }
    }
    const runIds = await this.runIds(this.stateDir);
    let eligible = 0;
    const relaunched: string[] = [];
    for (const runId of runIds) {
      try {
        const journal = await RunJournal.open(this.stateDir, runId);
        if (
          journal.record.version !== 4 ||
          journal.record.runtime.backend !== "local-service"
        ) {
          continue;
        }
        const claim = verifiedClaims.get(runId);
        if (
          !journal.record.submissionId ||
          invalidClaimedRuns.has(runId) ||
          !claim ||
          claim.submissionId !== journal.record.submissionId ||
          claim.submissionHash !== journal.record.submissionHash ||
          claim.backend !== journal.record.runtime.backend
        ) {
          throw new Error(
            `Service-owned run ${runId} does not have one verified durable submission claim`,
          );
        }
        const sessionRecovery = await recoverSessionTurns(
          {
            stateDir: this.stateDir,
            entrypoint: this.entrypoint,
            env: this.env,
            backend: "local-service",
          },
          runId,
        );
        for (const failure of sessionRecovery.errors) {
          errors.push({ runId, error: `${failure.turnId}: ${failure.error}` });
        }
        const queryRecovery = await recoverSessionQueries(
          {
            stateDir: this.stateDir,
            entrypoint: this.entrypoint,
            env: this.env,
            backend: "local-service",
          },
          runId,
        );
        for (const failure of queryRecovery.errors) {
          errors.push({ runId, error: `${failure.queryId}: ${failure.error}` });
        }
        eligible++;
        const summary = await inspectRun(this.stateDir, runId);
        if (summary.status !== "pending" && summary.status !== "interrupted") continue;
        const prepared = await openPreparedRunForResume({
          stateDir: this.stateDir,
          runId,
          expectedBackend: "local-service",
        });
        await launchDetachedRun(prepared, { entrypoint: this.entrypoint, env: this.env });
        relaunched.push(runId);
      } catch (error) {
        errors.push({ runId, error: errorMessage(error) });
      }
    }
    return { considered: runIds.length, eligible, relaunched, errors };
  }

  admissionReady(): boolean {
    return this.installationCommitted();
  }

  async initializeModules(): Promise<void> {
    if (this.backendKind !== "local-service" || !this.installationCommitted()) return;
    await this.modules.initialize();
  }

  startRuntimeServices(): void {
    this.startScheduling();
    this.startHooks();
    this.startModules();
  }

  async stopRuntimeServices(): Promise<void> {
    await Promise.all([
      this.stopScheduling(),
      this.stopHooks(),
      this.stopModules(),
    ]);
  }

  startScheduling(): void {
    if (
      this.backendKind !== "local-service" ||
      !this.installationCommitted() ||
      this.scheduleTimer
    ) {
      return;
    }
    const tick = (): void => {
      if (this.scheduleTick) return;
      this.scheduleTick = this.schedules
        .tick()
        .catch((error) => {
          process.stderr.write(`jaeger schedule service: ${errorMessage(error)}\n`);
        })
        .finally(() => {
          this.scheduleTick = undefined;
        });
    };
    tick();
    this.scheduleTimer = setInterval(tick, 5_000);
    this.scheduleTimer.unref();
  }

  async stopScheduling(): Promise<void> {
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    this.scheduleTimer = undefined;
    await this.scheduleTick;
  }

  startHooks(): void {
    if (this.backendKind !== "local-service" || !this.installationCommitted()) return;
    this.hooks.start();
  }

  async stopHooks(): Promise<void> {
    await this.hooks.stop();
  }

  startModules(): void {
    if (this.backendKind !== "local-service" || !this.installationCommitted()) return;
    this.modules.start();
  }

  async stopModules(): Promise<void> {
    await this.modules.stop();
  }

  private backendDescriptor() {
    return {
      ready: true,
      backend: {
        name: "local",
        kind: this.backendKind,
        version: JAEGER_VERSION,
        host: os.hostname(),
        protocol: 1,
        runtimeAbi: WORKFLOW_RUNTIME_ABI,
        capabilities: {
          schedules: this.backendKind === "local-service",
          hooks: this.backendKind === "local-service",
          modules: this.backendKind === "local-service",
        },
        stateDir: this.stateDir,
        entrypoint: this.entrypoint,
        ...(this.harnessConfigPath ? { harnessConfigPath: this.harnessConfigPath } : {}),
        ...(this.hooksConfigPath ? { hooksConfigPath: this.hooksConfigPath } : {}),
        ...(this.runtimeModuleConfigPath
          ? { runtimeModuleConfigPath: this.runtimeModuleConfigPath }
          : {}),
        ...(this.installGeneration ? { generation: this.installGeneration } : {}),
        ...(this.installInstanceId ? { instanceId: this.installInstanceId } : {}),
        admissionReady: this.installationCommitted(),
        pid: process.pid,
      },
    };
  }

  private installationCommitted(): boolean {
    if (this.backendKind !== "local-service" || !this.installGeneration) return true;
    if (this.installPending) return false;
    if (!this.installProfilePath) return false;
    try {
      const profile = readBackendInstallConfigFile(this.installProfilePath);
      return (
        profile?.generation === this.installGeneration &&
        (this.installInstanceId === undefined ||
          profile.instanceId === this.installInstanceId)
      );
    } catch {
      return false;
    }
  }

  private async doctor(harnessConfigPath?: string): Promise<JsonValue> {
    const result = await doctor(
      await loadHarnessDefinitions(harnessConfigPath ?? this.harnessConfigPath),
    );
    return jsonValue({
      ...result,
      backend: this.backendDescriptor().backend,
      hooks: await this.hooks.status(),
    });
  }

  private async submit(params: Record<string, JsonValue>): Promise<JsonValue> {
    const intent = this.submissionIntent(params);
    const key = `${intent.stateDir}\0${intent.submissionId}`;
    const existing = this.submissions.get(key);
    if (existing) {
      if (existing.hash !== intent.submissionHash) {
        throw new BackendRpcError(
          "idempotency_conflict",
          `Submission id ${intent.submissionId} was already used for a different run request`,
        );
      }
      return await existing.promise;
    }
    const operation = this.submitIntent(intent).finally(() => {
      this.submissions.delete(key);
    });
    this.submissions.set(key, { hash: intent.submissionHash, promise: operation });
    return await operation;
  }

  private submissionIntent(params: Record<string, JsonValue>): SubmissionIntent {
    const submissionId = requiredString(params.submissionId, "submissionId");
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(submissionId)) {
      throw new BackendRpcError("invalid_request", "submissionId is invalid");
    }
    const stateDir = this.requestStateDir(params);
    if (
      params.workflowPathPinned !== undefined &&
      typeof params.workflowPathPinned !== "boolean"
    ) {
      throw new BackendRpcError(
        "invalid_request",
        "workflowPathPinned must be a boolean",
      );
    }
    const pinnedWorkflowPath = params.workflowPathPinned === true;
    const workflowPathValue = requiredString(params.workflowPath, "workflowPath");
    const requestedWorkflowPath = pinnedWorkflowPath
      ? workflowPathValue
      : path.resolve(workflowPathValue);
    const workflowSource = requiredString(params.workflowSource, "workflowSource");
    const requestedCwd = path.resolve(requiredString(params.cwd, "cwd"));
    const inputs = params.inputs ?? {};
    const maxConcurrency =
      params.maxConcurrency === undefined
        ? 4
        : positiveInteger(params.maxConcurrency, "maxConcurrency");
    const requestedHarnessConfigPath = optionalString(
      params.harnessConfigPath,
      "harnessConfigPath",
    );
    const submissionHash = hashSubmission(jsonValue({
      version: pinnedWorkflowPath ? 2 : 1,
      workflowPath: requestedWorkflowPath,
      workflowHash: createHash("sha256").update(workflowSource).digest("hex"),
      ...(pinnedWorkflowPath ? { workflowPathPinned: true } : {}),
      cwd: requestedCwd,
      inputs,
      maxConcurrency,
      harnessConfigPath: requestedHarnessConfigPath
        ? path.resolve(requestedHarnessConfigPath)
        : null,
      backend: this.backendKind,
    }));
    return {
      stateDir,
      submissionId,
      submissionHash,
      requestedWorkflowPath,
      workflowSource,
      requestedCwd,
      inputs,
      maxConcurrency,
      ...(pinnedWorkflowPath ? { pinnedWorkflowPath: true } : {}),
      ...(requestedHarnessConfigPath
        ? { requestedHarnessConfigPath: path.resolve(requestedHarnessConfigPath) }
        : {}),
    };
  }

  private async submitIntent(intent: SubmissionIntent): Promise<JsonValue> {
    const existing = await readSubmissionClaim(intent.stateDir, intent.submissionId);
    if (existing) {
      if (
        existing.submissionHash !== intent.submissionHash ||
        existing.backend !== this.backendKind
      ) {
        throw new BackendRpcError(
          "idempotency_conflict",
          `Submission id ${intent.submissionId} was already used for a different run request`,
        );
      }
      await reconcileClaimedRun(intent.stateDir, existing);
      return await this.ensureClaimedRunLaunched(intent.stateDir, existing.runId);
    }
    return await this.submitOnce(await this.normalizeSubmission(intent));
  }

  private async normalizeSubmission(intent: SubmissionIntent): Promise<NormalizedSubmission> {
    const workflowPath = intent.pinnedWorkflowPath
      ? intent.requestedWorkflowPath
      : await realpath(intent.requestedWorkflowPath);
    const cwd = await realpath(intent.requestedCwd);
    const harnessDefinitions = intent.pinnedHarnessDefinitions
      ? [...intent.pinnedHarnessDefinitions]
      : (await pinHarnessDefinitions(
          await loadHarnessDefinitions(
            intent.requestedHarnessConfigPath ?? this.harnessConfigPath,
          ),
          this.env,
        ))
          .slice()
          .sort((left, right) => left.name.localeCompare(right.name));
    return {
      ...intent,
      workflowPath,
      cwd,
      harnessDefinitions,
      workspace: intent.pinnedWorkspace ?? (await describeLocalWorkspace(cwd)),
    };
  }

  private async submitOnce(request: NormalizedSubmission): Promise<JsonValue> {
    const existing = await readSubmissionClaim(request.stateDir, request.submissionId);
    if (existing) {
      if (
        existing.submissionHash !== request.submissionHash ||
        existing.backend !== this.backendKind
      ) {
        throw new BackendRpcError(
          "idempotency_conflict",
          `Submission id ${request.submissionId} was already used for a different run request`,
        );
      }
      await reconcileClaimedRun(request.stateDir, existing);
      return await this.ensureClaimedRunLaunched(request.stateDir, existing.runId);
    }

    const candidate = await prepareWorkflowRun({
      workflowPath: request.workflowPath,
      workflowSource: request.workflowSource,
      ...(request.pinnedWorkflowPath ? { workflowPathPinned: true } : {}),
      cwd: request.cwd,
      inputs: request.inputs,
      ...(request.trigger ? { trigger: request.trigger } : {}),
      stateDir: request.stateDir,
      maxConcurrency: request.maxConcurrency,
      harnessDefinitions: request.harnessDefinitions,
      backend: this.backendKind,
      submissionId: request.submissionId,
      submissionHash: request.submissionHash,
      workspace: request.workspace,
      stageOnly: true,
    });
    if (!candidate.staged) throw new Error("Jaeger submission candidate was not staged");
    let claimed: { readonly claim: SubmissionClaim; readonly created: boolean };
    try {
      claimed = await claimSubmission(
        request.stateDir,
        submissionClaimFor(
          candidate.staged,
          request.submissionId,
          request.submissionHash,
          this.backendKind,
        ),
      );
    } catch (error) {
      let visible: SubmissionClaim | undefined;
      try {
        visible = await readSubmissionClaim(request.stateDir, request.submissionId);
      } catch {
        // Publication may have linked the canonical claim before reporting an
        // I/O failure. Preserve the only matching stage while authority is
        // ambiguous so a later recovery can reconcile it.
        throw error;
      }
      if (
        !visible ||
        visible.submissionHash !== request.submissionHash ||
        visible.backend !== this.backendKind
      ) {
        await discardPreparedWorkflowRun(candidate).catch(() => undefined);
        throw error;
      }
      if (visible.runId === candidate.runId) {
        if (visible.runRecordHash !== candidate.staged.recordHash) throw error;
        claimed = { claim: visible, created: true };
      } else {
        claimed = { claim: visible, created: false };
      }
    }
    if (!claimed.created) {
      await discardPreparedWorkflowRun(candidate);
      await reconcileClaimedRun(request.stateDir, claimed.claim);
      return await this.ensureClaimedRunLaunched(request.stateDir, claimed.claim.runId);
    }
    let published: PreparedWorkflowRun;
    try {
      published = await publishPreparedWorkflowRun(candidate);
    } catch {
      await reconcileClaimedRun(request.stateDir, claimed.claim);
      published = await openPreparedRunForResume({
        stateDir: request.stateDir,
        runId: claimed.claim.runId,
        expectedBackend: this.backendKind,
      });
    }
    return await this.ensureLaunched(published, request.stateDir);
  }

  private async lookupSubmission(params: Record<string, JsonValue>): Promise<JsonValue> {
    const stateDir = this.requestStateDir(params);
    const submissionId = requiredString(params.submissionId, "submissionId");
    const claim = await readSubmissionClaim(stateDir, submissionId);
    if (!claim) {
      throw new BackendRpcError("not_found", `Unknown Jaeger submission ${submissionId}`);
    }
    await reconcileClaimedRun(stateDir, claim);
    return this.publicSummary(await inspectRun(stateDir, claim.runId), stateDir);
  }

  private async ensureLaunched(
    prepared: PreparedWorkflowRun,
    stateDir: string,
    allowStopped = false,
  ): Promise<JsonValue> {
    const current = await inspectRun(stateDir, prepared.runId);
    if (
      current.status === "pending" ||
      current.status === "interrupted" ||
      (allowStopped && current.status === "stopped")
    ) {
      try {
        const launched = await launchDetachedRun(prepared, {
          entrypoint: this.entrypoint,
          env: this.env,
        });
        return this.publicSummary(launched, stateDir);
      } catch (error) {
        let observed = await inspectRun(stateDir, prepared.runId);
        const deadline = Date.now() + 1_000;
        while (observed.status === "pending" && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          observed = await inspectRun(stateDir, prepared.runId);
        }
        if (observed.status === "running" || observed.status === "completed") {
          return this.publicSummary(observed, stateDir);
        }
        const summary = this.publicSummary(observed, stateDir);
        throw new Error(
          `${errorMessage(error)}\njaeger run summary: ${JSON.stringify(summary)}`,
        );
      }
    }
    return this.publicSummary(current, stateDir);
  }

  private async ensureClaimedRunLaunched(stateDir: string, runId: string): Promise<JsonValue> {
    const current = await inspectRun(stateDir, runId);
    if (current.status !== "pending" && current.status !== "interrupted") {
      return this.publicSummary(current, stateDir);
    }
    let prepared: PreparedWorkflowRun;
    try {
      prepared = await openPreparedRunForResume({
        stateDir,
        runId,
        expectedBackend: this.backendKind,
      });
    } catch (error) {
      // Another authority may have launched the claimed run after our first
      // inspection. Readback of accepted work must not depend on a workspace
      // that is no longer needed for execution.
      const observed = await inspectRun(stateDir, runId);
      if (observed.status !== "pending" && observed.status !== "interrupted") {
        return this.publicSummary(observed, stateDir);
      }
      throw error;
    }
    return await this.ensureLaunched(prepared, stateDir);
  }

  private async inspect(params: Record<string, JsonValue>): Promise<JsonValue> {
    const stateDir = this.requestStateDir(params);
    return this.publicSummary(
      await inspectRun(stateDir, requiredRunId(params.runId)),
      stateDir,
    );
  }

  private async wait(params: Record<string, JsonValue>, signal?: AbortSignal): Promise<JsonValue> {
    const stateDir = this.requestStateDir(params);
    return this.publicSummary(
      await waitForRun(stateDir, requiredRunId(params.runId), signal),
      stateDir,
    );
  }

  private async stop(params: Record<string, JsonValue>): Promise<JsonValue> {
    const stateDir = this.requestStateDir(params);
    return this.publicSummary(
      await stopRun(stateDir, requiredRunId(params.runId)),
      stateDir,
    );
  }

  private async resume(params: Record<string, JsonValue>): Promise<JsonValue> {
    const stateDir = this.requestStateDir(params);
    const runId = requiredRunId(params.runId);
    const current = await inspectRun(stateDir, runId);
    if (current.status === "running" || current.status === "stopping" || current.status === "completed") {
      return this.publicSummary(current, stateDir);
    }
    const prepared = await openPreparedRunForResume({
      stateDir,
      runId,
      expectedBackend: this.backendKind,
    });
    return await this.ensureLaunched({ ...prepared, isResume: true }, stateDir, true);
  }

  private async list(params: Record<string, JsonValue>): Promise<JsonValue> {
    const stateDir = this.requestStateDir(params);
    const limit = params.limit === undefined ? 50 : positiveInteger(params.limit, "limit");
    if (limit > 500) throw new BackendRpcError("invalid_request", "limit cannot exceed 500");
    const summaries: WorkflowRunSummary[] = [];
    for (const runId of await this.runIds(stateDir)) {
      summaries.push(await inspectRun(stateDir, runId));
    }
    summaries.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return summaries.slice(0, limit).map((summary) => this.publicSummary(summary, stateDir));
  }

  private async details(params: Record<string, JsonValue>): Promise<JsonValue> {
    const stateDir = this.requestStateDir(params);
    const runId = requiredRunId(params.runId);
    const journal = await RunJournal.open(stateDir, runId);
    const read = await journal.readEvents();
    const stepId = optionalString(params.stepId, "stepId");
    const includeEvents = params.events === true || stepId !== undefined;
    const events = stepId
      ? read.events.filter((event) => event.stepId === stepId)
      : read.events;
    const scratchDir = stepId ? stepScratchDirectory(journal.runDir, stepId) : undefined;
    let transcript: { path: string; name: string; contents: string } | undefined;
    const transcriptName = optionalString(params.transcript, "transcript");
    if (transcriptName) {
      if (transcriptName !== "stdout" && transcriptName !== "stderr") {
        throw new BackendRpcError("invalid_request", "transcript must be stdout or stderr");
      }
      if (!stepId) {
        throw new BackendRpcError("invalid_request", "transcript requires stepId");
      }
      const transcriptPath = path.join(
        stepScratchDirectory(journal.runDir, stepId),
        `${transcriptName}.log`,
      );
      transcript = {
        path: transcriptPath,
        name: `${transcriptName}.log`,
        contents: await readFile(transcriptPath, "utf8"),
      };
    }
    return jsonValue({
      summary: this.publicSummary(await inspectRun(stateDir, runId), stateDir),
      ...(includeEvents ? { events } : {}),
      ...(scratchDir ? { scratchDir } : {}),
      ...(read.truncatedTail ? { truncatedTail: true } : {}),
      ...(transcript ? { transcript } : {}),
    });
  }

  private async scheduleApply(params: Record<string, JsonValue>): Promise<JsonValue> {
    this.assertSchedulesSupported();
    const application = parseScheduleApplication(params.application);
    const manifestPath = application.sourcePathsPinned
      ? application.manifestPath
      : await realpath(application.manifestPath);
    const workflowPath = application.sourcePathsPinned
      ? application.workflowPath
      : await realpath(application.workflowPath);
    const cwd = await realpath(application.cwd);
    compileWorkflowSource(application.workflowSource, workflowPath);
    const harnesses = (await pinHarnessDefinitions(
      await loadHarnessDefinitions(this.harnessConfigPath),
      this.env,
    ))
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name));
    return await this.schedules.apply(
      { ...application, manifestPath, workflowPath, cwd },
      harnesses,
      await describeLocalWorkspace(cwd),
      params.activate === true,
    );
  }

  private async scheduleList(): Promise<JsonValue> {
    this.assertSchedulesSupported();
    return await this.schedules.list();
  }

  private async scheduleInspect(params: Record<string, JsonValue>): Promise<JsonValue> {
    this.assertSchedulesSupported();
    return await this.schedules.inspect(requiredString(params.name, "name"));
  }

  private async scheduleEnable(params: Record<string, JsonValue>): Promise<JsonValue> {
    this.assertSchedulesSupported();
    return await this.schedules.enable(requiredString(params.name, "name"));
  }

  private async scheduleDisable(params: Record<string, JsonValue>): Promise<JsonValue> {
    this.assertSchedulesSupported();
    return await this.schedules.disable(requiredString(params.name, "name"));
  }

  private async scheduleRemove(params: Record<string, JsonValue>): Promise<JsonValue> {
    this.assertSchedulesSupported();
    return await this.schedules.remove(requiredString(params.name, "name"));
  }

  private async scheduleHistory(params: Record<string, JsonValue>): Promise<JsonValue> {
    this.assertSchedulesSupported();
    const limit = params.limit === undefined ? 50 : positiveInteger(params.limit, "limit");
    if (limit > 500) throw new BackendRpcError("invalid_request", "limit cannot exceed 500");
    return await this.schedules.history(requiredString(params.name, "name"), limit);
  }

  private async scheduleTrigger(params: Record<string, JsonValue>): Promise<JsonValue> {
    this.assertSchedulesSupported();
    return await this.schedules.trigger(
      requiredString(params.name, "name"),
      requiredString(params.requestId, "requestId"),
    );
  }

  private assertSchedulesSupported(): void {
    if (this.backendKind !== "local-service") {
      throw new BackendRpcError(
        "unsupported_capability",
        "Jaeger schedules require the persistent local backend; embedded mode cannot own future time",
      );
    }
  }

  private async submitScheduled(request: ScheduleLaunchRequest): Promise<JsonValue> {
    const submissionHash = hashSubmission(jsonValue({
      version: 1,
      workflowPath: request.workflowPath,
      workflowHash: createHash("sha256").update(request.workflowSource).digest("hex"),
      cwd: request.cwd,
      inputs: request.inputs,
      maxConcurrency: request.maxConcurrency,
      harnesses: request.harnessDefinitions,
      workspace: request.workspace,
      trigger: request.trigger,
      backend: this.backendKind,
    }));
    const intent: SubmissionIntent = {
      stateDir: this.stateDir,
      submissionId: request.submissionId,
      submissionHash,
      requestedWorkflowPath: request.workflowPath,
      requestedCwd: request.cwd,
      workflowSource: request.workflowSource,
      inputs: request.inputs,
      maxConcurrency: request.maxConcurrency,
      trigger: request.trigger,
      pinnedHarnessDefinitions: request.harnessDefinitions,
      pinnedWorkspace: request.workspace,
      pinnedWorkflowPath: true,
    };
    const key = `${intent.stateDir}\0${intent.submissionId}`;
    const existing = this.submissions.get(key);
    if (existing) {
      if (existing.hash !== intent.submissionHash) {
        throw new BackendRpcError(
          "idempotency_conflict",
          `Submission id ${intent.submissionId} was already used for a different run request`,
        );
      }
      return await existing.promise;
    }
    const operation = this.submitIntent(intent).finally(() => {
      this.submissions.delete(key);
    });
    this.submissions.set(key, { hash: intent.submissionHash, promise: operation });
    return await operation;
  }

  private async sessionList(params: Record<string, JsonValue>): Promise<JsonValue> {
    const stateDir = this.requestStateDir(params);
    const journal = await RunJournal.open(stateDir, requiredRunId(params.runId));
    return (await listWorkflowSessions(journal.runDir, stateDir)).map((session) =>
      this.publicSession(session, stateDir),
    );
  }

  private async sessionInspect(params: Record<string, JsonValue>): Promise<JsonValue> {
    const value = await this.sessionList(params);
    if (!Array.isArray(value)) throw new Error("Session list response is invalid");
    const sessions = value;
    const selector = requiredString(params.selector, "selector");
    const matching = sessions.filter((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      return value.id === selector || value.stepId === selector || value.nativeSessionId === selector;
    });
    if (matching.length !== 1) {
      throw new BackendRpcError(
        matching.length === 0 ? "not_found" : "ambiguous_selector",
        matching.length === 0
          ? `Unknown Jaeger session ${selector}`
          : `Session selector ${selector} is ambiguous`,
      );
    }
    return matching[0] as JsonValue;
  }

  private async sessionResume(
    params: Record<string, JsonValue>,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const stateDir = this.requestStateDir(params);
    const runId = requiredRunId(params.runId);
    const selector = requiredString(params.selector, "selector");
    const message = requiredString(params.message, "message");
    const timeoutMs =
      params.timeoutMs === undefined
        ? undefined
        : positiveInteger(params.timeoutMs, "timeoutMs");
    if (this.backendKind === "local-service") {
      const turnId = requiredString(params.turnId, "turnId");
      const submitted = await submitSessionTurn({
        stateDir,
        entrypoint: this.entrypoint,
        env: this.env,
        backend: "local-service",
        runId,
        selector,
        message,
        turnId,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
      if (params.detach === true) return jsonValue(submitted);
      return jsonValue(
        await waitForSessionTurn(
          { stateDir, runId, turnId, backend: "local-service" },
          signal,
        ),
      );
    }
    const result = await resumeSession({
      stateDir,
      runId,
      selector,
      message,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      expectedBackend: "embedded",
      ...(signal ? { signal } : {}),
    });
    return jsonValue(result);
  }

  private async sessionQuerySubmit(
    params: Record<string, JsonValue>,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    if (this.backendKind !== "local-service") {
      throw new BackendRpcError(
        "unsupported_capability",
        "Detached forked session queries require the persistent local backend",
      );
    }
    const runId = requiredRunId(params.runId);
    const queryId = requiredString(params.queryId, "queryId");
    const submitted = await submitSessionQuery({
      stateDir: this.requestStateDir(params),
      entrypoint: this.entrypoint,
      env: this.env,
      backend: "local-service",
      runId,
      selector: requiredString(params.selector, "selector"),
      message: requiredString(params.message, "message"),
      queryId,
      ...(params.model !== undefined
        ? { model: requiredString(params.model, "model") }
        : {}),
      ...(params.timeoutMs !== undefined
        ? { timeoutMs: positiveInteger(params.timeoutMs, "timeoutMs") }
        : {}),
    });
    if (params.detach === true) return jsonValue(submitted);
    return jsonValue(
      await waitForSessionQuery(
        {
          stateDir: this.requestStateDir(params),
          runId,
          queryId,
          backend: "local-service",
        },
        signal,
      ),
    );
  }

  private async sessionQueryInspect(
    params: Record<string, JsonValue>,
  ): Promise<JsonValue> {
    return jsonValue(
      await inspectSessionQuery({
        stateDir: this.requestStateDir(params),
        runId: requiredRunId(params.runId),
        queryId: requiredString(params.queryId, "queryId"),
        backend: this.backendKind,
      }),
    );
  }

  private async sessionQueryWait(
    params: Record<string, JsonValue>,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    return jsonValue(
      await waitForSessionQuery(
        {
          stateDir: this.requestStateDir(params),
          runId: requiredRunId(params.runId),
          queryId: requiredString(params.queryId, "queryId"),
          backend: this.backendKind,
        },
        signal,
      ),
    );
  }

  private async sessionTurnInspect(params: Record<string, JsonValue>): Promise<JsonValue> {
    const stateDir = this.requestStateDir(params);
    return jsonValue(
      await inspectSessionTurn({
        stateDir,
        runId: requiredRunId(params.runId),
        turnId: requiredString(params.turnId, "turnId"),
        backend: this.backendKind,
      }),
    );
  }

  private async sessionTurnWait(
    params: Record<string, JsonValue>,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const stateDir = this.requestStateDir(params);
    return jsonValue(
      await waitForSessionTurn(
        {
          stateDir,
          runId: requiredRunId(params.runId),
          turnId: requiredString(params.turnId, "turnId"),
          backend: this.backendKind,
        },
        signal,
      ),
    );
  }

  private async sessionControl(params: Record<string, JsonValue>): Promise<JsonValue> {
    const stateDir = this.requestStateDir(params);
    const runId = requiredRunId(params.runId);
    const selector = requiredString(params.selector, "selector");
    const kind = requiredString(params.kind, "kind");
    if (kind !== "steer" && kind !== "interrupt") {
      throw new BackendRpcError("invalid_request", "session control kind is invalid");
    }
    const journal = await RunJournal.open(stateDir, runId);
    assertRunExecutionAdmission(journal.record, this.backendKind);
    const result = await requestSessionControl(
      journal.runDir,
      selector,
      kind,
      kind === "steer" ? requiredString(params.message, "message") : undefined,
    );
    return jsonValue({ sessionId: selector, action: kind, acknowledged: true, ...result });
  }

  private publicSummary(summary: WorkflowRunSummary, stateDir: string): JsonValue {
    const command = this.backendKind === "embedded" ? "jaeger --runtime embedded" : "jaeger";
    const stateArgument =
      this.backendKind === "embedded"
        ? ` --state-dir ${shellQuote(path.resolve(stateDir))}`
        : "";
    const runId = shellQuote(summary.runId);
    return jsonValue({
      schemaVersion: 1,
      backend: { name: "local", kind: this.backendKind },
      ...summary,
      inspect: `${command} inspect ${runId}${stateArgument} --summary --json`,
      ...(summary.wait ? { wait: `${command} wait ${runId}${stateArgument}` } : {}),
      ...(summary.stop ? { stop: `${command} stop ${runId}${stateArgument}` } : {}),
      ...(summary.resume ? { resume: `${command} resume ${runId}${stateArgument}` } : {}),
    });
  }

  private publicSession(session: WorkflowSessionSummary, stateDir: string): JsonValue {
    const command = this.backendKind === "embedded" ? "jaeger --runtime embedded" : "jaeger";
    const stateArgument =
      this.backendKind === "embedded"
        ? ` --state-dir ${shellQuote(path.resolve(stateDir))}`
        : "";
    const target = `${shellQuote(session.runId)} ${shellQuote(session.id)}${stateArgument}`;
    return jsonValue({
      ...session,
      inspect: `${command} session inspect ${target}`,
      ...(session.status === "running"
        ? {
            steer: `${command} session steer ${target} --message -`,
            interrupt: `${command} session interrupt ${target}`,
          }
        : session.nativeSessionId && session.status === "idle"
          ? { resume: `${command} session resume ${target} --message -` }
          : {}),
    });
  }

  private requestStateDir(params: Record<string, JsonValue>): string {
    const value = optionalString(params.stateDir, "stateDir");
    const resolved = path.resolve(value ?? this.stateDir);
    if (this.backendKind === "local-service" && resolved !== this.stateDir) {
      throw new BackendRpcError(
        "invalid_request",
        `The persistent backend owns ${this.stateDir}; per-command --state-dir is available only with --runtime embedded`,
      );
    }
    return resolved;
  }

  private async runIds(stateDir: string): Promise<string[]> {
    try {
      return (await readdir(stateDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && RUN_ID_PATTERN.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (hasCode(error, "ENOENT")) return [];
      throw error;
    }
  }
}

function recordParams(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BackendRpcError("invalid_request", "Backend params must be an object");
  }
  return value;
}

function requiredRunId(value: JsonValue | undefined): string {
  const runId = requiredString(value, "runId");
  if (!RUN_ID_PATTERN.test(runId)) throw new BackendRpcError("invalid_request", "Invalid Jaeger run id");
  return runId;
}

function requiredString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new BackendRpcError("invalid_request", `${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: JsonValue | undefined, label: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, label);
}

function positiveInteger(value: JsonValue, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new BackendRpcError("invalid_request", `${label} must be a positive integer`);
  }
  return value;
}

function parseScheduleApplication(value: JsonValue | undefined): ScheduleApplication {
  const application = recordParams(value ?? null);
  if (application.version !== 1) {
    throw new BackendRpcError("invalid_request", "Schedule application version must be 1");
  }
  const name = requiredString(application.name, "application.name");
  if (
    application.sourcePathsPinned !== undefined &&
    typeof application.sourcePathsPinned !== "boolean"
  ) {
    throw new BackendRpcError(
      "invalid_request",
      "application.sourcePathsPinned must be a boolean",
    );
  }
  const sourcePathsPinned = application.sourcePathsPinned === true;
  const manifestPath = sourcePathsPinned
    ? requiredString(application.manifestPath, "application.manifestPath")
    : requiredAbsolutePath(
        application.manifestPath,
        "application.manifestPath",
      );
  const workflowPath = sourcePathsPinned
    ? requiredString(application.workflowPath, "application.workflowPath")
    : requiredAbsolutePath(
        application.workflowPath,
        "application.workflowPath",
      );
  const workflowSource = requiredString(
    application.workflowSource,
    "application.workflowSource",
  );
  const cwd = requiredAbsolutePath(application.cwd, "application.cwd");
  const maxConcurrency = positiveInteger(
    application.maxConcurrency ?? 4,
    "application.maxConcurrency",
  );
  if (maxConcurrency > 64) {
    throw new BackendRpcError(
      "invalid_request",
      "Schedule application maxConcurrency cannot exceed 64",
    );
  }
  const triggerValue = recordParams(application.trigger ?? null);
  if (triggerValue.type !== "cron") {
    throw new BackendRpcError("invalid_request", "Schedule trigger type must be cron");
  }
  const trigger: CronTrigger = {
    type: "cron",
    expression: requiredString(triggerValue.expression, "trigger.expression"),
    timezone: requiredString(triggerValue.timezone, "trigger.timezone"),
  };
  validateCronExpression(trigger.expression);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trigger.timezone }).format(new Date(0));
  } catch (error) {
    throw new BackendRpcError(
      "invalid_request",
      `Invalid IANA timezone: ${trigger.timezone}`,
    );
  }
  const policyValue = recordParams(application.policy ?? null);
  if (policyValue.overlap !== "forbid") {
    throw new BackendRpcError("invalid_request", "Schedule overlap policy must be forbid");
  }
  if (
    policyValue.misfire !== "skip" &&
    policyValue.misfire !== "latest" &&
    policyValue.misfire !== "catch-up"
  ) {
    throw new BackendRpcError(
      "invalid_request",
      "Schedule misfire policy must be skip, latest, or catch-up",
    );
  }
  if (typeof policyValue.pauseOnUncertain !== "boolean") {
    throw new BackendRpcError(
      "invalid_request",
      "Schedule pauseOnUncertain must be a boolean",
    );
  }
  if (policyValue.pauseOnUncertain !== true) {
    throw new BackendRpcError(
      "invalid_request",
      "Schedule pauseOnUncertain must be true; uncertainty is fail-closed",
    );
  }
  const maxCatchUp = positiveInteger(policyValue.maxCatchUp ?? 1, "policy.maxCatchUp");
  if (maxCatchUp > 24) {
    throw new BackendRpcError("invalid_request", "Schedule maxCatchUp cannot exceed 24");
  }
  const policy: SchedulePolicy = {
    overlap: "forbid",
    misfire: policyValue.misfire,
    maxCatchUp,
    pauseOnUncertain: policyValue.pauseOnUncertain,
    pauseAfterFailures: positiveInteger(
      policyValue.pauseAfterFailures ?? 3,
      "policy.pauseAfterFailures",
    ),
  };
  return {
    version: 1,
    name,
    manifestPath,
    workflowPath,
    workflowSource,
    cwd,
    inputs: application.inputs ?? {},
    maxConcurrency,
    trigger,
    policy,
    ...(sourcePathsPinned ? { sourcePathsPinned: true } : {}),
  };
}

function requiredAbsolutePath(value: JsonValue | undefined, label: string): string {
  const target = requiredString(value, label);
  if (!path.isAbsolute(target)) {
    throw new BackendRpcError("invalid_request", `${label} must be absolute`);
  }
  return target;
}

function jsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Backend result is not JSON-serializable");
  return JSON.parse(serialized) as JsonValue;
}

function hashSubmission(value: JsonValue): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key] as JsonValue)}`)
    .join(",")}}`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
