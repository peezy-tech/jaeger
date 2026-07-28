import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  builtinHarnessDefinitions,
  harnessesFromDefinitions,
  loadHarnessDefinitions,
  pinHarnessDefinitions,
  validateHarnessDefinitions,
} from "../src/harnesses/registry.js";

test("loads custom harness surfaces without replacing built-in drivers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-harness-registry-"));
  const configPath = path.join(root, "harnesses.json");
  await writeFile(
    configPath,
    `${JSON.stringify({
      version: 1,
      harnesses: {
        "gateway-claude": {
          driver: "claude-agent-sdk",
          command: "/opt/acme/bin/claude-gateway",
          description: "Acme gateway",
        },
        "gateway-pi": {
          driver: "pi-rpc",
          command: "/opt/acme/bin/pi-gateway",
          description: "Pi through the Acme gateway",
        },
      },
    })}\n`,
  );

  const definitions = await loadHarnessDefinitions(configPath);
  assert.deepEqual(definitions.map((definition) => definition.name), [
    "codex",
    "claude",
    "pi",
    "gateway-claude",
    "gateway-pi",
  ]);
  const adapters = harnessesFromDefinitions(definitions);
  const custom = adapters.get("gateway-claude");
  assert.equal(custom?.driver, "claude-agent-sdk");
  assert.equal(custom?.name, "gateway-claude");
  assert.throws(
    () => custom?.validateOptions?.({ harness: "gateway-claude", profile: "review" }),
    /does not support the Codex profile option/,
  );
  assert.equal(adapters.get("gateway-pi")?.driver, "pi-rpc");
  assert.equal(adapters.get("gateway-pi")?.name, "gateway-pi");
});

test("pins every service harness launcher to an absolute executable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-harness-pinning-"));
  const bin = path.join(root, "bin");
  const configPath = path.join(root, "harnesses.json");
  await mkdir(bin);
  for (const command of ["codex", "claude", "pi", "gateway"]) {
    const executable = path.join(bin, command);
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);
  }
  await writeFile(
    configPath,
    `${JSON.stringify({
      version: 1,
      harnesses: {
        gateway: { driver: "codex-app-server", command: "gateway" },
      },
    })}\n`,
  );

  const pinned = await pinHarnessDefinitions(await loadHarnessDefinitions(configPath), {
    PATH: bin,
  });
  assert.deepEqual(
    pinned.map((definition) => definition.command),
    [
      path.join(bin, "codex"),
      path.join(bin, "claude"),
      path.join(bin, "pi"),
      path.join(bin, "gateway"),
    ],
  );
  assert.equal(harnessesFromDefinitions(pinned).get("codex")?.name, "codex");
});

test("rejects malformed custom definitions and built-in replacement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-harness-invalid-"));
  const configPath = path.join(root, "harnesses.json");
  await writeFile(
    configPath,
    `${JSON.stringify({
      version: 1,
      harnesses: {
        codex: { driver: "claude-agent-sdk", command: "replacement" },
      },
    })}\n`,
  );
  await assert.rejects(loadHarnessDefinitions(configPath), /cannot replace built-in harness codex/);

  assert.throws(
    () => validateHarnessDefinitions([
      ...builtinHarnessDefinitions(),
      { name: "Invalid Name", driver: "claude-agent-sdk", command: "launcher" },
    ]),
    /agent harness must start with a lowercase letter/,
  );
});

test("historical pinned registries remain valid when newer built-ins are added", () => {
  const historical = builtinHarnessDefinitions().filter(
    (definition) => definition.name !== "pi",
  );
  assert.throws(
    () => validateHarnessDefinitions(historical),
    /Built-in harness pi cannot be replaced/,
  );
  assert.deepEqual(
    validateHarnessDefinitions(historical, {
      allowPinnedBuiltins: true,
      allowMissingBuiltins: true,
    }).map((definition) => definition.name),
    ["codex", "claude"],
  );
  assert.throws(
    () =>
      validateHarnessDefinitions(
        [
          ...historical,
          { name: "pi", driver: "codex-app-server", command: "/usr/bin/pi" },
        ],
        { allowPinnedBuiltins: true, allowMissingBuiltins: true },
      ),
    /Built-in harness pi cannot be replaced/,
  );
});

test("pinning omits unavailable built-ins without weakening custom launchers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-harness-optional-"));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const codex = path.join(bin, "codex");
  await writeFile(codex, "#!/bin/sh\nexit 0\n");
  await chmod(codex, 0o755);

  const pinned = await pinHarnessDefinitions(builtinHarnessDefinitions(), {
    PATH: bin,
  });
  assert.deepEqual(
    pinned.map((definition) => definition.name),
    ["codex"],
  );

  await assert.rejects(
    pinHarnessDefinitions(
      [
        ...builtinHarnessDefinitions(),
        {
          name: "required-custom",
          driver: "pi-rpc",
          command: "missing-custom",
        },
      ],
      { PATH: bin },
    ),
    /Cannot pin unavailable harness command: missing-custom/,
  );
});
