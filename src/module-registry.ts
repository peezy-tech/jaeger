import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Range, minVersion, validRange } from "semver";
import {
  acquireProcessLease,
  ProcessLeaseBusyError,
  releaseProcessLease,
} from "./process-lease.js";

const execFileAsync = promisify(execFile);
const MODULE_LOCK_FILE = "modules.lock.json";
const MODULE_MUTATION_LOCK_FILE = ".modules-mutation.lock";
const MODULE_DIRECTORY = "modules";
const RUNTIME_CONFIG_FILE = "jaeger.runtime.mjs";
const MODULE_TRANSACTION_FILE = "transaction.json";
const MODULE_TRANSACTION_PREFIXES = [
  ".modules-stage-",
  ".modules-remove-",
  ".modules-sync-",
] as const;
const MAX_MODULE_FILE_BYTES = 5 * 1024 * 1024;
const MAX_MODULE_BYTES = 25 * 1024 * 1024;
const MODULE_REGISTRY_CODE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_REGISTRY_PATH = path.resolve(
  MODULE_REGISTRY_CODE_DIRECTORY,
  "../jaeger.registry.json",
);

export interface ModuleRegistryItem {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly files: readonly string[];
  readonly dependencies: Readonly<Record<string, string>>;
  readonly requires?: Readonly<Record<string, string>>;
  readonly configuration?: readonly ModuleConfigurationRequirement[];
  readonly declaredAccess?: Readonly<Record<string, readonly string[]>>;
  readonly commands?: Readonly<Record<string, string>>;
}

export interface ModuleConfigurationRequirement {
  readonly name: string;
  readonly required?: boolean;
  readonly secret?: boolean;
  readonly description?: string;
}

export interface ResolvedModuleItem {
  readonly item: ModuleRegistryItem;
  readonly reference: string;
  readonly resolvedSource: string;
  readonly files: ReadonlyMap<string, Buffer>;
  readonly digest: string;
}

export interface InstalledModuleRecord {
  readonly source: string;
  readonly resolvedSource: string;
  readonly digest: string;
  readonly installedAt: string;
  readonly files: Readonly<Record<string, string>>;
  readonly dependencies: Readonly<Record<string, string>>;
}

export interface ManagedDependencyRecord {
  readonly appliedRange: string;
  readonly operatorRange?: string;
  readonly requestedBy: Readonly<Record<string, string>>;
}

export interface ModuleProjectLock {
  readonly schemaVersion: 1;
  readonly modules: Readonly<Record<string, InstalledModuleRecord>>;
  readonly dependencies: Readonly<Record<string, ManagedDependencyRecord>>;
}

