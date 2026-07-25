import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { ServiceRuntimeClient } from "../src/runtime-client.js";
import { SshRuntimeClient } from "../src/ssh-runtime-client.js";
import {
  loadRuntimeRegistry,
  provisionalSshRuntimeTarget,
  runtimeRegistryPath,
} from "../src/runtime-targets.js";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.js");

test(
  "a named SSH runtime runs pinned local source in an explicit remote workspace",
  { skip: process.platform !== "linux" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-ssh-runtime-"));
    const localHome = path.join(root, "local-home");
    const localConfig = path.join(root, "local-config");
    const remoteHome = path.join(root, "remote-home");
    const remoteConfig = path.join(root, "remote-config");
    const remoteState = path.join(root, "remote-state", "runs");
    const remoteSocket = path.join(root, "remote-runtime", "backend.sock");
    const remoteWorkspace = path.join(root, "remote-workspace");
    const bin = path.join(root, "bin");
    const argsLog = path.join(root, "ssh-args.jsonl");
    const workflow = path.join(root, "local-workflow.js");
    const movedWorkflow = `${workflow}.moved`;
    const profilePath = path.join(remoteConfig, "jaeger", "backend.json");
    const generation = "a".repeat(32);
    const instanceId = "b".repeat(32);
    await Promise.all([
      mkdir(localHome, { recursive: true, mode: 0o700 }),
      mkdir(localConfig, { recursive: true, mode: 0o700 }),
      mkdir(remoteHome, { recursive: true, mode: 0o700 }),
      mkdir(path.dirname(profilePath), { recursive: true, mode: 0o700 }),
      mkdir(remoteWorkspace, { recursive: true, mode: 0o700 }),
      mkdir(path.dirname(remoteSocket), { recursive: true, mode: 0o700 }),
      mkdir(remoteState, { recursive: true, mode: 0o700 }),
      mkdir(bin, { recursive: true, mode: 0o700 }),
    ]);
    await writeFile(
      workflow,
      `
export const meta = { name: "remote source fixture" }
phase("Remote")
return { answer: "remote" }
`,
      "utf8",
    );
    await writeFile(
      profilePath,
      `${JSON.stringify({
        version: 3,
        socketPath: remoteSocket,
        stateDir: remoteState,
        entrypoint: cliPath,
        generation,
        instanceId,
        systemctlPath: "/usr/bin/systemctl",
        installedAt: new Date().toISOString(),
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const fakeSsh = path.join(bin, "ssh");
    await writeFile(
      fakeSsh,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs"
import { spawn } from "node:child_process"
appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)) + "\\n")
const child = spawn(process.execPath, [${JSON.stringify(cliPath)}, "__rpc-stdio"], {
  stdio: "inherit",
  env: {
    ...process.env,
    HOME: ${JSON.stringify(remoteHome)},
    XDG_CONFIG_HOME: ${JSON.stringify(remoteConfig)}
  }
})
for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"]) {
  process.on(signal, () => child.kill(signal))
}
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
`,
      "utf8",
    );
    await chmod(fakeSsh, 0o755);

    const backendEnv = {
      ...process.env,
      HOME: remoteHome,
      XDG_CONFIG_HOME: remoteConfig,
      JAEGER_SOCKET: remoteSocket,
      JAEGER_STATE_DIR: remoteState,
    };
    const backend = spawn(
      process.execPath,
      [
        cliPath,
        "__backend",
        "--socket",
        remoteSocket,
        "--state-dir",
        remoteState,
        "--generation",
        generation,
        "--instance-id",
        instanceId,
        "--profile-path",
        profilePath,
      ],
      { env: backendEnv, stdio: ["ignore", "pipe", "pipe"] },
    );
    t.after(async () => {
      await stopProcess(backend);
      await rm(root, { recursive: true, force: true });
    });
    await waitForBackend(remoteSocket, generation);

    const cliEnv = {
      ...process.env,
      HOME: localHome,
      XDG_CONFIG_HOME: localConfig,
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    };
    const added = parseJson<{
      target: { name: string; instanceId: string };
      doctor: { ready: boolean };
    }>(
      (
        await cli(
          [
            "runtime",
            "add",
            "build",
            "--ssh",
            "remote-alias",
            "--default",
          ],
          cliEnv,
          root,
        )
      ).stdout,
    );
    assert.equal(added.target.name, "build");
    assert.equal(added.target.instanceId, instanceId);
    assert.equal(added.doctor.ready, true);
    assert.equal(loadRuntimeRegistry(cliEnv).runtimes.build?.destination, "remote-alias");
    assert.equal(loadRuntimeRegistry(cliEnv).defaultRuntime, "build");
    const selected = parseJson<{ defaultRuntime: string }>(
      (await cli(["runtime", "default", "--json"], cliEnv, root)).stdout,
    );
    assert.equal(selected.defaultRuntime, "build");

    const status = parseJson<{
      runtime: string;
      target: string;
      transport: string;
      backend: { active: boolean };
    }>(
      (
        await cli(
          ["status", "--json"],
          cliEnv,
          root,
        )
      ).stdout,
    );
    assert.equal(status.runtime, "ssh-service");
    assert.equal(status.target, "build");
    assert.equal(status.transport, "ssh");
    assert.equal(status.backend.active, true);

    const launched = parseJson<{
      runId: string;
      runRef: string;
      cwd: string;
      inspect: string;
      location: { runtime: string; transport: string };
    }>(
      (
        await cli(
          [
            "run",
            workflow,
            "--cwd",
            remoteWorkspace,
            "--detach",
          ],
          cliEnv,
          root,
        )
      ).stdout,
    );
    assert.equal(launched.runRef, `build:${launched.runId}`);
    assert.equal(launched.cwd, remoteWorkspace);
    assert.equal(launched.location.runtime, "build");
    assert.equal(launched.location.transport, "ssh");
    assert.equal(
      launched.inspect,
      `jaeger inspect build:${launched.runId} --summary --json`,
    );
    await rename(workflow, movedWorkflow);

    const completed = parseJson<{
      status: string;
      result: { answer: string };
      runRef: string;
    }>(
      (
        await cli(
          ["wait", `build:${launched.runId}`],
          cliEnv,
          path.join(root, "local-home"),
        )
      ).stdout,
    );
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.result, { answer: "remote" });
    assert.equal(completed.runRef, `build:${launched.runId}`);

    const record = JSON.parse(
      await readFile(path.join(remoteState, launched.runId, "run.json"), "utf8"),
    ) as {
      workflowPath: string;
      cwd: string;
      workspace: { root: string };
      runtime: { backend: string };
    };
    assert.equal(record.workflowPath, workflow);
    assert.equal(record.cwd, remoteWorkspace);
    assert.equal(record.workspace.root, remoteWorkspace);
    assert.equal(record.runtime.backend, "local-service");

    const beforeMissingCwd = (await readFile(argsLog, "utf8")).trim().split("\n").length;
    await assert.rejects(
      cli(
        ["--runtime", "build", "run", movedWorkflow, "--detach"],
        cliEnv,
        root,
      ),
      (error: unknown) =>
        commandFailure(error).includes("--cwd is required for a remote Jaeger runtime"),
    );
    const afterMissingCwd = (await readFile(argsLog, "utf8")).trim().split("\n").length;
    assert.equal(
      afterMissingCwd,
      beforeMissingCwd,
      "remote path validation must happen before opening SSH",
    );
    await assert.rejects(
      cli(
        [
          "run",
          movedWorkflow,
          "--cwd",
          "C:\\workspaces\\project",
          "--detach",
        ],
        cliEnv,
        root,
      ),
      (error: unknown) =>
        commandFailure(error).includes(
          "--cwd must be an absolute path on the remote Jaeger runtime",
        ),
    );
    const afterWindowsCwd = (await readFile(argsLog, "utf8")).trim().split("\n").length;
    assert.equal(
      afterWindowsCwd,
      beforeMissingCwd,
      "Windows controller paths must be rejected before opening SSH",
    );

    const registryPath = runtimeRegistryPath(cliEnv);
    const registryText = await readFile(registryPath, "utf8");
    await writeFile(
      registryPath,
      registryText.replace(instanceId, "d".repeat(32)),
      { mode: 0o600 },
    );
    await assert.rejects(
      cli(["--runtime", "build", "list", "--json"], cliEnv, root),
      (error: unknown) =>
        commandFailure(error).includes("does not match configured instance"),
    );

    const invocations = (await readFile(argsLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.ok(invocations.length >= 4);
    for (const invocation of invocations) {
      assert.deepEqual(invocation.slice(0, 2), ["-T", "-o"]);
      assert.ok(invocation.includes("BatchMode=yes"));
      assert.ok(invocation.includes("ForwardAgent=no"));
      assert.ok(invocation.includes("ClearAllForwardings=yes"));
      assert.deepEqual(invocation.slice(-3), [
        "remote-alias",
        "jaeger",
        "__rpc-stdio",
      ]);
    }
  },
);

test("runtime registries are private, strict, and keep SSH credentials out of Jaeger", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-runtime-registry-"));
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, "config"),
  };
  const target = runtimeRegistryPath(env);
  try {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(
      target,
      `version = 1

[runtimes.prod]
transport = "ssh"
destination = "prod-profile"
command = "/opt/jaeger/bin/jaeger"
instance_id = "${"c".repeat(32)}"
connect_timeout_seconds = 12
`,
      { mode: 0o600 },
    );
    const registry = loadRuntimeRegistry(env);
    assert.deepEqual(registry.runtimes.prod, {
      name: "prod",
      transport: "ssh",
      kind: "ssh-service",
      destination: "prod-profile",
      command: "/opt/jaeger/bin/jaeger",
      instanceId: "c".repeat(32),
      connectTimeoutSeconds: 12,
    });
    await chmod(target, 0o644);
    assert.throws(() => loadRuntimeRegistry(env), /Invalid Jaeger runtime registry/);
    await chmod(target, 0o600);
    await writeFile(
      target,
      `version = 1
[runtimes.prod]
transport = "ssh"
destination = "prod-profile"
command = "jaeger"
instance_id = "${"c".repeat(32)}"
identity_file = "/secret/key"
`,
      { mode: 0o600 },
    );
    assert.throws(() => loadRuntimeRegistry(env), /Unknown runtime prod field/);
    assert.throws(
      () =>
        provisionalSshRuntimeTarget({
          name: "prod",
          destination: "prod-profile",
          command: "jaeger; curl attacker",
        }),
      /without shell syntax/,
    );
    assert.throws(
      () =>
        provisionalSshRuntimeTarget({
          name: "prod",
          destination: "-oProxyCommand=attacker",
        }),
      /without spaces/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("aborting an attached SSH wait terminates only the transport process", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-ssh-abort-"));
  const command = path.join(root, "fake-ssh");
  const marker = path.join(root, "terminated");
  const ready = path.join(root, "ready");
  try {
    await writeFile(
      command,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs"
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(marker)}, "terminated")
  process.exit(0)
})
writeFileSync(${JSON.stringify(ready)}, "ready")
process.stdin.resume()
setInterval(() => {}, 1000)
`,
      "utf8",
    );
    await chmod(command, 0o755);
    const target = provisionalSshRuntimeTarget({
      name: "build",
      destination: "build-host",
      instanceId: "f".repeat(32),
    });
    const controller = new AbortController();
    const operation = new SshRuntimeClient(target, {
      sshCommand: command,
      retryWindowMs: 0,
    }).call(
      "run.wait",
      { runId: "20260724120000-0123456789" },
      controller.signal,
    );
    const readyDeadline = Date.now() + 2_000;
    while (Date.now() < readyDeadline) {
      try {
        assert.equal(await readFile(ready, "utf8"), "ready");
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    controller.abort(new Error("caller stopped waiting"));
    await assert.rejects(operation, /caller stopped waiting/);
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try {
        assert.equal(await readFile(marker, "utf8"), "terminated");
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    assert.fail("SSH transport did not terminate after caller abort");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function cli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return await execFileAsync(process.execPath, [cliPath, ...args], {
    env,
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 20 * 1024 * 1024,
  });
}

async function waitForBackend(socketPath: string, generation: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let failure: unknown;
  while (Date.now() < deadline) {
    try {
      await new ServiceRuntimeClient(socketPath, {
        timeoutMs: 250,
        expectedGeneration: generation,
      }).call("ping");
      return;
    } catch (error) {
      failure = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw failure;
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function commandFailure(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const record = error as { readonly message?: unknown; readonly stderr?: unknown };
  return `${String(record.message ?? "")}\n${String(record.stderr ?? "")}`;
}
