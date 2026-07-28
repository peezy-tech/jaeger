import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parse as parseToml } from "smol-toml";
import { syncDirectory } from "./durable-json.js";
import { ensurePrivateDirectory } from "./paths.js";

const ENVIRONMENT_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const PROVIDERS = ["codex", "claude", "pi"] as const;
const PLUGIN_PROVIDERS = ["codex", "claude"] as const;
const PLUGIN_SELECTOR = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;
const execFileAsync = promisify(execFile);
type ProviderName = (typeof PROVIDERS)[number];
type PluginProviderName = (typeof PLUGIN_PROVIDERS)[number];
type ResourceKind = "file" | "directory";
type ResourceCategory = "instructions" | "skill" | "plugin" | "config" | "harness-config";

export interface EnvironmentPaths {
  readonly configRoot: string;
  readonly stateRoot: string;
}

export interface EnvironmentResource {
  readonly provider: ProviderName | "jaeger";
  readonly category: ResourceCategory;
  readonly source?: string;
  readonly target: string;
  readonly kind: ResourceKind;
  readonly digest: string;
  readonly content?: string;
}

export interface SnippetDecision {
  readonly path: string;
  readonly selected: boolean;
  readonly reason: string;
  readonly description?: string;
}

export interface EnvironmentPlan {
  readonly version: 1;
  readonly name: string;
  readonly manifestPath: string;
  readonly resources: readonly EnvironmentResource[];
  readonly plugins: readonly EnvironmentPlugin[];
  readonly packages: readonly EnvironmentPackage[];
  readonly snippets: readonly SnippetDecision[];
}

export interface EnvironmentPlugin {
  readonly provider: PluginProviderName;
  readonly selector: string;
}

export interface EnvironmentPackage {
  readonly provider: "pi";
  readonly source: string;
}

interface ManagedResource {
  readonly provider: ProviderName | "jaeger";
  readonly category: ResourceCategory;
  readonly target: string;
  readonly kind: ResourceKind;
  readonly digest: string;
  readonly backup?: string;
}

interface EnvironmentState {
  readonly version: 1;
  readonly environment: string;
  readonly manifestPath: string;
  readonly appliedAt: string;
  readonly resources: readonly ManagedResource[];
  readonly plugins: readonly ManagedPlugin[];
  readonly packages: readonly ManagedPackage[];
}

interface ManagedPlugin extends EnvironmentPlugin {
  readonly installedByEnvironment: boolean;
}

interface ManagedPackage extends EnvironmentPackage {
  readonly installedByEnvironment: boolean;
}

export interface EnvironmentPluginStatus extends EnvironmentPlugin {
  readonly status: "current" | "missing" | "obsolete";
  readonly installedByEnvironment?: boolean;
}

export interface EnvironmentPackageStatus extends EnvironmentPackage {
  readonly status: "current" | "missing" | "obsolete";
  readonly installedByEnvironment?: boolean;
}

export interface NativePluginManager {
  isInstalled(provider: PluginProviderName, selector: string): Promise<boolean>;
  install(provider: PluginProviderName, selector: string): Promise<void>;
  uninstall(provider: PluginProviderName, selector: string): Promise<void>;
}

