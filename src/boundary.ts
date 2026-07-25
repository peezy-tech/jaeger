import { spawn, type ChildProcess } from "node:child_process";
import { runOwnerSystemdScopeArgs } from "./harnesses/active-process.js";
import { systemdRunCommand } from "./launchers.js";
import type { RuntimeBoundaryDescriptor } from "./types.js";

export interface DetachedWorkerLaunch {
  readonly entrypoint: string;
  readonly runId: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdoutFd: number;
  readonly stderrFd: number;
}

/**
 * A runtime boundary owns the process that contains the coordinator and every
 * native harness it launches. It is intentionally not part of AgentOptions.
 */
export interface WorkflowRuntimeBoundary {
  readonly descriptor: RuntimeBoundaryDescriptor;
  launchDetached(input: DetachedWorkerLaunch): ChildProcess;
}

export const hostRuntimeBoundaryDescriptor: RuntimeBoundaryDescriptor = Object.freeze({
  kind: "host",
  isolated: false,
  description:
    "Runs with full authority on the current host; wrap the Jaeger process in a constrained workspace, sandbox, container, or VM when isolation is required.",
});

export class HostRuntimeBoundary implements WorkflowRuntimeBoundary {
  get descriptor(): RuntimeBoundaryDescriptor {
    return hostRuntimeBoundaryDescriptor;
  }

  launchDetached(input: DetachedWorkerLaunch): ChildProcess {
    return spawn(
      systemdRunCommand(input.env),
      [...runOwnerSystemdScopeArgs(input.runId, process.execPath, [input.entrypoint, ...input.args])],
      {
      cwd: input.cwd,
      env: input.env,
      detached: true,
      shell: false,
      stdio: ["ignore", input.stdoutFd, input.stderrFd],
      },
    );
  }
}

Object.freeze(HostRuntimeBoundary.prototype);
export const hostRuntimeBoundary = Object.freeze(new HostRuntimeBoundary());
