import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
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

const execFileAsync = promisify(execFile);

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

test("the Windows controller rejects local module project management", async () => {
  const cliPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../src/cli.js",
  );
  const appData = await mkdtemp(path.join(os.tmpdir(), "jaeger-windows-modules-"));
  const script = `
    Object.defineProperty(process, "platform", { value: "win32" });
    process.argv = [
      process.execPath,
      ${JSON.stringify(cliPath)},
      "modules",
      "list",
      "--root",
      "C:\\\\runtime"
    ];
    await import(${JSON.stringify(pathToFileURL(cliPath).href)});
  `;

  try {
    await assert.rejects(
      execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
        env: {
          ...process.env,
          APPDATA: appData,
          JAEGER_RUNTIME: "local",
        },
      }),
      (error: unknown) => {
        if (typeof error !== "object" || error === null) return false;
        const stderr = "stderr" in error ? String(error.stderr) : "";
        assert.match(stderr, /Module project management is available only on a Linux/);
        assert.match(stderr, /Windows installation is an SSH controller/);
        return true;
      },
    );
  } finally {
    await rm(appData, { recursive: true, force: true });
  }
});