export interface ModuleAddOptions {
  readonly root: string;
  readonly references: readonly string[];
  readonly dryRun?: boolean;
  readonly install?: boolean;
  readonly overwrite?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ModuleRemoveOptions {
  readonly root: string;
  readonly names: readonly string[];
  readonly dryRun?: boolean;
  readonly install?: boolean;
  readonly force?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ModuleSyncOptions {
  readonly root: string;
  readonly dryRun?: boolean;
  readonly install?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ModuleMutationResult {
  readonly schemaVersion: 1;
  readonly root: string;
  readonly action: "add" | "remove" | "sync";
  readonly modules: readonly string[];
  readonly dependencies: Readonly<Record<string, ManagedDependencyRecord>>;
  readonly packageManager?: string;
  readonly dependenciesInstalled: boolean;
  readonly dryRun: boolean;
}

export interface ModuleDiff {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly root: string;
  readonly clean: boolean;
  readonly modified: readonly string[];
  readonly missing: readonly string[];
  readonly added: readonly string[];
}

interface RegistryCatalog {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly items: readonly {
    readonly name: string;
    readonly path: string;
  }[];
}

interface SourceDocument {
  readonly locator: string;
  readonly value: unknown;
}

interface PreparedModule {
  readonly resolved: ResolvedModuleItem;
  readonly record: InstalledModuleRecord;
}

interface PackageProject {
  readonly existed: boolean;
  readonly value: Record<string, unknown>;
}

interface PackageReconciliation {
  readonly packageJson: Record<string, unknown>;
  readonly dependencies: Record<string, ManagedDependencyRecord>;
  readonly changed: boolean;
}

interface FileSnapshot {
  readonly path: string;
  readonly backup?: string;
  readonly mode?: number;
}

interface DirectorySnapshot {
  readonly path: string;
  readonly backup?: string;
}

interface PackageSnapshot {
  readonly files: readonly FileSnapshot[];
  readonly directories: readonly DirectorySnapshot[];
}

interface ModuleTransaction {
  readonly schemaVersion: 1;
  readonly phase: "active" | "committed";
  readonly action: "add" | "remove" | "sync";
  readonly modules: readonly {
    readonly name: string;
    readonly existed: boolean;
  }[];
  readonly files: readonly {
    readonly name: string;
    readonly existed: boolean;
    readonly mode?: number;
  }[];
  readonly directories: readonly {
    readonly name: string;
    readonly existed: boolean;
  }[];
}

interface RollbackFailure {
  readonly target: string;
  readonly error: unknown;
}

export function defaultModuleProjectRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configRoot = env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(configRoot, "jaeger", "runtime");
}

export async function runtimeModuleProjectDigest(
  configPath: string,
  configSource: string,
): Promise<string> {
  const root = path.dirname(configPath);
  const digest = createHash("sha256");
  digest.update("jaeger.runtime.mjs\0");
  digest.update(configSource);
  if (!await pathExists(path.join(root, MODULE_LOCK_FILE))) {
    return digest.digest("hex");
  }
  for (const relative of [
    "package.json",
    "npm-shrinkwrap.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    MODULE_LOCK_FILE,
  ]) {
    const target = path.join(root, relative);
    if (!await pathExists(target)) continue;
    await updateDigestFromRegularFile(digest, target, relative);
  }
  const modulesRoot = path.join(root, MODULE_DIRECTORY);
  if (await pathExists(modulesRoot)) {
    const modulesStat = await lstat(modulesRoot);
    if (!modulesStat.isDirectory() || modulesStat.isSymbolicLink()) {
      throw new Error(`Registry-managed module root is not a regular directory: ${modulesRoot}`);
    }
  }
  for (const relative of await listRelativeFiles(modulesRoot)) {
    await updateDigestFromRegularFile(
      digest,
      path.join(modulesRoot, ...relative.split("/")),
      `${MODULE_DIRECTORY}/${relative}`,
    );
  }
  return digest.digest("hex");
}

export async function resolveModuleItem(
  reference: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedModuleItem> {
  if (!reference.trim()) throw new Error("Module source reference must not be empty");
  const github = await existingLocalSource(reference)
    ? undefined
    : parseGithubReference(reference);
  let githubToken: string | undefined;
  let manifest: SourceDocument;
  if (
    /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(reference)
  ) {
    manifest = await resolveCatalogItem(await bundledRegistryPath(), reference);
  } else if (github) {
    githubToken = env.GITHUB_TOKEN || env.GH_TOKEN || undefined;
    const commit = await resolveGithubCommit(github.owner, github.repository, github.ref, env);
    const catalogUrl =
      `https://raw.githubusercontent.com/${encodeURIComponent(github.owner)}/` +
      `${encodeURIComponent(github.repository)}/${commit}/jaeger.registry.json`;
    manifest = await resolveCatalogItem(catalogUrl, github.item, githubToken);
  } else {
    const { locator, item } = splitCatalogReference(reference);
    const document = await readJsonDocument(normalizeLocator(locator));
    if (item) {
      manifest = await resolveCatalogDocumentItem(document, item);
    } else if (isRegistryCatalog(document.value)) {
      throw new Error(`Registry source requires an item fragment: ${reference}#ITEM`);
    } else {
      manifest = document;
    }
  }

  const item = parseModuleItem(manifest.value, manifest.locator);
  const files = new Map<string, Buffer>();
  let totalBytes = 0;
  for (const relative of item.files) {
    const locator = resolveRelativeLocator(manifest.locator, relative);
    const contents = await readSourceBytes(locator, githubToken);
    if (contents.byteLength > MAX_MODULE_FILE_BYTES) {
      throw new Error(`Module file exceeds ${MAX_MODULE_FILE_BYTES} bytes: ${relative}`);
    }
    totalBytes += contents.byteLength;
    if (totalBytes > MAX_MODULE_BYTES) {
      throw new Error(`Module ${item.name} exceeds ${MAX_MODULE_BYTES} total bytes`);
    }
    files.set(relative, contents);
  }
  return {
    item,
    reference,
    resolvedSource: manifest.locator,
    files,
    digest: hashModule(item, files),
  };
}

async function bundledRegistryPath(): Promise<string> {
  if (await pathExists(BUNDLED_REGISTRY_PATH)) return BUNDLED_REGISTRY_PATH;
  const testBuildFallback = path.resolve(
    MODULE_REGISTRY_CODE_DIRECTORY,
    "../../jaeger.registry.json",
  );
  if (await pathExists(testBuildFallback)) return testBuildFallback;
  throw new Error(`Bundled Jaeger module registry is missing: ${BUNDLED_REGISTRY_PATH}`);
}

export async function addModules(
  options: ModuleAddOptions,
): Promise<ModuleMutationResult> {
  const root = path.resolve(options.root);
  await assertSafeModuleProject(root, true);
  if (options.dryRun) return await addModulesUnlocked(options);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return await withModuleMutationLock(root, async () => {
    await recoverModuleTransactions(root);
    return await addModulesUnlocked(options);
  });
}

async function addModulesUnlocked(
  options: ModuleAddOptions,
): Promise<ModuleMutationResult> {
  if (options.references.length === 0) throw new Error("modules add requires a source");
  const root = path.resolve(options.root);
  await assertSafeModuleProject(root, true);
  const resolved = await Promise.all(
    options.references.map(async (reference) => await resolveModuleItem(reference, options.env)),
  );
  const names = resolved.map(({ item }) => item.name);
  assertUnique(names, "Module source list contains duplicate module");

  const project = await readPackageProject(root);
  const currentLock = await readModuleLock(root);
  const prepared = resolved.map(prepareModule);
  const nextModules: Record<string, InstalledModuleRecord> = {
    ...currentLock.modules,
  };
  for (const module of prepared) {
    const name = module.resolved.item.name;
    if (Object.hasOwn(nextModules, name) && !options.overwrite) {
      throw new Error(
        `Module ${name} is already installed; use --overwrite to replace it`,
      );
    }
    if (
      !options.overwrite &&
      await pathExists(path.join(root, MODULE_DIRECTORY, name))
    ) {
      throw new Error(
        `Module ${name} exists outside ${MODULE_LOCK_FILE}; use --overwrite to replace it`,
      );
    }
    setRecordValue(nextModules, name, module.record);
  }
  const reconciliation = reconcilePackageProject(project.value, currentLock, nextModules);
  const shouldInstall = options.install !== false;
  const result: ModuleMutationResult = {
    schemaVersion: 1,
    root,
    action: "add",
    modules: names,
    dependencies: reconciliation.dependencies,
    ...(shouldInstall
      ? { packageManager: await detectPackageManager(root, reconciliation.packageJson) }
      : {}),
    dependenciesInstalled: !options.dryRun && shouldInstall,
    dryRun: options.dryRun === true,
  };
  if (options.dryRun) return result;

  const staging = await mkdtemp(path.join(root, ".modules-stage-"));
  const snapshots = await snapshotPackageState(
    root,
    staging,
    shouldInstall,
    "add",
    await Promise.all(
      names.map(async (name) => ({
        name,
        existed: await pathExists(path.join(root, MODULE_DIRECTORY, name)),
      })),
    ),
  );
  const promoted: Array<{ readonly target: string; readonly backup?: string }> = [];
  let preserveStaging = false;
  try {
    for (const module of prepared) {
      await stageModule(staging, module.resolved);
    }
    await writeJsonAtomic(path.join(root, "package.json"), reconciliation.packageJson);
    if (shouldInstall) {
      await installProjectDependencies(root, reconciliation.packageJson, options.env);
    }
    await mkdir(path.join(root, MODULE_DIRECTORY), { recursive: true, mode: 0o700 });
    for (const module of prepared) {
      const name = module.resolved.item.name;
      const target = path.join(root, MODULE_DIRECTORY, name);
      const staged = path.join(staging, "new", name);
      let backup: string | undefined;
      if (await pathExists(target)) {
        if (!options.overwrite && !Object.hasOwn(currentLock.modules, name)) {
          throw new Error(
            `Module ${name} exists outside ${MODULE_LOCK_FILE}; use --overwrite to replace it`,
          );
        }
        backup = path.join(staging, "old", name);
        await mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
        await rename(target, backup);
      }
      promoted.push({ target, ...(backup ? { backup } : {}) });
      await rename(staged, target);
    }
    await writeModuleLock(root, {
      schemaVersion: 1,
      modules: sortRecord(nextModules),
      dependencies: reconciliation.dependencies,
    });
    await markModuleTransactionCommitted(staging);
  } catch (error) {
    const failures: RollbackFailure[] = [];
    for (const entry of promoted.reverse()) {
      await rollbackStep(failures, entry.target, async () => {
        await rm(entry.target, { recursive: true, force: true });
        if (entry.backup) await rename(entry.backup, entry.target);
      });
    }
    await restorePackageSnapshot(snapshots, failures);
    if (failures.length > 0) {
      preserveStaging = true;
      throw rollbackError(error, failures, staging);
    }
    throw error;
  } finally {
    if (!preserveStaging) {
      await rm(staging, { recursive: true, force: true });
    }
  }
  return result;
}

export async function removeModules(
  options: ModuleRemoveOptions,
): Promise<ModuleMutationResult> {
  const root = path.resolve(options.root);
  await assertSafeModuleProject(root, false);
  if (options.dryRun) return await removeModulesUnlocked(options);
  return await withModuleMutationLock(root, async () => {
    await recoverModuleTransactions(root);
    return await removeModulesUnlocked(options);
  });
}

async function removeModulesUnlocked(
  options: ModuleRemoveOptions,
): Promise<ModuleMutationResult> {
  if (options.names.length === 0) throw new Error("modules remove requires a module name");
  assertUnique(options.names, "Module removal list contains duplicate module");
  const root = path.resolve(options.root);
  await assertSafeModuleProject(root, false);
  const currentLock = await readModuleLock(root);
  for (const name of options.names) {
    if (!Object.hasOwn(currentLock.modules, name)) {
      throw new Error(`Module ${name} is not installed`);
    }
    const diff = await diffModule(root, name);
    if (!diff.clean && !options.force) {
      throw new Error(
        `Module ${name} has local changes; inspect with 'jaeger modules diff ${name}' or use --force`,
      );
    }
    if (
      !options.force &&
      await pathExists(path.join(root, RUNTIME_CONFIG_FILE))
    ) {
      throw new Error(
        `Cannot prove module ${name} is unused while ${RUNTIME_CONFIG_FILE} exists; remove it from the runtime configuration, then use --force`,
      );
    }
  }
  const nextModules: Record<string, InstalledModuleRecord> = {
    ...currentLock.modules,
  };
  for (const name of options.names) delete nextModules[name];
  const project = await readPackageProject(root);
  const reconciliation = reconcilePackageProject(project.value, currentLock, nextModules);
  const shouldInstall = reconciliation.changed && options.install !== false;
  const result: ModuleMutationResult = {
    schemaVersion: 1,
    root,
    action: "remove",
    modules: [...options.names],
    dependencies: reconciliation.dependencies,
    ...(shouldInstall
      ? { packageManager: await detectPackageManager(root, reconciliation.packageJson) }
      : {}),
    dependenciesInstalled: !options.dryRun && shouldInstall,
    dryRun: options.dryRun === true,
  };
  if (options.dryRun) return result;

  const staging = await mkdtemp(path.join(root, ".modules-remove-"));
  const snapshots = await snapshotPackageState(
    root,
    staging,
    shouldInstall,
    "remove",
    await Promise.all(
      options.names.map(async (name) => ({
        name,
        existed: await pathExists(path.join(root, MODULE_DIRECTORY, name)),
      })),
    ),
  );
  const removed: Array<{ readonly target: string; readonly backup: string }> = [];
  let preserveStaging = false;
  try {
    await writeJsonAtomic(path.join(root, "package.json"), reconciliation.packageJson);
    if (shouldInstall) {
      await installProjectDependencies(root, reconciliation.packageJson, options.env);
    }
    for (const name of options.names) {
      const target = path.join(root, MODULE_DIRECTORY, name);
      const backup = path.join(staging, name);
      try {
        await rename(target, backup);
      } catch (error) {
        if (options.force && hasCode(error, "ENOENT")) continue;
        throw error;
      }
      removed.push({ target, backup });
    }
    await writeModuleLock(root, {
      schemaVersion: 1,
      modules: sortRecord(nextModules),
      dependencies: reconciliation.dependencies,
    });
    await markModuleTransactionCommitted(staging);
  } catch (error) {
    const failures: RollbackFailure[] = [];
    for (const entry of removed.reverse()) {
      await rollbackStep(
        failures,
        entry.target,
        async () => await rename(entry.backup, entry.target),
      );
    }
    await restorePackageSnapshot(snapshots, failures);
    if (failures.length > 0) {
      preserveStaging = true;
      throw rollbackError(error, failures, staging);
    }
    throw error;
  } finally {
    if (!preserveStaging) {
      await rm(staging, { recursive: true, force: true });
    }
  }
  return result;
}

export async function syncModules(
  options: ModuleSyncOptions,
): Promise<ModuleMutationResult> {
  const root = path.resolve(options.root);
  await assertSafeModuleProject(root, true);
  if (options.dryRun) return await syncModulesUnlocked(options);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return await withModuleMutationLock(root, async () => {
    await recoverModuleTransactions(root);
    return await syncModulesUnlocked(options);
  });
}

async function syncModulesUnlocked(
  options: ModuleSyncOptions,
): Promise<ModuleMutationResult> {
  const root = path.resolve(options.root);
  await assertSafeModuleProject(root, true);
  const currentLock = await readModuleLock(root);
  const project = await readPackageProject(root);
  const reconciliation = reconcilePackageProject(
    project.value,
    currentLock,
    currentLock.modules,
  );
  const shouldInstall = options.install !== false;
  const result: ModuleMutationResult = {
    schemaVersion: 1,
    root,
    action: "sync",
    modules: Object.keys(currentLock.modules).sort(),
    dependencies: reconciliation.dependencies,
    ...(shouldInstall
      ? { packageManager: await detectPackageManager(root, reconciliation.packageJson) }
      : {}),
    dependenciesInstalled: !options.dryRun && shouldInstall,
    dryRun: options.dryRun === true,
  };
  if (options.dryRun) return result;
  const staging = await mkdtemp(path.join(root, ".modules-sync-"));
  const snapshots = await snapshotPackageState(
    root,
    staging,
    shouldInstall,
    "sync",
    [],
  );
  let preserveStaging = false;
  try {
    await writeJsonAtomic(path.join(root, "package.json"), reconciliation.packageJson);
    if (shouldInstall) {
      await installProjectDependencies(root, reconciliation.packageJson, options.env);
    }
    await writeModuleLock(root, {
      schemaVersion: 1,
      modules: currentLock.modules,
      dependencies: reconciliation.dependencies,
    });
    await markModuleTransactionCommitted(staging);
  } catch (error) {
    const failures: RollbackFailure[] = [];
    await restorePackageSnapshot(snapshots, failures);
    if (failures.length > 0) {
      preserveStaging = true;
      throw rollbackError(error, failures, staging);
    }
    throw error;
  } finally {
    if (!preserveStaging) {
      await rm(staging, { recursive: true, force: true });
    }
  }
  return result;
}

export async function listInstalledModules(
  rootInput: string,
): Promise<{
  readonly schemaVersion: 1;
  readonly root: string;
  readonly modules: readonly (InstalledModuleRecord & { readonly name: string })[];
  readonly dependencies: Readonly<Record<string, ManagedDependencyRecord>>;
}> {
  const root = path.resolve(rootInput);
  await assertSafeModuleProject(root, true);
  const lock = await readModuleLock(root);
  return {
    schemaVersion: 1,
    root,
    modules: Object.entries(lock.modules)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => ({ name, ...value })),
    dependencies: lock.dependencies,
  };
}

export async function diffModule(rootInput: string, name: string): Promise<ModuleDiff> {
  const root = path.resolve(rootInput);
  await assertSafeModuleProject(root, false);
  const lock = await readModuleLock(root);
  if (!Object.hasOwn(lock.modules, name)) {
    throw new Error(`Module ${name} is not installed`);
  }
  const installed = lock.modules[name]!;
  const moduleRoot = path.join(root, MODULE_DIRECTORY, name);
  const modified: string[] = [];
  const missing: string[] = [];
  for (const [relative, expected] of Object.entries(installed.files)) {
    const target = path.join(moduleRoot, ...relative.split("/"));
    try {
      const targetStat = await lstat(target);
      if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
        modified.push(relative);
        continue;
      }
      if (hashBytes(await readFile(target)) !== expected) modified.push(relative);
    } catch (error) {
      if (hasCode(error, "ENOENT")) missing.push(relative);
      else throw error;
    }
  }
  const present = await listRelativeFiles(moduleRoot);
  const tracked = new Set(Object.keys(installed.files));
  const added = present.filter((relative) => !tracked.has(relative));
  return {
    schemaVersion: 1,
    name,
    root,
    clean: modified.length === 0 && missing.length === 0 && added.length === 0,
    modified: modified.sort(),
    missing: missing.sort(),
    added: added.sort(),
  };
}

function prepareModule(resolved: ResolvedModuleItem): PreparedModule {
  const installedAt = new Date().toISOString();
  const files = Object.fromEntries(
    [
      ...resolved.files.entries(),
      [
        "jaeger.module.json",
        Buffer.from(`${JSON.stringify(resolved.item, null, 2)}\n`),
      ] as const,
    ]
      .map(([relative, contents]): [string, string] => [relative, hashBytes(contents)])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  return {
    resolved,
    record: {
      source: resolved.reference,
      resolvedSource: resolved.resolvedSource,
      digest: resolved.digest,
      installedAt,
      files,
      dependencies: sortRecord(resolved.item.dependencies),
    },
  };
}

function reconcilePackageProject(
  packageJsonInput: Record<string, unknown>,
  currentLock: ModuleProjectLock,
  modules: Readonly<Record<string, InstalledModuleRecord>>,
): PackageReconciliation {
  const packageJson = structuredClone(packageJsonInput);
  const rootDependencies = stringRecord(packageJson.dependencies, "package.json dependencies");
  const rootDevDependencies = stringRecord(
    packageJson.devDependencies,
    "package.json devDependencies",
  );
  const rootOptionalDependencies = stringRecord(
    packageJson.optionalDependencies,
    "package.json optionalDependencies",
  );
  const requested = new Map<string, Record<string, string>>();
  for (const [moduleName, module] of Object.entries(modules)) {
    for (const [dependency, range] of Object.entries(module.dependencies)) {
      if (
        Object.hasOwn(rootDevDependencies, dependency) &&
        !Object.hasOwn(rootDependencies, dependency)
      ) {
        throw new Error(
          `Runtime dependency ${dependency} is operator-owned in devDependencies; move it to dependencies before installing ${moduleName}`,
        );
      }
      if (Object.hasOwn(rootOptionalDependencies, dependency)) {
        throw new Error(
          `Runtime dependency ${dependency} is operator-owned in optionalDependencies; move it to dependencies before installing ${moduleName}`,
        );
      }
      const requesters = requested.get(dependency) ?? {};
      setRecordValue(requesters, moduleName, range);
      requested.set(dependency, requesters);
    }
  }

  const dependencies: Record<string, ManagedDependencyRecord> = {};
  const nextRootDependencies = { ...rootDependencies };
  const managedNames = new Set([
    ...Object.keys(currentLock.dependencies),
    ...requested.keys(),
  ]);
  for (const dependency of [...managedNames].sort()) {
    const previous = currentLock.dependencies[dependency];
    const currentRange = Object.hasOwn(rootDependencies, dependency)
      ? rootDependencies[dependency]
      : undefined;
    let operatorRange = previous?.operatorRange;
    if (previous) {
      if (currentRange !== previous.appliedRange) operatorRange = currentRange;
    } else if (currentRange !== undefined) {
      operatorRange = currentRange;
    }
    const requestedBy = sortRecord(requested.get(dependency) ?? {});
    const ranges = [
      ...(operatorRange ? [`operator:${operatorRange}`] : []),
      ...Object.entries(requestedBy).map(([name, range]) => `${name}:${range}`),
    ];
    if (Object.keys(requestedBy).length === 0) {
      if (operatorRange === undefined) delete nextRootDependencies[dependency];
      else setRecordValue(nextRootDependencies, dependency, operatorRange);
      continue;
    }
    const appliedRange = intersectDependencyRanges(dependency, ranges);
    setRecordValue(nextRootDependencies, dependency, appliedRange);
    setRecordValue(dependencies, dependency, {
      appliedRange,
      ...(operatorRange ? { operatorRange } : {}),
      requestedBy,
    });
  }
  packageJson.dependencies = sortRecord(nextRootDependencies);
  return {
    packageJson,
    dependencies,
    changed:
      JSON.stringify(sortRecord(rootDependencies)) !==
      JSON.stringify(sortRecord(nextRootDependencies)),
  };
}

function intersectDependencyRanges(
  dependency: string,
  labelledRanges: readonly string[],
): string {
  const parsed = labelledRanges.map((entry) => {
    const separator = entry.indexOf(":");
    const label = entry.slice(0, separator);
    const range = entry.slice(separator + 1);
    const normalized = validRange(range);
    return { label, range, normalized };
  });
  if (parsed.every(({ range }) => range === parsed[0]?.range)) {
    return parsed[0]?.range ?? "*";
  }
  if (parsed.some(({ normalized }) => normalized === null)) {
    throw new Error(
      `Dependency ${dependency} has incompatible non-semver requirements: ` +
        parsed.map(({ label, range }) => `${label}=${range}`).join(", "),
    );
  }
  let alternatives: string[][] = [[]];
  for (const entry of parsed) {
    const next: string[][] = [];
    for (const existing of alternatives) {
      for (const comparatorSet of new Range(entry.normalized ?? entry.range).set) {
        const candidate = [...existing, ...comparatorSet.map(String)].filter(Boolean);
        const text = candidate.join(" ") || "*";
        if (minVersion(text)) next.push(candidate);
      }
    }
    alternatives = next;
  }
  const unique = [
    ...new Set(alternatives.map((comparators) => comparators.join(" ").trim() || "*")),
  ];
  if (unique.length === 0) {
    throw new Error(
      `Dependency ${dependency} has incompatible requirements: ` +
        parsed.map(({ label, range }) => `${label}=${range}`).join(", "),
    );
  }
  return unique.join(" || ");
}

async function stageModule(staging: string, resolved: ResolvedModuleItem): Promise<void> {
  const root = path.join(staging, "new", resolved.item.name);
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const [relative, contents] of resolved.files) {
    const target = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, contents, { mode: 0o600 });
  }
  await writeJsonAtomic(path.join(root, "jaeger.module.json"), resolved.item);
}

