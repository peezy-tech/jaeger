import type { ChildProcess } from "node:child_process";
import { open } from "node:fs/promises";
import path from "node:path";
import { hostRuntimeBoundary } from "./boundary.js";
import { RunOwnedError, RunTerminalError, WorkflowChangedError } from "./errors.js";
import {
  clearActiveHarnessProcess,
  discoverRunHarnessProcesses,
  harnessContainmentState,
  runOwnerContainment,
  signalActiveHarnessProcess,
  type ActiveHarnessProcess,
  type HarnessContainmentState,
} from "./harnesses/active-process.js";
import { RunJournal } from "./journal.js";
import {
  isRunLeaseHeld,
  ownerProcessIdentityMatches,
  readRunOwner,
  type RunOwnerRecord,
  type RunOwnerState,
} from "./lease.js";
import { inspectRun } from "./run-state.js";
import type { PreparedWorkflowRun } from "./runtime.js";
import type { WorkflowRunSummary } from "./types.js";

const OWNER_START_TIMEOUT_MS = 5_000;
const STOP_GRACE_MS = 3_000;
const INACTIVE_CONTAINMENT_SETTLE_MS = 250;

export interface DetachedLaunchOptions {
  readonly entrypoint: string;
  readonly env?: NodeJS.ProcessEnv;
}

export async function launchDetachedRun(
  prepared: PreparedWorkflowRun,
  options: DetachedLaunchOptions,
): Promise<WorkflowRunSummary> {
  const current = await inspectRun(prepared.stateDir, prepared.runId);
  if (current.status === "completed") return current;
  if (current.status === "running" || current.status === "stopping") {
    throw new RunOwnedError(`Jaeger run ${prepared.runId} already has an active owner`);
  }
  if (current.status === "uncertain" || current.status === "failed") {
    throw new RunTerminalError(
      `Jaeger run ${prepared.runId} is ${current.status} and cannot be launched again`,
    );
  }

  const boundary = hostRuntimeBoundary;
  if (
    boundary.descriptor.kind !== current.boundary.kind ||
    boundary.descriptor.isolated !== current.boundary.isolated ||
    boundary.descriptor.description !== current.boundary.description
  ) {
    throw new WorkflowChangedError(
      `Run ${prepared.runId} is pinned to runtime boundary ${current.boundary.kind}, not ${boundary.descriptor.kind}`,
    );
  }
  const stdout = await open(path.join(prepared.runDir, "runtime.stdout.log"), "a", 0o600);
  const stderr = await open(path.join(prepared.runDir, "runtime.stderr.log"), "a", 0o600);
  let child: ChildProcess;
  let spawnError: unknown;
  try {
    child = boundary.launchDetached({
      entrypoint: options.entrypoint,
      runId: prepared.runId,
      args: [
        "__worker",
        "--state-dir",
        prepared.stateDir,
        "--run-id",
        prepared.runId,
        "--backend",
        prepared.backend,
        ...(prepared.isResume ? ["--resume"] : []),
      ],
      cwd: prepared.runDir,
      env: { ...process.env, ...options.env },
      stdoutFd: stdout.fd,
      stderrFd: stderr.fd,
    });
    // Node may emit ENOENT on the next turn. Attach synchronously before the
    // first await so a missing launcher can never become an unhandled event.
    child.once("error", (error) => {
      spawnError = error;
    });
  } finally {
    await Promise.all([stdout.close(), stderr.close()]);
  }

  const deadline = Date.now() + OWNER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    const owner = await readRunOwner(prepared.runDir, prepared.runId);
    if (owner.active && owner.owner) {
      child.unref();
      return await inspectRun(prepared.stateDir, prepared.runId);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      const summary = await inspectRun(prepared.stateDir, prepared.runId);
      if (summary.status === "completed") return summary;
      throw new Error(
        `Detached Jaeger worker exited before acquiring run ${prepared.runId}; inspect ${prepared.runDir}/runtime.stderr.log`,
      );
    }
    await delay(25);
  }

  terminateChild(child);
  throw new Error(
    `Detached Jaeger worker did not acquire run ${prepared.runId} within ${OWNER_START_TIMEOUT_MS}ms`,
  );
}

