export { compileWorkflowSource } from "./compiler.js";
export {
  addModules,
  defaultModuleProjectRoot,
  diffModule,
  listInstalledModules,
  removeModules,
  resolveModuleItem,
  runtimeModuleProjectDigest,
  syncModules,
  type InstalledModuleRecord,
  type ManagedDependencyRecord,
  type ModuleAddOptions,
  type ModuleDiff,
  type ModuleMutationResult,
  type ModuleProjectLock,
  type ModuleRegistryItem,
  type ModuleRemoveOptions,
  type ModuleSyncOptions,
  type ResolvedModuleItem,
} from "./module-registry.js";
export {
  HostRuntimeBoundary,
  hostRuntimeBoundary,
} from "./boundary.js";
export { doctor } from "./doctor.js";
export {
  collectStatus,
  renderStatus,
  type JaegerStatus,
} from "./status.js";
export {
  activeEnvironment,
  applyEnvironment,
  createNativePackageManager,
  createNativePluginManager,
  defaultEnvironmentPaths,
  inspectEnvironmentStatus,
  listEnvironments,
  loadEnvironmentPlan,
  uninstallEnvironment,
} from "./environments.js";
export {
  HarnessExecutionError,
  JaegerError,
  JournalCorruptionError,
  RunOwnedError,
  RunStoppedError,
  RunTerminalError,
  StructuredOutputError,
  UncertainAgentRunError,
  WorkflowChangedError,
  WorkflowCompileError,
} from "./errors.js";
export {
  ClaudeHarness,
  CodexHarness,
  PiHarness,
  defaultHarnesses,
} from "./harnesses/index.js";
export {
  builtinHarnessDefinitions,
  harnessDefinitionsForRun,
  harnessesFromDefinitions,
  loadHarnessDefinitions,
  validateHarnessDefinitions,
  validateHarnessName,
} from "./harnesses/registry.js";
export { launchDetachedRun, stopRun, waitForRun } from "./lifecycle.js";
export {
  EmbeddedRuntimeClient,
  ServiceRuntimeClient,
  type RuntimeClient,
} from "./runtime-client.js";
export { SshRuntimeClient } from "./ssh-runtime-client.js";
export {
  loadRuntimeRegistry,
  provisionalSshRuntimeTarget,
  resolveRuntimeTarget,
  runtimeRegistryPath,
  saveRuntimeTarget,
  setDefaultRuntimeTarget,
  type RuntimeRegistry,
  type RuntimeTarget,
  type SshRuntimeTarget,
} from "./runtime-targets.js";
export {
  assertLocalRuntimeSupported,
  supportsLocalRuntime,
} from "./platform.js";
export {
  LocalRuntimeService,
  type LocalRuntimeServiceOptions,
} from "./local-runtime-service.js";
export {
  BACKEND_PROTOCOL_VERSION,
  BackendRpcError,
  type BackendMethod,
} from "./backend-protocol.js";
export {
  backendInstallConfigPath,
  defaultBackendSocketPath,
  defaultPersistentStateDir,
  readBackendInstallConfig,
  type BackendInstallConfig,
} from "./paths.js";
export {
  discardPreparedWorkflowRun,
  executePreparedRun,
  openPreparedRunForResume,
  openWorkflowForResume,
  prepareWorkflowRun,
  publishPreparedWorkflowRun,
  runWorkflow,
  type ExecutePreparedRunOptions,
  type PreparedWorkflowRun,
  type PrepareWorkflowOptions,
  type RunWorkflowOptions,
} from "./runtime.js";
export { inspectRun } from "./run-state.js";
export {
  ScheduleStore,
  cronMatches,
  loadScheduleApplication,
  validateCronExpression,
  type CronTrigger,
  type ScheduleApplication,
  type ScheduleLaunchRequest,
  type ScheduleOccurrence,
  type SchedulePolicy,
  type ScheduleRevision,
  type ScheduleState,
} from "./schedules.js";
export {
  HOOK_EVENT_TYPES,
  loadHookConfig,
  type HookConfig,
  type HookDefinition,
  type HookEventType,
} from "./hook-config.js";
export {
  HookManager,
  parseLifecycleEvent,
  type HookHistoryFilter,
  type HookManagerOptions,
  type LifecycleHookEvent,
} from "./hooks.js";
export {
  loadRuntimeModuleConfig,
  RuntimeModuleHost,
  type RuntimeModule,
  type RuntimeModuleConfig,
  type RuntimeModuleContext,
  type RuntimeModuleHostOptions,
  type RuntimeModuleOperations,
  type RuntimeSessionQueryOptions,
} from "./runtime-modules.js";
export { resumeSession, type SessionResumeResult } from "./session-runtime.js";
export {
  createSessionQueryId,
  executeSessionQueryWorker,
  inspectSessionQuery,
  recoverSessionQueries,
  submitSessionQuery,
  waitForSessionQuery,
  type SessionQueryRequest,
  type SessionQueryServiceOptions,
} from "./session-queries.js";
export {
  createSessionTurnId,
  inspectSessionTurn,
  waitForSessionTurn,
} from "./session-turns.js";
export { listWorkflowSessions, requestSessionControl } from "./sessions.js";
export type {
  AgentOptions,
  HarnessAdapter,
  HarnessDefinition,
  HarnessDriver,
  HarnessName,
  HarnessResult,
  JsonSchema,
  JsonValue,
  RuntimeReporter,
  RuntimeBoundaryDescriptor,
  SessionControlKind,
  SessionTurnStatus,
  SessionTurnSummary,
  SessionQueryStatus,
  SessionQuerySummary,
  WorkflowMeta,
  WorkflowTriggerMetadata,
  ScheduleTriggerMetadata,
  WorkflowRunResult,
  WorkflowRunRecord,
  WorkflowRunRecordV2,
  WorkflowRunRecordV3,
  WorkflowRunRecordV4,
  WorkflowRunStatus,
  WorkflowRunSummary,
  WorkflowSessionRecord,
  WorkflowSessionStatus,
  WorkflowSessionSummary,
} from "./types.js";
export { JAEGER_VERSION, WORKFLOW_RUNTIME_ABI } from "./version.js";