async function readPackageProject(root: string): Promise<PackageProject> {
  const packagePath = path.join(root, "package.json");
  try {
    const value = parseJsonObject(await readFile(packagePath, "utf8"), packagePath);
    return { existed: true, value };
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    return {
      existed: false,
      value: {
        name: "jaeger-runtime",
        private: true,
        type: "module",
        dependencies: {},
      },
    };
  }
}

async function readModuleLock(root: string): Promise<ModuleProjectLock> {
  const lockPath = path.join(root, MODULE_LOCK_FILE);
  let value: Record<string, unknown>;
  try {
    value = parseJsonObject(await readFile(lockPath, "utf8"), lockPath);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return { schemaVersion: 1, modules: {}, dependencies: {} };
    }
    throw error;
  }
  if (value.schemaVersion !== 1) throw new Error(`Unsupported module lock: ${lockPath}`);
  assertOnlyKeys(value, ["schemaVersion", "modules", "dependencies"], `Module lock ${lockPath}`);
  const moduleValues = recordValue(value.modules, `${lockPath} modules`);
  const modules: Record<string, InstalledModuleRecord> = {};
  for (const [nameInput, entry] of Object.entries(moduleValues)) {
    const name = moduleName(nameInput, `${lockPath} module name`);
    const record = recordValue(entry, `${lockPath} module ${name}`);
    assertOnlyKeys(
      record,
      [
        "source",
        "resolvedSource",
        "digest",
        "installedAt",
        "files",
        "dependencies",
      ],
      `${lockPath} module ${name}`,
    );
    if (
      typeof record.source !== "string" ||
      !record.source ||
      typeof record.resolvedSource !== "string" ||
      !record.resolvedSource ||
      typeof record.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.digest) ||
      typeof record.installedAt !== "string" ||
      Number.isNaN(Date.parse(record.installedAt))
    ) {
      throw new Error(`Invalid installed module record in ${lockPath}: ${name}`);
    }
    const files = stringRecord(record.files, `${lockPath} module ${name} files`);
    for (const [relative, digest] of Object.entries(files)) {
      safeModuleRelativePath(relative, `${lockPath} module ${name} file`);
      if (!/^[a-f0-9]{64}$/.test(digest)) {
        throw new Error(`Invalid file digest in ${lockPath}: ${name}/${relative}`);
      }
    }
    const moduleDependencies = stringRecord(
      record.dependencies,
      `${lockPath} module ${name} dependencies`,
    );
    for (const dependency of Object.keys(moduleDependencies)) {
      if (!validPackageName(dependency)) {
        throw new Error(`Invalid dependency name in ${lockPath}: ${dependency}`);
      }
    }
    setRecordValue(modules, name, {
      source: record.source,
      resolvedSource: record.resolvedSource,
      digest: record.digest,
      installedAt: record.installedAt,
      files,
      dependencies: moduleDependencies,
    });
  }
  const dependencyValues = recordValue(value.dependencies, `${lockPath} dependencies`);
  const dependencies: Record<string, ManagedDependencyRecord> = {};
  for (const [name, entry] of Object.entries(dependencyValues)) {
    if (!validPackageName(name)) throw new Error(`Invalid dependency name in ${lockPath}: ${name}`);
    const record = recordValue(entry, `${lockPath} dependency ${name}`);
    assertOnlyKeys(
      record,
      ["appliedRange", "operatorRange", "requestedBy"],
      `${lockPath} dependency ${name}`,
    );
    if (
      typeof record.appliedRange !== "string" ||
      !record.appliedRange ||
      (record.operatorRange !== undefined &&
        (typeof record.operatorRange !== "string" || !record.operatorRange))
    ) {
      throw new Error(`Invalid dependency record in ${lockPath}: ${name}`);
    }
    const requestedBy = stringRecord(
      record.requestedBy,
      `${lockPath} dependency ${name} requestedBy`,
    );
    for (const requester of Object.keys(requestedBy)) {
      moduleName(requester, `${lockPath} dependency ${name} requester`);
    }
    setRecordValue(dependencies, name, {
      appliedRange: record.appliedRange,
      ...(typeof record.operatorRange === "string"
        ? { operatorRange: record.operatorRange }
        : {}),
      requestedBy,
    });
  }
  return {
    schemaVersion: 1,
    modules,
    dependencies,
  };
}