export async function waitForRun(
  stateDir: string,
  runId: string,
  signal?: AbortSignal,
): Promise<WorkflowRunSummary> {
  let terminalFingerprint: string | undefined;
  while (true) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("Waiting for Jaeger run aborted");
    }
    const summary = await inspectRun(stateDir, runId);
    if (summary.status === "completed" && !summary.stop) return summary;
    if (summary.stop && summary.status !== "running" && summary.status !== "stopping") {
      terminalFingerprint = undefined;
      await delay(100, signal);
      continue;
    }
    if (summary.status !== "running" && summary.status !== "stopping") {
      const fingerprint = JSON.stringify({
        status: summary.status,
        finishedAt: summary.finishedAt ?? null,
        agents: summary.agents,
        uncertainty: summary.uncertainty ?? null,
      });
      if (fingerprint === terminalFingerprint) return summary;
      terminalFingerprint = fingerprint;
    } else {
      terminalFingerprint = undefined;
    }
    await delay(100, signal);
  }
}

export async function stopRun(stateDir: string, runId: string): Promise<WorkflowRunSummary> {
  const resolvedStateDir = path.resolve(stateDir);
  if (!/^\d{14}-[a-f0-9]{10}$/.test(runId)) throw new Error("Invalid Jaeger run id");
  const expectedRunDir = path.join(resolvedStateDir, runId);
  const preflightProviders = readProviderContainments(expectedRunDir, runId);
  const preflightOwnerScope = readOwnerScope(runId);
  let journal: RunJournal;
  try {
    journal = await RunJournal.open(resolvedStateDir, runId);
  } catch (error) {
    return await stopWithoutDurableState(
      resolvedStateDir,
      runId,
      expectedRunDir,
      preflightProviders,
      preflightOwnerScope,
      error,
    );
  }
  const initialOwnerRead = await readOwnerForControl(journal.runDir, runId);
  const ownerState = initialOwnerRead.state;
  const initialProviders = preflightProviders;
  const initialOwnerScope = preflightOwnerScope;
  let controlError =
    initialProviders.error ?? initialOwnerScope.error ?? initialOwnerRead.error;
  if (
    !ownerState.active &&
    initialOwnerScope.state === "inactive" &&
    initialProviders.records.length === 0 &&
    !initialProviders.error &&
    !initialOwnerScope.error &&
    !initialOwnerRead.error
  ) {
    return await inspectRun(resolvedStateDir, runId);
  }
  let initialOwner: RunOwnerRecord | undefined;
  try {
    initialOwner = await stableActiveOwner(journal.runDir, runId);
  } catch (error) {
    controlError ??= error;
  }
  if (initialOwner?.pid === process.pid) {
    throw new Error("Refusing to stop a Jaeger run from inside its owning process");
  }

  await journal.requestStop(
    process.pid,
    initialOwner?.pid ?? initialProviders.records[0]?.pid ?? 0,
    initialOwner?.token,
  );
  try {
    await signalProviderTrees(
      [
        ...initialProviders.records,
        ...(initialOwnerScope.state === "inactive" ? [] : [initialOwnerScope.record]),
      ],
      "SIGTERM",
    );
  } catch (error) {
    controlError ??= error;
  }
  const termSignaled = new Set<string>();
  try {
    const token = await signalCurrentOwner(journal.runDir, runId, "SIGTERM");
    if (token) termSignaled.add(token);
  } catch (error) {
    controlError ??= error;
  }

  const deadline = Date.now() + STOP_GRACE_MS;
  let inactiveSince: number | undefined;
  while (Date.now() < deadline) {
    const ownerRead = await readOwnerForControl(journal.runDir, runId);
    const currentOwner = ownerRead.state;
    const providers = readProviderContainments(journal.runDir, runId);
    const ownerScope = readOwnerScope(runId);
    controlError ??= providers.error ?? ownerScope.error ?? ownerRead.error;
    const providersInactive =
      !providers.error && providers.states.every((state) => state === "inactive");
    if (!currentOwner.active && ownerScope.state === "inactive" && providersInactive) {
      inactiveSince ??= Date.now();
      if (Date.now() - inactiveSince >= INACTIVE_CONTAINMENT_SETTLE_MS) {
        clearInactiveProviderIntents(providers.records, providers.states);
        if (controlError) throw controlError;
        return await inspectRun(resolvedStateDir, runId);
      }
    } else {
      inactiveSince = undefined;
    }
    if (providers.states.some((state) => state !== "inactive")) {
      try {
        await signalProviderTrees(providers.records, "SIGTERM");
      } catch (error) {
        controlError ??= error;
      }
    }
    if (ownerScope.state !== "inactive") {
      try {
        await signalProviderTrees([ownerScope.record], "SIGTERM");
      } catch (error) {
        controlError ??= error;
      }
    }
    if (currentOwner.active) {
      try {
        const stable = await stableActiveOwner(journal.runDir, runId);
        if (stable && !termSignaled.has(stable.token)) {
          signalOwner(stable, "SIGTERM");
          termSignaled.add(stable.token);
        }
      } catch (error) {
        controlError ??= error;
      }
    }
    await delay(50);
  }

  const beforeKill = readProviderContainments(journal.runDir, runId);
  const ownerScopeBeforeKill = readOwnerScope(runId);
  controlError ??= beforeKill.error ?? ownerScopeBeforeKill.error;
  try {
    await signalProviderTrees(
      [
        ...beforeKill.records,
        ...(ownerScopeBeforeKill.state === "inactive" ? [] : [ownerScopeBeforeKill.record]),
      ],
      "SIGKILL",
    );
  } catch (error) {
    controlError ??= error;
  }
  try {
    await signalCurrentOwner(journal.runDir, runId, "SIGKILL");
  } catch (error) {
    controlError ??= error;
  }
  inactiveSince = undefined;
  for (let attempt = 0; attempt < 40; attempt++) {
    const ownerRead = await readOwnerForControl(journal.runDir, runId);
    const currentOwner = ownerRead.state;
    const providers = readProviderContainments(journal.runDir, runId);
    const ownerScope = readOwnerScope(runId);
    controlError ??= providers.error ?? ownerScope.error ?? ownerRead.error;
    const providersInactive =
      !providers.error && providers.states.every((state) => state === "inactive");
    if (!currentOwner.active && ownerScope.state === "inactive" && providersInactive) {
      inactiveSince ??= Date.now();
      if (Date.now() - inactiveSince >= INACTIVE_CONTAINMENT_SETTLE_MS) {
        clearInactiveProviderIntents(providers.records, providers.states);
        if (controlError) throw controlError;
        return await inspectRun(resolvedStateDir, runId);
      }
    } else {
      inactiveSince = undefined;
    }
    if (providers.states.some((state) => state !== "inactive")) {
      try {
        await signalProviderTrees(providers.records, "SIGKILL");
      } catch (error) {
        controlError ??= error;
      }
    }
    if (ownerScope.state !== "inactive") {
      try {
        await signalProviderTrees([ownerScope.record], "SIGKILL");
      } catch (error) {
        controlError ??= error;
      }
    }
    if (currentOwner.active) {
      try {
        await signalCurrentOwner(journal.runDir, runId, "SIGKILL");
      } catch (error) {
        controlError ??= error;
      }
    }
    await delay(50);
  }
  const remainingProviders = readProviderContainments(journal.runDir, runId);
  const remainingOwnerScope = readOwnerScope(runId);
  if (remainingProviders.error) throw remainingProviders.error;
  if (remainingOwnerScope.error) throw remainingOwnerScope.error;
  const nonempty = remainingProviders.records.filter(
    (_record, index) => remainingProviders.states[index] !== "inactive",
  );
  if (nonempty.length > 0) {
    throw new Error(
      `Could not prove provider systemd scopes stopped for run ${runId}: ${nonempty
        .map((record) => record.unit)
        .join(", ")}`,
    );
  }
  if (remainingOwnerScope.state !== "inactive") {
    throw new Error(`Could not prove run owner scope stopped for run ${runId}`);
  }
  const remainingOwnerRead = await readOwnerForControl(journal.runDir, runId);
  controlError ??= remainingOwnerRead.error;
  const remainingOwner = remainingOwnerRead.state;
  if (remainingOwner.active) {
    throw new Error(`Could not prove the owner lease stopped for run ${runId}`);
  }
  clearInactiveProviderIntents(remainingProviders.records, remainingProviders.states);
  if (controlError) throw controlError;
  return await inspectRun(resolvedStateDir, runId);
}

