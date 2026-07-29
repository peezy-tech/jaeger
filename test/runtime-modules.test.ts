import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { initialize, resolve } from "../src/runtime-module-loader.js";
import {
  loadRuntimeModuleConfig,
  RuntimeModuleHost,
  type RuntimeModule,
  type RuntimeModuleConfig,
  type RuntimeModuleOperations,
} from "../src/runtime-modules.js";
import type { JsonValue } from "../src/types.js";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.js");

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

test("the loader hook honors every registered runtime project root", async () => {
  const first = path.join(os.tmpdir(), "jaeger-loader-first");
  const second = path.join(os.tmpdir(), "jaeger-loader-second");
  initialize({ root: first });
  initialize({ root: second });

  const nextResolve = (specifier: string) => ({ url: specifier, shortCircuit: true });
  const resolveChild = async (parentRoot: string, digest: string, child: string) =>
    (
      await resolve(
        pathToFileURL(child).href,
        {
          conditions: ["node", "import"],
          importAttributes: {},
          parentURL: `${pathToFileURL(path.join(parentRoot, "jaeger.runtime.mjs")).href}?jaeger-runtime-digest=${digest}`,
        },
        nextResolve,
      )
    ).url;

  const firstDigest = "a".repeat(64);
  const secondDigest = "b".repeat(64);
  assert.match(
    await resolveChild(first, firstDigest, path.join(first, "modules", "fixture.mjs")),
    new RegExp(`jaeger-runtime-digest=${firstDigest}$`),
  );
  assert.match(
    await resolveChild(second, secondDigest, path.join(second, "modules", "fixture.mjs")),
    new RegExp(`jaeger-runtime-digest=${secondDigest}$`),
  );
  assert.doesNotMatch(
    await resolveChild(first, firstDigest, path.join(os.tmpdir(), "outside-fixture.mjs")),
    /jaeger-runtime-digest/,
  );
});