async function writeModuleLock(root: string, lock: ModuleProjectLock): Promise<void> {
  await writeJsonAtomic(path.join(root, MODULE_LOCK_FILE), lock);
}

async function installProjectDependencies(
  root: string,
  packageJson: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const manager = await detectPackageManager(root, packageJson);
  const modernYarn = manager === "yarn" && await usesModernYarn(root, packageJson);
  if (modernYarn) await assertYarnNodeModulesLinker(root);
  const args =
    manager === "pnpm"
      ? ["install", "--ignore-scripts"]
      : manager === "yarn"
        ? modernYarn
          ? ["install", "--mode=skip-build"]
          : ["install", "--ignore-scripts"]
        : ["install", "--ignore-scripts", "--no-audit", "--no-fund"];
  try {
    await execFileAsync(manager, args, {
      cwd: root,
      env,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `Shared runtime dependency installation failed: ${manager} ${args.join(" ")}`,
      { cause: error },
    );
  }
}

async function detectPackageManager(
  root: string,
  packageJson: Record<string, unknown>,
): Promise<"npm" | "pnpm" | "yarn"> {
  const declared = packageJson.packageManager;
  if (typeof declared === "string") {
    const name = declared.split("@", 1)[0];
    if (name === "npm" || name === "pnpm" || name === "yarn") return name;
    throw new Error(`Unsupported runtime package manager: ${declared}`);
  }
  if (await pathExists(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (
    await pathExists(path.join(root, "yarn.lock")) ||
    await pathExists(path.join(root, ".yarnrc.yml"))
  ) {
    return "yarn";
  }
  return "npm";
}

async function usesModernYarn(
  root: string,
  packageJson: Record<string, unknown>,
): Promise<boolean> {
  if (await pathExists(path.join(root, ".yarnrc.yml"))) return true;
  const declared = packageJson.packageManager;
  if (typeof declared !== "string") return false;
  const match = /^yarn@(\d+)(?:[.+-]|$)/.exec(declared);
  return match ? Number(match[1]) >= 2 : false;
}

async function assertYarnNodeModulesLinker(root: string): Promise<void> {
  const configPath = path.join(root, ".yarnrc.yml");
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      throw new Error(
        "Yarn Modern runtime module projects must set nodeLinker: node-modules in .yarnrc.yml; " +
          "Jaeger starts runtime modules with raw Node and cannot load Yarn Plug'n'Play dependencies",
      );
    }
    throw error;
  }
  const match = /^nodeLinker\s*:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))\s*(?:#.*)?$/m.exec(source);
  const linker = match?.[1] ?? match?.[2] ?? match?.[3];
  if (linker !== "node-modules") {
    throw new Error(
      `Yarn Modern runtime module projects require nodeLinker: node-modules in ${configPath}; ` +
        "Jaeger starts runtime modules with raw Node and cannot load Yarn Plug'n'Play dependencies",
    );
  }
}

