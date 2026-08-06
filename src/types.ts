export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = Record<string, unknown>;

export type HarnessName = string;
export type HarnessDriver = "codex-app-server" | "claude-agent-sdk" | "pi-rpc";

export interface HarnessDefinition {
  readonly name: HarnessName;
  readonly driver: HarnessDriver;
  readonly command: string;
  readonly description?: string;
}

export interface WorkflowMeta {
  readonly name: string;
  readonly description?: string;
  readonly phases?: ReadonlyArray<{
    readonly title: string;
    readonly detail?: string;
  }>;
}

export interface AgentOptions {
  readonly harness: HarnessName;
  readonly label?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly serviceTier?: string;
  readonly cwd?: string;
  readonly schema?: JsonSchema;
  readonly profile?: string;
  readonly timeoutMs?: number;
}

export interface AgentRequest extends AgentOptions {
  readonly prompt: string;
  readonly harness: HarnessName;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly runDir: string;
  readonly stepId: string;
  readonly session: SessionTurn;
  readonly forkSessionId?: string;
  readonly readOnly?: boolean;
  readonly signal?: AbortSignal;
}

export type SessionControlKind = "steer" | "interrupt";

export interface SessionControlRequest {
  readonly id: string;
  readonly kind: SessionControlKind;
  readonly message?: string;
}

export type ProviderRuntimeActivity = "starting" | "running" | "completed" | "failed" | "interrupted";

export interface ProviderRuntimeProgress {
  readonly id: string;
  readonly kind: "task" | "tool" | "workflow";
  readonly status: "running" | "completed" | "failed" | "interrupted";
  readonly label?: string;
  readonly parentId?: string;
  readonly updatedAt: string;
}

/**
 * An allowlisted projection of a native provider event. It is safe to persist
 * in a session record and intentionally never contains prompts, outputs, or
 * provider-authentication material.
 */
export interface ProviderRuntimeEvent {
  readonly id: string;
  readonly type: string;
  readonly source: HarnessDriver;
  readonly at: string;
  readonly nativeSessionId?: string;
  readonly nativeTurnId?: string;
  readonly nativeItemId?: string;
  readonly activity?: ProviderRuntimeActivity;
  readonly usage?: Record<string, JsonValue>;
  readonly rateLimits?: Record<string, JsonValue>;
  readonly identity?: unknown;
  readonly progress?: ProviderRuntimeProgress;
  readonly error?: string;
}

export interface ProviderRuntimeSnapshot {
  readonly version: 1;
  readonly activity: ProviderRuntimeActivity;
  readonly updatedAt: string;
  readonly identity?: JsonValue;
  readonly usage?: Record<string, JsonValue>;
  readonly rateLimits?: Record<string, JsonValue>;
  readonly progress: readonly ProviderRuntimeProgress[];
  readonly recentEvents: readonly {
    readonly id: string;
    readonly type: string;
    readonly at: string;
    readonly activity?: ProviderRuntimeActivity;
  }[];
  readonly lastError?: string;
}

