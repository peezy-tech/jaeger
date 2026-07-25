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
      },
    })}\n`,
  );

  const definitions = await loadHarnessDefinitions(configPath);
  assert.deepEqual(definitions.map((definition) => definition.name), [
    "codex",
    "claude",
    "gateway-claude",
  ]);
  const adapters = harnessesFromDefinitions(definitions);
  const custom = adapters.get("gateway-claude");
  assert.equal(custom?.driver, "claude-agent-sdk");
  assert.equal(custom?.name, "gateway-claude");
  assert.throws(
    () => custom?.validateOptions?.({ harness: "gateway-claude", profile: "review" }),
    /does not support the Codex profile option/,
  );
});

test("pins every service harness launcher to an absolute executable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-harness-pinning-"));
  const bin = path.join(root, "bin");
  const configPath = path.join(root, "harnesses.json");
  await mkdir(bin);
  for (const command of ["codex", "claude", "gateway"]) {
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
    [path.join(bin, "codex"), path.join(bin, "claude"), path.join(bin, "gateway")],
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
