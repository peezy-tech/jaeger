# Jaeger

[![CI](https://github.com/peezy-tech/jaeger/actions/workflows/ci.yml/badge.svg)](https://github.com/peezy-tech/jaeger/actions/workflows/ci.yml)
[![Windows controller](https://github.com/peezy-tech/jaeger/actions/workflows/windows-controller.yml/badge.svg)](https://github.com/peezy-tech/jaeger/actions/workflows/windows-controller.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Jaeger is a prompt-first workflow runner for coordinating native coding-agent
harnesses. A workflow is an ordinary JavaScript or TypeScript file: normal
control flow connects structured agent outputs while Jaeger owns routing,
concurrency, durable run state, and inspection.

The npm distribution is named `@peezy.tech/jaeger`; the repository is
`peezy-tech/jaeger`, and the installed command is `jaeger`. This project is not
affiliated with the
[CNCF Jaeger distributed tracing project](https://github.com/jaegertracing/jaeger).
Jaeger's source is MIT licensed. Provider SDKs, native harnesses, accounts, and
services remain subject to their own terms; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Jaeger does not wrap capabilities the harness already provides. Native harnesses
continue to own commands, edits, tools, skills, MCP servers, hooks, and provider
behavior.

Jaeger can also reconcile the environment around those native harnesses. This is
separate from workflow execution: `jaeger env` composes instruction files and
installs provider-native skills, Codex/Claude plugins, Pi packages, and
configuration from a declarative, reversible environment.
Instruction composition is provided by the standalone
[`mdcsp`](https://github.com/peezy-tech/mdcsp) package and
consumed through its library API; Jaeger retains ownership of environment
targets, native assets, state, backups, and reconciliation.

```js
export const meta = {
  name: "mixed-review",
  phases: [
    { title: "Review", detail: "Two independent reviews" },
    { title: "Synthesize", detail: "Reconcile their findings" },
  ],
}

phase("Review")
const reviews = await parallel([
  () => agent(`${reviewPrompt}\nDo not modify files.`, {
    harness: "codex",
    effort: "low",
    schema: FINDINGS,
  }),
  () => agent(`${reviewPrompt}\nDo not modify files.`, {
    harness: "claude",
    effort: "low",
    schema: FINDINGS,
  }),
])

return agent(`Reconcile these reviews: ${JSON.stringify(reviews)}`, {
  harness: "codex",
  schema: VERDICT,
})
```

## Current capabilities

- `.js` and `.ts` workflow files with top-level `await` and `return`
- `agent`, `parallel`, `phase`, `log`, `inputs`, and immutable `trigger` globals
- persistent Codex app-server threads, Claude Agent SDK sessions, and Pi RPC
  sessions
- host-configured harness surfaces over any shipped protocol driver
- user-controlled session resume plus active-turn steer and interrupt
- model, effort, service-tier, profile, working-directory, schema, label, and
  timeout selection per agent
- JSON Schema structured-output validation
- pinned source and inputs with durable completed-call replay
- fail-closed uncertainty for a call that started but did not durably complete
- a persistent same-user local backend with transient, independently supervised
  per-run and per-session-turn workers
- named remote runtimes over existing OpenSSH host profiles, with no Jaeger TCP
  listener, tunnel, key store, or credential protocol
- a Windows controller-only CLI that sends locally authored workflows to Linux
  runtimes through Windows OpenSSH
- persistent-backend schedules with immutable revisions, idempotent occurrences,
  explicit activation, overlap and misfire policy, and fail-closed pausing
- operator-configured post-checkpoint lifecycle hooks with stable event IDs,
  durable at-least-once delivery, bounded direct commands, and independent
  failure state
- blocking or detached CLI attachment with compact inspect, wait, list, resume,
  and stop controls
- a bare-command system overview with harness versions, backend health, active
  workflows and sessions, schedules, and environment state
- one packaged, optional `jaeger-workflows` authoring and operations skill
- declarative Codex, Claude, and Pi environments with drift detection, backups,
  and reversible instruction, skill, plugin/package, and config installation

The compiler requires one `export const meta` declaration and otherwise expects a small,
prompt-heavy coordinator. Imports and other exports are intentionally unsupported.

## Develop and verify

Linux runtime hosts require Node.js 22.13 or newer, pnpm for development, cgroup
v2, and an available user systemd manager. Jaeger runs coordinators and every
provider call in transient user scopes so lifecycle control remains
authoritative across CLI exits, backend restarts, owner crashes, and
new-session descendants. Windows 10 and Windows 11 are supported as
controller-only clients with Node.js and the built-in OpenSSH client; execution
still belongs to a prepared Linux runtime.

For a fresh machine, give an agent the raw GitHub URL for
[AGENT_INSTALL.md](https://raw.githubusercontent.com/peezy-tech/jaeger/main/AGENT_INSTALL.md).
That runbook detects the controller/runtime role, installs an exact source
artifact per-user, preserves existing Jaeger configuration, exposes the
packaged skill, and proves the installed path with a provider-free workflow.

Registry consumers can install the exact release into a user-owned prefix:

Jaeger 0.1.0 used the unscoped package name `jaeger-workflows`. Uninstall that
package from the same prefix before installing the scoped package so npm can
replace its `jaeger` executable shim.

```bash
npm uninstall --global --prefix "$HOME/.local" jaeger-workflows
npm install --global --prefix "$HOME/.local" @peezy.tech/jaeger@0.1.4
export PATH="$HOME/.local/bin:$PATH"
hash -r
jaeger backend install
jaeger backend status
jaeger doctor
```

```powershell
$InstallRoot = Join-Path $env:LOCALAPPDATA "Jaeger"
npm uninstall --global --prefix $InstallRoot jaeger-workflows
npm install --global --prefix $InstallRoot @peezy.tech/jaeger@0.1.4
$env:Path = "$InstallRoot;$env:Path"
jaeger --help
```

Persist `$HOME/.local/bin` on Linux or `%LOCALAPPDATA%\Jaeger` on Windows in
the user's `PATH` if it is not already present.

```bash
pnpm install --frozen-lockfile
pnpm verify
```

The verifier starts from clean build output, checks and tests the project,
validates every example and the skill, packs the npm artifact, installs that
tarball into a temporary project, and exercises the installed binary. It does
not publish or globally install anything.

Run `jaeger` without arguments for the human-readable operational overview.
The display is colorized in a terminal and stays useful when a subsystem is
unavailable by reporting degraded sections as warnings. Agents and scripts can
read the same snapshot without parsing terminal output:

```bash
jaeger status --json
jaeger --help
```

For individual commands:

```bash
pnpm build
pnpm jaeger backend install
pnpm jaeger doctor
pnpm jaeger validate examples/mixed-review.js
pnpm jaeger run examples/mixed-review.js \
  --input examples/mixed-review-input.json
```

Acceptance and failure diagnostics are written to stderr. Machine-readable
command results are written to stdout; durable phase and agent progress is
available through targeted `inspect --events` calls. If a blocking run fails,
stderr also includes a one-line
`jaeger run summary: {...}` record with the durable run ID, uncertainty boundary,
and exact inspect command.

## Harness environments

Jaeger environments use mdcsp's canonical configuration home and profile list:
`$MDCSP_HOME`, then `$XDG_CONFIG_HOME/mdcsp`, then `~/.config/mdcsp`. A profile
is an environment's instruction authority, so `mdcsp render workstation` and
`jaeger env apply workstation` select the same ordered snippets. The minimal
layout is:

```text
~/.config/mdcsp/
├── profiles/
│   ├── workstation.toml
│   ├── workstation-claude.toml
│   └── workstation-pi.toml
├── snippets/
│   ├── common.md
│   ├── codex.md
│   ├── claude.md
│   └── pi.md
└── jaeger/
    └── workstation/
        ├── environment.toml
        ├── harnesses.json
        ├── skills/
        └── configs/
```

`profiles/workstation.toml` is an ordinary mdcsp profile:

```toml
version = 1
name = "workstation"
snippets = ["common", "codex"]
```

The `jaeger/<name>/environment.toml` sidecar is optional. It adds native
provider assets and can map Claude or Pi to other mdcsp profiles without owning
Markdown composition itself. Sources are relative to the sidecar and must
remain inside its directory:

```toml
version = 1
name = "workstation"
harness_config = "harnesses.json"

[providers.codex]
skills = ["skills/jaeger-workflows"]
plugins = ["github@openai-curated"]

[[providers.codex.configs]]
source = "configs/tool.toml"
target = "$CODEX_HOME/tool.toml"

[providers.claude]
profile = "workstation-claude"

[providers.pi]
profile = "workstation-pi"
skills = ["skills/jaeger-workflows"]
packages = ["npm:@acme/pi-tools@1.2.3"]

[[providers.pi.configs]]
source = "configs/pi-settings.json"
target = "$PI_CODING_AGENT_DIR/settings.json"
```

Without a sidecar, Jaeger manages only Codex instructions from the profile with
the environment's name. Explicit `--file` paths continue to accept the previous
standalone Jaeger environment-manifest format for controlled migrations, but
the default discovery path is exclusively mdcsp `profiles/`.

To migrate an existing Jaeger environment, copy its Markdown snippets into the
mdcsp `snippets/` directory, express their order in `profiles/<name>.toml`, and
move only the remaining skills/plugins/packages/config entries into the
optional sidecar. Keep the old environment directory until both
`mdcsp explain <name>` and `jaeger env inspect <name>` show the intended plan;
then `jaeger env apply <name>` safely replaces the previously managed output
and records the profile as the new manifest authority.

Codex instructions target `$CODEX_HOME/AGENTS.md` (normally
`~/.codex/AGENTS.md`); Claude instructions target
`$CLAUDE_CONFIG_DIR/CLAUDE.md` (normally `~/.claude/CLAUDE.md`); Pi instructions
target `$PI_CODING_AGENT_DIR/AGENTS.md` (normally `~/.pi/agent/AGENTS.md`).
Skills are copied into each provider's native `skills/` directory. Codex and
Claude plugins use
explicit `plugin@marketplace` selectors and are installed or removed through
the provider's native plugin manager (`codex plugin` or `claude plugin`), so
Jaeger does not create a second plugin loader. Pi `packages` retain their native
source identity and are reconciled through `pi install`, `pi list`, and
`pi remove`; packages that predate the environment are never removed by it. An
`npm:`, `git:`, HTTPS, or SSH source is stored verbatim; a local `./` source is
resolved inside the environment directory before it is installed. An
optional top-level
`harness_config = "harnesses.json"` installs
Jaeger's custom harness registry at the standard Jaeger config path.

Instruction snippets are Markdown with optional TOML front matter:

```markdown
+++
description = "Only use this block when Jaeger is available"
requires = ["jaeger"]
excludes = ["some-incompatible-command"]
+++
## Jaeger

Use Jaeger for durable workflow execution.
```

Jaeger calls the `mdcsp` library directly and uses its profile loader, snippet
directory, ordering, conditions, digest, and generated header. It does not
shell out to the executable or maintain a parallel instruction home. Jaeger's
private apply/uninstall state and backups remain under
`$XDG_STATE_HOME/jaeger/environment` because mdcsp owns no lifecycle state.

Inspect and reconcile an environment with:

```bash
jaeger env list
jaeger env inspect workstation
jaeger env diff workstation
jaeger env apply workstation
jaeger env check workstation
jaeger env status
jaeger env uninstall workstation
```

`apply` refuses to replace unmanaged targets or overwrite locally modified
managed targets. Use `--force` only after reviewing `inspect` or `diff`. The
first forced adoption preserves existing content under Jaeger's private state
root. Switching environments restores targets no longer managed by the new
environment; uninstall restores all preserved originals and removes targets
that Jaeger created. State is stored under
`$XDG_STATE_HOME/jaeger/environment` (falling back to
`~/.local/state/jaeger/environment`). `check` and `diff` exit with status 1 when
the requested environment is not the active, byte-current environment.

Use `--file`, `--config-root`, and `--state-root` for explicit local testing or
non-default layouts. These commands do not require the workflow backend to be
running.

## Persistent local backend

On Linux, the installed CLI resolves the persistent local backend by default.
On Windows, it resolves the configured default SSH runtime. Operational
commands—`run`, `inspect`, `wait`, `stop`, `resume`, `list`, `doctor`, and every
`session` action—cross one versioned Unix-socket protocol. The backend owns
submission, run discovery, recovery, session control, and artifact reads. CLI
users normally need only a run ID; they do not need to preserve a state path or
stay in the directory where a run began.

`jaeger backend install` writes and enables a user unit named
`jaeger-backend.service`. By default it listens at
`$XDG_RUNTIME_DIR/jaeger/backend.sock` and stores runs under
`$XDG_STATE_HOME/jaeger/runs` (falling back to `~/.local/state/jaeger/runs`).
Installation persists the selected socket, state root, entrypoint, optional
harness, lifecycle-hook, and runtime-module configurations, stable backend instance identity,
random service generation, and absolute `systemctl` launcher in
`$XDG_CONFIG_HOME/jaeger/backend.json` (falling back to
`~/.config/jaeger/backend.json`), so a custom installation remains the target of
later plain CLI commands. `JAEGER_SOCKET` can temporarily redirect a client.
`JAEGER_STATE_DIR` selects the root when installing or directly starting a
backend; it does not retarget an already-running service. The socket, state
root, and their runtime parents are user-only. The profile itself must be a
user-owned, owner-only regular file. Profile, socket, state, and user-unit paths
must have real, non-replaceable ancestor chains owned by root or the current
user; the CLI fails closed instead of following writable or symlinked routing
authority.

```bash
jaeger backend status
jaeger backend restart
```

The service and workers have separate lifetimes. Restarting the control plane
does not terminate an active workflow or continued session turn. On startup,
the backend reconciles its atomic submission index, publishes any durably
claimed staged run, relaunches only safe pending or interrupted workflows, and
launches only session turns that were queued but never claimed by a worker. It
never replays a claimed session turn or a workflow at an uncertain agent
boundary. A client disconnect stops waiting, not execution.

If the configured socket is unavailable, the CLI fails with an actionable
error; it never silently starts the same submission under another authority.
`--runtime embedded` or `JAEGER_RUNTIME=embedded` is an explicit development and
legacy escape hatch. Embedded mode still uses durable state and transient
workers, but has no persistent control plane. `--state-dir` remains an advanced
same-host override for embedded compatibility. The persistent service owns one
configured state root and rejects per-command alternate roots so every accepted
run remains discoverable and recoverable.

The installed unit pins Node, the CLI entrypoint, and the resolved `systemd-run`
and `systemctl` launchers used by both the service and later lifecycle commands.
Resolved service and harness paths must be owned by root or the current user and
must not be writable by other users or a shared group; ancestor directories are
checked under the same rule. Each accepted run also pins
absolute harness launcher paths instead of resolving `codex`, `claude`, `pi`, or a
custom command later from a mutable PATH. Rerun
`jaeger backend install` after moving or replacing the installation so the unit
and running service use the intended build. Reinstallation preserves an existing
harness profile unless another `--harness-config` is supplied. Installation
serializes installers with a generation-fenced process lease and durably records
a pending profile before changing systemd. The replacement service can bind both
the old and new socket during handoff, but rejects every operation except `ping`
until its exact generation is atomically committed in the routing profile. CLI
requests carry the committed generation, so a crash or stale client fails closed
instead of submitting into a different state root. A later install continues the
durable pending intent; a failed pre-commit update restores the prior unit,
profiles, and exact persistent/runtime enabled plus active lifecycle state. After
commit, the temporary compatibility socket is retired. Before changing systemd,
installation also verifies that any existing unit is the exact current-user
regular unit at Jaeger's unit path with a stable active/inactive and supported
enabled state. A foreign, masked, symlinked, transient-state, or unsupported
same-named unit is refused instead of shadowed or approximately restored.
Provider launchers inherit the user systemd manager's environment plus a
normalized absolute PATH captured at installation, so credentials that exist
only in an interactive shell must be imported into that manager or owned by the
provider's normal on-disk configuration.

## Remote runtimes over SSH

A named remote runtime is the same persistent local backend viewed through an
SSH transport. The remote host still listens only on its owner-only Unix socket.
For each CLI operation, Jaeger opens one noninteractive SSH channel, runs the
hidden `jaeger __rpc-stdio` bridge, and forwards one versioned request through
that bridge to the remote socket:

```text
local jaeger -> OpenSSH Host profile -> remote jaeger stdio bridge
             -> remote backend.sock -> remote transient workers
```

Install and verify Jaeger on the target host first. Configure its keys, user,
hostname, port, jump hosts, host-key policy, and optional connection sharing in
the normal OpenSSH configuration. Jaeger never reads or stores those settings.
Register the already-working SSH destination and optionally make it the
persistent default:

```bash
jaeger runtime add build --ssh build-host --default
jaeger runtime list --json
jaeger runtime doctor build
jaeger doctor
```

Registration performs a protocol and doctor handshake, captures the remote
backend's stable instance ID, and writes a strict owner-only registry at
`$XDG_CONFIG_HOME/jaeger/runtimes.toml` (falling back to
`~/.config/jaeger/runtimes.toml`) on Linux, or an inherited-user-ACL registry at
`%APPDATA%\Jaeger\runtimes.toml` on Windows. The ID binds the name to one remote
state authority. Changing a backend's state root creates a new ID and requires
an explicit `runtime add --force`; ordinary reinstalls against the same state
root preserve it.

Windows installations are deliberately controller-only. They do not provide
`backend install`, embedded execution, or local systemd workers. The CLI uses
the built-in `ssh.exe`, including `%USERPROFILE%\.ssh\config`, to reach the
selected Linux runtime. `jaeger runtime default NAME` persists a target so bare
`jaeger` and ordinary operational commands route there without an environment
variable. Local workflow and input paths use Windows semantics; every target
`--cwd` and target harness path remains an absolute POSIX path.

Runtime entries contain only an OpenSSH destination, a constrained remote
Jaeger executable name or absolute path, the pinned instance ID, and a connect
timeout. They cannot contain private-key paths, passwords, arbitrary SSH
arguments, or shell fragments. The client keeps normal host-key verification,
uses batch mode without a TTY, disables agent and port forwarding for the
transport command, and fails closed on unexpected stdout or identity mismatch.

Launch local workflow source against an existing directory on the remote host:

```bash
jaeger --runtime build run ./workflows/review.js \
  --input ./review-input.json \
  --cwd /srv/checkouts/project \
  --detach
```

The workflow and input files are read and validated locally, then their contents
are transmitted and pinned in the remote run. `--cwd` is required, must be an
absolute path on the target, and is resolved and identity-pinned by the remote
backend. Jaeger does not copy or synchronize a checkout. Git, deployment,
`rsync`, shared storage, and other workspace preparation remain separate
operator concerns.

Remote responses include both the ordinary `runId` and a target-qualified
`runRef`. Exact action commands retain the target without another flag:

```bash
jaeger inspect build:20260724120000-0123456789 --summary --json
jaeger wait build:20260724120000-0123456789
jaeger stop build:20260724120000-0123456789
```

`JAEGER_RUNTIME=build` or `--runtime build` also selects the target for run
discovery, schedules, hooks, doctor, and session operations. A qualified run
reference overrides the environment default, but conflicts with an explicit
different `--runtime`. Physical `cwd`, run, scratch, and transcript paths in a
remote response are target-local diagnostics.

Remote schedule manifests are read locally, but their `cwd` must likewise be an
absolute target path. Source and inputs are pinned in the remote schedule
revision. Backend installation and restart remain deliberately host-local
administration; perform them in an interactive SSH shell instead of through the
workflow transport.

An SSH failure never falls back to the local backend. A disconnected `wait`
stops only client attachment. Run submission, session continuation, schedule
application, and manual schedule triggering retain their existing idempotency
IDs across ambiguous transport failure, so retry the exact target-qualified
command rather than creating replacement work blindly.

## Lifecycle hooks

Lifecycle hooks observe Jaeger-owned durable state after it is recorded. They
are global operator configuration, not authored workflow commands, and are
separate from provider-native hooks. A hook cannot intercept tools or influence
workflow decisions.

```toml
version = 1

[[hooks]]
name = "hq-markdown"
events = [
  "run.accepted",
  "phase.changed",
  "agent.completed",
  "run.terminal",
  "schedule.changed",
  "schedule.occurrence",
]
command = ["node", "/home/user/.local/libexec/jaeger-hq-markdown.mjs"]
timeout_ms = 5000
```

Validate and install the private, user-owned configuration explicitly:

```bash
jaeger hooks validate ~/.config/jaeger/hooks.toml
jaeger backend install --hooks-config ~/.config/jaeger/hooks.toml
jaeger hooks status --json
jaeger hooks history --limit 50 --json
```

Each direct command receives one bounded normalized JSON event on standard
input. Prompts, transcripts, arbitrary results, agent outputs, and provider
metadata are excluded. A zero exit status acknowledges delivery. Nonzero exits,
timeouts, output-limit violations, and backend restarts retain retryable state
with the same event ID and capped backoff. Hook failure never changes a run or
makes a completed workflow uncertain. Embedded mode validates configuration but
does not dispatch hooks.

## Runtime modules

Runtime modules are trusted JavaScript loaded into the persistent backend
process. They are machine-owned composition, not workflow input or a provider
plugin system. A normal ESM project can import arbitrary packages and export a
small module list:

```js
import { telegramModule } from "./telegram.mjs";

export default {
  version: 1,
  modules: [telegramModule({
    tokenFile: new URL("./secrets/telegram-token", import.meta.url),
  })],
};
```

Each module registers durable lifecycle-event consumers and background
services. Its runtime context provides run/session inspection, forked session
queries, namespaced JSON storage, and logging. Module code shares the backend
PID and trust boundary. Handler error containment is reliability handling, not
a security sandbox.

Modules can be copied from a source registry into the one operator-owned
runtime project. Like source-component registries, items remain readable and
editable after installation. Their dependency requirements are reconciled into
one root `package.json`, one package-manager lockfile, and one `node_modules`;
module directories are not independent package installations.

Inspect or install the built-in catalog without executing module code:

```bash
jaeger modules view telegram
jaeger modules add telegram voice-spike --dry-run
jaeger modules add telegram
jaeger modules list
jaeger modules diff telegram
```

`modules add` accepts a local manifest, HTTPS manifest or catalog reference,
and `OWNER/REPOSITORY/ITEM#REF`. GitHub refs resolve to a commit before files
are fetched. Multi-item additions perform one dependency installation with
package lifecycle scripts disabled. `modules.lock.json` records source and file
hashes plus dependency ownership. `modules remove` refuses locally edited
modules and, because runtime configurations are arbitrary ESM, requires
`--force` whenever `jaeger.runtime.mjs` exists after the operator removes the
module from that composition.

Installing source does not activate it. Review and configure the files, then
cross the existing explicit execution boundary:

```bash
jaeger modules validate ~/.config/jaeger/runtime/jaeger.runtime.mjs
jaeger backend install \
  --runtime-config ~/.config/jaeger/runtime/jaeger.runtime.mjs
jaeger modules status --json
```

Configuration loads on backend start. Reinstall or restart after edits.
`jaeger backend install --clear-runtime-config` removes a broken composition.
The source schemas are under `schemas/`, the catalog is
`jaeger.registry.json`, and reference
items are under `examples/runtime-modules/`.

## Run lifecycle

Every run is backend-owned and may outlive the invoking shell or parent-agent
turn. Without `--detach`, the CLI waits for the terminal result. With
`--detach`, it returns immediately after durable acceptance:

```bash
jaeger run examples/mixed-review.js \
  --input examples/mixed-review-input.json \
  --detach
```

`--detach` changes only client attachment; it does not select a backend or make
the run more durable. Preserve the returned `runId` and action commands rather
than continuously polling or ingesting full transcripts.

```json
{
  "schemaVersion": 1,
  "backend": { "name": "local", "kind": "local-service" },
  "runId": "20260720194512-0123456789",
  "submissionId": "142c8ce2-51cb-448d-8f83-f9fbe3ad2d60",
  "status": "running",
  "scriptPath": "/workspace/examples/mixed-review.js",
  "runDir": "/home/user/.local/state/jaeger/runs/20260720194512-0123456789",
  "inspect": "jaeger inspect 20260720194512-0123456789 --summary --json",
  "wait": "jaeger wait 20260720194512-0123456789",
  "stop": "jaeger stop 20260720194512-0123456789"
}
```

The CLI creates and prints the `submissionId` before contacting the backend.
The service atomically binds that ID to one normalized request and one staged
run before publication. If transport fails after possible acceptance, retry the
same command with `--submission-id ID`, or resolve it without creating work:

```bash
jaeger submission 142c8ce2-51cb-448d-8f83-f9fbe3ad2d60
```

Reusing an ID with different source, inputs, workspace, harness definitions, or
runtime policy is rejected as an idempotency conflict.

Operate the run through the CLI:

```bash
jaeger inspect 20260720194512-0123456789 --summary --json
jaeger wait 20260720194512-0123456789
jaeger stop 20260720194512-0123456789
jaeger list --json
```

Every launched agent step also has a durable Jaeger session. List them by run,
then use the exact command returned for the session's current state:

```bash
jaeger session list 20260720194512-0123456789 --json
jaeger session inspect 20260720194512-0123456789 session-0123456789abcdef --json
jaeger session resume 20260720194512-0123456789 session-0123456789abcdef --message -
jaeger session steer 20260720194512-0123456789 session-0123456789abcdef --message -
jaeger session interrupt 20260720194512-0123456789 session-0123456789abcdef
jaeger session query 20260720194512-0123456789 session-0123456789abcdef \
  --message -
```

`resume` starts another turn in an idle provider session. `steer` and
`interrupt` address the active turn owned by a running workflow or resume
command. A session selector may be the Jaeger session ID, workflow step ID, or
native provider session ID. Codex applies steering to its active app-server
turn. Claude Code's native SDK has interrupt but no equivalent append-to-active-
turn operation, so Jaeger steering interrupts the current Claude response and
immediately continues with the steering message in the same persisted session.
Pi maps steering and interrupt directly to its RPC commands and waits for
`agent_settled`, after automatic retries, compaction retries, and queued
continuations have finished.

The persistent backend archives idle Codex threads after a run completes
successfully, so workflow workers do not accumulate in the default Codex app
thread list. Failed, interrupted, stopped, uncertain, active, or pinned threads
remain visible. Jaeger also retains a parent thread when archiving it would
cascade into a descendant that Jaeger does not own. Session list and inspect
responses expose the resulting `threadArchive` state. A later Jaeger resume or
fork transparently unarchives the provider thread first; the durable Jaeger run,
session record, outputs, and transcripts are never removed.

Under the persistent backend, each `resume` is first recorded as a durable turn
job and then executed by its own transient systemd worker. The CLI prints the
turn ID before submission. Use `--detach` to return after worker acceptance,
`--request-id TURN_ID` to retry the same ambiguous submission, and the returned
commands to inspect or wait:

```bash
jaeger session turn inspect 20260720194512-0123456789 turn-0123456789abcdef
jaeger session turn wait 20260720194512-0123456789 turn-0123456789abcdef
```

A backend or client exit never aborts that worker. The worker durably claims the
turn before provider interaction and writes its result before making the
session idle. If it disappears after the claim without a result, Jaeger records
the turn as uncertain and never relaunches it, avoiding duplicated provider
effects. If two distinct IDs contend for the same next turn, exactly one is
accepted; the loser is durably `rejected` rather than left as a phantom queued
job and has no provider effects.

`session query` is separate from `resume`: it forks the latest native provider
session and asks the question in a read-only child conversation. The workflow
session's turn count, provider ID, and result remain unchanged. Query
submissions have their own durable request IDs, transient workers, inspect/wait
commands, and uncertainty boundary. A later question creates a fresh fork so it
sees the latest parent state. Pi queries require the parent session to be idle
because Pi can only fork a session after its durable session file exists.

Start with a summary and request detailed events or transcripts only for the
current decision. `wait` exits when the run reaches a terminal state. `stop`
empties each OS-owned provider cgroup before it returns, including descendants
that created a new process session. If a worker had started, its possible
external effects remain uncertain.

## Standing schedules

A schedule is persistent-backend-owned standing authority to create ordinary
Jaeger runs at matching times. Embedded mode deliberately rejects schedule
operations because an embedded process cannot own future time. Cron is the first
trigger type; it is not a second workflow runtime.

Schedule manifests are ordinary TOML files. Relative workflow, input, and
working-directory paths resolve from the manifest directory:

```toml
version = 1
name = "weekday_triage"
workflow = "./workflows/triage.ts"
cwd = "."
input = "./inputs/triage.json"
max_concurrency = 2

[trigger]
type = "cron"
expression = "0 9 * * 1-5"
timezone = "America/New_York"

[policy]
overlap = "forbid"
misfire = "skip"
max_catch_up = 1
pause_on_uncertain = true
pause_after_failures = 3
```

Jaeger accepts five-field minute, hour, day-of-month, month, and day-of-week
expressions with lists, ranges, and steps. Timezones are explicit IANA names.
When day-of-month and day-of-week are both restricted, either may match, as in
traditional cron. Every matching real UTC minute is evaluated in the requested
timezone, including both repeated local minutes during a fall-back transition.

Validate the file, apply an immutable disabled revision, then explicitly grant
standing authority:

```bash
jaeger schedule validate ./weekday-triage.toml
jaeger schedule apply ./weekday-triage.toml
jaeger schedule enable weekday_triage
```

`schedule apply --activate` combines the last two operations when immediate
activation is intentional. Applying a changed launch template creates a new
disabled revision. An identical application is idempotent and preserves the
existing revision and activation state.

Operate schedules and occurrence history through the same backend:

```bash
jaeger schedule list --json
jaeger schedule inspect weekday_triage --json
jaeger schedule history weekday_triage --limit 20 --json
jaeger schedule trigger weekday_triage --json
jaeger schedule disable weekday_triage
jaeger schedule remove weekday_triage
```

Manual triggers use the same immutable revision and occurrence admission path.
The CLI prints a request ID before submission; retry an ambiguous request with
the same `--request-id`. Removal requires the schedule to be disabled and leaves
its revision and occurrence history as a tombstone. Reapplying the same name
creates a new disabled revision while retaining that history.

Each occurrence is durably claimed before submission and uses a deterministic
submission key, so service restarts and concurrent recovery cannot create two
authoritative runs for one firing. A scheduled run receives immutable metadata
through the coordinator's `trigger` global:

```js
export const meta = { name: "scheduled triage" }

log({
  schedule: trigger.scheduleId,
  revision: trigger.revision,
  scheduledFor: trigger.scheduledFor,
})
return await agent("Triage the current repository state.", { harness: "codex" })
```

Ordinary launches expose `trigger` as `undefined`. Scheduled source, inputs,
harness definitions, workspace identity, cron expression, timezone, and policy
are pinned in the schedule revision; every occurrence then gets a normal run
record, run ID, checkpoint journal, sessions, and inspection commands.

The default overlap policy is `forbid`. A cron firing that overlaps an active
occurrence is recorded as skipped; an explicit manual trigger reports the
conflict. `misfire = "skip"` ignores times missed while the backend was down,
`latest` admits only the latest match, and `catch-up` admits at most
`max_catch_up` matches, capped at 24 within a seven-day scan window.

Jaeger never automatically retries an uncertain occurrence. Uncertainty or an
interrupted run pauses the schedule immediately. Repeated failed or stopped
runs pause it at `pause_after_failures`. Reconcile the affected run, then use
`schedule enable` to grant standing authority again. Disabling or removing a
schedule never stops an already admitted run.

## Exact resume and uncertainty

Workflow source, inputs, harness definitions, runtime ABI, workspace identity,
and execution boundary are pinned when a run starts. A safely interrupted run
can replay completed agent results and continue unfinished work in the same
workspace and execution boundary. Use the exact resume command reported by
`inspect`; the backend reopens its pinned snapshot and does not require the
original workflow file to remain present.

For the local backend, workspace identity includes the real path plus filesystem
device and inode. Replacing a directory at the same path therefore fails before
execution rather than being mistaken for the continuing workspace.

```bash
jaeger resume 20260720194512-0123456789
```

Editing the workflow or changing inputs creates a new run. Resume does not
reconstruct or verify filesystem and external effects from completed workers. If
that state was rolled back, replaced, or changed outside the run, abandon the old
run and start a new one.

An agent step that started but did not durably complete is `uncertain`. It may
already have produced side effects, so Jaeger fails closed: it does not retry the
step and does not offer a resume command. Reconcile the possible external effects
before deciding whether to start a new run.

## Workflow API

### `inputs`

The pinned JSON value read from `--input FILE` or stdin with `--input -`.

### `phase(name)` and `log(value)`

Record replay-safe human-readable progress without changing workflow dataflow.

### `parallel(tasks)`

Run zero-argument functions concurrently and return their results in input order.
Jaeger's run-level concurrency policy bounds launched agent work.

### `agent(prompt, options)`

Each call creates a durable native provider session and runs its first turn.
Supported authored options are:

| Option | Meaning |
| --- | --- |
| `harness` | Required: built-in `codex`, `claude`, or `pi`, or a configured custom name |
| `model` | Native model identifier passed to the harness |
| `effort` | Native effort value passed to the harness |
| `serviceTier` | Codex service-tier override |
| `profile` | Codex configuration profile |
| `cwd` | Working directory, resolved relative to the run working directory |
| `schema` | JSON Schema for the final structured output |
| `label` | Human-readable label included in the durable step identity |
| `timeoutMs` | Positive timeout up to 24 hours |

Per-agent permission and session-persistence controls are deliberately absent.
Sessions are always persisted and workers always have full authority. Legacy
`access`, `fresh`, and `claude-code` compatibility forms are invalid rather than
silently ignored.

## Custom harness surfaces

Jaeger ships three protocol drivers: `codex-app-server`, `claude-agent-sdk`, and
`pi-rpc`.
Operators may register additional workflow-facing harness names that select one
of those drivers and a launcher executable. The local backend reads user configuration from
`$XDG_CONFIG_HOME/jaeger/harnesses.json` or `~/.config/jaeger/harnesses.json`.
Use `jaeger backend install --harness-config FILE` to pin another same-host
configuration into the service, or use `--harness-config FILE` explicitly with
`run` or `doctor`.

```json
{
  "version": 1,
  "harnesses": {
    "company-claude": {
      "driver": "claude-agent-sdk",
      "command": "/opt/company/bin/claude-gateway",
      "description": "Claude Code through the company gateway"
    }
  }
}
```

The custom name is then an ordinary workflow choice:

```js
return agent("Inspect the current change.", {
  harness: "company-claude",
  effort: "high",
})
```

Built-in names are reserved. Configuration supplies one executable path, not a
shell command or argument string; wrapper launchers may own environment setup,
credentials, gateway selection, and default model mapping. Keep credentials out
of the Jaeger configuration itself.

New runs pin the resolved harness definitions in their immutable run record.
Detached workers and later `session resume` operations therefore retain the
same driver and launcher without re-reading mutable user configuration. The
launcher binary and its external environment remain host-owned dependencies,
just as they are for the built-in `codex`, `claude`, and `pi` commands.
Unavailable built-ins are omitted from a new run's pinned registry, so adding
Pi support does not make Pi a mandatory dependency for Codex- or Claude-only
hosts. An unavailable explicitly configured custom launcher still blocks
admission.

## Native session boundary

Codex is integrated only through the
[Codex app-server](https://developers.openai.com/codex/app-server/) protocol over
`codex app-server --stdio`; Jaeger does not retain a `codex exec` fallback. Each
active turn gets a contained app-server
transport process while the non-ephemeral Codex thread remains provider-
persisted and resumable. Claude Code surfaces are integrated through the official
[streaming Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
with [session persistence](https://code.claude.com/docs/en/agent-sdk/sessions)
enabled; there is no `claude --print` fallback. Custom surfaces reuse one of
these transports rather than weakening the provider session contract. Pi
surfaces use strict-LF JSONL over `pi --mode rpc`, require Pi 0.80.4 or newer,
persist sessions below the Jaeger run, and wait for `agent_settled`; there is no
text/print compatibility fallback. Pi has no native output-schema switch, so
Jaeger adds the schema to the prompt and still parses and validates the final
JSON itself. All
surfaces load their native commands, tools, skills, MCP servers, hooks, and
settings with full permissions.

The workflow checkpoint and provider session are related but distinct durable
objects. Steering an in-flight workflow step can change that step's eventual
checkpointed result. Turns started later with `jaeger session resume` remain in
the provider conversation and Jaeger's session record, but do not rewrite the
already completed workflow result or replay journal.

## Authority and isolation

Starting a workflow is the authorization event for the entire automation. Every
worker receives its native harness's full non-interactive technical authority.
Jaeger does not pause for per-command or per-edit approval.

Prompts such as “review without editing” are useful behavioral constraints, but
they do not reduce technical authority. Do not describe them as a sandbox or a
permission guarantee.

Containment belongs around the whole Jaeger process. When a workflow must not
reach the full host, run Jaeger and all of its workers inside a constrained
workspace, sandbox, container, or VM selected by the operator. Jaeger's default
boundary is the host and working directory from which it was launched; Jaeger
does not claim that boundary is isolated.

The per-call systemd scopes are lifecycle containment, not a security sandbox.
They let Jaeger discover, stop, and prove the absence of ordinary provider
descendants after failures. A full-authority worker on the default host boundary
is still trusted and may be technically capable of changing its own host
process controls. Use the outer runtime boundary for adversarial isolation.

## Coordinator replay contract

Coordinator code may compute with pinned inputs and checkpointed agent outputs
using ordinary deterministic JavaScript. Outside Jaeger primitives, it must not
perform filesystem, shell, network, clock, randomness, or environment-dependent
operations. Put external effects in `agent()` calls so Jaeger can attribute and
checkpoint them. `phase()` and `log()` are safe because Jaeger owns their journal
and replay behavior.

The validator also rejects Promise continuation methods, timing races,
locale-sensitive methods, reflective or dynamically synthesized string member
access, and mutation of captured state from async or `parallel` callbacks. Use
`await`, return values from parallel tasks, combine those results afterward, and
coerce dynamic array indexes with `Number(...)` when necessary. These constraints
keep replay order independent of provider completion timing and host locale.

Only a truncated final coordinator checkpoint with no unfinished agent can be
repaired, and repair occurs while holding the exclusive run lease. A complete
`agent.started` without one durable completion remains uncertain and is never
discarded or retried.

Each service-owned run stores its immutable record, pinned workflow source,
journal, session records, control mailboxes, and harness scratch data below
`$XDG_STATE_HOME/jaeger/runs/<run-id>/` by default. Version 4 run records also
pin the runtime ABI, backend kind, filesystem-backed workspace identity, and
submission key. The state root also contains a private atomic submission index;
continued provider turns add immutable request, owner, and result records under
the run directory. Persistent schedule state lives under the same backend-owned
root in `.schedules/`, with private state, revision, and occurrence records.
Lifecycle hook events and delivery attempts live separately in `.hooks/`; they
are observer state and are never interpreted as workflow checkpoints.
Embedded compatibility mode defaults to `.jaeger/runs/<run-id>/`. Provider-
native conversation history is owned by Codex, Claude Code, or Pi. Jaeger state and
transcripts may contain prompts, tool activity, and outputs; treat the entire
state root as sensitive local data.

## Packaged skill

The npm artifact contains exactly one skill at
`skills/jaeger-workflows/`. Installing the package makes that directory available
inside the package, but deliberately does not copy or link it into a harness's
personal skill directory. Load or install it explicitly according to the parent
harness's skill conventions.

See [examples/mixed-review.js](examples/mixed-review.js),
[examples/review-fix-loop.js](examples/review-fix-loop.js), and
[examples/cross-harness-smoke.js](examples/cross-harness-smoke.js) for complete
workflow files. The accepted product boundary is documented in
[docs/design/jaeger-workflows.md](docs/design/jaeger-workflows.md).
