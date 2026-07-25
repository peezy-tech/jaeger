import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadRuntimeRegistry,
  provisionalSshRuntimeTarget,
  runtimeRegistryPath,
  saveRuntimeTarget,
  setDefaultRuntimeTarget,
} from "../src/runtime-targets.js";
import {
  assertLocalRuntimeSupported,
  supportsLocalRuntime,
} from "../src/platform.js";

test("Windows controllers use APPDATA for runtime targets", () => {
  assert.equal(
    runtimeRegistryPath(
      {
        APPDATA: "C:\\Users\\operator\\AppData\\Roaming",
        USERPROFILE: "C:\\Users\\operator",
      },
      "win32",
    ),
    "C:\\Users\\operator\\AppData\\Roaming\\Jaeger\\runtimes.toml",
  );
});

test("Windows controller registries persist a default SSH runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-windows-controller-"));
  const env: NodeJS.ProcessEnv = {
    XDG_CONFIG_HOME: path.join(root, "config"),
  };
  const target = provisionalSshRuntimeTarget({
    name: "build",
    destination: "build-host",
    instanceId: "a".repeat(32),
  });
  try {
    const configPath = await saveRuntimeTarget(target, {
      env,
      platform: "win32",
      makeDefault: true,
    });
    assert.equal(configPath, path.join(root, "config", "jaeger", "runtimes.toml"));
    assert.equal(loadRuntimeRegistry(env, "win32").defaultRuntime, "build");
    assert.match(await readFile(configPath, "utf8"), /^default = "build"$/m);

    await setDefaultRuntimeTarget("local", { env, platform: "win32" });
    assert.equal(loadRuntimeRegistry(env, "win32").defaultRuntime, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows is controller-only while Linux retains local runtimes", () => {
  assert.equal(supportsLocalRuntime("linux"), true);
  assert.equal(supportsLocalRuntime("win32"), false);
  assert.throws(
    () => assertLocalRuntimeSupported("Backend management", "win32"),
    /Windows installation is an SSH controller/,
  );
});
