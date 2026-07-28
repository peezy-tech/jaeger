import assert from "node:assert/strict";
import { access, mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  runHarnessProcess,
  spawnStreamingHarnessProcess,
} from "../src/harnesses/process.js";

test("a missing systemd-run launcher rejects without an unhandled child error", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-process-missing-launcher-"));
  const transcriptDir = path.join(root, "transcript");
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = path.join(root, "missing-bin");
    await assert.rejects(
      runHarnessProcess({
        command: process.execPath,
        args: ["-e", "process.stdout.write('wrong')"],
        cwd: root,
        stdin: "",
        timeoutMs: 1_000,
        transcriptDir,
        killGraceMs: 25,
      }),
      /spawn systemd-run ENOENT/,
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
  await assert.rejects(access(path.join(transcriptDir, "process.json")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(transcriptDir, "stdout.log"), "utf8"), "");
  assert.equal(await readFile(path.join(transcriptDir, "stderr.log"), "utf8"), "");
});

test("transcripts are observable while the provider is still running", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-process-live-transcript-"));
  const transcriptDir = path.join(root, "transcript");
  const provider = `
process.stdout.write("partial\\n")
setTimeout(() => {
  process.stdout.write("complete\\n")
}, 500)
`;
  let settled = false;
  const running = runHarnessProcess({
    command: process.execPath,
    args: ["-e", provider],
    cwd: root,
    stdin: "",
    timeoutMs: 5_000,
    transcriptDir,
  });
  void running.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  await waitForText(path.join(transcriptDir, "stdout.log"), "partial\n", 400);
  assert.equal(settled, false);
  const result = await running;
  assert.equal(result.stdout, "partial\ncomplete\n");
  assert.equal(await readFile(result.stdoutPath, "utf8"), result.stdout);
});

test("streaming protocol clients can parse stdout without transcript amplification", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-process-protocol-"));
  const transcriptDir = path.join(root, "transcript");
  const running = spawnStreamingHarnessProcess({
    command: process.execPath,
    args: [
      "-e",
      'process.stdout.write("x".repeat(8 * 1024)); process.stderr.write("kept\\n")',
    ],
    cwd: root,
    transcriptDir,
    recordStdout: false,
    maxOutputBytes: 1_024,
  });
  const result = await running.done;

  assert.equal(result.exitCode, 0);
  assert.equal(await readFile(result.stdoutPath, "utf8"), "");
  assert.equal(await readFile(result.stderrPath, "utf8"), "kept\n");
});

test("normal completion empties the scope even when a descendant starts a new session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-process-detached-descendant-"));
  const marker = path.join(root, "detached-descendant-survived");
  const transcriptDir = path.join(root, "transcript");
  const descendant = `
const fs = require("node:fs")
setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, "survived"), 500)
setInterval(() => {}, 1_000)
`;
  const provider = `
const { spawn } = require("node:child_process")
const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {
  detached: true,
  stdio: "ignore",
})
child.unref()
process.stdout.write("provider-complete\\n")
`;

  const result = await runHarnessProcess({
    command: process.execPath,
    args: ["-e", provider],
    cwd: root,
    stdin: "",
    timeoutMs: 5_000,
    transcriptDir,
  });
  assert.equal(result.stdout, "provider-complete\n");
  await delay(650);
  await assert.rejects(access(marker), { code: "ENOENT" });
});

