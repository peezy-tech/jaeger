import { randomBytes } from "node:crypto";
import { register } from "node:module";
import {
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { publishJsonExclusive, syncDirectory } from "./durable-json.js";
import {
  HOOK_EVENT_TYPES,
  type HookEventType,
} from "./hook-config.js";
import {
  parseLifecycleEvent,
  type LifecycleHookEvent,
} from "./hooks.js";
import { ensurePrivateDirectory } from "./paths.js";
import { runtimeModuleProjectDigest } from "./module-registry.js";
import type { JsonValue } from "./types.js";

const MODULE_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const STORAGE_KEY = /^[A-Za-z0-9._-]{1,128}$/;
const EVENT_FILE = /^evt-[a-f0-9]{64}\.json$/;
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000, 600_000] as const;
const registeredRuntimeModuleRoots = new Set<string>();

export interface RuntimeModuleConfig {
  readonly version: 1;
  readonly path: string;
  readonly digest: string;
  readonly modules: readonly RuntimeModule[];
}

export interface RuntimeModule {
  readonly name: string;
  readonly setup: (runtime: RuntimeModuleContext) => void | Promise<void>;
}

export interface RuntimeModuleContext {
  readonly events: {
    consume(
      types: HookEventType | readonly HookEventType[],
      handler: (event: LifecycleHookEvent) => void | Promise<void>,
    ): void;
  };
  readonly services: {
    run(
      name: string,
      worker: (signal: AbortSignal) => void | Promise<void>,
    ): void;
  };
  readonly runs: {
    list(): Promise<JsonValue>;
    inspect(runId: string): Promise<JsonValue>;
  };
  readonly sessions: {
    list(runId: string): Promise<JsonValue>;
    inspect(runId: string, selector: string): Promise<JsonValue>;
    query(
      runId: string,
      selector: string,
      options: RuntimeSessionQueryOptions,
    ): Promise<JsonValue>;
    inspectQuery(runId: string, queryId: string): Promise<JsonValue>;
    waitQuery(runId: string, queryId: string): Promise<JsonValue>;
  };
  readonly storage: {
    get(key: string): Promise<JsonValue | undefined>;
    set(key: string, value: JsonValue): Promise<void>;
  };
  readonly log: {
    info(message: string): void;
    error(message: string, error?: unknown): void;
  };
}

export interface RuntimeSessionQueryOptions {
  readonly message: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly queryId?: string;
}

export interface RuntimeModuleOperations {
  readonly listRuns: () => Promise<JsonValue>;
  readonly inspectRun: (runId: string) => Promise<JsonValue>;
  readonly listSessions: (runId: string) => Promise<JsonValue>;
  readonly inspectSession: (runId: string, selector: string) => Promise<JsonValue>;
  readonly querySession: (
    runId: string,
    selector: string,
    options: RuntimeSessionQueryOptions,
  ) => Promise<JsonValue>;
  readonly inspectSessionQuery: (runId: string, queryId: string) => Promise<JsonValue>;
  readonly waitSessionQuery: (runId: string, queryId: string) => Promise<JsonValue>;
}

interface EventConsumer {
  readonly id: string;
  readonly slot: string;
  readonly module: string;
  readonly types: readonly HookEventType[];
  readonly handler: (event: LifecycleHookEvent) => void | Promise<void>;
}

interface BackgroundService {
  readonly id: string;
  readonly module: string;
  readonly name: string;
  readonly worker: (signal: AbortSignal) => void | Promise<void>;
  status: "registered" | "running" | "completed" | "failed" | "stopped";
  startedAt?: string;
  finishedAt?: string;
  lastError?: string;
  promise?: Promise<void>;
}

interface ModuleState {
  readonly name: string;
  status: "loading" | "ready" | "running" | "degraded" | "stopped";
  lastError?: string;
}

interface ModuleDelivery {
  readonly version: 1;
  readonly consumer: string;
  readonly eventId: string;
  readonly eventType: HookEventType;
  readonly attempts: number;
  readonly status: "retrying" | "delivered";
  readonly updatedAt: string;
  readonly nextAttemptAt: string;
  readonly lastError?: string;
}

export interface RuntimeModuleHostOptions {
  readonly stateDir: string;
  readonly config?: RuntimeModuleConfig;
  readonly operations: RuntimeModuleOperations;
  readonly tickIntervalMs?: number;
  readonly now?: () => Date;
}