function clearInactiveProviderIntents(
  records: readonly ActiveHarnessProcess[],
  states: readonly HarnessContainmentState[],
): void {
  for (let index = 0; index < records.length; index++) {
    if (states[index] !== "inactive") continue;
    clearActiveHarnessProcess(records[index] as ActiveHarnessProcess);
  }
}

async function readOwnerForControl(
  runDir: string,
  runId: string,
): Promise<{ readonly state: RunOwnerState; readonly error?: unknown }> {
  try {
    return { state: await readRunOwner(runDir, runId) };
  } catch (error) {
    try {
      return { state: { active: isRunLeaseHeld(runDir) }, error };
    } catch (leaseError) {
      return {
        state: { active: true },
        error: new AggregateError(
          [error, leaseError],
          `Could not inspect owner metadata or lease for Jaeger run ${runId}`,
        ),
      };
    }
  }
}

async function stopWithoutDurableState(
  _stateDir: string,
  runId: string,
  runDir: string,
  initialProviders: ReturnType<typeof readProviderContainments>,
  initialOwnerScope: ReturnType<typeof readOwnerScope>,
  stateError: unknown,
): Promise<never> {
  if (
    initialProviders.records.length === 0 &&
    initialOwnerScope.state === "inactive" &&
    !initialProviders.error &&
    !initialOwnerScope.error
  ) {
    throw stateError;
  }

  let controlError = initialProviders.error ?? initialOwnerScope.error;
  try {
    await signalProviderTrees(
      [
        ...initialProviders.records,
        ...(initialOwnerScope.state === "inactive" ? [] : [initialOwnerScope.record]),
      ],
      "SIGTERM",
    );
  } catch (error) {
    controlError ??= error;
  }

  const graceDeadline = Date.now() + STOP_GRACE_MS;
  let inactiveSince: number | undefined;
  while (Date.now() < graceDeadline) {
    const providers = readProviderContainments(runDir, runId);
    const ownerScope = readOwnerScope(runId);
    controlError ??= providers.error ?? ownerScope.error;
    const providersInactive =
      !providers.error && providers.states.every((state) => state === "inactive");
    if (providersInactive && ownerScope.state === "inactive") {
      inactiveSince ??= Date.now();
      if (Date.now() - inactiveSince >= INACTIVE_CONTAINMENT_SETTLE_MS) {
        if (controlError) throw controlError;
        throw stoppedWithoutStateError(runId, stateError);
      }
    } else {
      inactiveSince = undefined;
    }
    try {
      await signalProviderTrees(
        [
          ...providers.records.filter((_record, index) => providers.states[index] !== "inactive"),
          ...(ownerScope.state === "inactive" ? [] : [ownerScope.record]),
        ],
        "SIGTERM",
      );
    } catch (error) {
      controlError ??= error;
    }
    await delay(50);
  }

  inactiveSince = undefined;
  for (let attempt = 0; attempt < 40; attempt++) {
    const providers = readProviderContainments(runDir, runId);
    const ownerScope = readOwnerScope(runId);
    controlError ??= providers.error ?? ownerScope.error;
    try {
      await signalProviderTrees(
        [
          ...providers.records.filter((_record, index) => providers.states[index] !== "inactive"),
          ...(ownerScope.state === "inactive" ? [] : [ownerScope.record]),
        ],
        "SIGKILL",
      );
    } catch (error) {
      controlError ??= error;
    }
    const providersInactive =
      !providers.error && providers.states.every((state) => state === "inactive");
    if (providersInactive && ownerScope.state === "inactive") {
      inactiveSince ??= Date.now();
      if (Date.now() - inactiveSince >= INACTIVE_CONTAINMENT_SETTLE_MS) {
        if (controlError) throw controlError;
        throw stoppedWithoutStateError(runId, stateError);
      }
    } else {
      inactiveSince = undefined;
    }
    await delay(50);
  }
  if (controlError) throw controlError;
  throw new Error(`Could not prove run and provider scopes stopped for state-less run ${runId}`);
}