async function resolveCatalogItem(
  locator: string,
  item: string,
  githubToken?: string,
): Promise<SourceDocument> {
  return await resolveCatalogDocumentItem(
    await readJsonDocument(locator, githubToken),
    item,
    githubToken,
  );
}

async function resolveCatalogDocumentItem(
  document: SourceDocument,
  itemName: string,
  githubToken?: string,
): Promise<SourceDocument> {
  const catalog = parseRegistryCatalog(document.value, document.locator);
  const item = catalog.items.find((candidate) => candidate.name === itemName);
  if (!item) throw new Error(`Registry ${catalog.name} does not contain module ${itemName}`);
  return await readJsonDocument(
    resolveCatalogRelativeLocator(document.locator, item.path),
    githubToken,
  );
}

function parseModuleItem(value: unknown, locator: string): ModuleRegistryItem {
  const root = recordValue(value, `Module item ${locator}`);
  assertOnlyKeys(
    root,
    [
      "$schema",
      "schemaVersion",
      "name",
      "title",
      "description",
      "files",
      "dependencies",
      "requires",
      "configuration",
      "declaredAccess",
      "commands",
    ],
    `Module item ${locator}`,
  );
  validateSchemaReference(root, `Module item ${locator}`);
  if (root.schemaVersion !== 1) throw new Error(`Unsupported module item schema: ${locator}`);
  const name = moduleName(root.name, `Module item ${locator} name`);
  if (!Array.isArray(root.files) || root.files.length === 0) {
    throw new Error(`Module item ${locator} requires at least one file`);
  }
  const files = root.files.map((value, index) =>
    safeModuleRelativePath(value, `Module item ${locator} file ${index}`),
  );
  assertUnique(files, `Module item ${locator} contains duplicate file`);
  const reserved = files.find((file) => {
    const segments = file.split("/");
    const basename = segments.at(-1);
    return (
      file === "jaeger.module.json" ||
      segments.includes("node_modules") ||
      basename === "package.json" ||
      basename === "package-lock.json" ||
      basename === "pnpm-lock.yaml" ||
      basename === "yarn.lock" ||
      basename === ".env"
    );
  });
  if (reserved) {
    throw new Error(`Module item ${locator} includes reserved package or secret path: ${reserved}`);
  }
  if (root.dependencies === undefined) {
    throw new Error(`Module item ${locator} requires dependencies`);
  }
  const dependencies = stringRecord(root.dependencies, `Module item ${locator} dependencies`);
  for (const [dependency, range] of Object.entries(dependencies)) {
    if (!validPackageName(dependency) || !range.trim()) {
      throw new Error(`Invalid dependency in module item ${locator}: ${dependency}`);
    }
  }
  const title = strictOptionalString(root, "title", `Module item ${locator}`);
  const description = strictOptionalString(root, "description", `Module item ${locator}`);
  const item: ModuleRegistryItem = {
    schemaVersion: 1,
    name,
    files,
    dependencies: sortRecord(dependencies),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(root.requires !== undefined
      ? { requires: stringRecord(root.requires, `Module item ${locator} requires`) }
      : {}),
    ...(root.configuration !== undefined
      ? { configuration: parseConfiguration(root.configuration, locator) }
      : {}),
    ...(root.declaredAccess !== undefined
      ? { declaredAccess: stringArrayRecord(root.declaredAccess, locator) }
      : {}),
    ...(root.commands !== undefined
      ? { commands: stringRecord(root.commands, `Module item ${locator} commands`) }
      : {}),
  };
  return item;
}

function parseRegistryCatalog(value: unknown, locator: string): RegistryCatalog {
  const root = recordValue(value, `Registry ${locator}`);
  assertOnlyKeys(
    root,
    ["$schema", "schemaVersion", "name", "homepage", "items"],
    `Registry ${locator}`,
  );
  validateSchemaReference(root, `Registry ${locator}`);
  if (root.schemaVersion !== 1) throw new Error(`Unsupported registry schema: ${locator}`);
  const name = optionalString(root.name);
  if (!name || !Array.isArray(root.items)) throw new Error(`Invalid registry: ${locator}`);
  strictOptionalString(root, "homepage", `Registry ${locator}`);
  const items = root.items.map((value, index) => {
    const record = recordValue(value, `Registry ${locator} item ${index}`);
    assertOnlyKeys(record, ["name", "path"], `Registry ${locator} item ${index}`);
    return {
      name: moduleName(record.name, `Registry ${locator} item ${index} name`),
      path: safeCatalogRelativePath(record.path, `Registry ${locator} item ${index} path`),
    };
  });
  assertUnique(items.map((item) => item.name), `Registry ${locator} contains duplicate item`);
  return { schemaVersion: 1, name, items };
}

function isRegistryCatalog(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray((value as Record<string, unknown>).items)
  );
}

