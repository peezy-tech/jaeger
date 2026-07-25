import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { trustedDirectory, trustedRegularFile } from "../path-trust.js";
import { ClaudeHarness } from "./claude.js";
import { CodexHarness } from "./codex.js";
import type {
  HarnessAdapter,
  HarnessDefinition,
  HarnessDriver,
  WorkflowRunRecord,
} from "../types.js";

const HARNESS_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const BUILTIN_DEFINITIONS: readonly HarnessDefinition[] = Object.freeze([
  Object.freeze({
    name: "codex",
    driver: "codex-app-server",
    command: "codex",
    description: "Native Codex app-server",
  }),
  Object.freeze({
    name: "claude",
    driver: "claude-agent-sdk",
    command: "claude",
    description: "Native Claude Code through the Claude Agent SDK",
  }),
]);
const BUILTIN_NAMES = new Set(BUILTIN_DEFINITIONS.map((definition) => definition.name));

export function builtinHarnessDefinitions(): readonly HarnessDefinition[] {
  return BUILTIN_DEFINITIONS;
}

export async function loadHarnessDefinitions(
  configPath?: string,
): Promise<readonly HarnessDefinition[]> {
  const explicit = configPath !== undefined;
  const resolvedPath = path.resolve(configPath ?? defaultHarnessConfigPath());
  let text: string;
  try {
    text = await readFile(resolvedPath, "utf8");
  } catch (error) {
    if (!explicit && hasCode(error, "ENOENT")) return BUILTIN_DEFINITIONS;
    throw new Error(`Could not read Jaeger harness config ${resolvedPath}`, { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Jaeger harness config is not valid JSON: ${resolvedPath}`, { cause: error });
  }
  const custom = parseHarnessConfig(value, resolvedPath);
  return validateHarnessDefinitions([...BUILTIN_DEFINITIONS, ...custom]);
}

export function validateHarnessDefinitions(
  value: unknown,
  options: { readonly allowPinnedBuiltins?: boolean } = {},
): readonly HarnessDefinition[] {
  if (!Array.isArray(value)) throw new Error("Harness definitions must be an array");
  const definitions = value.map((definition, index) =>
    parseHarnessDefinition(definition, `harness definition ${index}`),
  );
  const names = new Set<string>();
  for (const definition of definitions) {
    if (names.has(definition.name)) {
      throw new Error(`Duplicate harness definition: ${definition.name}`);
    }
    names.add(definition.name);
  }
  for (const builtin of BUILTIN_DEFINITIONS) {
    const pinned = definitions.find((definition) => definition.name === builtin.name);
    const pinnedCommand =
      pinned?.command === builtin.command ||
      (options.allowPinnedBuiltins === true &&
        typeof pinned?.command === "string" &&
        path.isAbsolute(pinned.command));
    if (!pinned || pinned.driver !== builtin.driver || !pinnedCommand) {
      throw new Error(`Built-in harness ${builtin.name} cannot be replaced`);
    }
  }
  return Object.freeze(definitions.map((definition) => Object.freeze({ ...definition })));
}

export async function pinHarnessDefinitions(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly HarnessDefinition[]> {
  const definitions = validateHarnessDefinitions(value);
  const pinned = await Promise.all(
    definitions.map(async (definition) => ({
      ...definition,
      command: await resolveHarnessCommand(definition.command, env),
    })),
  );
  return validateHarnessDefinitions(pinned, { allowPinnedBuiltins: true });
}

export function harnessesFromDefinitions(
  definitions: readonly HarnessDefinition[],
): ReadonlyMap<string, HarnessAdapter> {
  const validated = validateHarnessDefinitions(definitions, { allowPinnedBuiltins: true });
  return new Map(
    validated.map((definition) => [definition.name, adapterForDefinition(definition)]),
  );
}

export function harnessDefinitionsForRun(
  record: WorkflowRunRecord,
): readonly HarnessDefinition[] {
  return record.version === 3 || record.version === 4
    ? validateHarnessDefinitions(record.harnesses, { allowPinnedBuiltins: true })
    : BUILTIN_DEFINITIONS;
}

export function harnessesForRun(record: WorkflowRunRecord): ReadonlyMap<string, HarnessAdapter> {
  return harnessesFromDefinitions(harnessDefinitionsForRun(record));
}

export function validateHarnessName(value: unknown): string {
  if (typeof value !== "string" || !HARNESS_NAME.test(value)) {
    throw new TypeError(
      "agent harness must start with a lowercase letter and contain only lowercase letters, numbers, hyphens, or underscores",
    );
  }
  return value;
}

function adapterForDefinition(definition: HarnessDefinition): HarnessAdapter {
  if (definition.driver === "codex-app-server") {
    return new CodexHarness(definition.command, definition.name);
  }
  return new ClaudeHarness(definition.command, undefined, definition.name);
}

function parseHarnessConfig(value: unknown, configPath: string): HarnessDefinition[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Jaeger harness config must be an object: ${configPath}`);
  }
  const config = value as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (key !== "version" && key !== "harnesses") {
      throw new Error(`Unknown Jaeger harness config field: ${key}`);
    }
  }
  if (config.version !== 1) throw new Error("Jaeger harness config version must be 1");
  if (!config.harnesses || typeof config.harnesses !== "object" || Array.isArray(config.harnesses)) {
    throw new Error("Jaeger harness config harnesses must be an object");
  }
  return Object.entries(config.harnesses as Record<string, unknown>).map(([name, definition]) => {
    validateHarnessName(name);
    if (BUILTIN_NAMES.has(name)) {
      throw new Error(`Custom harness cannot replace built-in harness ${name}`);
    }
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
      throw new Error(`Custom harness ${name} must be an object`);
    }
    return parseHarnessDefinition({ name, ...(definition as Record<string, unknown>) }, name);
  });
}