export class RuntimeModuleHost {
  private readonly stateDir: string;
  private readonly root: string;
  private readonly eventsDir: string;
  private readonly config: RuntimeModuleConfig | undefined;
  private readonly operations: RuntimeModuleOperations;
  private readonly tickIntervalMs: number;
  private readonly now: () => Date;
  private readonly consumers: EventConsumer[] = [];
  private readonly services: BackgroundService[] = [];
  private readonly modules = new Map<string, ModuleState>();
  private readonly controller = new AbortController();
  private timer: NodeJS.Timeout | undefined;
  private eventTick: Promise<void> | undefined;
  private initialized = false;
  private started = false;
  private lastEventTickAt: string | undefined;
  private lastEventError: string | undefined;

  constructor(options: RuntimeModuleHostOptions) {
    this.stateDir = path.resolve(options.stateDir);
    this.root = path.join(this.stateDir, ".modules");
    this.eventsDir = path.join(this.stateDir, ".hooks", "events");
    this.config = options.config;
    this.operations = options.operations;
    this.tickIntervalMs = options.tickIntervalMs ?? 2_000;
    this.now = options.now ?? (() => new Date());
    for (const module of this.config?.modules ?? []) {
      this.modules.set(module.name, { name: module.name, status: "loading" });
    }
  }

  get enabled(): boolean {
    return Boolean(this.config && this.config.modules.length > 0);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    if (!this.enabled) return;
    await ensurePrivateDirectory(this.root, "Jaeger runtime module state directory");
    for (const module of this.config?.modules ?? []) {
      const state = this.modules.get(module.name) as ModuleState;
      try {
        await ensurePrivateDirectory(
          this.moduleRoot(module.name),
          `Jaeger runtime module ${module.name} state directory`,
        );
        await module.setup(this.context(module.name));
        state.status = "ready";
      } catch (error) {
        state.status = "degraded";
        state.lastError = errorMessage(error);
        throw new Error(`Runtime module ${module.name} setup failed: ${state.lastError}`, {
          cause: error,
        });
      }
    }
    for (const consumer of this.consumers) {
      const directory = this.consumerDirectory(consumer);
      await ensurePrivateDirectory(
        directory,
        `Jaeger runtime module ${consumer.module} event delivery directory`,
      );
      await publishJsonExclusive(path.join(directory, "consumer.json"), {
        version: 1,
        id: consumer.id,
        createdAt: this.now().toISOString(),
      });
      await this.migratePendingDeliveries(consumer);
    }
  }