function stoppedWithoutStateError(runId: string, cause: unknown): Error {
  return new Error(
    `Stopped OS containment for Jaeger run ${runId}, but its durable run state is unavailable`,
    { cause },
  );
}

function readOwnerScope(runId: string): {
  readonly record: ActiveHarnessProcess;
  readonly state: HarnessContainmentState;
  readonly error?: unknown;
} {
  const record = runOwnerContainment(runId);
  try {
    return { record, state: harnessContainmentState(record) };
  } catch (error) {
    return { record, state: "unverifiable", error };
  }
}

function readProviderContainments(runDir: string, runId: string): {
  readonly records: readonly ActiveHarnessProcess[];
  readonly states: readonly HarnessContainmentState[];
  readonly error?: unknown;
} {
  let records: readonly ActiveHarnessProcess[];
  try {
    records = discoverRunHarnessProcesses(runDir, runId);
  } catch (error) {
    return { records: [], states: [], error };
  }
  const states: HarnessContainmentState[] = [];
  for (const record of records) {
    try {
      states.push(harnessContainmentState(record));
    } catch (error) {
      return {
        records,
        states: records.map((_item, index) => states[index] ?? "unverifiable"),
        error,
      };
    }
  }
  return { records, states };
}

async function signalProviderTrees(
  records: readonly ActiveHarnessProcess[],
  signal: "SIGTERM" | "SIGKILL",
): Promise<void> {
  await Promise.all(
    records.map(async (record) => await signalActiveHarnessProcess(record, signal)),
  );
}

