import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadRuntimeModuleConfig,
  RuntimeModuleHost,
  type RuntimeModuleConfig,
  type RuntimeModuleOperations,
} from "../src/runtime-modules.js";
import type { JsonValue } from "../src/types.js";

const operations: RuntimeModuleOperations = {
  listRuns: async () => [],
  inspectRun: async (runId) => ({ runId }),
  listSessions: async () => [],
  inspectSession: async (runId, selector) => ({ runId, selector }),
  querySession: async (runId, selector, options) => ({
    runId,
    selector,
    output: options.message,
  }),
  inspectSessionQuery: async (runId, queryId) => ({ runId, queryId }),
  waitSessionQuery: async (runId, queryId) => ({ runId, queryId }),
};

test("loads an ESM runtime configuration with package-local dependencies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-modules-config-"));
  try {
    const helper = path.join(root, "node_modules", "fixture-helper");
    await mkdir(helper, { recursive: true });
    await writeFile(
      path.join(helper, "package.json"),
      JSON.stringify({ name: "fixture-helper", type: "module", exports: "./index.js" }),
    );
    await writeFile(
      path.join(helper, "index.js"),
      `export const fixture = { name: "fixture", setup() {} }\n`,
    );
    const configPath = path.join(root, "jaeger.runtime.mjs");
    await writeFile(
      configPath,
      `import { fixture } from "fixture-helper"
export default { version: 1, modules: [fixture] }
`,
    );

    const config = await loadRuntimeModuleConfig(configPath);
    assert.equal(config.modules[0]?.name, "fixture");
    assert.match(config.digest, /^[a-f0-9]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registry-managed runtime digest changes with module source and npm shrinkwrap", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-modules-digest-"));
  try {
    const moduleRoot = path.join(root, "modules", "fixture");
    await mkdir(moduleRoot, { recursive: true });
    const modulePath = path.join(moduleRoot, "fixture.mjs");
    await writeFile(
      modulePath,
      `export const fixture = { name: "fixture", setup() { return "first" } }\n`,
    );
    await writeFile(
      path.join(root, "modules.lock.json"),
      `${JSON.stringify({ schemaVersion: 1, modules: {}, dependencies: {} })}\n`,
    );
    await writeFile(
      path.join(root, "package.json"),
      `${JSON.stringify({ private: true, type: "module", dependencies: {} })}\n`,
    );
    const shrinkwrapPath = path.join(root, "npm-shrinkwrap.json");
    await writeFile(
      shrinkwrapPath,
      `${JSON.stringify({ lockfileVersion: 3, packages: {} })}\n`,
    );
    const configPath = path.join(root, "jaeger.runtime.mjs");
    await writeFile(
      configPath,
      `import { fixture } from "./modules/fixture/fixture.mjs"
export default { version: 1, modules: [fixture] }
`,
    );

    const first = await loadRuntimeModuleConfig(configPath);
    assert.equal(
      (first.modules[0]?.setup as unknown as () => string)(),
      "first",
    );
    await writeFile(
      modulePath,
      `export const fixture = { name: "fixture", setup() { return "second" } }\n`,
    );
    const second = await loadRuntimeModuleConfig(configPath);
    assert.notEqual(first.digest, second.digest);
    assert.equal(
      (second.modules[0]?.setup as unknown as () => string)(),
      "second",
    );
    await writeFile(
      shrinkwrapPath,
      `${JSON.stringify({
        lockfileVersion: 3,
        packages: { "node_modules/fixture": { version: "1.0.0" } },
      })}\n`,
    );
    const third = await loadRuntimeModuleConfig(configPath);
    assert.notEqual(second.digest, third.digest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runs trusted modules in-process and durably retries lifecycle events", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-modules-host-"));
  const stateDir = path.join(root, "state");
  const eventsDir = path.join(stateDir, ".hooks", "events");
  await mkdir(eventsDir, { recursive: true });
  const eventId = `evt-${"a".repeat(64)}`;
  await writeFile(
    path.join(eventsDir, `${eventId}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      id: eventId,
      type: "run.terminal",
      occurredAt: "2026-07-25T00:00:00.000Z",
      observedAt: "2026-07-25T00:00:00.000Z",
      run: { runId: "20260725000000-aaaaaaaaaa" },
      subject: { status: "completed" },
    })}\n`,
  );
  let attempts = 0;
  let delivered = false;
  let handlerPid = 0;
  let servicePid = 0;
  const config: RuntimeModuleConfig = {
    version: 1,
    path: path.join(root, "jaeger.runtime.mjs"),
    digest: "b".repeat(64),
    modules: [
      {
        name: "fixture",
        setup(runtime) {
          runtime.events.consume("run.terminal", async () => {
            attempts++;
            handlerPid = process.pid;
            if (attempts === 1) throw new Error("retry me");
            await runtime.storage.set("observed", { delivered: true });
            delivered = true;
          });
          runtime.services.run("background", async (signal) => {
            servicePid = process.pid;
            await new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true }),
            );
          });
        },
      },
    ],
  };
  let now = new Date("2026-07-25T00:00:00.000Z");
  const host = new RuntimeModuleHost({
    stateDir,
    config,
    operations,
    tickIntervalMs: 10,
    now: () => now,
  });
  try {
    await host.initialize();
    host.start();
    await waitFor(() => attempts === 1);
    now = new Date(now.getTime() + 2_000);
    await waitFor(() => delivered);

    assert.equal(handlerPid, process.pid);
    assert.equal(servicePid, process.pid);
    const stored = JSON.parse(
      await readFile(path.join(stateDir, ".modules", "fixture", "storage", "observed.json"), "utf8"),
    ) as JsonValue;
    assert.deepEqual(stored, { delivered: true });
    const status = host.status() as Record<string, JsonValue>;
    assert.equal(status.running, true);
  } finally {
    await host.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects duplicate runtime module names", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-modules-duplicate-"));
  try {
    const configPath = path.join(root, "jaeger.runtime.mjs");
    await writeFile(
      configPath,
      `const module = { name: "duplicate", setup() {} }
export default { version: 1, modules: [module, module] }
`,
    );
    await assert.rejects(loadRuntimeModuleConfig(configPath), /duplicated/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for runtime module");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