function parseConfiguration(value: unknown, locator: string): ModuleConfigurationRequirement[] {
  if (!Array.isArray(value)) throw new Error(`Invalid module configuration in ${locator}`);
  const result = value.map((entry, index) => {
    const record = recordValue(entry, `Module item ${locator} configuration ${index}`);
    assertOnlyKeys(
      record,
      ["name", "required", "secret", "description"],
      `Module item ${locator} configuration ${index}`,
    );
    const name = optionalString(record.name);
    if (!name) throw new Error(`Invalid module configuration name in ${locator}`);
    if (record.required !== undefined && typeof record.required !== "boolean") {
      throw new Error(`Invalid module configuration required flag in ${locator}: ${name}`);
    }
    if (record.secret !== undefined && typeof record.secret !== "boolean") {
      throw new Error(`Invalid module configuration secret flag in ${locator}: ${name}`);
    }
    const description = strictOptionalString(
      record,
      "description",
      `Module item ${locator} configuration ${name}`,
    );
    return {
      name,
      ...(typeof record.required === "boolean" ? { required: record.required } : {}),
      ...(typeof record.secret === "boolean" ? { secret: record.secret } : {}),
      ...(description ? { description } : {}),
    };
  });
  assertUnique(result.map(({ name }) => name), `Module item ${locator} contains duplicate configuration`);
  return result;
}

function stringArrayRecord(value: unknown, locator: string): Record<string, readonly string[]> {
  const record = recordValue(value, `Module item ${locator} declaredAccess`);
  const result: Record<string, readonly string[]> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (!Array.isArray(entry) || entry.some((item) => typeof item !== "string")) {
      throw new Error(`Invalid declaredAccess ${key} in ${locator}`);
    }
    result[key] = entry as string[];
  }
  return result;
}

function splitCatalogReference(reference: string): { locator: string; item?: string } {
  const hash = reference.lastIndexOf("#");
  if (hash <= 0) return { locator: reference };
  const locator = reference.slice(0, hash);
  const item = reference.slice(hash + 1);
  if (!item) return { locator };
  return { locator, item };
}

function parseGithubReference(
  reference: string,
): { owner: string; repository: string; item: string; ref: string } | undefined {
  if (
    reference.startsWith(".") ||
    reference.startsWith("/") ||
    /^[a-z]+:/i.test(reference)
  ) {
    return undefined;
  }
  const match = /^([^/]+)\/([^/]+)\/([^/#]+)(?:#(.+))?$/.exec(reference);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return {
    owner: match[1],
    repository: match[2],
    item: match[3],
    ref: match[4] ?? "main",
  };
}

async function resolveGithubCommit(
  owner: string,
  repository: string,
  ref: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  if (/^[a-f0-9]{40}$/i.test(ref)) return ref.toLowerCase();
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/commits/${encodeURIComponent(ref)}`,
    {
      signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "jaeger-module-registry",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    },
  );
  if (!response.ok) {
    throw new Error(
      `Unable to resolve GitHub module source ${owner}/${repository}#${ref}: HTTP ${response.status}`,
    );
  }
  const value = recordValue(await response.json(), "GitHub commit response");
  if (typeof value.sha !== "string" || !/^[a-f0-9]{40}$/i.test(value.sha)) {
    throw new Error(`GitHub returned an invalid commit for ${owner}/${repository}#${ref}`);
  }
  return value.sha.toLowerCase();
}

function normalizeLocator(locator: string): string {
  if (/^https:\/\//i.test(locator)) return new URL(locator).toString();
  if (/^http:\/\//i.test(locator)) {
    throw new Error(`Remote module sources require HTTPS: ${locator}`);
  }
  if (locator.startsWith("file:")) return path.resolve(fileURLToPath(locator));
  return path.resolve(locator);
}

function resolveRelativeLocator(base: string, relativeInput: string): string {
  const relative = safeModuleRelativePath(relativeInput, "Module source path");
  if (/^https:\/\//i.test(base)) {
    return resolveContainedRemoteLocator(base, relative, "Module source path");
  }
  return path.resolve(path.dirname(base), ...relative.split("/"));
}

function resolveCatalogRelativeLocator(base: string, relativeInput: string): string {
  const relative = safeCatalogRelativePath(relativeInput, "Registry item path");
  if (/^https:\/\//i.test(base)) {
    return resolveContainedRemoteLocator(base, relative, "Registry item path");
  }
  return path.resolve(path.dirname(base), ...relative.split("/"));
}

function resolveContainedRemoteLocator(
  base: string,
  relative: string,
  label: string,
): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(relative);
  } catch (error) {
    throw new Error(`${label} contains invalid percent encoding: ${relative}`, {
      cause: error,
    });
  }
  safeModuleRelativePath(decoded, label);
  const baseDirectory = new URL(".", base);
  const resolved = new URL(relative, base);
  if (
    resolved.origin !== baseDirectory.origin ||
    !resolved.pathname.startsWith(baseDirectory.pathname)
  ) {
    throw new Error(`${label} escapes its remote registry: ${relative}`);
  }
  return resolved.toString();
}

async function readJsonDocument(
  locator: string,
  githubToken?: string,
): Promise<SourceDocument> {
  let contents: Buffer;
  let resolvedLocator = locator;
  if (/^https:\/\//i.test(locator)) {
    const fetched = await fetchHttps(locator, githubToken);
    contents = await readRemoteSourceBytes(fetched.response, locator);
    resolvedLocator = fetched.locator;
  } else {
    contents = await readSourceBytes(locator, githubToken);
  }
  try {
    return {
      locator: resolvedLocator,
      value: JSON.parse(contents.toString("utf8")) as unknown,
    };
  } catch (error) {
    throw new Error(`Invalid JSON module source: ${locator}`, { cause: error });
  }
}

async function readSourceBytes(locator: string, githubToken?: string): Promise<Buffer> {
  if (/^https:\/\//i.test(locator)) {
    const fetched = await fetchHttps(locator, githubToken);
    return await readRemoteSourceBytes(fetched.response, locator);
  }
  await assertNoSymlinkComponents(locator);
  const targetStat = await lstat(locator);
  if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
    throw new Error(`Module source is not a regular file: ${locator}`);
  }
  const contents = await readFile(locator);
  if (contents.byteLength > MAX_MODULE_FILE_BYTES) {
    throw new Error(`Module source is too large: ${locator}`);
  }
  return contents;
}

