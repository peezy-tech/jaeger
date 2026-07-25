import { readFileSync } from "node:fs";

export interface ProcessIdentity {
  readonly pid: number;
  readonly processStartId: string;
}

export function currentProcessIdentity(): ProcessIdentity {
  return { pid: process.pid, processStartId: processStartId(process.pid) };
}

export function isProcessIdentityActive(identity: ProcessIdentity): boolean {
  try {
    return processStartId(identity.pid) === identity.processStartId;
  } catch {
    return false;
  }
}

export function processStartId(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid process id ${pid}`);
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const close = stat.lastIndexOf(")");
  if (close < 0) throw new Error(`Could not parse process ${pid} identity`);
  const fields = stat.slice(close + 2).split(" ");
  const start = fields[19];
  if (!start) throw new Error(`Could not read process ${pid} identity`);
  return start;
}