  start(): void {
    if (this.started || !this.enabled) return;
    if (!this.initialized) throw new Error("Runtime modules must be initialized before start");
    this.started = true;
    for (const state of this.modules.values()) {
      if (state.status === "ready") state.status = "running";
    }
    for (const service of this.services) this.startService(service);
    const schedule = (): void => {
      if (this.eventTick) return;
      this.eventTick = this.deliverEvents()
        .catch((error) => {
          this.lastEventError = errorMessage(error);
          process.stderr.write(`jaeger runtime modules: ${this.lastEventError}\n`);
        })
        .finally(() => {
          this.eventTick = undefined;
        });
    };
    schedule();
    this.timer = setInterval(schedule, this.tickIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.controller.abort(new Error("Jaeger runtime module host is stopping"));
    await this.eventTick;
    await Promise.allSettled(
      this.services.map(async (service) => {
        await service.promise;
        if (service.status === "running") service.status = "stopped";
      }),
    );
    for (const state of this.modules.values()) state.status = "stopped";
    this.started = false;
  }

  status(): JsonValue {
    return toJsonValue({
      schemaVersion: 1,
      enabled: this.enabled,
      running: this.started,
      configPath: this.config?.path ?? null,
      configDigest: this.config?.digest ?? null,
      lastEventTickAt: this.lastEventTickAt ?? null,
      lastEventError: this.lastEventError ?? null,
      modules: [...this.modules.values()].map((state) => ({
        name: state.name,
        status: state.status,
        lastError: state.lastError ?? null,
        consumers: this.consumers.filter((consumer) => consumer.module === state.name).length,
        services: this.services
          .filter((service) => service.module === state.name)
          .map((service) => ({
            name: service.name,
            status: service.status,
            startedAt: service.startedAt ?? null,
            finishedAt: service.finishedAt ?? null,
            lastError: service.lastError ?? null,
          })),
      })),
    });
  }

  private context(moduleName: string): RuntimeModuleContext {
    return {
      events: {
        consume: (types, handler) => {
          const normalized = Array.isArray(types) ? [...types] : [types];
          if (normalized.length === 0) {
            throw new Error(`Runtime module ${moduleName} event consumer requires events`);
          }
          for (const type of normalized) {
            if (!HOOK_EVENT_TYPES.includes(type)) {
              throw new Error(`Runtime module ${moduleName} requested unknown event ${type}`);
            }
          }
          const index =
            this.consumers.filter((consumer) => consumer.module === moduleName).length + 1;
          const slot = `${moduleName}-${index}`;
          const generation = this.config?.digest.slice(0, 16) ?? "unversioned";
          this.consumers.push({
            id: `${slot}-${generation}`,
            slot,
            module: moduleName,
            types: normalized,
            handler,
          });
        },
      },
      services: {
        run: (name, worker) => {
          if (!MODULE_NAME.test(name)) {
            throw new Error(`Runtime module ${moduleName} service name is invalid: ${name}`);
          }
          if (
            this.services.some(
              (service) => service.module === moduleName && service.name === name,
            )
          ) {
            throw new Error(`Runtime module ${moduleName} service is duplicated: ${name}`);
          }
          this.services.push({
            id: `${moduleName}:${name}`,
            module: moduleName,
            name,
            worker,
            status: "registered",
          });
        },
      },
      runs: {
        list: async () => await this.operations.listRuns(),
        inspect: async (runId) => await this.operations.inspectRun(runId),
      },
      sessions: {
        list: async (runId) => await this.operations.listSessions(runId),
        inspect: async (runId, selector) =>
          await this.operations.inspectSession(runId, selector),
        query: async (runId, selector, options) =>
          await this.operations.querySession(runId, selector, options),
        inspectQuery: async (runId, queryId) =>
          await this.operations.inspectSessionQuery(runId, queryId),
        waitQuery: async (runId, queryId) =>
          await this.operations.waitSessionQuery(runId, queryId),
      },
      storage: {
        get: async (key) => await this.readStorage(moduleName, key),
        set: async (key, value) => await this.writeStorage(moduleName, key, value),
      },
      log: {
        info: (message) => {
          process.stderr.write(`jaeger module ${moduleName}: ${message}\n`);
        },
        error: (message, error) => {
          process.stderr.write(
            `jaeger module ${moduleName}: ${message}${
              error === undefined ? "" : `: ${errorMessage(error)}`
            }\n`,
          );
        },
      },
    };
  }

  private startService(service: BackgroundService): void {
    service.status = "running";
    service.startedAt = this.now().toISOString();
    service.promise = Promise.resolve()
      .then(async () => await service.worker(this.controller.signal))
      .then(() => {
        service.status = this.controller.signal.aborted ? "stopped" : "completed";
        service.finishedAt = this.now().toISOString();
      })
      .catch((error) => {
        service.status = "failed";
        service.finishedAt = this.now().toISOString();
        service.lastError = errorMessage(error);
        const module = this.modules.get(service.module);
        if (module) {
          module.status = "degraded";
          module.lastError = `service ${service.name}: ${service.lastError}`;
        }
        process.stderr.write(
          `jaeger module ${service.module} service ${service.name}: ${service.lastError}\n`,
        );
      });
  }

  private async deliverEvents(): Promise<void> {
    if (this.consumers.length === 0) return;
    let entries;
    try {
      entries = await readdir(this.eventsDir, { withFileTypes: true });
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !EVENT_FILE.test(entry.name)) continue;
      const event = parseLifecycleEvent(
        JSON.parse(await readFile(path.join(this.eventsDir, entry.name), "utf8")),
      );
      for (const consumer of this.consumers) {
        if (!consumer.types.includes(event.type)) continue;
        await this.deliverEvent(consumer, event);
      }
    }
    this.lastEventTickAt = this.now().toISOString();
    this.lastEventError = undefined;
  }