async function readRemoteSourceBytes(response: Response, locator: string): Promise<Buffer> {
  if (!response.ok) throw new Error(`Unable to fetch module source ${locator}: HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_MODULE_FILE_BYTES) throw new Error(`Remote module source is too large: ${locator}`);
  return await readLimitedResponseBody(response, locator);
}

async function readLimitedResponseBody(response: Response, locator: string): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_MODULE_FILE_BYTES) {
        await reader.cancel();
        throw new Error(`Remote module source is too large: ${locator}`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

async function assertNoSymlinkComponents(locator: string): Promise<void> {
  const resolved = path.resolve(locator);
  const root = path.parse(resolved).root;
  let current = root;
  for (const component of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error(`Module source path contains a symlink: ${locator}`);
    }
  }
}

async function fetchHttps(
  locator: string,
  githubToken?: string,
): Promise<{ response: Response; locator: string }> {
  let current = new URL(locator);
  for (let redirects = 0; redirects <= 10; redirects += 1) {
    if (current.protocol !== "https:") {
      throw new Error(`Remote module sources require HTTPS: ${current.toString()}`);
    }
    const response = await fetch(current, {
      headers: {
        "User-Agent": "jaeger-module-registry",
        ...(githubToken && current.hostname === "raw.githubusercontent.com"
          ? { Authorization: `Bearer ${githubToken}` }
          : {}),
      },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, locator: current.toString() };
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`Module source redirect is missing a location: ${current.toString()}`);
    }
    current = new URL(location, current);
  }
  throw new Error(`Module source has too many redirects: ${locator}`);
}

function hashModule(item: ModuleRegistryItem, files: ReadonlyMap<string, Buffer>): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(item));
  for (const [relative, contents] of [...files.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    hash.update("\0");
    hash.update(relative);
    hash.update("\0");
    hash.update(contents);
  }
  return hash.digest("hex");
}

function hashBytes(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function safeModuleRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0")) {
    throw new Error(`${label} must be a portable relative path`);
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    path.posix.isAbsolute(normalized) ||
    normalized !== value
  ) {
    throw new Error(`${label} escapes or is not normalized: ${value}`);
  }
  return normalized;
}

function safeCatalogRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0")) {
    throw new Error(`${label} must be a portable relative path`);
  }
  const normalized = path.posix.normalize(value);
  if (path.posix.isAbsolute(normalized) || normalized !== value) {
    throw new Error(`${label} must be normalized and relative: ${value}`);
  }
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`${label} escapes its registry: ${value}`);
  }
  return normalized;
}

function moduleName(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(value)
  ) {
    throw new Error(`${label} must be a lowercase portable module name`);
  }
  return value;
}

function validPackageName(value: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function strictOptionalString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): string | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  const parsed = optionalString(candidate);
  if (!parsed) throw new Error(`${label} ${key} must be a non-empty string`);
  return parsed;
}

function validateSchemaReference(
  value: Readonly<Record<string, unknown>>,
  label: string,
): void {
  if (value.$schema !== undefined && typeof value.$schema !== "string") {
    throw new Error(`${label} $schema must be a string`);
  }
}

function parseJsonObject(contents: string, label: string): Record<string, unknown> {
  try {
    return recordValue(JSON.parse(contents) as unknown, label);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON: ${label}`, { cause: error });
    throw error;
  }
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  const record = recordValue(value, label);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`${label} values must be non-empty strings`);
    }
    setRecordValue(result, key, entry);
  }
  return result;
}

function sortRecord<T>(value: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function setRecordValue<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${label}: ${value}`);
    seen.add(value);
  }
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown) throw new Error(`${label} contains unknown field: ${unknown}`);
}

async function existingLocalSource(reference: string): Promise<boolean> {
  const { locator } = splitCatalogReference(reference);
  if (/^[a-z]+:/i.test(locator)) return false;
  return await pathExists(path.resolve(locator));
}

async function listRelativeFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      throw error;
    }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target, relative);
      else result.push(relative);
    }
  }
  await visit(root, "");
  return result.sort();
}

async function updateDigestFromRegularFile(
  digest: ReturnType<typeof createHash>,
  target: string,
  label: string,
): Promise<void> {
  const targetStat = await lstat(target);
  if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
    throw new Error(`Registry-managed runtime project contains a non-regular file: ${target}`);
  }
  digest.update("\0");
  digest.update(label);
  digest.update("\0");
  digest.update(await readFile(target));
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  await chmod(target, 0o600);
}

async function withModuleMutationLock<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = path.join(root, MODULE_MUTATION_LOCK_FILE);
  let lease;
  try {
    lease = await acquireProcessLease(lockPath, { waitMs: 30_000 });
  } catch (error) {
    if (error instanceof ProcessLeaseBusyError) {
      throw new Error(`Another Jaeger module mutation holds ${lockPath}`, {
        cause: error,
      });
    }
    throw error;
  }
  try {
    return await operation();
  } finally {
    await releaseProcessLease(lockPath, lease);
  }
}

async function snapshotPackageState(
  root: string,
  staging: string,
  snapshotInstalledState: boolean,
  action: ModuleTransaction["action"],
  modules: ModuleTransaction["modules"],
): Promise<PackageSnapshot> {
  const fileNames = [
    "package.json",
    "npm-shrinkwrap.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    ".pnp.cjs",
    ".pnp.loader.mjs",
    ".yarn/build-state.yml",
    ".yarn/install-state.gz",
    MODULE_LOCK_FILE,
  ] as const;
  const files: FileSnapshot[] = [];
  for (const [index, name] of fileNames.entries()) {
    const target = path.join(root, name);
    try {
      const targetStat = await stat(target);
      const backup = path.join(staging, "package-files", String(index));
      await mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
      await writeFile(backup, await readFile(target), { mode: 0o600 });
      files.push({
        path: target,
        backup,
        mode: targetStat.mode & 0o777,
      });
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        files.push({ path: target });
        continue;
      }
      throw error;
    }
  }
  const directoryNames = snapshotInstalledState
    ? ["node_modules", ".yarn/cache", ".yarn/unplugged"] as const
    : [];
  const directories: DirectorySnapshot[] = [];
  const directoryStates: ModuleTransaction["directories"][number][] = [];
  for (const name of directoryNames) {
    const target = path.join(root, name);
    directoryStates.push({ name, existed: await pathExists(target) });
  }
  await writeJsonAtomic(path.join(staging, MODULE_TRANSACTION_FILE), {
    schemaVersion: 1,
    phase: "active",
    action,
    modules,
    files: fileNames.map((name, index) => ({
      name,
      existed: files[index]?.backup !== undefined,
      ...(files[index]?.mode === undefined ? {} : { mode: files[index].mode }),
    })),
    directories: directoryStates,
  } satisfies ModuleTransaction);

  if (!snapshotInstalledState) return { files, directories };
  try {
    for (
      const [index, name] of [
        "node_modules",
        ".yarn/cache",
        ".yarn/unplugged",
      ].entries()
    ) {
      const target = path.join(root, name);
      if (!await pathExists(target)) {
        directories.push({ path: target });
        continue;
      }
      const backup = path.join(staging, "package-state", String(index));
      await mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
      if (name === ".yarn/cache") {
        const copyTarget = `${backup}.copy-${randomUUID()}`;
        await cp(target, copyTarget, { recursive: true, preserveTimestamps: true });
        await rename(copyTarget, backup);
      } else {
        await rename(target, backup);
      }
      directories.push({ path: target, backup });
    }
    return { files, directories };
  } catch (error) {
    await restoreDirectorySnapshots(directories);
    throw error;
  }
}

async function restoreFileSnapshot(snapshot: FileSnapshot): Promise<void> {
  if (snapshot.backup === undefined) {
    await rm(snapshot.path, { force: true });
    return;
  }
  // A failed install can delete the parent directory of a nested snapshot such
  // as .yarn/install-state.gz, so recreate it before writing the contents back.
  await mkdir(path.dirname(snapshot.path), { recursive: true, mode: 0o700 });
  const temporary = `${snapshot.path}.restore-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, await readFile(snapshot.backup), {
    mode: snapshot.mode ?? 0o600,
    flag: "wx",
  });
  await rename(temporary, snapshot.path);
  await chmod(snapshot.path, snapshot.mode ?? 0o600);
}

async function restorePackageSnapshot(
  snapshot: PackageSnapshot,
  failures: RollbackFailure[],
): Promise<void> {
  for (const file of snapshot.files) {
    await rollbackStep(failures, file.path, async () => await restoreFileSnapshot(file));
  }
  for (const directory of [...snapshot.directories].reverse()) {
    await rollbackStep(
      failures,
      directory.path,
      async () => await restoreDirectorySnapshot(directory),
    );
  }
}

async function restoreDirectorySnapshot(snapshot: DirectorySnapshot): Promise<void> {
  await rm(snapshot.path, { recursive: true, force: true });
  if (!snapshot.backup) return;
  await mkdir(path.dirname(snapshot.path), { recursive: true, mode: 0o700 });
  await rename(snapshot.backup, snapshot.path);
}

async function restoreDirectorySnapshots(
  snapshots: readonly DirectorySnapshot[],
): Promise<void> {
  for (const snapshot of [...snapshots].reverse()) {
    await restoreDirectorySnapshot(snapshot);
  }
}

async function rollbackStep(
  failures: RollbackFailure[],
  target: string,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    failures.push({ target, error });
  }
}