export interface SessionTurn {
  readonly id: string;
  readonly nativeSessionId?: string | undefined;
  providerStarted(nativeSessionId: string): Promise<void>;
  turnStarted(nativeTurnId?: string): Promise<void>;
  providerEvent(event: ProviderRuntimeEvent): Promise<void>;
  processControls(
    handler: (request: SessionControlRequest) => Promise<Record<string, JsonValue> | void>,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface HarnessResult {
  readonly output: unknown;
  readonly nativeSessionId?: string;
  readonly metadata?: Record<string, JsonValue>;
}

export interface HarnessAdapter {
  readonly name: string;
  readonly driver: HarnessDriver;
  validateOptions?(options: AgentOptions): void;
  execute(request: AgentRequest): Promise<HarnessResult>;
}

export interface WorkflowContext {
  readonly inputs: unknown;
  readonly trigger: WorkflowTriggerMetadata | undefined;
  readonly agent: (prompt: string, options: AgentOptions) => Promise<unknown>;
  readonly parallel: <T>(tasks: ReadonlyArray<() => Promise<T> | T>) => Promise<T[]>;
  readonly phase: (name: string) => void;
  readonly log: (message: unknown) => void;
  readonly setMeta: (meta: unknown) => void;
}

export interface ScheduleTriggerMetadata {
  readonly type: "schedule";
  readonly scheduleId: string;
  readonly revision: number;
  readonly occurrenceId: string;
  readonly kind: "cron" | "manual";
  readonly scheduledFor: string;
  readonly admittedAt: string;
}

export type WorkflowTriggerMetadata = ScheduleTriggerMetadata;

interface WorkflowRunRecordFields {
  readonly runId: string;
  readonly workflowPath: string;
  readonly workflowHash: string;
  readonly cwd: string;
  readonly inputs: JsonValue;
  readonly maxConcurrency: number;
  readonly boundary: RuntimeBoundaryDescriptor;
  readonly createdAt: string;
}

export interface WorkflowRunRecordV2 extends WorkflowRunRecordFields {
  readonly version: 2;
}

export interface WorkflowRunRecordV3 extends WorkflowRunRecordFields {
  readonly version: 3;
  readonly harnesses: readonly HarnessDefinition[];
}

export interface WorkflowRunRecordV4 extends WorkflowRunRecordFields {
  readonly version: 4;
  readonly trigger?: WorkflowTriggerMetadata;
  readonly harnesses: readonly HarnessDefinition[];
  readonly runtime: {
    readonly abi: number;
    readonly version: string;
    readonly backend: "embedded" | "local-service";
  };
  readonly workspace: {
    readonly kind: "local-path";
    readonly root: string;
    readonly device: string;
    readonly inode: string;
    readonly identity: string;
  };
  readonly submissionId?: string;
  readonly submissionHash?: string;
}

export type WorkflowRunRecord =
  | WorkflowRunRecordV2
  | WorkflowRunRecordV3
  | WorkflowRunRecordV4;

export interface RuntimeBoundaryDescriptor {
  readonly kind: string;
  readonly isolated: boolean;
  readonly description: string;
}

export interface WorkflowRunResult {
  readonly runId: string;
  readonly meta: WorkflowMeta;
  readonly result: unknown;
  readonly runDir: string;
}

export type WorkflowRunStatus =
  | "pending"
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "interrupted"
  | "stopped"
  | "uncertain";

export interface WorkflowRunSummary {
  readonly runId: string;
  readonly submissionId?: string;
  readonly trigger?: WorkflowTriggerMetadata;
  readonly status: WorkflowRunStatus;
  readonly scriptPath: string;
  readonly runDir: string;
  readonly cwd: string;
  readonly boundary: RuntimeBoundaryDescriptor;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly currentPhase?: string;
  readonly agents: {
    readonly started: number;
    readonly completed: number;
    readonly failed: number;
  };
  readonly sessions: {
    readonly total: number;
    readonly running: number;
    readonly idle: number;
  };
  readonly result?: JsonValue;
  readonly error?: string;
  readonly uncertainty?: {
    readonly stepId?: string;
    readonly reason: string;
  };
  readonly inspect: string;
  readonly wait?: string;
  readonly stop?: string;
  readonly resume?: string;
}

export type WorkflowSessionStatus =
  | "starting"
  | "running"
  | "idle"
  | "failed"
  | "uncertain";

export interface WorkflowSessionRecord {
  readonly version: 1;
  readonly id: string;
  readonly runId: string;
  readonly stepId: string;
  readonly harness: HarnessName;
  readonly driver?: HarnessDriver;
  readonly cwd: string;
  readonly label?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly serviceTier?: string;
  readonly profile?: string;
  readonly nativeSessionId?: string | undefined;
  readonly activeTurnId?: string | undefined;
  readonly status: WorkflowSessionStatus;
  readonly turnCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastOutput?: JsonValue | undefined;
  readonly lastError?: string | undefined;
  readonly runtime?: ProviderRuntimeSnapshot | undefined;
}

export interface WorkflowSessionSummary extends WorkflowSessionRecord {
  readonly threadArchive?: {
    readonly status: "visible" | "retrying" | "archived" | "retained";
    readonly updatedAt: string;
    readonly reason?: string;
    readonly lastError?: string;
    readonly nextAttemptAt?: string;
  };
  readonly resume?: string;
  readonly steer?: string;
  readonly interrupt?: string;
  readonly inspect: string;
}

export type SessionTurnStatus =
  | "queued"
  | "running"
  | "orphaned"
  | "completed"
  | "rejected"
  | "uncertain";

export interface SessionTurnSummary {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly turn: number;
  readonly status: SessionTurnStatus;
  readonly createdAt: string;
  readonly output?: JsonValue;
  readonly nativeSessionId?: string;
  readonly metadata?: Record<string, JsonValue>;
  readonly error?: string;
  readonly inspect: string;
  readonly wait?: string;
  readonly interrupt?: string;
}

export type SessionQueryStatus =
  | "queued"
  | "running"
  | "orphaned"
  | "completed"
  | "rejected"
  | "uncertain";

export interface SessionQuerySummary {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly sessionId: string;
  readonly queryId: string;
  readonly status: SessionQueryStatus;
  readonly createdAt: string;
  readonly parentNativeSessionId: string;
  readonly model?: string;
  readonly output?: JsonValue;
  readonly nativeSessionId?: string;
  readonly metadata?: Record<string, JsonValue>;
  readonly finishedAt?: string;
  readonly error?: string;
  readonly inspect: string;
  readonly wait?: string;
}

export interface RuntimeReporter {
  phase(name: string): void;
  log(message: string): void;
  agentStarted(stepId: string, options: AgentOptions): void;
  agentCompleted(stepId: string, replayed: boolean): void;
}
