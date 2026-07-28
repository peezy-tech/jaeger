import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { providerContainmentDoctor } from "./harnesses/active-process.js";
import { assertSupportedPiVersion } from "./harnesses/pi-version.js";
import { builtinHarnessDefinitions } from "./harnesses/registry.js";
import type { HarnessDefinition } from "./types.js";

const execFileAsync = promisify(execFile);
export { assertSupportedPiVersion } from "./harnesses/pi-version.js";

export async function doctor(
  definitions: readonly HarnessDefinition[] = builtinHarnessDefinitions(),
): Promise<{
  readonly ready: boolean;
  readonly node: string;
  readonly containment: ReturnType<typeof providerContainmentDoctor>;
  readonly harnesses: ReadonlyArray<{
    readonly name: string;
    readonly transport: string;
    readonly available: boolean;
    readonly version?: string;
    readonly error?: string;
  }>;
}> {
  const harnesses = await inspectHarnesses(definitions);
  const containment = providerContainmentDoctor();
  return {
    ready: containment.available && harnesses.some((harness) => harness.available),
    node: process.version,
    containment,
    harnesses,
  };
}

export interface HarnessInspection {
  readonly name: string;
  readonly transport: string;
  readonly available: boolean;
  readonly version?: string;
  readonly error?: string;
}

export async function inspectHarnesses(
  definitions: readonly HarnessDefinition[] = builtinHarnessDefinitions(),
  timeoutMs = 10_000,
): Promise<readonly HarnessInspection[]> {
  return await Promise.all(
    definitions.map(
      async (definition) =>
        await inspectHarness(
          definition.name,
          definition.driver,
          definition.command,
          ["--version"],
          definition.driver === "codex-app-server"
            ? ["app-server", "--help"]
            : definition.driver === "pi-rpc"
              ? ["--help"]
              : ["--version"],
          timeoutMs,
        ),
    ),
  );
}

async function inspectHarness(
  name: string,
  transport: string,
  command: string,
  versionArgs: string[],
  probeArgs: string[],
  timeoutMs: number,
): Promise<HarnessInspection> {
  try {
    const { stdout, stderr } = await execFileAsync(command, versionArgs, {
      encoding: "utf8",
      timeout: timeoutMs,
    });
    await execFileAsync(command, probeArgs, {
      encoding: "utf8",
      timeout: timeoutMs,
    });
    const version = (stdout || stderr).trim();
    if (transport === "pi-rpc") assertSupportedPiVersion(version);
    return {
      name,
      transport,
      available: true,
      version,
    };
  } catch (error) {
    return {
      name,
      transport,
      available: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
