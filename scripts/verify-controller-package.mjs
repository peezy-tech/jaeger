import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

const execFileAsync = promisify(execFile)
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jaeger-controller-package-"))
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm"

try {
  const packDir = path.join(tempRoot, "pack")
  const installDir = path.join(tempRoot, "install")
  const appData = path.join(tempRoot, "appdata")
  await Promise.all([
    mkdir(packDir),
    mkdir(installDir),
    mkdir(appData),
  ])
  const pack = JSON.parse(
    (await run(npmCommand, ["pack", "--json", "--pack-destination", packDir], root))
      .stdout,
  )
  assert.equal(pack.length, 1)
  const artifact = pack[0]
  const paths = artifact.files.map((file) => file.path)
  for (const required of [
    "AGENT_INSTALL.md",
    "dist/cli.js",
    "dist/platform.js",
    "dist/runtime-targets.js",
    "dist/ssh-runtime-client.js",
    "dist/stdio-bridge.js",
    "dist/vendor/claude-agent-sdk/LICENSE.md",
    "dist/vendor/claude-agent-sdk/package.json",
    "dist/vendor/claude-agent-sdk/README.md",
    "dist/vendor/claude-agent-sdk/sdk.mjs",
  ]) {
    assert(paths.includes(required), `controller artifact is missing ${required}`)
  }
  assert(
    !paths.some((entry) => entry.startsWith("node_modules/")),
    "nested node_modules leaked into the controller package",
  )
  assert.deepEqual(artifact.bundled, [], "npm dependency bundles leaked into controller package")

  await writeFile(
    path.join(installDir, "package.json"),
    `${JSON.stringify({ name: "jaeger-controller-artifact-test", private: true }, null, 2)}\n`,
  )
  const tarball = path.join(packDir, artifact.filename)
  await run(
    npmCommand,
    [
      "install",
      "--no-audit",
      "--no-fund",
      tarball,
    ],
    installDir,
  )
  await run(npmCommand, ["audit", "--omit=dev", "--audit-level=low"], installDir)
  const installedRoot = path.join(
    installDir,
    "node_modules",
    "@peezy.tech",
    "jaeger",
  )
  const installedPackage = JSON.parse(
    await readFile(path.join(installedRoot, "package.json"), "utf8"),
  )
  assert.equal(installedPackage.name, "@peezy.tech/jaeger")
  assert.equal(installedPackage.version, "0.1.4")
  assert.deepEqual(installedPackage.bin, { jaeger: "dist/cli.js" })
  assert.deepEqual(installedPackage.os, ["linux", "win32"])
  assert(
    !installedPackage.dependencies?.["@anthropic-ai/claude-agent-sdk"],
    "Claude Agent SDK must not expose its declaration-only peer graph at runtime",
  )
  const vendoredClaudeRoot = path.join(
    installedRoot,
    "dist",
    "vendor",
    "claude-agent-sdk",
  )
  const vendoredClaudePackage = JSON.parse(
    await readFile(path.join(vendoredClaudeRoot, "package.json"), "utf8"),
  )
  assert.equal(vendoredClaudePackage.name, "@anthropic-ai/claude-agent-sdk")
  assert.equal(vendoredClaudePackage.version, "0.3.220")
  await access(path.join(vendoredClaudeRoot, "LICENSE.md"))
  await access(path.join(vendoredClaudeRoot, "README.md"))
  await access(path.join(vendoredClaudeRoot, "sdk.mjs"))
  await access(path.join(installedRoot, "AGENT_INSTALL.md"))

  const binary = path.join(
    installDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "jaeger.cmd" : "jaeger",
  )
  const help = await run(binary, ["--help"], installDir)
  assert.match(help.stdout, /Windows\s+is supported as an SSH controller/)
  assert.match(help.stdout, /jaeger runtime default/)
  assert.match(help.stdout, /--default/)

  const runtimeList = JSON.parse(
    (
      await run(binary, ["runtime", "list", "--json"], installDir, {
        ...process.env,
        APPDATA: appData,
        XDG_CONFIG_HOME: appData,
      })
    ).stdout,
  )
  assert.equal(runtimeList.platform, process.platform)
  assert.equal(runtimeList.defaultRuntime, "local")
  assert.equal(
    runtimeList.runtimes.find((runtime) => runtime.name === "local")?.supported,
    process.platform === "linux",
  )

  process.stdout.write(
    `${JSON.stringify({
      artifact: artifact.filename,
      platform: process.platform,
      controllerCommands: [
        "--help",
        "runtime list",
      ],
    }, null, 2)}\n`,
  )
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}

async function run(command, args, cwd, env = process.env) {
  try {
    return await execFileAsync(command, args, {
      cwd,
      env,
      encoding: "utf8",
      shell: process.platform === "win32" && command.toLowerCase().endsWith(".cmd"),
      timeout: 120_000,
      maxBuffer: 20 * 1024 * 1024,
    })
  } catch (error) {
    const stdout = typeof error?.stdout === "string" ? error.stdout : ""
    const stderr = typeof error?.stderr === "string" ? error.stderr : ""
    throw new Error(
      `${command} ${args.join(" ")} failed: ${error?.message ?? String(error)}\n${stdout}\n${stderr}`,
      { cause: error },
    )
  }
}
