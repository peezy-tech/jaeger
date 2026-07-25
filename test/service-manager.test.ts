import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BackendRpcError } from "../src/backend-protocol.js";
import { LocalRuntimeService } from "../src/local-runtime-service.js";
import {
  backendInstallConfigPath,
  defaultBackendSocketPath,
  defaultPersistentStateDir,
  ensurePrivateDirectory,
  readBackendInstallConfig,
} from "../src/paths.js";
import { renderBackendUnit } from "../src/service-manager.js";

test("an installed backend profile becomes the default CLI target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-backend-profile-"));
  const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: path.join(root, "config") };
  const configPath = backendInstallConfigPath(env);
  const socketPath = path.join(root, "custom runtime", "backend.sock");
  const stateDir = path.join(root, "custom state", "runs");
  try {
    await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
    await writeFile(
      configPath,
      `${JSON.stringify({
        version: 1,
        socketPath,
        stateDir,
        entrypoint: path.join(root, "dist", "cli.js"),
        installedAt: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
    assert.equal(readBackendInstallConfig(env)?.socketPath, socketPath);
    assert.equal(defaultBackendSocketPath(env), socketPath);
    assert.equal(defaultPersistentStateDir(env), stateDir);
    assert.equal(
      defaultBackendSocketPath({ ...env, JAEGER_SOCKET: path.join(root, "override.sock") }),
      path.join(root, "override.sock"),
    );
    await chmod(configPath, 0o644);
    assert.throws(
      () => readBackendInstallConfig(env),
      /Invalid Jaeger backend configuration/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backend authority paths reject symlinked ancestors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-backend-path-trust-"));
  const actualConfigRoot = path.join(root, "actual-config");
  const linkedConfigRoot = path.join(root, "linked-config");
  const actualRuntimeRoot = path.join(root, "actual-runtime");
  const linkedRuntimeRoot = path.join(root, "linked-runtime");
  const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: linkedConfigRoot };
  const configPath = backendInstallConfigPath(env);
  try {
    await mkdir(path.join(actualConfigRoot, "jaeger"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(actualRuntimeRoot, "jaeger"), { recursive: true, mode: 0o700 });
    await symlink(actualConfigRoot, linkedConfigRoot);
    await symlink(actualRuntimeRoot, linkedRuntimeRoot);
    await writeFile(
      path.join(actualConfigRoot, "jaeger", "backend.json"),
      `${JSON.stringify({
        version: 2,
        socketPath: path.join(root, "runtime", "backend.sock"),
        stateDir: path.join(root, "state"),
        entrypoint: path.join(root, "dist", "cli.js"),
        generation: "d".repeat(32),
        systemctlPath: "/usr/bin/systemctl",
        installedAt: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
    assert.throws(
      () => readBackendInstallConfig(env),
      /Invalid Jaeger backend configuration/,
    );
    await assert.rejects(
      ensurePrivateDirectory(
        path.join(linkedRuntimeRoot, "jaeger"),
        "Jaeger backend socket directory",
      ),
      /ancestor is not a real directory/,
    );
    assert.equal(configPath, path.join(linkedConfigRoot, "jaeger", "backend.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the generated systemd unit pins executable paths and rejects control characters", () => {
  const unit = renderBackendUnit({
    entrypoint: "/opt/jaeger build/dist/cli.js",
    nodePath: "/usr/bin/node",
    socketPath: "/run/user/1000/jaeger/backend.sock",
    stateDir: "/home/user/${RUNTIME}/jaeger/runs",
    servicePath: "/opt/$TOOLS:/usr/local/bin:/usr/bin",
    systemdRunPath: "/usr/bin/systemd-run",
    systemctlPath: "/usr/bin/systemctl",
    generation: "a".repeat(32),
    instanceId: "c".repeat(32),
    profilePath: "/home/user/.config/jaeger/backend.json",
    admissionPending: true,
    compatibilitySocketPath: "/run/user/1000/jaeger/previous.sock",
    harnessConfigPath: "/home/user/config/100% harnesses.json",
    hooksConfigPath: "/home/user/config/hooks.toml",
  });
  assert.match(unit, /^\[Unit\]/);
  assert.match(unit, /ExecStart="[^"]+" "\/opt\/jaeger build\/dist\/cli\.js"/);
  assert.match(unit, /100%% harnesses\.json/);
  assert.match(unit, /--hooks-config/);
  assert.match(unit, /hooks\.toml/);
  assert.match(unit, /--compat-socket/);
  assert.match(unit, /previous\.sock/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /UMask=0077/);
  assert.match(unit, /JAEGER_SYSTEMD_RUN=\/usr\/bin\/systemd-run/);
  assert.match(unit, /JAEGER_SYSTEMCTL=\/usr\/bin\/systemctl/);
  assert.match(unit, /\$\$\{RUNTIME\}/);
  assert.match(unit, /PATH=\/opt\/\$TOOLS:/);
  assert.doesNotMatch(unit, /PATH=\/opt\/\$\$TOOLS:/);
  assert.match(unit, /--generation/);
  assert.match(unit, /--instance-id/);
  assert.match(unit, new RegExp("c{32}"));
  assert.match(unit, /--profile-path/);
  assert.match(unit, /--admission-pending/);
  assert.doesNotMatch(unit, /After=default\.target/);
  assert.match(unit, /WantedBy=default\.target/);
  assert.throws(
    () =>
      renderBackendUnit({
        entrypoint: "/opt/jaeger\nmalicious",
        nodePath: "/usr/bin/node",
        socketPath: "/run/user/1000/jaeger/backend.sock",
        stateDir: "/tmp/state",
        servicePath: "/usr/bin",
        systemdRunPath: "/usr/bin/systemd-run",
        systemctlPath: "/usr/bin/systemctl",
        generation: "b".repeat(32),
        instanceId: "d".repeat(32),
        profilePath: "/home/user/.config/jaeger/backend.json",
      }),
    /forbidden control character/,
  );
});

test("a managed backend rejects work until its exact generation profile commits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-backend-generation-"));
  const profilePath = path.join(root, "config", "jaeger", "backend.json");
  const stateDir = path.join(root, "state", "runs");
  const generation = "c".repeat(32);
  const instanceId = "e".repeat(32);
  const entrypoint = path.join(root, "dist", "cli.js");
  const service = new LocalRuntimeService({
    stateDir,
    entrypoint,
    backendKind: "local-service",
    installGeneration: generation,
    installInstanceId: instanceId,
    installProfilePath: profilePath,
  });
  try {
    const pending = await service.dispatch("ping", {});
    assert.equal((pending as { backend?: { admissionReady?: boolean } }).backend?.admissionReady, false);
    await assert.rejects(
      service.dispatch("run.list", {}),
      (error: unknown) =>
        error instanceof BackendRpcError && error.code === "backend_install_pending",
    );
    await mkdir(path.dirname(profilePath), { recursive: true, mode: 0o700 });
    await writeFile(
      profilePath,
      `${JSON.stringify({
        version: 3,
        socketPath: path.join(root, "runtime", "backend.sock"),
        stateDir,
        entrypoint,
        generation,
        instanceId,
        systemctlPath: "/usr/bin/systemctl",
        installedAt: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
    const ready = await service.dispatch("ping", {});
    assert.equal((ready as { backend?: { admissionReady?: boolean } }).backend?.admissionReady, true);
    assert.equal((ready as { backend?: { instanceId?: string } }).backend?.instanceId, instanceId);
    assert.deepEqual(await service.dispatch("run.list", {}), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