  private async deliverEvent(
    consumer: EventConsumer,
    event: LifecycleHookEvent,
  ): Promise<void> {
    const directory = this.consumerDirectory(consumer);
    await ensurePrivateDirectory(
      directory,
      `Jaeger runtime module ${consumer.module} event delivery directory`,
    );
    const target = path.join(directory, `${event.id}.json`);
    const existing = await readOptionalJson(target);
    if (existing) {
      const delivery = parseModuleDelivery(existing);
      if (delivery.status === "delivered") return;
      if (Date.parse(delivery.nextAttemptAt) > this.now().getTime()) return;
    }
    if (!existing) {
      const metadata = record(
        JSON.parse(await readFile(path.join(directory, "consumer.json"), "utf8")),
        "runtime module event consumer",
      );
      if (
        typeof metadata.createdAt !== "string" ||
        Number.isNaN(Date.parse(metadata.createdAt))
      ) {
        throw new Error(`Runtime module event consumer ${consumer.id} has invalid metadata`);
      }
      if (Date.parse(event.occurredAt) < Date.parse(metadata.createdAt)) {
        await writeJsonAtomic(target, {
          version: 1,
          consumer: consumer.id,
          eventId: event.id,
          eventType: event.type,
          attempts: 0,
          status: "delivered",
          updatedAt: this.now().toISOString(),
          nextAttemptAt: this.now().toISOString(),
        } satisfies ModuleDelivery);
        return;
      }
    }
    const attempts = existing ? parseModuleDelivery(existing).attempts + 1 : 1;
    try {
      await consumer.handler(event);
      const delivered: ModuleDelivery = {
        version: 1,
        consumer: consumer.id,
        eventId: event.id,
        eventType: event.type,
        attempts,
        status: "delivered",
        updatedAt: this.now().toISOString(),
        nextAttemptAt: this.now().toISOString(),
      };
      await writeJsonAtomic(target, delivered);
    } catch (error) {
      const delay =
        RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)] ??
        600_000;
      const retrying: ModuleDelivery = {
        version: 1,
        consumer: consumer.id,
        eventId: event.id,
        eventType: event.type,
        attempts,
        status: "retrying",
        updatedAt: this.now().toISOString(),
        nextAttemptAt: new Date(this.now().getTime() + delay).toISOString(),
        lastError: errorMessage(error),
      };
      await writeJsonAtomic(target, retrying);
      const state = this.modules.get(consumer.module);
      if (state) {
        state.status = "degraded";
        state.lastError = `event ${event.id}: ${retrying.lastError}`;
      }
    }
  }

  private async migratePendingDeliveries(consumer: EventConsumer): Promise<void> {
    const eventsRoot = path.join(this.moduleRoot(consumer.module), "events");
    const currentDirectory = this.consumerDirectory(consumer);
    const escapedSlot = consumer.slot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const consumerDirectoryPattern = new RegExp(
      `^${escapedSlot}(?:-[a-f0-9]{16})?$`,
    );
    const candidates = new Map<
      string,
      { readonly delivery: ModuleDelivery; readonly directory: string }
    >();
    for (const directoryEntry of await readdir(eventsRoot, { withFileTypes: true })) {
      if (
        !directoryEntry.isDirectory() ||
        directoryEntry.isSymbolicLink() ||
        !consumerDirectoryPattern.test(directoryEntry.name)
      ) {
        continue;
      }
      const directory = path.join(eventsRoot, directoryEntry.name);
      for (const eventEntry of await readdir(directory, { withFileTypes: true })) {
        if (
          !eventEntry.isFile() ||
          eventEntry.isSymbolicLink() ||
          !EVENT_FILE.test(eventEntry.name)
        ) {
          continue;
        }
        const delivery = parseModuleDelivery(
          JSON.parse(await readFile(path.join(directory, eventEntry.name), "utf8")),
        );
        if (`${delivery.eventId}.json` !== eventEntry.name) {
          throw new Error("Invalid runtime module event delivery");
        }
        if (!consumer.types.includes(delivery.eventType)) continue;
        const previous = candidates.get(delivery.eventId);
        if (!previous || moduleDeliveryPrecedes(previous.delivery, delivery)) {
          candidates.set(delivery.eventId, { delivery, directory });
        }
      }
    }
    for (const { delivery, directory } of candidates.values()) {
      if (directory === currentDirectory || delivery.status !== "retrying") continue;
      await writeJsonAtomic(path.join(currentDirectory, `${delivery.eventId}.json`), {
        ...delivery,
        consumer: consumer.id,
      } satisfies ModuleDelivery);
    }
  }

  private async readStorage(
    moduleName: string,
    key: string,
  ): Promise<JsonValue | undefined> {
    validateStorageKey(key);
    const value = await readOptionalJson(
      path.join(this.moduleRoot(moduleName), "storage", `${key}.json`),
    );
    return value === undefined ? undefined : toJsonValue(value);
  }

  private async writeStorage(
    moduleName: string,
    key: string,
    value: JsonValue,
  ): Promise<void> {
    validateStorageKey(key);
    const directory = path.join(this.moduleRoot(moduleName), "storage");
    await ensurePrivateDirectory(
      directory,
      `Jaeger runtime module ${moduleName} storage directory`,
    );
    await writeJsonAtomic(path.join(directory, `${key}.json`), value);
  }

  private moduleRoot(moduleName: string): string {
    return path.join(this.root, moduleName);
  }

  private consumerDirectory(consumer: EventConsumer): string {
    return path.join(this.moduleRoot(consumer.module), "events", consumer.id);
  }
}