async function stableActiveOwner(
  runDir: string,
  runId: string,
): Promise<RunOwnerRecord | undefined> {
  const first = await readRunOwner(runDir, runId);
  if (!first.active || !first.owner) return undefined;
  await delay(10);
  const second = await readRunOwner(runDir, runId);
  if (
    !second.active ||
    !second.owner ||
    second.owner.token !== first.owner.token ||
    second.owner.pid !== first.owner.pid ||
    !(await ownerProcessIdentityMatches(second.owner))
  ) {
    return undefined;
  }
  return second.owner;
}

async function signalCurrentOwner(
  runDir: string,
  runId: string,
  signal: NodeJS.Signals,
): Promise<string | undefined> {
  const owner = await stableActiveOwner(runDir, runId);
  if (!owner) return undefined;
  if (owner.pid === process.pid) {
    throw new Error("Refusing to stop a Jaeger run from inside its owning process");
  }
  signalOwner(owner, signal);
  return owner.token;
}

function signalOwner(owner: RunOwnerRecord, signal: NodeJS.Signals): void {
  try {
    process.kill(owner.pid, signal);
  } catch (error) {
    if (!hasCode(error, "ESRCH")) throw error;
  }
}

function terminateChild(child: ChildProcess): void {
  try {
    child.kill("SIGTERM");
  } catch {}
  const timeout = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {}
  }, 500);
  timeout.unref();
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