test("timeout kills the provider process group including descendants", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-process-timeout-"));
  const marker = path.join(root, "descendant-survived");
  const transcriptDir = path.join(root, "transcript");
  const descendant = `
const fs = require("node:fs")
process.on("SIGTERM", () => {})
setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, "survived"), 500)
setInterval(() => {}, 1_000)
`;
  const provider = `
const { spawn } = require("node:child_process")
process.stdout.on("error", () => {})
process.on("SIGTERM", () => process.stdout.write("late".repeat(256 * 1024)))
spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" })
process.stdout.write("spawned\\n")
setInterval(() => {}, 1_000)
`;

  await assert.rejects(
    runHarnessProcess({
      command: process.execPath,
      args: ["-e", provider],
      cwd: root,
      stdin: "",
      timeoutMs: 150,
      transcriptDir,
      killGraceMs: 100,
    }),
    /timed out after 150ms/,
  );
  await delay(650);
  await assert.rejects(access(marker), { code: "ENOENT" });
  assert.equal(await readFile(path.join(transcriptDir, "stdout.log"), "utf8"), "spawned\n");
  assert.equal(await readFile(path.join(transcriptDir, "stderr.log"), "utf8"), "");
});

test("output cap bounds the transcript and kills descendants", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-process-cap-"));
  const marker = path.join(root, "descendant-survived");
  const transcriptDir = path.join(root, "transcript");
  const descendant = `
const fs = require("node:fs")
setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, "survived"), 500)
setInterval(() => {}, 1_000)
`;
  const provider = `
const { spawn } = require("node:child_process")
spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" })
process.stdout.write("x".repeat(8 * 1024))
setInterval(() => {}, 1_000)
`;

  await assert.rejects(
    runHarnessProcess({
      command: process.execPath,
      args: ["-e", provider],
      cwd: root,
      stdin: "",
      timeoutMs: 5_000,
      transcriptDir,
      maxOutputBytes: 1_024,
      killGraceMs: 100,
    }),
    /exceeded the 1024 byte output limit/,
  );
  await delay(650);
  await assert.rejects(access(marker), { code: "ENOENT" });
  assert.equal((await stat(path.join(transcriptDir, "stdout.log"))).size, 1_024);
  assert.equal((await stat(path.join(transcriptDir, "stderr.log"))).size, 0);
});

test("output cap is shared across stdout and stderr", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-process-shared-cap-"));
  const transcriptDir = path.join(root, "transcript");
  const provider = `
process.stdout.write("o".repeat(700))
process.stderr.write("e".repeat(700))
setInterval(() => {}, 1_000)
`;

  await assert.rejects(
    runHarnessProcess({
      command: process.execPath,
      args: ["-e", provider],
      cwd: root,
      stdin: "",
      timeoutMs: 5_000,
      transcriptDir,
      maxOutputBytes: 1_024,
      killGraceMs: 100,
    }),
    /exceeded the 1024 byte output limit/,
  );
  const stdoutSize = (await stat(path.join(transcriptDir, "stdout.log"))).size;
  const stderrSize = (await stat(path.join(transcriptDir, "stderr.log"))).size;
  assert.equal(stdoutSize + stderrSize, 1_024);
});

test("AbortSignal kills the provider process group and persists partial transcripts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-process-abort-"));
  const marker = path.join(root, "descendant-survived");
  const transcriptDir = path.join(root, "transcript");
  const descendant = `
const fs = require("node:fs")
setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, "survived"), 500)
setInterval(() => {}, 1_000)
`;
  const provider = `
const { spawn } = require("node:child_process")
spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" })
process.stderr.write("before abort\\n")
setInterval(() => {}, 1_000)
`;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150).unref();

  await assert.rejects(
    runHarnessProcess({
      command: process.execPath,
      args: ["-e", provider],
      cwd: root,
      stdin: "",
      timeoutMs: 5_000,
      transcriptDir,
      signal: controller.signal,
      killGraceMs: 100,
    }),
    /was aborted/,
  );
  await delay(650);
  await assert.rejects(access(marker), { code: "ENOENT" });
  assert.equal(await readFile(path.join(transcriptDir, "stderr.log"), "utf8"), "before abort\n");
});

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitForText(filePath: string, expected: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(filePath, "utf8")) === expected) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await delay(10);
  }
  assert.fail(`did not observe ${JSON.stringify(expected)} in ${filePath}`);
}
