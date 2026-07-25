import { createHash } from "node:crypto";
import { stat, statSync } from "node:fs";
import { promisify } from "node:util";
import { hostRuntimeBoundaryDescriptor } from "./boundary.js";
import { WorkflowChangedError } from "./errors.js";
import type { WorkflowRunRecord } from "./types.js";
import { WORKFLOW_RUNTIME_ABI } from "./version.js";

const statAsync = promisify(stat);

export type RuntimeBackendKind = "embedded" | "local-service";

export interface LocalWorkspaceDescriptor {
  readonly kind: "local-path";
  readonly root: string;
  readonly device: string;
  readonly inode: string;
  readonly identity: string;
}

export async function describeLocalWorkspace(root: string): Promise<LocalWorkspaceDescriptor> {
  const stats = await statAsync(root, { bigint: true });
  if (!stats.isDirectory()) throw new Error(`Workflow workspace is not a directory: ${root}`);
  return workspaceDescriptor(root, stats.dev, stats.ino);
}

export function sameLocalWorkspace(
  left: LocalWorkspaceDescriptor,
  right: LocalWorkspaceDescriptor,
): boolean {
  return (
    left.kind === right.kind &&
    left.root === right.root &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.identity === right.identity
  );
}

export function assertRunExecutionAdmission(
  record: WorkflowRunRecord,
  expectedBackend: RuntimeBackendKind,
): void {
  if (
    record.boundary.kind !== hostRuntimeBoundaryDescriptor.kind ||
    record.boundary.isolated !== hostRuntimeBoundaryDescriptor.isolated ||
    record.boundary.description !== hostRuntimeBoundaryDescriptor.description
  ) {
    throw new WorkflowChangedError(
      `Run ${record.runId} claims an unverified runtime boundary; this Jaeger build only records the concrete host boundary`,
    );
  }
  if (record.version !== 4) {
    if (expectedBackend !== "embedded") {
      throw new WorkflowChangedError(
        `Run ${record.runId} predates backend ownership records and can only execute in embedded mode`,
      );
    }
    return;
  }
  if (record.runtime.abi !== WORKFLOW_RUNTIME_ABI) {
    throw new WorkflowChangedError(
      `Run ${record.runId} requires workflow runtime ABI ${record.runtime.abi}; this Jaeger supports ABI ${WORKFLOW_RUNTIME_ABI}`,
    );
  }
  if (record.runtime.backend !== expectedBackend) {
    throw new WorkflowChangedError(
      `Run ${record.runId} is owned by the ${record.runtime.backend} backend and cannot execute through ${expectedBackend}`,
    );
  }
  let stats;
  try {
    stats = statSync(record.cwd, { bigint: true });
  } catch (error) {
    throw new WorkflowChangedError(`Run ${record.runId} workspace is no longer available`, {
      cause: error,
    });
  }
  const current = workspaceDescriptor(record.cwd, stats.dev, stats.ino);
  if (!sameLocalWorkspace(record.workspace, current)) {
    throw new WorkflowChangedError(
      `Run ${record.runId} workspace identity changed at ${record.cwd}`,
    );
  }
}

function workspaceDescriptor(
  root: string,
  device: bigint,
  inode: bigint,
): LocalWorkspaceDescriptor {
  const deviceText = device.toString(10);
  const inodeText = inode.toString(10);
  return {
    kind: "local-path",
    root,
    device: deviceText,
    inode: inodeText,
    identity: createHash("sha256")
      .update(`local-path\0${root}\0${deviceText}\0${inodeText}`)
      .digest("hex"),
  };
}
