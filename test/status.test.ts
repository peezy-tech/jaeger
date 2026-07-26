import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { renderStatus, type JaegerStatus } from "../src/status.js";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.js");

test("status renderer produces a neofetch-style operational overview", () => {
  const rendered = renderStatus(statusFixture());

  assert.match(rendered, /JAEGER/);
  assert.match(rendered, /Version\s+0\.1\.1 · Node v24\.0\.0/);
  assert.match(rendered, /Harnesses\s+2\/2 available/);
  assert.match(rendered, /codex · codex-cli 1\.2\.3/);
  assert.match(rendered, /Workflows\s+1 active · 7 recorded/);
  assert.match(rendered, /Schedules\s+2 active · 1 paused · 3 configured/);
  assert.match(rendered, /Environment\s+default · 4 resources · 1 plugins/);
  assert.match(rendered, /jaeger status --json/);
  assert.doesNotMatch(rendered, /\u001b\[/);
});

test("bare CLI renders status while explicit help retains command documentation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-status-cli-"));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  for (const [name, version] of [
    ["codex", "codex fixture 1.0"],
    ["claude", "claude fixture 2.0"],
  ] as const) {
    const target = path.join(bin, name);
    await writeFile(
      target,
      `#!/bin/sh\nprintf '%s\\n' '${version}'\n`,
      "utf8",
    );
    await chmod(target, 0o755);
  }
  const env = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"),
    JAEGER_RUNTIME: "embedded",
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    NO_COLOR: "1",
  };

  const bare = await execFileAsync(process.execPath, [cliPath], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.match(bare.stdout, /JAEGER/);
  assert.match(bare.stdout, /codex fixture 1\.0/);
  assert.doesNotMatch(bare.stdout, /^Jaeger prompt-first/m);

  const jsonResult = await execFileAsync(process.execPath, [cliPath, "status", "--json"], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  const status = JSON.parse(jsonResult.stdout) as JaegerStatus;
  assert.equal(status.runtime, "embedded");
  assert.equal(status.backend.active, true);
  assert.deepEqual(
    status.harnesses.map(({ name, available }) => ({ name, available })),
    [
      { name: "codex", available: true },
      { name: "claude", available: true },
    ],
  );

  const help = await execFileAsync(process.execPath, [cliPath, "--help"], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.match(help.stdout, /^Jaeger prompt-first cross-harness workflows/);
  assert.match(help.stdout, /jaeger status \[--json\]/);
});

function statusFixture(): JaegerStatus {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-23T00:00:00.000Z",
    version: "0.1.1",
    node: "v24.0.0",
    host: "workstation",
    runtime: "local-service",
    target: "local",
    transport: "local",
    backend: {
      active: true,
      connected: true,
      pid: 123,
      version: "0.1.1",
      stateDir: "/tmp/jaeger",
    },
    harnesses: [
      {
        name: "codex",
        transport: "codex-app-server",
        available: true,
        version: "codex-cli 1.2.3",
      },
      {
        name: "claude",
        transport: "claude-agent-sdk",
        available: true,
        version: "claude 4.5.6",
      },
    ],
    workflows: {
      total: 7,
      active: 1,
      sessions: { running: 1, idle: 2 },
      current: [{ runId: "20260723000000-0123456789", status: "running", phase: "Review" }],
    },
    schedules: {
      total: 3,
      active: 2,
      paused: 1,
      names: ["daily-review", "weekly-report", "paused-job"],
    },
    environment: {
      name: "default",
      resources: 4,
      plugins: 1,
      appliedAt: "2026-07-23T00:00:00.000Z",
    },
    warnings: [],
  };
}