export type PluginCommandRunner = (
  command: "codex" | "claude",
  args: readonly string[],
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

export interface NativePackageManager {
  isInstalled(source: string): Promise<boolean>;
  install(source: string): Promise<void>;
  uninstall(source: string): Promise<void>;
}

export type PackageCommandRunner = (
  command: "pi",
  args: readonly string[],
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

export interface ResourceStatus {
  readonly provider: ProviderName | "jaeger";
  readonly category: ResourceCategory;
  readonly target: string;
  readonly status: "current" | "missing" | "different" | "unmanaged" | "obsolete";
  readonly expectedDigest: string;
  readonly actualDigest?: string;
}

export interface EnvironmentStatus {
  readonly environment: string;
  readonly activeEnvironment?: string;
  readonly current: boolean;
  readonly resources: readonly ResourceStatus[];
  readonly plugins: readonly EnvironmentPluginStatus[];
  readonly packages: readonly EnvironmentPackageStatus[];
}

export interface ApplyResult {
  readonly environment: string;
  readonly changed: number;
  readonly unchanged: number;
  readonly removed: number;
  readonly installedPlugins: number;
  readonly removedPlugins: number;
  readonly installedPackages: number;
  readonly removedPackages: number;
  readonly statePath: string;
}

export interface UninstallResult {
  readonly environment: string;
  readonly restored: number;
  readonly removed: number;
  readonly removedPlugins: number;
  readonly removedPackages: number;
}

export function defaultEnvironmentPaths(env: NodeJS.ProcessEnv = process.env): EnvironmentPaths {
  const configBase = env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  const stateBase = env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  return {
    configRoot: path.join(configBase, "jaeger", "environments"),
    stateRoot: path.join(stateBase, "jaeger", "environment"),
  };
}

export async function listEnvironments(configRoot: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(configRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && ENVIRONMENT_NAME.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
}

export async function loadEnvironmentPlan(
  name: string,
  paths: EnvironmentPaths,
  explicitManifest?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EnvironmentPlan> {
  validateEnvironmentName(name);
  const manifestPath = path.resolve(
    explicitManifest ?? path.join(paths.configRoot, name, "environment.toml"),
  );
  const manifestDirectory = path.dirname(manifestPath);
  let parsed: unknown;
  try {
    parsed = parseToml(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (hasCode(error, "ENOENT")) throw new Error(`Environment manifest not found: ${manifestPath}`);
    throw new Error(`Could not parse environment manifest ${manifestPath}`, { cause: error });
  }
  const manifest = objectValue(parsed, `Environment manifest ${manifestPath}`);
  rejectUnknown(manifest, ["version", "name", "harness_config", "providers"], "environment manifest");
  if (manifest.version !== 1) throw new Error("Environment manifest version must be 1");
  if (manifest.name !== name) throw new Error(`Environment manifest name must be ${name}`);
  const resources: EnvironmentResource[] = [];
  const plugins: EnvironmentPlugin[] = [];
  const packages: EnvironmentPackage[] = [];
  const snippets: SnippetDecision[] = [];
  if (manifest.harness_config !== undefined) {
    const source = await resolveSource(manifestDirectory, stringValue(manifest.harness_config, "harness_config"));
    const target = path.join(path.dirname(paths.configRoot), "harnesses.json");
    resources.push(await sourceResource("jaeger", "harness-config", source, target));
  }
  const providers = objectValue(manifest.providers ?? {}, "providers");
  rejectUnknown(providers, PROVIDERS, "providers");
  for (const provider of PROVIDERS) {
    if (providers[provider] === undefined) continue;
    const providerConfig = objectValue(providers[provider], `providers.${provider}`);
    rejectUnknown(
      providerConfig,
      provider === "pi"
        ? ["instructions", "skills", "packages", "configs"]
        : ["instructions", "skills", "plugins", "configs"],
      `providers.${provider}`,
    );
    if (providerConfig.instructions !== undefined) {
      const names = stringArray(providerConfig.instructions, `providers.${provider}.instructions`);
      const bodies: string[] = [];
      for (const sourceName of names) {
        const source = await resolveSource(manifestDirectory, sourceName);
        const loaded = await loadSnippet(source, env);
        snippets.push(loaded.decision);
        if (loaded.decision.selected && loaded.body) bodies.push(loaded.body);
      }
      const digest = hashText(bodies.join("\n\n"));
      const header =
        `<!-- Generated by jaeger env. Edit the ${name} environment, not this file.\n` +
        `     Manifest: ${manifestPath}\n` +
        `     Content: sha256:${digest.slice(0, 12)} -->`;
      const content = `${header}\n\n${bodies.join("\n\n").trim()}\n`;
      resources.push({
        provider,
        category: "instructions",
        target: providerInstructionsTarget(provider, env),
        kind: "file",
        digest: hashText(content),
        content,
      });
    }
    if (providerConfig.skills !== undefined) {
      for (const sourceName of stringArray(providerConfig.skills, `providers.${provider}.skills`)) {
        const source = await resolveSource(manifestDirectory, sourceName);
        const target = path.join(providerAssetRoot(provider, "skills", env), path.basename(source));
        resources.push(await sourceResource(provider, "skill", source, target));
      }
    }
    if (providerConfig.plugins !== undefined) {
      if (provider === "pi") {
        throw new Error("providers.pi uses packages, not plugins");
      }
      for (const selector of stringArray(providerConfig.plugins, `providers.${provider}.plugins`)) {
        if (!PLUGIN_SELECTOR.test(selector)) {
          throw new Error(
            `providers.${provider}.plugins entries must be explicit plugin@marketplace selectors: ${selector}`,
          );
        }
        plugins.push({ provider, selector });
      }
    }
    if (providerConfig.packages !== undefined) {
      if (provider !== "pi") {
        throw new Error(`providers.${provider} uses plugins, not packages`);
      }
      for (const source of stringArray(
        providerConfig.packages,
        "providers.pi.packages",
      )) {
        packages.push({
          provider: "pi",
          source: await resolvePiPackageSource(source, manifestDirectory),
        });
      }
    }
    if (providerConfig.configs !== undefined) {
      if (!Array.isArray(providerConfig.configs)) {
        throw new Error(`providers.${provider}.configs must be an array of tables`);
      }
      for (const [index, rawConfig] of providerConfig.configs.entries()) {
        const config = objectValue(rawConfig, `providers.${provider}.configs[${index}]`);
        rejectUnknown(config, ["source", "target"], `providers.${provider}.configs[${index}]`);
        const source = await resolveSource(
          manifestDirectory,
          stringValue(config.source, `providers.${provider}.configs[${index}].source`),
        );
        const target = expandTarget(
          stringValue(config.target, `providers.${provider}.configs[${index}].target`),
          env,
        );
        resources.push(await sourceResource(provider, "config", source, target));
      }
    }
  }
  const targets = new Set<string>();
  for (const resource of resources) {
    if (targets.has(resource.target)) throw new Error(`Environment target is declared more than once: ${resource.target}`);
    targets.add(resource.target);
  }
  const pluginKeys = new Set<string>();
  for (const plugin of plugins) {
    const key = `${plugin.provider}:${plugin.selector}`;
    if (pluginKeys.has(key)) throw new Error(`Environment plugin is declared more than once: ${plugin.selector}`);
    pluginKeys.add(key);
  }
  const packageKeys = new Set<string>();
  for (const packageDefinition of packages) {
    const key = packageKey(packageDefinition);
    if (packageKeys.has(key)) {
      throw new Error(
        `Environment Pi package is declared more than once: ${packageDefinition.source}`,
      );
    }
    packageKeys.add(key);
  }
  return {
    version: 1,
    name,
    manifestPath,
    resources,
    plugins,
    packages,
    snippets,
  };
}

export async function inspectEnvironmentStatus(
  plan: EnvironmentPlan,
  paths: EnvironmentPaths,
  pluginManager: NativePluginManager = nativePluginManager,
  packageManager: NativePackageManager = nativePackageManager,
): Promise<EnvironmentStatus> {
  const state = await readState(paths.stateRoot);
  const managed = new Map((state?.resources ?? []).map((resource) => [resource.target, resource]));
  const plannedResources = await Promise.all(
    plan.resources.map(async (resource): Promise<ResourceStatus> => {
      const actualDigest = await digestPath(resource.target);
      const status =
        actualDigest === undefined
          ? "missing"
          : actualDigest === resource.digest
            ? "current"
            : managed.has(resource.target)
              ? "different"
              : "unmanaged";
      return {
        provider: resource.provider,
        category: resource.category,
        target: resource.target,
        status,
        expectedDigest: resource.digest,
        ...(actualDigest ? { actualDigest } : {}),
      };
    }),
  );
  const plannedTargets = new Set(plan.resources.map((resource) => resource.target));
  const obsoleteResources: ResourceStatus[] = [];
  for (const resource of state?.resources ?? []) {
    if (plannedTargets.has(resource.target)) continue;
    const actualDigest = await digestPath(resource.target);
    obsoleteResources.push({
      provider: resource.provider,
      category: resource.category,
      target: resource.target,
      status: "obsolete",
      expectedDigest: resource.digest,
      ...(actualDigest ? { actualDigest } : {}),
    });
  }
  const resources = [...plannedResources, ...obsoleteResources];
  const desiredPluginKeys = new Set(plan.plugins.map(pluginKey));
  const managedPlugins = new Map((state?.plugins ?? []).map((plugin) => [pluginKey(plugin), plugin]));
  const plugins: EnvironmentPluginStatus[] = [];
  for (const plugin of plan.plugins) {
    const installed = await pluginManager.isInstalled(plugin.provider, plugin.selector);
    const managedPlugin = managedPlugins.get(pluginKey(plugin));
    plugins.push({
      ...plugin,
      status: installed ? "current" : "missing",
      ...(managedPlugin ? { installedByEnvironment: managedPlugin.installedByEnvironment } : {}),
    });
  }
  for (const plugin of state?.plugins ?? []) {
    if (desiredPluginKeys.has(pluginKey(plugin))) continue;
    plugins.push({ ...plugin, status: "obsolete" });
  }
  const desiredPackageKeys = new Set(plan.packages.map(packageKey));
  const managedPackages = new Map(
    (state?.packages ?? []).map((packageDefinition) => [
      packageKey(packageDefinition),
      packageDefinition,
    ]),
  );
  const packages: EnvironmentPackageStatus[] = [];
  for (const packageDefinition of plan.packages) {
    const installed = await packageManager.isInstalled(packageDefinition.source);
    const managedPackage = managedPackages.get(packageKey(packageDefinition));
    packages.push({
      ...packageDefinition,
      status: installed ? "current" : "missing",
      ...(managedPackage
        ? { installedByEnvironment: managedPackage.installedByEnvironment }
        : {}),
    });
  }
  for (const packageDefinition of state?.packages ?? []) {
    if (desiredPackageKeys.has(packageKey(packageDefinition))) continue;
    packages.push({ ...packageDefinition, status: "obsolete" });
  }
  const current =
    state?.environment === plan.name &&
    resources.every((resource) => resource.status === "current") &&
    plugins.every((plugin) => plugin.status === "current") &&
    packages.every((packageDefinition) => packageDefinition.status === "current");
  return {
    environment: plan.name,
    ...(state ? { activeEnvironment: state.environment } : {}),
    current,
    resources,
    plugins,
    packages,
  };
}

export async function applyEnvironment(
  plan: EnvironmentPlan,
  paths: EnvironmentPaths,
  options: {
    readonly force?: boolean;
    readonly pluginManager?: NativePluginManager;
    readonly packageManager?: NativePackageManager;
  } = {},
): Promise<ApplyResult> {
  await ensurePrivateDirectory(paths.stateRoot, "Jaeger environment state root");
  const previous = await readState(paths.stateRoot);
  const previousByTarget = new Map((previous?.resources ?? []).map((resource) => [resource.target, resource]));
  const desiredByTarget = new Map(plan.resources.map((resource) => [resource.target, resource]));
  await preflightManagedChanges(previous, desiredByTarget, options.force === true);
  if (!options.force) {
    for (const resource of plan.resources) {
      if (previousByTarget.has(resource.target)) continue;
      const actual = await digestPath(resource.target);
      if (actual !== undefined && actual !== resource.digest) {
        throw new Error(
          `Refusing to replace unmanaged target ${resource.target}; rerun with --force to preserve it as a backup`,
        );
      }
    }
  }
  let changed = 0;
  let unchanged = 0;
  let removed = 0;
  let installedPlugins = 0;
  let removedPlugins = 0;
  let installedPackages = 0;
  let removedPackages = 0;
  const statePath = path.join(paths.stateRoot, "active.json");
  const appliedAt = new Date().toISOString();
  const persistState = async (
    resources: readonly ManagedResource[],
    plugins: readonly ManagedPlugin[],
    packages: readonly ManagedPackage[],
  ): Promise<void> => {
    const state: EnvironmentState = {
      version: 1,
      environment: plan.name,
      manifestPath: plan.manifestPath,
      appliedAt,
      resources,
      plugins,
      packages,
    };
    await atomicWrite(
      statePath,
      `${JSON.stringify(state, null, 2)}\n`,
      0o600,
    );
  };
  const nextResources: ManagedResource[] = [];
  for (const old of previous?.resources ?? []) {
    if (desiredByTarget.has(old.target)) continue;
    await removeManagedResource(old);
    removed += 1;
  }
  const backupGeneration = path.join(paths.stateRoot, "backups", randomUUID());
  for (const resource of plan.resources) {
    const old = previousByTarget.get(resource.target);
    const actualDigest = await digestPath(resource.target);
    let backup = old?.backup;
    if (actualDigest === resource.digest) {
      unchanged += 1;
    } else {
      if (!old && actualDigest !== undefined) {
        if (!options.force) {
          throw new Error(`Refusing to replace unmanaged target ${resource.target}; rerun with --force to preserve it as a backup`);
        }
        const backupTarget = path.join(backupGeneration, String(nextResources.length));
        await copyPath(resource.target, backupTarget);
        backup = backupTarget;
      }
      await materializeResource(resource);
      changed += 1;
    }
    nextResources.push({
      provider: resource.provider,
      category: resource.category,
      target: resource.target,
      kind: resource.kind,
      digest: resource.digest,
      ...(backup ? { backup } : {}),
    });
  }
  await persistState(
    nextResources,
    previous?.plugins ?? [],
    previous?.packages ?? [],
  );
  const pluginManager = options.pluginManager ?? nativePluginManager;
  const desiredPluginKeys = new Set(plan.plugins.map(pluginKey));
  const previousPlugins = new Map((previous?.plugins ?? []).map((plugin) => [pluginKey(plugin), plugin]));
  for (const old of previous?.plugins ?? []) {
    if (desiredPluginKeys.has(pluginKey(old)) || !old.installedByEnvironment) continue;
    if (await pluginManager.isInstalled(old.provider, old.selector)) {
      await pluginManager.uninstall(old.provider, old.selector);
      removedPlugins += 1;
    }
  }
  const nextPlugins: ManagedPlugin[] = [];
  for (const plugin of plan.plugins) {
    const previousPlugin = previousPlugins.get(pluginKey(plugin));
    const installed = await pluginManager.isInstalled(plugin.provider, plugin.selector);
    if (!installed) {
      await pluginManager.install(plugin.provider, plugin.selector);
      installedPlugins += 1;
    }
    nextPlugins.push({
      ...plugin,
      installedByEnvironment: previousPlugin?.installedByEnvironment === true || !installed,
    });
  }
  await persistState(
    nextResources,
    nextPlugins,
    previous?.packages ?? [],
  );
  const packageManager = options.packageManager ?? nativePackageManager;
  const desiredPackageKeys = new Set(plan.packages.map(packageKey));
  const previousPackages = new Map(
    (previous?.packages ?? []).map((packageDefinition) => [
      packageKey(packageDefinition),
      packageDefinition,
    ]),
  );
  for (const old of previous?.packages ?? []) {
    if (
      desiredPackageKeys.has(packageKey(old)) ||
      !old.installedByEnvironment
    ) {
      continue;
    }
    if (await packageManager.isInstalled(old.source)) {
      await packageManager.uninstall(old.source);
      removedPackages += 1;
    }
  }
  const nextPackages: ManagedPackage[] = [];
  for (const [index, packageDefinition] of plan.packages.entries()) {
    const previousPackage = previousPackages.get(packageKey(packageDefinition));
    const installed = await packageManager.isInstalled(packageDefinition.source);
    nextPackages.push({
      ...packageDefinition,
      installedByEnvironment:
        previousPackage?.installedByEnvironment === true || !installed,
    });
    if (!installed) {
      const remainingPreviousPackages = plan.packages
        .slice(index + 1)
        .flatMap((remainingPackage) => {
          const previousPackage = previousPackages.get(
            packageKey(remainingPackage),
          );
          return previousPackage ? [previousPackage] : [];
        });
      await persistState(
        nextResources,
        nextPlugins,
        [...nextPackages, ...remainingPreviousPackages],
      );
      await packageManager.install(packageDefinition.source);
      installedPackages += 1;
    }
  }
  await persistState(nextResources, nextPlugins, nextPackages);
  return {
    environment: plan.name,
    changed,
    unchanged,
    removed,
    installedPlugins,
    removedPlugins,
    installedPackages,
    removedPackages,
    statePath,
  };
}

export async function uninstallEnvironment(
  paths: EnvironmentPaths,
  expectedName?: string,
  options: {
    readonly force?: boolean;
    readonly pluginManager?: NativePluginManager;
    readonly packageManager?: NativePackageManager;
  } = {},
): Promise<UninstallResult> {
  const state = await readState(paths.stateRoot);
  if (!state) throw new Error("No Jaeger environment is active");
  if (expectedName && expectedName !== state.environment) {
    throw new Error(`Active environment is ${state.environment}, not ${expectedName}`);
  }
  await preflightManagedChanges(state, new Map(), options.force === true);
  let restored = 0;
  let removed = 0;
  let removedPlugins = 0;
  let removedPackages = 0;
  for (const resource of state.resources) {
    await removeManagedResource(resource);
    if (resource.backup) restored += 1;
    else removed += 1;
  }
  const pluginManager = options.pluginManager ?? nativePluginManager;
  for (const plugin of state.plugins) {
    if (
      plugin.installedByEnvironment &&
      (await pluginManager.isInstalled(plugin.provider, plugin.selector))
    ) {
      await pluginManager.uninstall(plugin.provider, plugin.selector);
      removedPlugins += 1;
    }
  }
  const packageManager = options.packageManager ?? nativePackageManager;
  for (const packageDefinition of state.packages) {
    if (
      packageDefinition.installedByEnvironment &&
      (await packageManager.isInstalled(packageDefinition.source))
    ) {
      await packageManager.uninstall(packageDefinition.source);
      removedPackages += 1;
    }
  }
  await rm(path.join(paths.stateRoot, "active.json"), { force: true });
  return {
    environment: state.environment,
    restored,
    removed,
    removedPlugins,
    removedPackages,
  };
}

export async function activeEnvironment(paths: EnvironmentPaths): Promise<EnvironmentState | undefined> {
  return await readState(paths.stateRoot);
}

async function preflightManagedChanges(
  state: EnvironmentState | undefined,
  desired: ReadonlyMap<string, EnvironmentResource>,
  force: boolean,
): Promise<void> {
  for (const resource of state?.resources ?? []) {
    const actual = await digestPath(resource.target);
    const next = desired.get(resource.target);
    if (actual !== resource.digest && actual !== next?.digest && !force) {
      throw new Error(`Managed target has local changes: ${resource.target}; rerun with --force to replace them`);
    }
  }
}

async function removeManagedResource(resource: ManagedResource): Promise<void> {
  await rm(resource.target, { recursive: true, force: true });
  if (resource.backup) {
    if ((await digestPath(resource.backup)) === undefined) {
      throw new Error(`Environment backup is missing: ${resource.backup}`);
    }
    await copyPath(resource.backup, resource.target);
  }
}

async function materializeResource(resource: EnvironmentResource): Promise<void> {
  await mkdir(path.dirname(resource.target), { recursive: true });
  if (resource.content !== undefined) {
    const existing = await lstat(resource.target).catch((error: unknown) => {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    });
    if (existing?.isDirectory()) await rm(resource.target, { recursive: true });
    await atomicWrite(resource.target, resource.content, 0o600);
    return;
  }
  if (!resource.source) throw new Error(`Resource has no source: ${resource.target}`);
  const temporary = path.join(path.dirname(resource.target), `.${path.basename(resource.target)}.jaeger-${randomUUID()}`);
  await copyPath(resource.source, temporary);
  await rm(resource.target, { recursive: true, force: true });
  await rename(temporary, resource.target);
}

async function sourceResource(
  provider: ProviderName | "jaeger",
  category: ResourceCategory,
  source: string,
  target: string,
): Promise<EnvironmentResource> {
  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink() || (!sourceStat.isFile() && !sourceStat.isDirectory())) {
    throw new Error(`Environment source must be a regular file or directory: ${source}`);
  }
  return {
    provider,
    category,
    source,
    target,
    kind: sourceStat.isDirectory() ? "directory" : "file",
    digest: await requiredDigestPath(source),
  };
}

async function loadSnippet(
  source: string,
  env: NodeJS.ProcessEnv,
): Promise<{ readonly body: string; readonly decision: SnippetDecision }> {
  const raw = await readFile(source, "utf8");
  let body = raw;
  let metadata: Record<string, unknown> = {};
  if (raw.startsWith("+++\n")) {
    const end = raw.indexOf("\n+++\n", 4);
    if (end < 0) throw new Error(`Unterminated TOML front matter in ${source}`);
    metadata = objectValue(parseToml(raw.slice(4, end)), `front matter in ${source}`);
    rejectUnknown(metadata, ["description", "requires", "excludes"], `front matter in ${source}`);
    body = raw.slice(end + 5);
  }
  const requires = metadata.requires === undefined ? [] : stringArray(metadata.requires, `${source} requires`);
  const excludes = metadata.excludes === undefined ? [] : stringArray(metadata.excludes, `${source} excludes`);
  const missing = requires.filter((command) => !commandAvailable(command, env));
  const excluded = excludes.filter((command) => commandAvailable(command, env));
  const selected = missing.length === 0 && excluded.length === 0;
  const reason =
    missing.length > 0
      ? `missing commands: ${missing.join(", ")}`
      : excluded.length > 0
        ? `excluded commands present: ${excluded.join(", ")}`
        : "selected";
  const description = metadata.description;
  if (description !== undefined && (typeof description !== "string" || description.trim() === "")) {
    throw new Error(`Snippet description must be a non-empty string: ${source}`);
  }
  return {
    body: body.trim(),
    decision: {
      path: source,
      selected,
      reason,
      ...(typeof description === "string" ? { description } : {}),
    },
  };
}

function providerInstructionsTarget(provider: ProviderName, env: NodeJS.ProcessEnv): string {
  if (provider === "codex") return path.join(codexHome(env), "AGENTS.md");
  if (provider === "claude") return path.join(claudeHome(env), "CLAUDE.md");
  return path.join(piHome(env), "AGENTS.md");
}

function providerAssetRoot(
  provider: ProviderName,
  field: "skills",
  env: NodeJS.ProcessEnv,
): string {
  const root =
    provider === "codex"
      ? codexHome(env)
      : provider === "claude"
        ? claudeHome(env)
        : piHome(env);
  return path.join(root, field);
}

function codexHome(env: NodeJS.ProcessEnv): string {
  return path.resolve(expandHome(env.CODEX_HOME ?? path.join(os.homedir(), ".codex")));
}

function claudeHome(env: NodeJS.ProcessEnv): string {
  return path.resolve(expandHome(env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude")));
}

function piHome(env: NodeJS.ProcessEnv): string {
  return path.resolve(
    expandHome(env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent")),
  );
}

function expandTarget(value: string, env: NodeJS.ProcessEnv): string {
  const replacements: Record<string, string> = {
    "$HOME": os.homedir(),
    "$CODEX_HOME": codexHome(env),
    "$CLAUDE_CONFIG_DIR": claudeHome(env),
    "$PI_CODING_AGENT_DIR": piHome(env),
  };
  let expanded = expandHome(value);
  for (const [token, replacement] of Object.entries(replacements)) {
    if (expanded === token || expanded.startsWith(`${token}/`)) {
      expanded = replacement + expanded.slice(token.length);
      break;
    }
  }
  if (!path.isAbsolute(expanded)) throw new Error(`Environment config target must be absolute or home-relative: ${value}`);
  return path.resolve(expanded);
}

function expandHome(value: string): string {
  return value === "~" || value.startsWith("~/") ? os.homedir() + value.slice(1) : value;
}

async function resolveSource(directory: string, relative: string): Promise<string> {
  if (path.isAbsolute(relative) || relative.includes("\0")) {
    throw new Error(`Environment source must be relative: ${relative}`);
  }
  const candidate = path.resolve(directory, relative);
  const relation = path.relative(directory, candidate);
  if (relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new Error(`Environment source escapes its manifest directory: ${relative}`);
  }
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch (error) {
    throw new Error(`Environment source not found: ${candidate}`, { cause: error });
  }
  const realDirectory = await realpath(directory);
  const resolvedRelation = path.relative(realDirectory, resolved);
  if (resolvedRelation.startsWith("..") || path.isAbsolute(resolvedRelation)) {
    throw new Error(`Environment source resolves outside its manifest directory: ${relative}`);
  }
  return resolved;
}

async function copyPath(source: string, target: string): Promise<void> {
  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink()) throw new Error(`Environment resources cannot contain symlinks: ${source}`);
  if (sourceStat.isFile()) {
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target, constants.COPYFILE_EXCL);
    await chmod(target, sourceStat.mode & 0o777);
    return;
  }
  if (!sourceStat.isDirectory()) throw new Error(`Unsupported environment resource: ${source}`);
  await mkdir(target, { recursive: true, mode: sourceStat.mode & 0o777 });
  for (const entry of await readdir(source)) await copyPath(path.join(source, entry), path.join(target, entry));
}

async function digestPath(target: string): Promise<string | undefined> {
  try {
    const targetStat = await lstat(target);
    if (targetStat.isSymbolicLink()) return `symlink:${await realpath(target).catch(() => "broken")}`;
    if (targetStat.isFile()) return hashText(await readFile(target));
    if (!targetStat.isDirectory()) return `unsupported:${targetStat.mode}`;
    const hash = createHash("sha256");
    await hashDirectory(target, "", hash);
    return hash.digest("hex");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function requiredDigestPath(target: string): Promise<string> {
  const digest = await digestPath(target);
  if (digest === undefined) throw new Error(`Environment resource disappeared: ${target}`);
  return digest;
}

async function hashDirectory(directory: string, prefix: string, hash: ReturnType<typeof createHash>): Promise<void> {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Environment resources cannot contain symlinks: ${absolute}`);
    if (entry.isDirectory()) {
      hash.update(`d:${relative}\0`);
      await hashDirectory(absolute, relative, hash);
    } else if (entry.isFile()) {
      hash.update(`f:${relative}\0`);
      hash.update(await readFile(absolute));
      hash.update("\0");
    } else {
      throw new Error(`Unsupported environment resource: ${absolute}`);
    }
  }
}

async function atomicWrite(target: string, content: string, mode: number): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}`);
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
  await syncDirectory(path.dirname(target));
}

async function readState(stateRoot: string): Promise<EnvironmentState | undefined> {
  const target = path.join(stateRoot, "active.json");
  let value: unknown;
  try {
    const rootStat = await lstat(stateRoot);
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      (process.getuid && rootStat.uid !== process.getuid()) ||
      (rootStat.mode & 0o077) !== 0
    ) {
      throw new Error(`Jaeger environment state root must be a private owned directory: ${stateRoot}`);
    }
    const targetStat = await lstat(target);
    if (
      !targetStat.isFile() ||
      targetStat.isSymbolicLink() ||
      (process.getuid && targetStat.uid !== process.getuid()) ||
      (targetStat.mode & 0o077) !== 0
    ) {
      throw new Error(`Jaeger environment state must be a private owned regular file: ${target}`);
    }
    value = JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw new Error(`Invalid Jaeger environment state: ${target}`, { cause: error });
  }
  const state = objectValue(value, "environment state");
  rejectUnknown(
    state,
    [
      "version",
      "environment",
      "manifestPath",
      "appliedAt",
      "resources",
      "plugins",
      "packages",
    ],
    "environment state",
  );
  if (
    state.version !== 1 ||
    typeof state.environment !== "string" || !ENVIRONMENT_NAME.test(state.environment) ||
    typeof state.manifestPath !== "string" || !path.isAbsolute(state.manifestPath) ||
    typeof state.appliedAt !== "string" || Number.isNaN(Date.parse(state.appliedAt)) ||
    !Array.isArray(state.resources) ||
    !Array.isArray(state.plugins) ||
    (state.packages !== undefined && !Array.isArray(state.packages))
  ) {
    throw new Error(`Invalid Jaeger environment state: ${target}`);
  }
  const seen = new Set<string>();
  const resources = state.resources.map((raw, index): ManagedResource => {
    const resource = objectValue(raw, `environment state resource ${index}`);
    rejectUnknown(resource, ["provider", "category", "target", "kind", "digest", "backup"], `environment state resource ${index}`);
    if (
      (resource.provider !== "jaeger" && !PROVIDERS.includes(resource.provider as ProviderName)) ||
      !["instructions", "skill", "plugin", "config", "harness-config"].includes(String(resource.category)) ||
      typeof resource.target !== "string" || !path.isAbsolute(resource.target) ||
      (resource.kind !== "file" && resource.kind !== "directory") ||
      typeof resource.digest !== "string" || !/^[a-f0-9]{64}$/.test(resource.digest)
    ) {
      throw new Error(`Invalid Jaeger environment state resource ${index}: ${target}`);
    }
    if (seen.has(resource.target)) throw new Error(`Duplicate Jaeger environment state target: ${resource.target}`);
    seen.add(resource.target);
    let backup: string | undefined;
    if (resource.backup !== undefined) {
      if (typeof resource.backup !== "string" || !path.isAbsolute(resource.backup)) {
        throw new Error(`Invalid Jaeger environment backup in ${target}`);
      }
      const backupRoot = path.join(path.resolve(stateRoot), "backups");
      const relation = path.relative(backupRoot, resource.backup);
      if (relation.startsWith("..") || path.isAbsolute(relation)) {
        throw new Error(`Jaeger environment backup escapes its state root: ${resource.backup}`);
      }
      backup = resource.backup;
    }
    return {
      provider: resource.provider as ProviderName | "jaeger",
      category: resource.category as ResourceCategory,
      target: resource.target,
      kind: resource.kind,
      digest: resource.digest,
      ...(backup ? { backup } : {}),
    };
  });
  const pluginKeys = new Set<string>();
  const plugins = state.plugins.map((raw, index): ManagedPlugin => {
    const plugin = objectValue(raw, `environment state plugin ${index}`);
    rejectUnknown(plugin, ["provider", "selector", "installedByEnvironment"], `environment state plugin ${index}`);
    if (
      !PLUGIN_PROVIDERS.includes(plugin.provider as PluginProviderName) ||
      typeof plugin.selector !== "string" ||
      !PLUGIN_SELECTOR.test(plugin.selector) ||
      typeof plugin.installedByEnvironment !== "boolean"
    ) {
      throw new Error(`Invalid Jaeger environment state plugin ${index}: ${target}`);
    }
    const parsed = {
      provider: plugin.provider as PluginProviderName,
      selector: plugin.selector,
      installedByEnvironment: plugin.installedByEnvironment,
    };
    const key = pluginKey(parsed);
    if (pluginKeys.has(key)) throw new Error(`Duplicate Jaeger environment state plugin: ${key}`);
    pluginKeys.add(key);
    return parsed;
  });
  const packageKeys = new Set<string>();
  const packages = (state.packages ?? []).map(
    (raw, index): ManagedPackage => {
      const packageDefinition = objectValue(
        raw,
        `environment state package ${index}`,
      );
      rejectUnknown(
        packageDefinition,
        ["provider", "source", "installedByEnvironment"],
        `environment state package ${index}`,
      );
      if (
        packageDefinition.provider !== "pi" ||
        typeof packageDefinition.source !== "string" ||
        typeof packageDefinition.installedByEnvironment !== "boolean"
      ) {
        throw new Error(
          `Invalid Jaeger environment state package ${index}: ${target}`,
        );
      }
      validatePiPackageSource(packageDefinition.source);
      const parsed: ManagedPackage = {
        provider: "pi",
        source: packageDefinition.source,
        installedByEnvironment: packageDefinition.installedByEnvironment,
      };
      const key = packageKey(parsed);
      if (packageKeys.has(key)) {
        throw new Error(`Duplicate Jaeger environment state package: ${key}`);
      }
      packageKeys.add(key);
      return parsed;
    },
  );
  return {
    version: 1,
    environment: state.environment,
    manifestPath: state.manifestPath,
    appliedAt: state.appliedAt,
    resources,
    plugins,
    packages,
  };
}

export function createNativePluginManager(
  runner: PluginCommandRunner = executePluginCommand,
): NativePluginManager {
  return {
    async isInstalled(provider, selector) {
      const command = provider === "codex" ? "codex" : "claude";
      const { stdout } = await runner(command, ["plugin", "list", "--json"]);
      let value: unknown;
      try {
        value = JSON.parse(stdout);
      } catch (error) {
        throw new Error(`${provider} plugin list did not return valid JSON`, { cause: error });
      }
      const entries = Array.isArray(value)
        ? value
        : value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).installed)
          ? ((value as Record<string, unknown>).installed as unknown[])
          : [];
      return entries.some((entry) => pluginEntrySelector(entry) === selector);
    },
    async install(provider, selector) {
      const command = provider === "codex" ? "codex" : "claude";
      await runner(
        command,
        provider === "codex"
          ? ["plugin", "add", selector, "--json"]
          : ["plugin", "install", selector, "--scope", "user"],
      );
    },
    async uninstall(provider, selector) {
      const command = provider === "codex" ? "codex" : "claude";
      await runner(
        command,
        provider === "codex"
          ? ["plugin", "remove", selector, "--json"]
          : ["plugin", "uninstall", selector],
      );
    },
  };
}

const nativePluginManager = createNativePluginManager();

export function createNativePackageManager(
  runner: PackageCommandRunner = executePackageCommand,
): NativePackageManager {
  return {
    async isInstalled(source) {
      const { stdout } = await runner("pi", ["list", "--no-approve"]);
      return parsePiPackageSources(stdout).includes(source);
    },
    async install(source) {
      await runner("pi", ["install", source, "--no-approve"]);
    },
    async uninstall(source) {
      await runner("pi", ["remove", source, "--no-approve"]);
    },
  };
}

const nativePackageManager = createNativePackageManager();

async function executePluginCommand(
  command: "codex" | "claude",
  args: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  try {
    return await execFileAsync(command, args, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`Could not run ${command} ${args.join(" ")}`, { cause: error });
  }
}

async function executePackageCommand(
  command: "pi",
  args: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  try {
    return await execFileAsync(command, args, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: "1" },
    });
  } catch (error) {
    throw new Error(`Could not run ${command} ${args.join(" ")}`, { cause: error });
  }
}

function pluginEntrySelector(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  for (const key of ["pluginId", "id", "selector"]) {
    if (typeof entry[key] === "string" && PLUGIN_SELECTOR.test(entry[key])) return entry[key];
  }
  const name = typeof entry.name === "string" ? entry.name : undefined;
  const marketplace =
    typeof entry.marketplaceName === "string"
      ? entry.marketplaceName
      : typeof entry.marketplace === "string"
        ? entry.marketplace
        : undefined;
  return name && marketplace ? `${name}@${marketplace}` : undefined;
}

function pluginKey(plugin: EnvironmentPlugin): string {
  return `${plugin.provider}:${plugin.selector}`;
}

function packageKey(packageDefinition: EnvironmentPackage): string {
  return `${packageDefinition.provider}:${packageDefinition.source}`;
}

function parsePiPackageSources(output: string): readonly string[] {
  const lines = output.split(/\r?\n/);
  if (
    !lines.includes("User packages:") &&
    !lines.includes("Project packages:") &&
    !lines.includes("No packages installed.")
  ) {
    throw new Error("Pi package list returned an unrecognized format");
  }
  const sources: string[] = [];
  let userPackages = false;
  for (const line of lines) {
    if (line === "User packages:") {
      userPackages = true;
      continue;
    }
    if (/^\S/.test(line)) userPackages = false;
    if (!userPackages) continue;
    const match = line.match(/^  (\S.*?)(?:\s+\(filtered\))?$/);
    if (match) sources.push(match[1] as string);
  }
  return sources;
}

function validatePiPackageSource(source: string): void {
  if (
    source.trim() === "" ||
    source !== source.trim() ||
    /[\0\r\n]/.test(source) ||
    (!path.isAbsolute(source) &&
      !/^(?:npm:|git:|https:\/\/|ssh:\/\/)/.test(source))
  ) {
    throw new Error(
      `providers.pi.packages entries must be npm:, git:, HTTPS, SSH, or local path sources: ${source}`,
    );
  }
}

async function resolvePiPackageSource(
  source: string,
  manifestDirectory: string,
): Promise<string> {
  if (path.isAbsolute(source)) {
    throw new Error(
      `Local providers.pi.packages paths must be relative to the manifest: ${source}`,
    );
  }
  if (source === "." || source.startsWith("./") || source.startsWith("../")) {
    return await resolveSource(manifestDirectory, source);
  }
  validatePiPackageSource(source);
  return source;
}

function commandAvailable(command: string, env: NodeJS.ProcessEnv): boolean {
  if (!/^[A-Za-z0-9._+-]+$/.test(command)) throw new Error(`Invalid required command name: ${command}`);
  const pathValue = env.PATH ?? "";
  return pathValue.split(path.delimiter).some((directory) => {
    if (!directory) return false;
    try {
      const candidate = path.join(directory, command);
      accessSync(candidate, constants.X_OK);
      const value = statSync(candidate);
      return value.isFile() && (value.mode & 0o111) !== 0;
    } catch {
      return false;
    }
  });
}

function hashText(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateEnvironmentName(name: string): void {
  if (!ENVIRONMENT_NAME.test(name)) {
    throw new Error("Environment name must start with a lowercase letter and contain only lowercase letters, numbers, hyphens, or underscores");
  }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a table`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string without NUL bytes`);
  }
  return value;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim() !== "")) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value;
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