function rollbackError(
  originalError: unknown,
  failures: readonly RollbackFailure[],
  staging: string,
): AggregateError {
  const targets = failures.map(({ target }) => target).join(", ");
  return new AggregateError(
    [originalError, ...failures.map(({ error }) => error)],
    `Module mutation failed and rollback was incomplete for ${targets}; recovery data was preserved at ${staging}`,
  );
}

async function markModuleTransactionCommitted(staging: string): Promise<void> {
  const transaction = await readModuleTransaction(staging);
  await writeJsonAtomic(path.join(staging, MODULE_TRANSACTION_FILE), {
    ...transaction,
    phase: "committed",
  } satisfies ModuleTransaction);
}

async function recoverModuleTransactions(root: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  for (const entry of entries) {
    if (!MODULE_TRANSACTION_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) {
      continue;
    }
    const staging = path.join(root, entry.name);
    const stagingStat = await lstat(staging);
    if (!entry.isDirectory() || stagingStat.isSymbolicLink()) {
      throw new Error(`Unsafe module transaction path requires operator recovery: ${staging}`);
    }
    let transaction: ModuleTransaction;
    try {
      transaction = await readModuleTransaction(staging);
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        // The journal is published before any project state is moved. A stage
        // without one is therefore an interrupted preparation only.
        await rm(staging, { recursive: true, force: true });
        continue;
      }
      throw error;
    }
    if (transaction.phase === "committed") {
      await rm(staging, { recursive: true, force: true });
      continue;
    }
    await recoverModuleSourceMutation(root, staging, transaction);
    await recoverPackageSnapshot(root, staging, transaction);
    await rm(staging, { recursive: true, force: true });
  }
}

async function recoverModuleSourceMutation(
  root: string,
  staging: string,
  transaction: ModuleTransaction,
): Promise<void> {
  for (const module of [...transaction.modules].reverse()) {
    const target = path.join(root, MODULE_DIRECTORY, module.name);
    if (transaction.action === "add") {
      const backup = path.join(staging, "old", module.name);
      if (await pathExists(backup)) {
        await rm(target, { recursive: true, force: true });
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await rename(backup, target);
      } else if (!module.existed) {
        const staged = path.join(staging, "new", module.name);
        if (!await pathExists(staged)) {
          await rm(target, { recursive: true, force: true });
        }
      }
      continue;
    }
    if (transaction.action === "remove") {
      const backup = path.join(staging, module.name);
      if (await pathExists(backup)) {
        await rm(target, { recursive: true, force: true });
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await rename(backup, target);
      }
    }
  }
}

async function recoverPackageSnapshot(
  root: string,
  staging: string,
  transaction: ModuleTransaction,
): Promise<void> {
  for (const [index, file] of transaction.files.entries()) {
    await restoreFileSnapshot({
      path: path.join(root, file.name),
      ...(file.existed
        ? { backup: path.join(staging, "package-files", String(index)) }
        : {}),
      ...(file.mode === undefined ? {} : { mode: file.mode }),
    });
  }
  for (let index = transaction.directories.length - 1; index >= 0; index -= 1) {
    const directory = transaction.directories[index]!;
    const target = path.join(root, directory.name);
    const backup = path.join(staging, "package-state", String(index));
    if (await pathExists(backup)) {
      await restoreDirectorySnapshot({ path: target, backup });
    } else if (!directory.existed) {
      await restoreDirectorySnapshot({ path: target });
    }
  }
}

async function readModuleTransaction(staging: string): Promise<ModuleTransaction> {
  const value = recordValue(
    JSON.parse(await readFile(path.join(staging, MODULE_TRANSACTION_FILE), "utf8")),
    "module transaction",
  );
  if (
    value.schemaVersion !== 1 ||
    !["active", "committed"].includes(String(value.phase)) ||
    !["add", "remove", "sync"].includes(String(value.action)) ||
    !Array.isArray(value.modules) ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.directories)
  ) {
    throw new Error(`Invalid module transaction journal: ${staging}`);
  }
  const modules = value.modules.map((entry, index) => {
    const item = recordValue(entry, `module transaction module ${index}`);
    if (typeof item.existed !== "boolean") {
      throw new Error(`Invalid module transaction module ${index}: ${staging}`);
    }
    return {
      name: moduleName(item.name, `module transaction module ${index}`),
      existed: item.existed,
    };
  });
  const allowedFiles = new Set([
    "package.json",
    "npm-shrinkwrap.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    ".pnp.cjs",
    ".pnp.loader.mjs",
    ".yarn/build-state.yml",
    ".yarn/install-state.gz",
    MODULE_LOCK_FILE,
  ]);
  const files = value.files.map((entry, index) => {
    const item = recordValue(entry, `module transaction file ${index}`);
    if (
      typeof item.name !== "string" ||
      !allowedFiles.has(item.name) ||
      typeof item.existed !== "boolean" ||
      (item.mode !== undefined &&
        (typeof item.mode !== "number" ||
          !Number.isInteger(item.mode) ||
          item.mode < 0 ||
          item.mode > 0o777))
    ) {
      throw new Error(`Invalid module transaction file ${index}: ${staging}`);
    }
    return {
      name: item.name,
      existed: item.existed,
      ...(item.mode === undefined ? {} : { mode: Number(item.mode) }),
    };
  });
  const allowedDirectories = new Set([
    "node_modules",
    ".yarn/cache",
    ".yarn/unplugged",
  ]);
  const directories = value.directories.map((entry, index) => {
    const item = recordValue(entry, `module transaction directory ${index}`);
    if (
      typeof item.name !== "string" ||
      !allowedDirectories.has(item.name) ||
      typeof item.existed !== "boolean"
    ) {
      throw new Error(`Invalid module transaction directory ${index}: ${staging}`);
    }
    return { name: item.name, existed: item.existed };
  });
  assertUnique(modules.map(({ name }) => name), "Module transaction contains duplicate module");
  assertUnique(files.map(({ name }) => name), "Module transaction contains duplicate file");
  assertUnique(
    directories.map(({ name }) => name),
    "Module transaction contains duplicate directory",
  );
  return {
    schemaVersion: 1,
    phase: value.phase as ModuleTransaction["phase"],
    action: value.action as ModuleTransaction["action"],
    modules,
    files,
    directories,
  };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function assertSafeModuleProject(
  root: string,
  allowMissing: boolean,
): Promise<void> {
  if (path.dirname(root) === root) {
    throw new Error(`Jaeger module project must not be a filesystem root: ${root}`);
  }
  let ancestor = root;
  while (true) {
    try {
      const ancestorStat = await lstat(ancestor);
      if (ancestorStat.isSymbolicLink()) {
        throw new Error(`Jaeger module project path has a symlinked ancestor: ${ancestor}`);
      }
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(`Jaeger module project root is not a regular directory: ${root}`);
    }
  } catch (error) {
    if (allowMissing && hasCode(error, "ENOENT")) return;
    throw error;
  }
  for (const relative of [
    MODULE_DIRECTORY,
    ".yarn",
    ".yarn/cache",
    ".yarn/unplugged",
    "package.json",
    "npm-shrinkwrap.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    ".yarnrc.yml",
    ".pnp.cjs",
    ".pnp.loader.mjs",
    ".yarn/build-state.yml",
    ".yarn/install-state.gz",
    MODULE_LOCK_FILE,
    MODULE_MUTATION_LOCK_FILE,
  ]) {
    const target = path.join(root, relative);
    try {
      const targetStat = await lstat(target);
      const valid =
        relative === MODULE_DIRECTORY ||
        relative === ".yarn" ||
        relative === ".yarn/cache" ||
        relative === ".yarn/unplugged" ||
        relative === MODULE_MUTATION_LOCK_FILE
          ? targetStat.isDirectory() && !targetStat.isSymbolicLink()
          : targetStat.isFile() && !targetStat.isSymbolicLink();
      if (!valid) {
        throw new Error(`Jaeger module project contains an unsafe path: ${target}`);
      }
    } catch (error) {
      if (hasCode(error, "ENOENT")) continue;
      throw error;
    }
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
