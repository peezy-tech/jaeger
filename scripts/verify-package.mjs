import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { satisfies } from "semver"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

const execFileAsync = promisify(execFile)
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const sourcePackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
const skillPath = path.join(root, "skills", "jaeger-workflows", "SKILL.md")
const agentInstallPath = path.join(root, "AGENT_INSTALL.md")
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jaeger-package-"))
let installedBackend

try {
  await verifySourceSkill()
  await verifyAgentInstallRunbook()
  const validatedExamples = await validateExamples()

  const packDir = path.join(tempRoot, "pack")
  const installDir = path.join(tempRoot, "install")
  await Promise.all([mkdir(packDir), mkdir(installDir)])

  const pack = await run("npm", ["pack", "--json", "--pack-destination", packDir], root)
  const packResult = JSON.parse(pack.stdout.trim())
  assert.equal(packResult.length, 1, "npm pack should produce exactly one artifact")

  const artifact = packResult[0]
  const paths = artifact.files.map((file) => file.path).sort()
  const tarball = path.join(packDir, artifact.filename)

  for (const required of [
    "AGENT_INSTALL.md",
    "SECURITY.md",
    "THIRD_PARTY_NOTICES.md",
    "dist/admission.js",
    "dist/cli.js",
    "dist/environments.js",
    "dist/backend-server.js",
    "dist/hook-config.js",
    "dist/hooks.js",
    "dist/harnesses/registry.js",
    "dist/index.js",
    "dist/launchers.js",
    "dist/local-runtime-service.js",
    "dist/module-registry.js",
    "dist/paths.js",
    "dist/path-trust.js",
    "dist/process-lease.js",
    "dist/runtime-client.js",
    "dist/runtime-modules.js",
    "dist/schedules.js",
    "dist/session-queries.js",
    "dist/session-turns.js",
    "dist/service-manager.js",
    "dist/status.js",
    "dist/submission-index.js",
    "dist/vendor/claude-agent-sdk/LICENSE.md",
    "dist/vendor/claude-agent-sdk/package.json",
    "dist/vendor/claude-agent-sdk/README.md",
    "dist/vendor/claude-agent-sdk/sdk.mjs",
    "docs/design/codex-realtime-voice-module.md",
    "docs/design/jaeger-runtime-modules.md",
    "docs/design/jaeger-workflows.md",
    "schemas/jaeger.module.schema.json",
    "schemas/jaeger.registry.schema.json",
    "jaeger.registry.json",
    "examples/runtime-modules/telegram/README.md",
    "examples/runtime-modules/telegram/jaeger.module.json",
    "examples/runtime-modules/telegram/jaeger.runtime.mjs",
    "examples/runtime-modules/telegram/package-lock.json",
    "examples/runtime-modules/telegram/package.json",
    "examples/runtime-modules/telegram/telegram.mjs",
    "examples/runtime-modules/voice-spike/README.md",
    "examples/runtime-modules/voice-spike/jaeger.module.json",
    "examples/runtime-modules/voice-spike/server.mjs",
    "examples/runtime-modules/voice-spike/public/app.js",
    "examples/mixed-review.js",
    "examples/backend-smoke.schedule.toml",
    "skills/jaeger-workflows/SKILL.md",
    "skills/jaeger-workflows/agents/openai.yaml",
  ]) {
    assert(paths.includes(required), `packed artifact is missing ${required}`)
  }

  assert.deepEqual(
    paths.filter((entry) => entry.endsWith("/SKILL.md")),
    ["skills/jaeger-workflows/SKILL.md"],
    "packed artifact must contain exactly one skill",
  )
  assert(!paths.some((entry) => entry.startsWith("src/")), "source tree leaked into package")
  assert(!paths.some((entry) => entry.startsWith("test/")), "test tree leaked into package")
  assert(!paths.some((entry) => entry.startsWith(".test-dist/")), "test build leaked into package")
  assert(!paths.some((entry) => entry.startsWith("dist/src/")), "stale nested build tree leaked into package")
  assert(
    !paths.some((entry) => entry.startsWith("node_modules/")),
    "nested node_modules leaked into package",
  )
  assert.deepEqual(artifact.bundled, [], "npm dependency bundles leaked into package")

  await writeFile(
    path.join(installDir, "package.json"),
    `${JSON.stringify({ name: "jaeger-artifact-test", private: true }, null, 2)}\n`,
  )
  await run(
    "npm",
    ["install", "--no-audit", "--no-fund", tarball],
    installDir,
  )
  await run("npm", ["audit", "--omit=dev", "--audit-level=low"], installDir)

  const installedRoot = path.join(
    installDir,
    "node_modules",
    "@peezy.tech",
    "jaeger",
  )
  const installedPackage = JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8"))
  assert.equal(installedPackage.name, "@peezy.tech/jaeger")
  assert.equal(installedPackage.version, sourcePackage.version)
  assert.deepEqual(installedPackage.bin, { jaeger: "dist/cli.js" })
  assert(installedPackage.dependencies?.typescript, "typescript must be a runtime dependency")
  assert(installedPackage.dependencies?.mdcsp, "mdcsp must be a runtime dependency")
  assert(
    !installedPackage.dependencies?.["@anthropic-ai/claude-agent-sdk"],
    "Claude Agent SDK must not expose its declaration-only peer graph at runtime",
  )
  assert.deepEqual(
    installedPackage.os,
    ["linux", "win32"],
    "artifact must support Linux runtime hosts and Windows SSH controllers",
  )
  await access(path.join(installDir, "node_modules", "typescript", "package.json"))
  const installedMdcsp = JSON.parse(
    await readFile(path.join(installDir, "node_modules", "mdcsp", "package.json"), "utf8"),
  )
  assert.equal(installedMdcsp.name, "mdcsp")
  assert(
    satisfies(installedMdcsp.version, installedPackage.dependencies.mdcsp),
    `installed mdcsp@${installedMdcsp.version} must satisfy ${installedPackage.dependencies.mdcsp}`,
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
  assert.equal(
    vendoredClaudePackage.version,
    sourcePackage.devDependencies["@anthropic-ai/claude-agent-sdk"],
  )
  await access(path.join(vendoredClaudeRoot, "LICENSE.md"))
  await access(path.join(vendoredClaudeRoot, "README.md"))
  await access(path.join(vendoredClaudeRoot, "sdk.mjs"))
  assert.doesNotMatch(
    await readFile(path.join(installedRoot, "dist", "harnesses", "claude.d.ts"), "utf8"),
    /@anthropic-ai\/claude-agent-sdk/,
    "public declarations must not require the vendored SDK's type-only peers",
  )
  for (const hook of ["preinstall", "install", "postinstall"]) {
    assert(!installedPackage.scripts?.[hook], `package must not define an ${hook} hook`)
  }

  await access(path.join(installedRoot, "skills", "jaeger-workflows", "SKILL.md"))
  for (const unexpected of ["skills", ".codex", ".claude"]) {
    await assertMissing(path.join(installDir, unexpected), `npm install auto-created ${unexpected}`)
  }

  const binary = path.join(installDir, "node_modules", ".bin", process.platform === "win32" ? "jaeger.cmd" : "jaeger")
  const help = await run(binary, ["--help"], installDir)
  assert.match(help.stdout, /Usage:/)
  assert.match(help.stdout, /jaeger session resume/)
  assert.match(help.stdout, /jaeger backend install/)
  assert.match(help.stdout, /jaeger env apply/)
  assert.match(help.stdout, /jaeger schedule apply/)
  assert.match(help.stdout, /jaeger hooks validate/)
  assert.match(help.stdout, /jaeger modules validate/)
  assert.match(help.stdout, /jaeger modules add/)
  assert.match(help.stdout, /jaeger session query/)
  assert.match(help.stdout, /On Linux,[\s\S]*persistent local backend by default/)
  assert.match(help.stdout, /--harness-config/)
  assert.doesNotMatch(help.stdout, /jaeger session send/)

  const moduleView = JSON.parse(
    (await run(binary, ["modules", "view", "telegram", "--json"], installDir)).stdout,
  )
  assert.equal(moduleView.item?.name, "telegram")
  assert.equal(moduleView.item?.dependencies?.grammy, "^1.38.3")
  const moduleProject = path.join(installDir, "module-project")
  const moduleAdd = JSON.parse(
    (await run(
      binary,
      [
        "modules",
        "add",
        "telegram",
        "voice-spike",
        "--root",
        moduleProject,
        "--no-install",
        "--json",
      ],
      installDir,
    )).stdout,
  )
  assert.deepEqual(moduleAdd.modules, ["telegram", "voice-spike"])
  assert.equal(moduleAdd.dependenciesInstalled, false)
  const modulePackage = JSON.parse(
    await readFile(path.join(moduleProject, "package.json"), "utf8"),
  )
  assert.deepEqual(modulePackage.dependencies, { grammy: "^1.38.3" })
  await access(path.join(moduleProject, "modules", "telegram", "telegram.mjs"))
  await access(path.join(moduleProject, "modules", "voice-spike", "server.mjs"))

  const environmentRoot = path.join(installDir, "mdcsp")
  await mkdir(path.join(environmentRoot, "profiles"), { recursive: true })
  await mkdir(path.join(environmentRoot, "snippets"), { recursive: true })
  await writeFile(
    path.join(environmentRoot, "profiles", "package-smoke.toml"),
    `version = 1\nname = "package-smoke"\nsnippets = ["package"]\n`,
  )
  await writeFile(
    path.join(environmentRoot, "snippets", "package.md"),
    "# Packaged environment\n",
  )
  const environmentList = await run(
    binary,
    ["env", "list", "--config-root", environmentRoot, "--json"],
    installDir,
  )
  assert.deepEqual(JSON.parse(environmentList.stdout), ["package-smoke"])
  const environmentState = path.join(installDir, "environment-state")
  const codexHome = path.join(installDir, "codex-home")
  const environmentEnv = { ...process.env, CODEX_HOME: codexHome }
  const appliedEnvironment = JSON.parse(
    (await run(
      binary,
      [
        "env",
        "apply",
        "package-smoke",
        "--config-root",
        environmentRoot,
        "--state-root",
        environmentState,
        "--json",
      ],
      installDir,
      environmentEnv,
    )).stdout,
  )
  assert.equal(appliedEnvironment.changed, 1)
  const mdcspBinary = path.join(
    installDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "mdcsp.cmd" : "mdcsp",
  )
  const renderedProfile = await run(
    mdcspBinary,
    ["render", "package-smoke", "--root", environmentRoot, "--stdout"],
    installDir,
    environmentEnv,
  )
  assert.equal(
    await readFile(path.join(codexHome, "AGENTS.md"), "utf8"),
    renderedProfile.stdout,
  )

  const backendSocket = path.join(tempRoot, "installed-runtime", "backend.sock")
  const backendState = path.join(tempRoot, "installed-state")
  const hooksConfig = path.join(installDir, "hooks.toml")
  await writeFile(
    hooksConfig,
    `version = 1

[[hooks]]
name = "package-smoke"
events = ["run.accepted", "phase.changed", "agent.completed", "run.terminal", "schedule.changed", "schedule.occurrence"]
command = ["/usr/bin/true"]
timeout_ms = 1000
`,
  )
  const hookValidation = JSON.parse(
    (await run(binary, ["hooks", "validate", hooksConfig, "--json"], installDir)).stdout,
  )
  assert.equal(hookValidation.valid, true)
  assert.equal(hookValidation.hooks[0]?.name, "package-smoke")
  const runtimeConfig = path.join(installDir, "jaeger.runtime.mjs")
  const moduleMarker = path.join(installDir, "runtime-module.pid")
  await writeFile(
    runtimeConfig,
    `import { writeFile } from "node:fs/promises"
export default {
  version: 1,
  modules: [{
    name: "package-smoke",
    setup(runtime) {
      runtime.events.consume("terminal", "run.terminal", async event => {
        await runtime.storage.set("last-terminal", { runId: event.run.runId })
      })
      runtime.services.run("marker", async signal => {
        await writeFile(${JSON.stringify(moduleMarker)}, String(process.pid))
        await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }))
      })
    }
  }]
}
`,
  )
  const moduleValidation = JSON.parse(
    (await run(binary, ["modules", "validate", runtimeConfig, "--json"], installDir)).stdout,
  )
  assert.equal(moduleValidation.valid, true)
  assert.deepEqual(moduleValidation.modules, ["package-smoke"])
  const backendEnv = {
    ...process.env,
    JAEGER_SOCKET: backendSocket,
    JAEGER_STATE_DIR: backendState,
  }
  installedBackend = await startBackend(
    binary,
    backendSocket,
    backendState,
    hooksConfig,
    runtimeConfig,
    installDir,
    backendEnv,
  )

  const doctor = await run(binary, ["doctor"], installDir, backendEnv)
  const doctorResult = JSON.parse(doctor.stdout)
  assert.equal(doctorResult.containment?.available, true, "installed doctor must prove containment")
  assert.equal(doctorResult.containment?.kind, "systemd-user-scope")
  assert.equal(doctorResult.backend?.kind, "local-service", "installed CLI must use the backend")
  assert.equal(doctorResult.backend?.stateDir, backendState)

  const dashboard = await run(binary, [], installDir, backendEnv)
  assert.match(dashboard.stdout, /JAEGER/)
  assert.match(dashboard.stdout, /Harnesses/)
  assert.doesNotMatch(dashboard.stdout, /^Jaeger prompt-first/m)
  const status = JSON.parse(
    (await run(binary, ["status", "--json"], installDir, backendEnv)).stdout,
  )
  assert.equal(status.runtime, "local-service")
  assert.equal(status.backend?.connected, true)
  assert.equal(status.backend?.stateDir, backendState)
  assert(Array.isArray(status.harnesses))
  const hookStatus = JSON.parse(
    (await run(binary, ["hooks", "status", "--json"], installDir, backendEnv)).stdout,
  )
  assert.equal(hookStatus.enabled, true)
  assert.equal(hookStatus.configPath, hooksConfig)
  const moduleStatus = JSON.parse(
    (await run(binary, ["modules", "status", "--json"], installDir, backendEnv)).stdout,
  )
  assert.equal(moduleStatus.enabled, true)
  assert.equal(moduleStatus.modules[0]?.name, "package-smoke")
  assert.equal(moduleStatus.modules[0]?.services[0]?.status, "running")
  await waitForFile(moduleMarker)
  assert.equal(
    Number(await readFile(moduleMarker, "utf8")),
    doctorResult.backend?.pid,
    "runtime module must execute in the backend process",
  )

  const harnessConfig = path.join(installDir, "harnesses.json")
  await writeFile(
    harnessConfig,
    `${JSON.stringify({
      version: 1,
      harnesses: {
        "package-claude": {
          driver: "claude-agent-sdk",
          command: "claude",
        },
      },
    })}\n`,
  )
  const customDoctor = await run(
    binary,
    ["doctor", "--harness-config", harnessConfig],
    installDir,
    backendEnv,
  )
  const customDoctorResult = JSON.parse(customDoctor.stdout)
  assert.equal(
    customDoctorResult.harnesses?.find((harness) => harness.name === "package-claude")?.available,
    true,
    "installed doctor must discover a configured custom harness",
  )

  const example = path.join(installedRoot, "examples", "mixed-review.js")
  const validation = await run(binary, ["validate", example], installDir)
  assert.equal(JSON.parse(validation.stdout).valid, true, "installed binary must validate a packed example")

  const smokeWorkflow = path.join(installDir, "backend-smoke.js")
  const submissionId = "package-smoke-submission"
  await writeFile(
    smokeWorkflow,
    `export const meta = { name: "installed backend smoke" }\nlog("installed")\nreturn { installed: true, trigger: trigger ?? null }\n`,
  )
  const submitted = JSON.parse(
    (await run(
      binary,
      ["run", smokeWorkflow, "--cwd", installDir, "--detach", "--submission-id", submissionId],
      installDir,
      backendEnv,
    )).stdout,
  )
  assert.match(submitted.runId, /^\d{14}-[a-f0-9]{10}$/)
  assert.equal(submitted.submissionId, submissionId)
  assert.equal(submitted.backend?.kind, "local-service")
  assert.doesNotMatch(submitted.inspect, /--state-dir/)
  const lookedUp = JSON.parse(
    (await run(binary, ["submission", submissionId], tempRoot, backendEnv)).stdout,
  )
  assert.equal(lookedUp.runId, submitted.runId, "submission lookup must resolve the accepted run")
  const completed = JSON.parse(
    (await run(binary, ["wait", submitted.runId], tempRoot, backendEnv)).stdout,
  )
  assert.equal(completed.status, "completed")
  assert.deepEqual(completed.result, { installed: true, trigger: null })
  const listed = JSON.parse((await run(binary, ["list"], tempRoot, backendEnv)).stdout)
  assert.equal(listed.filter((candidate) => candidate.runId === submitted.runId).length, 1)
  const hookHistory = await waitForDeliveredHook(binary, installDir, backendEnv)
  assert(
    hookHistory.some(
      (delivery) =>
        delivery.hook === "package-smoke" &&
        delivery.eventType === "run.terminal" &&
        delivery.status === "delivered",
    ),
    "installed hook dispatcher must deliver a terminal event",
  )
  await waitForFile(
    path.join(backendState, ".modules", "package-smoke", "storage", "last-terminal.json"),
  )

  const scheduleManifest = path.join(installDir, "backend-smoke.schedule.toml")
  await writeFile(
    scheduleManifest,
    `version = 1
name = "package_smoke"
workflow = "./backend-smoke.js"
cwd = "."

[trigger]
type = "cron"
expression = "0 0 1 1 *"
timezone = "UTC"
`,
  )
  const scheduleValidation = JSON.parse(
    (await run(binary, ["schedule", "validate", scheduleManifest], installDir, backendEnv)).stdout,
  )
  assert.equal(scheduleValidation.valid, true)
  const scheduleApplied = JSON.parse(
    (await run(
      binary,
      ["schedule", "apply", scheduleManifest, "--activate"],
      installDir,
      backendEnv,
    )).stdout,
  )
  assert.equal(scheduleApplied.enabled, true)
  assert.equal(scheduleApplied.activeRevision, 1)
  const scheduleOccurrence = JSON.parse(
    (await run(
      binary,
      [
        "schedule",
        "trigger",
        "package_smoke",
        "--request-id",
        "package-schedule-request",
      ],
      installDir,
      backendEnv,
    )).stdout,
  )
  assert.match(scheduleOccurrence.runId, /^\d{14}-[a-f0-9]{10}$/)
  const scheduledCompleted = JSON.parse(
    (await run(binary, ["wait", scheduleOccurrence.runId], installDir, backendEnv)).stdout,
  )
  assert.equal(scheduledCompleted.status, "completed")
  assert.equal(scheduledCompleted.result?.installed, true)
  assert.equal(scheduledCompleted.result?.trigger?.type, "schedule")
  assert.equal(scheduledCompleted.result?.trigger?.scheduleId, "package_smoke")
  assert.equal(
    scheduledCompleted.result?.trigger?.occurrenceId,
    scheduleOccurrence.id,
  )
  const scheduleHistory = JSON.parse(
    (await run(
      binary,
      ["schedule", "history", "package_smoke", "--json"],
      installDir,
      backendEnv,
    )).stdout,
  )
  assert.equal(scheduleHistory[0]?.status, "completed")
  await run(binary, ["schedule", "disable", "package_smoke"], installDir, backendEnv)
  const scheduleRemoved = JSON.parse(
    (await run(binary, ["schedule", "remove", "package_smoke"], installDir, backendEnv)).stdout,
  )
  assert.equal(typeof scheduleRemoved.removedAt, "string")

  await stopBackend(installedBackend)
  installedBackend = undefined
  installedBackend = await startBackend(
    binary,
    backendSocket,
    backendState,
    hooksConfig,
    runtimeConfig,
    installDir,
    backendEnv,
  )
  const afterRestart = JSON.parse(
    (await run(binary, ["inspect", submitted.runId, "--summary", "--json"], tempRoot, backendEnv)).stdout,
  )
  assert.equal(afterRestart.status, "completed", "installed state must survive backend restart")

  process.stdout.write(`${JSON.stringify({
    artifact: artifact.filename,
    fileCount: paths.length,
    skillFiles: paths.filter((entry) => entry.endsWith("/SKILL.md")),
    validatedExamples,
    installedCommands: [
      "--help",
      "bare status/status --json",
      "env list",
      "doctor through backend",
      "validate",
      "run --detach through backend",
      "submission lookup",
      "wait",
      "list",
      "inspect after backend restart",
      "schedule validate/apply/trigger/history/disable/remove",
      "hooks validate/status/history and direct delivery",
      "modules registry add, validate/status, and in-process event delivery",
    ],
    autoInstalledSkill: false,
  }, null, 2)}\n`)
} finally {
  if (installedBackend) await stopBackend(installedBackend)
  await rm(tempRoot, { recursive: true, force: true })
}

async function verifySourceSkill() {
  const skill = await readFile(skillPath, "utf8")
  assert(!skill.includes("TODO"), "skill still contains template TODOs")
  assert.match(skill, /^---\nname: jaeger-workflows\ndescription: .+\n---\n/)

  const metadata = await readFile(
    path.join(root, "skills", "jaeger-workflows", "agents", "openai.yaml"),
    "utf8",
  )
  assert.match(metadata, /display_name: "Jaeger Workflows"/)
  assert.match(metadata, /short_description: "[^"]{25,64}"/)
  assert.match(metadata, /default_prompt: "Use \$jaeger-workflows /)
}

async function verifyAgentInstallRunbook() {
  const runbook = await readFile(agentInstallPath, "utf8")
  assert.match(runbook, /pnpm install --frozen-lockfile/)
  assert.match(runbook, /pnpm verify/)
  assert.match(runbook, /pnpm verify:controller/)
  assert.match(runbook, /npm install --global --prefix/)
  assert.match(runbook, /jaeger backend install/)
  assert.match(runbook, /jaeger doctor/)
  assert.match(runbook, /examples\/backend-smoke\.js/)
  assert.match(runbook, /jaeger runtime add NAME --ssh SSH_HOST_PROFILE --default/)
  assert(!runbook.includes("curl | sh"), "agent install runbook must not pipe network content to a shell")
  assert(!runbook.includes("TODO"), "agent install runbook contains an unresolved TODO")
}

async function validateExamples() {
  const examplesDir = path.join(root, "examples")
  const examples = (await readdir(examplesDir))
    .filter((entry) => entry.endsWith(".js") || entry.endsWith(".ts"))
    .sort()
  assert(examples.length > 0, "expected at least one workflow example")

  for (const example of examples) {
    const result = await run(
      process.execPath,
      [path.join(root, "dist", "cli.js"), "validate", path.join(examplesDir, example)],
      root,
    )
    assert.equal(JSON.parse(result.stdout).valid, true, `${example} did not validate`)
  }
  return examples
}

async function run(command, args, cwd, env = process.env) {
  try {
    return await execFileAsync(command, args, {
      cwd,
      env,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    })
  } catch (error) {
    const stderr = error?.stderr?.trim()
    throw new Error(`${command} ${args.join(" ")} failed${stderr ? `:\n${stderr}` : ""}`, { cause: error })
  }
}

async function startBackend(
  binary,
  socketPath,
  stateDir,
  hooksConfig,
  runtimeConfig,
  cwd,
  env,
) {
  const child = spawn(
    binary,
    [
      "__backend",
      "--socket",
      socketPath,
      "--state-dir",
      stateDir,
      "--hooks-config",
      hooksConfig,
      "--runtime-config",
      runtimeConfig,
    ],
    { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
  )
  let stderr = ""
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", () => {})
  child.stderr.on("data", (chunk) => {
    stderr += chunk
  })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`installed backend exited before readiness (${child.exitCode}): ${stderr}`)
    }
    try {
      await execFileAsync(binary, ["list"], {
        cwd,
        env,
        encoding: "utf8",
        timeout: 2_000,
      })
      return child
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  child.kill("SIGTERM")
  throw new Error(`installed backend did not become ready: ${stderr}`)
}

async function waitForFile(target) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      await access(target)
      return
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${target}`)
}

async function waitForDeliveredHook(binary, cwd, env) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const history = JSON.parse(
      (await run(binary, ["hooks", "history", "--limit", "100", "--json"], cwd, env)).stdout,
    )
    if (
      history.some(
        (delivery) =>
          delivery.eventType === "run.terminal" && delivery.status === "delivered",
      )
    ) {
      return history
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("installed hook dispatcher did not deliver a terminal event")
}

async function stopBackend(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGTERM")
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      resolve()
    }, 5_000)
    child.once("exit", () => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

async function assertMissing(target, message) {
  try {
    await access(target)
  } catch (error) {
    if (error?.code === "ENOENT") return
    throw error
  }
  assert.fail(message)
}