export async function loadRuntimeModuleConfig(
  configPath: string,
): Promise<RuntimeModuleConfig> {
  const resolved = await realpath(path.resolve(configPath));
  const source = await readFile(resolved, "utf8");
  const digest = await runtimeModuleProjectDigest(resolved, source);
  registerRuntimeModuleRoot(path.dirname(resolved));
  const configUrl = pathToFileURL(resolved);
  configUrl.searchParams.set("jaeger-runtime-digest", digest);
  const imported = (await import(configUrl.href)) as {
    readonly default?: unknown;
  };
  const root = record(imported.default, "runtime module configuration");
  for (const key of Object.keys(root)) {
    if (key !== "version" && key !== "modules") {
      throw new Error(`Unknown runtime module configuration field: ${key}`);
    }
  }
  if (root.version !== 1) throw new Error("Runtime module configuration version must be 1");
  if (!Array.isArray(root.modules)) {
    throw new Error("Runtime module configuration requires a modules array");
  }
  const names = new Set<string>();
  const modules = root.modules.map((value, index): RuntimeModule => {
    const module = record(value, `runtime module ${index}`);
    for (const key of Object.keys(module)) {
      if (key !== "name" && key !== "setup") {
        throw new Error(`Unknown runtime module ${index} field: ${key}`);
      }
    }
    if (typeof module.name !== "string" || !MODULE_NAME.test(module.name)) {
      throw new Error(`Runtime module ${index} name is invalid`);
    }
    if (names.has(module.name)) throw new Error(`Runtime module is duplicated: ${module.name}`);
    names.add(module.name);
    if (typeof module.setup !== "function") {
      throw new Error(`Runtime module ${module.name} requires setup(runtime)`);
    }
    return {
      name: module.name,
      setup: module.setup as RuntimeModule["setup"],
    };
  });
  return { version: 1, path: resolved, digest, modules };
}

function registerRuntimeModuleRoot(root: string): void {
  if (registeredRuntimeModuleRoots.has(root)) return;
  register(new URL("./runtime-module-loader.js", import.meta.url), {
    data: { root },
  });
  registeredRuntimeModuleRoots.add(root);
}

function parseModuleDelivery(value: unknown): ModuleDelivery {
  const delivery = record(value, "runtime module event delivery");
  if (
    delivery.version !== 1 ||
    typeof delivery.consumer !== "string" ||
    typeof delivery.eventId !== "string" ||
    typeof delivery.eventType !== "string" ||
    !HOOK_EVENT_TYPES.includes(delivery.eventType as HookEventType) ||
    !Number.isSafeInteger(delivery.attempts) ||
    (delivery.status !== "retrying" && delivery.status !== "delivered") ||
    typeof delivery.updatedAt !== "string" ||
    typeof delivery.nextAttemptAt !== "string"
  ) {
    throw new Error("Invalid runtime module event delivery");
  }
  return delivery as unknown as ModuleDelivery;
}

function moduleDeliveryPrecedes(
  current: ModuleDelivery,
  candidate: ModuleDelivery,
): boolean {
  if (current.attempts !== candidate.attempts) {
    return current.attempts < candidate.attempts;
  }
  if (current.status !== candidate.status) {
    return current.status === "retrying";
  }
  const currentUpdatedAt = Date.parse(current.updatedAt);
  const candidateUpdatedAt = Date.parse(candidate.updatedAt);
  if (currentUpdatedAt !== candidateUpdatedAt) {
    if (Number.isNaN(currentUpdatedAt)) return true;
    if (Number.isNaN(candidateUpdatedAt)) return false;
    return currentUpdatedAt < candidateUpdatedAt;
  }
  return false;
}

function validateStorageKey(key: string): void {
  if (!STORAGE_KEY.test(key)) throw new Error(`Runtime module storage key is invalid: ${key}`);
}

async function readOptionalJson(target: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(target, "utf8")) as unknown;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
  await syncDirectory(path.dirname(target));
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function toJsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Runtime module value is not JSON");
  return JSON.parse(serialized) as JsonValue;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