test("modules validate reads the local project for every runtime selection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-modules-validate-"));
  try {
    const configPath = path.join(root, "jaeger.runtime.mjs");
    await writeFile(configPath, `export default { version: 1, modules: [] }\n`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_STATE_HOME: path.join(root, "state"),
    };
    delete env.JAEGER_RUNTIME;

    const selections: readonly (readonly string[])[] = [
      ["modules", "validate", configPath, "--json"],
      ["--runtime", "prod", "modules", "validate", configPath, "--json"],
    ];
    const digests: string[] = [];
    for (const argv of selections) {
      const { stdout } = await execFileAsync(process.execPath, [cliPath, ...argv], {
        cwd: root,
        env,
      });
      const result = JSON.parse(stdout) as { valid: boolean; digest: string };
      assert.equal(result.valid, true);
      digests.push(result.digest);
    }
    const viaEnvironment = await execFileAsync(
      process.execPath,
      [cliPath, "modules", "validate", configPath, "--json"],
      { cwd: root, env: { ...env, JAEGER_RUNTIME: "prod" } },
    );
    digests.push((JSON.parse(viaEnvironment.stdout) as { digest: string }).digest);

    assert.match(String(digests[0]), /^[a-f0-9]{64}$/);
    assert.equal(new Set(digests).size, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("modules mutation options cannot be consumed as the --root value", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-modules-root-option-"));
  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [cliPath, "modules", "sync", "--root", "--dry-run"],
        { cwd: root },
      ),
      /--root requires a value/,
    );
    await assert.rejects(
      readFile(path.join(root, "--dry-run", "package.json")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime config generations receive distinct durable consumer identities", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-modules-consumer-"));
  const module: RuntimeModule = {
    name: "fixture",
    setup(runtime) {
      runtime.events.consume("run.terminal", async () => {});
    },
  };
  try {
    for (const digest of ["a".repeat(64), "b".repeat(64)]) {
      const host = new RuntimeModuleHost({
        stateDir: root,
        config: {
          version: 1,
          path: path.join(root, "jaeger.runtime.mjs"),
          digest,
          modules: [module],
        },
        operations,
      });
      await host.initialize();
      await host.stop();
    }
    assert.deepEqual(
      (
        await readdir(path.join(root, ".modules", "fixture", "events"))
      ).sort(),
      [
        `fixture-1-${"a".repeat(16)}`,
        `fixture-1-${"b".repeat(16)}`,
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime config changes preserve pending event retries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-modules-retry-config-"));
  const stateDir = path.join(root, "state");
  const eventsDir = path.join(stateDir, ".hooks", "events");
  const eventId = `evt-${"c".repeat(64)}`;
  await mkdir(eventsDir, { recursive: true });
  await writeFile(
    path.join(eventsDir, `${eventId}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      id: eventId,
      type: "run.terminal",
      occurredAt: "2026-07-25T00:00:00.000Z",
      observedAt: "2026-07-25T00:00:00.000Z",
      run: { runId: "20260725000000-cccccccccc" },
      subject: { status: "completed" },
    })}\n`,
  );
  let now = new Date("2026-07-25T00:00:00.000Z");
  let attempts = 0;
  const config = (digest: string, fail: boolean): RuntimeModuleConfig => ({
    version: 1,
    path: path.join(root, "jaeger.runtime.mjs"),
    digest,
    modules: [{
      name: "fixture",
      setup(runtime) {
        runtime.events.consume("run.terminal", async () => {
          attempts++;
          if (fail) throw new Error("retry after restart");
        });
      },
    }],
  });
  const first = new RuntimeModuleHost({
    stateDir,
    config: config("a".repeat(64), true),
    operations,
    tickIntervalMs: 10,
    now: () => now,
  });
  let second: RuntimeModuleHost | undefined;
  try {
    await first.initialize();
    first.start();
    await waitFor(() => attempts === 1);
    await first.stop();

    now = new Date(now.getTime() + 2_000);
    second = new RuntimeModuleHost({
      stateDir,
      config: config("b".repeat(64), false),
      operations,
      tickIntervalMs: 10,
      now: () => now,
    });
    await second.initialize();
    second.start();
    await waitFor(() => attempts === 2);
    await second.stop();

    const delivery = JSON.parse(
      await readFile(
        path.join(
          stateDir,
          ".modules",
          "fixture",
          "events",
          `fixture-1-${"b".repeat(16)}`,
          `${eventId}.json`,
        ),
        "utf8",
      ),
    ) as Record<string, JsonValue>;
    assert.equal(delivery.status, "delivered");
    assert.equal(delivery.attempts, 2);
  } finally {
    await second?.stop();
    await first.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime config handoff preserves delivered events and claims unscanned events", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-modules-config-handoff-"));
  const stateDir = path.join(root, "state");
  const eventsDir = path.join(stateDir, ".hooks", "events");
  const deliveredEventId = `evt-${"a".repeat(64)}`;
  const unscannedEventId = `evt-${"b".repeat(64)}`;
  await mkdir(eventsDir, { recursive: true });
  let now = new Date("2026-07-25T00:00:00.000Z");
  const writeEvent = async (eventId: string): Promise<void> => {
    await writeFile(
      path.join(eventsDir, `${eventId}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        id: eventId,
        type: "run.terminal",
        occurredAt: now.toISOString(),
        observedAt: now.toISOString(),
        run: { runId: "20260725000000-dddddddddd" },
        subject: { status: "completed" },
      })}\n`,
    );
  };
  await writeEvent(deliveredEventId);
  const handled: string[] = [];
  const config = (digest: string): RuntimeModuleConfig => ({
    version: 1,
    path: path.join(root, "jaeger.runtime.mjs"),
    digest,
    modules: [{
      name: "fixture",
      setup(runtime) {
        runtime.events.consume("run.terminal", async (event) => {
          handled.push(event.id);
        });
      },
    }],
  });
  const first = new RuntimeModuleHost({
    stateDir,
    config: config("a".repeat(64)),
    operations,
    tickIntervalMs: 10,
    now: () => now,
  });
  let second: RuntimeModuleHost | undefined;
  try {
    await first.initialize();
    first.start();
    await waitFor(() => handled.includes(deliveredEventId));
    await first.stop();

    now = new Date("2026-07-25T00:00:01.000Z");
    await writeEvent(unscannedEventId);
    now = new Date("2026-07-25T00:00:02.000Z");
    second = new RuntimeModuleHost({
      stateDir,
      config: config("b".repeat(64)),
      operations,
      tickIntervalMs: 10,
      now: () => now,
    });
    await second.initialize();
    second.start();
    await waitFor(() => handled.includes(unscannedEventId));
    await second.stop();

    assert.deepEqual(handled, [deliveredEventId, unscannedEventId]);
    for (const eventId of [deliveredEventId, unscannedEventId]) {
      const delivery = JSON.parse(
        await readFile(
          path.join(
            stateDir,
            ".modules",
            "fixture",
            "events",
            `fixture-1-${"b".repeat(16)}`,
            `${eventId}.json`,
          ),
          "utf8",
        ),
      ) as Record<string, JsonValue>;
      assert.equal(delivery.status, "delivered");
      assert.equal(delivery.attempts, 1);
    }
  } finally {
    await second?.stop();
    await first.stop();
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