function parseHarnessDefinition(value: unknown, label: string): HarnessDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const definition = value as Record<string, unknown>;
  for (const key of Object.keys(definition)) {
    if (!["name", "driver", "command", "description"].includes(key)) {
      throw new Error(`Unknown ${label} field: ${key}`);
    }
  }
  const name = validateHarnessName(definition.name);
  const driver = parseDriver(definition.driver, label);
  const command = harnessCommand(definition.command, `${label} command`);
  const description = definition.description;
  if (
    description !== undefined &&
    (typeof description !== "string" || description.trim().length === 0)
  ) {
    throw new Error(`${label} description must be a non-empty string`);
  }
  return {
    name,
    driver,
    command,
    ...(typeof description === "string" ? { description } : {}),
  };
}

function parseDriver(value: unknown, label: string): HarnessDriver {
  if (value !== "codex-app-server" && value !== "claude-agent-sdk") {
    throw new Error(`${label} driver must be codex-app-server or claude-agent-sdk`);
  }
  return value;
}

function harnessCommand(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string without NUL bytes`);
  }
  if (value.includes("/") && !path.isAbsolute(value)) {
    throw new Error(`${label} must be an executable name or absolute path`);
  }
  return value;
}

function defaultHarnessConfigPath(): string {
  const configRoot = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(configRoot, "jaeger", "harnesses.json");
}

async function resolveHarnessCommand(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const candidates: string[] = [];
  if (path.isAbsolute(command)) {
    candidates.push(command);
  } else {
    for (const directory of (env.PATH ?? "").split(path.delimiter)) {
        if (!directory || !path.isAbsolute(directory)) {
          throw new Error(
            `Cannot pin harness command ${command}: PATH contains a relative or empty entry`,
          );
        }
        let canonicalDirectory: string;
        try {
          canonicalDirectory = await trustedDirectory(directory, "Harness PATH entry");
        } catch (error) {
          if (hasCode(error, "ENOENT")) continue;
          throw error;
        }
        candidates.push(path.join(canonicalDirectory, command));
    }
  }
  for (const candidate of candidates) {
    try {
      return await trustedRegularFile(candidate, `Harness executable ${candidate}`, true);
    } catch {
      // Keep searching the normalized install environment.
    }
  }
  throw new Error(`Cannot pin unavailable harness command: ${command}`);
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
