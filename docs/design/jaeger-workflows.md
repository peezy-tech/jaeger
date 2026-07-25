# Jaeger Workflow Model

Status: accepted design, implemented for first-class sessions, custom harness surfaces, the persistent local backend, named SSH runtimes, and Windows SSH controllers

Date: 2026-07-25

## Purpose

Jaeger is a high-level automation runner that coordinates native coding-agent
harnesses. It is not a clone of Claude Code's Dynamic Workflows implementation.

The supporting Claude Code observations are recorded separately in
[Claude Code Dynamic Workflows: Observational
Evidence](../research/claude-code-dynamic-workflows.md). Tool schemas, caching,
session behavior, worktrees, and other Claude-specific mechanics in that note
are comparative evidence, not Jaeger requirements.

## Core model

A workflow is an ordinary, prompt-heavy JavaScript or TypeScript file. Plain
control flow connects structured outputs between agents. Jaeger supplies a few
orchestration primitives and routes each agent call to a selected native
harness and model.

The boundary is:

- the workflow owns prompts, dataflow, branching, loops, and declared phases;
- Jaeger owns scheduling, harness routing, durable run state, concurrency,
  progress, session control, and inspection; and
- each harness owns commands, edits, tools, skills, MCP servers, hooks, and
  provider-native behavior.

Jaeger does not add action wrappers around capabilities the harness already
provides.

Runtime vocabulary separates four concerns that must not be conflated:

- the control plane is either the default persistent local service or an
  explicitly selected embedded implementation;
- coordinator and provider workers are transient per-run or per-turn processes
  in both implementations;
- run checkpoints are durable in both implementations; and
- provider-native conversation continuity is distinct from workflow state.

“Detached” describes whether a CLI waits. It is not a storage policy, a worker
placement choice, or a second workflow runtime.

## Coordinator replay contract

The workflow coordinator must be deterministic and rerunnable. It may compute
with pinned inputs and durably checkpointed agent outputs, using ordinary
branching, loops, arrays, objects, and other in-memory JavaScript. Outside the
Jaeger primitives, it must not perform filesystem, shell, network, clock,
randomness, or environment-dependent operations.

External effects belong in `agent()` calls so Jaeger can attribute them to a
durable step and avoid repeating a completed operation during resume. `phase()`
and `log()` are safe coordinator effects because Jaeger owns their replay and
journaling semantics.

This is not a lower permission mode. Starting a workflow authorizes the whole
automation with full authority; coordinator purity only determines where
side effects occur so checkpoint replay remains coherent.

## File-first CLI and skill

Jaeger has one operational interface: its CLI. A thin, installable skill teaches
Codex, Claude Code, or another parent harness how to:

1. author a workflow as an ordinary file;
2. validate and inspect it;
3. launch it intentionally without blocking the parent harness for its full
   duration;
4. inspect only the run state needed for the current decision;
5. resume an interrupted run whose source and inputs remain pinned;
6. resume, inspect, steer, or interrupt sessions launched by that run; and
7. organize and reuse successful workflow files.

A dedicated Workflow tool is not part of the design. Permanently registered
tool schemas consume parent-agent context and would duplicate the CLI protocol.
The parent harness already has the file and shell capabilities needed to use
Jaeger, while a skill can be loaded only when relevant.

A candidate progressive interaction is:

```text
jaeger validate <script>
jaeger run <script> [--input <file>] [--harness-config <file>] [--detach]
jaeger inspect <run-id> --summary --json
jaeger wait <run-id>
jaeger stop <run-id>
jaeger resume <run-id> [--detach]
jaeger list --json
jaeger session list <run-id> --json
jaeger session inspect <run-id> <session> --json
jaeger session resume <run-id> <session> --message -
jaeger session turn inspect <run-id> <turn-id>
jaeger session turn wait <run-id> <turn-id>
jaeger session steer <run-id> <session> --message -
jaeger session interrupt <run-id> <session>
```

The exact command names can evolve. The stable product contract is file-first
authoring, one CLI, compact structured results, and detailed state on demand.
Workflow files are already persistent artifacts, so reuse does not require a
separate save protocol. The backend provides recent-run discovery; a separate
named workflow registry is not required.

Background execution is a core capability because workflows may run far longer
than a parent-agent turn or interactive shell should remain blocked. Every
accepted run belongs to the backend and continues independently of the invoking
harness turn. Without `--detach`, the CLI waits for its terminal view; with
`--detach`, it returns the durable run ID immediately. The execution topology is
identical.

The CLI and skill should let an agent inspect compact summaries, wait when
appropriate, stop a run, and interact with a selected provider session without
continuously polling or ingesting full transcripts.

## Persistent scheduling model

Scheduling is a capability of a continuing runtime, not workflow syntax and not
a property of detached attachment. The persistent local service owns schedule
evaluation. Embedded mode can execute a run immediately but rejects standing
schedules because it cannot durably own future time.

The durable model has four layers:

1. a file-first schedule manifest describes one cron trigger and launch policy;
2. applying it creates an immutable schedule revision that pins workflow source,
   static inputs, resolved harness definitions, workspace identity, timezone,
   and overlap, misfire, and failure policy;
3. each matching instant creates one durably claimed occurrence identified by
   schedule, revision, and scheduled UTC minute; and
4. an admitted occurrence creates an ordinary Jaeger run with the existing run,
   checkpoint, session, inspection, and uncertainty contracts.

Schedule state is a mutable pointer to one immutable revision plus enabled,
cursor, pause, and tombstone state. Applying a changed revision disables the
schedule; enabling is the explicit standing-authorization event. An identical
application is idempotent. Disabling prevents new occurrences but does not stop
an already admitted run.

Occurrence identity is established before submission. Its deterministic
submission ID binds one schedule revision and occurrence to one run through the
existing atomic submission index. Recovery may complete a pending occurrence or
read back its accepted run, but cannot create a second authoritative run for the
same firing.

The scheduler records explicit overlap skips and supports three bounded misfire
policies: skip missed times, admit only the latest missed match, or catch up a
bounded number of matches. The default forbids overlap and skips misfires.
Uncertain runs are never retried. An uncertain or interrupted occurrence pauses
the schedule, as does the configured consecutive failure threshold.

Coordinator determinism remains intact. A scheduled run pins immutable trigger
metadata in its run record and exposes it through the `trigger` global. Ordinary
runs expose `trigger` as undefined. Workflow code never reads the clock, sleeps,
or implements an infinite recurrence loop.

Cron is initially one trigger type under the broader schedule resource. This
keeps later interval, webhook, repository-event, or run-dependency triggers from
requiring another execution or history model.

## Authorization model

Starting a workflow is the authorization event. When a user runs a workflow, or
asks a coding agent to run it, that invocation grants the workflow full,
non-interactive automation authority.

Consequently:

- workers run with the selected harness's full non-interactive permissions;
- Jaeger does not pause for supervised per-command or per-edit approval;
- per-agent permission levels are not part of the authored workflow API;
- instructions such as "review without editing" are behavioral prompt policy,
  not a reduced technical permission mode; and
- previewing a workflow supports comprehension and intentional invocation, not
  an additional worker-permission ceremony.

Full authority does not have to mean permanent unrestricted access to the host.
Security hardening should place the entire workflow inside an execution boundary
such as a sandbox, container, VM, or constrained workspace. Workers then retain
full authority inside that boundary. Isolation answers where automation may act;
interactive permission prompts are not Jaeger's security model.

## Workflow durability and session continuity

Jaeger does not need Claude Code's semantic agent cache or its edit-invalidation
rules. A run has a simpler identity and lifecycle:

1. Workflow source and inputs are pinned when the run starts.
2. A durably completed agent step becomes a checkpoint in that run.
3. Resuming the same run replays completed checkpoint results and continues
   unfinished work.
4. Editing the workflow or changing its inputs creates a new run.
5. A step that started but did not durably complete is uncertain and remains
   fail-closed because it may have produced side effects.

There is no cross-run cache identity, transitive invalidation graph, or edited
script reconciliation protocol. Labels, phase names, model options, and schemas
do not need special invalidation rules because a changed workflow is a new run.

This conservative model fits full-authority automation: Jaeger never retries an
uncertain side-effecting operation merely because a provider response was lost.

Resume also assumes the same continuing execution boundary and workspace. Jaeger
replays durable results; it does not reconstruct or verify the filesystem and
other external effects produced by completed agents. If that external state was
rolled back, replaced, or modified outside the run, the old run must be
abandoned and a new run started.

An uncertain step is terminal until its possible external effects have been
reconciled. Jaeger must not infer that the step failed harmlessly or retry it
automatically.

Every new `agent()` step also creates one durable Jaeger session backed by a
provider-native conversation. The session persists independently of the process
transport used for a particular turn. Once a workflow turn is idle, the user may
resume it with another message. While a turn is active, the user may steer or
interrupt it. Session selectors accept the Jaeger session ID, workflow step ID,
or native provider session ID.

Session interaction does not create a second workflow language. Steering an
active workflow turn can affect the result that the coordinator eventually
checkpoints. A later user-initiated resume extends the provider conversation but
does not mutate a completed workflow result or its replay journal.

Provider parity is behavioral, not protocol-identical. Codex app-server exposes
native active-turn steering. The Claude Agent SDK exposes streaming input and
native interrupt but no equivalent append-to-active-turn call, so every surface
using the Claude Agent SDK driver defines steering as interrupting the current
response and immediately continuing with the supplied message in the same
persisted session.

A user-initiated session continuation is a durable turn job, not work performed
inside the control-plane process. The backend records the immutable request and
one active-turn pointer, then launches a separately supervised worker. That
worker publishes an immutable ownership claim before provider interaction and
an immutable result before returning the session to idle. Backend or client
shutdown only interrupts a wait. A dead claimed worker without a result becomes
uncertain after its provider and worker scopes are proven inactive and is never
relaunched. A completed result can repair session metadata if the worker died
between result publication and finalization.
Distinct IDs contending for the same next session turn are serialized: one may
be accepted and every loser receives an immutable `rejected` result with no
provider interaction, so no durable request remains indefinitely `queued`.

A session query is a different operation from continuation. It forks the latest
provider-native conversation into a read-only child and records an independent
durable query job. Codex uses app-server `thread/fork`; Claude uses the Agent
SDK fork option. Query completion never advances or rewrites the workflow-owned
session. Claimed queries without durable results become uncertain and are not
replayed automatically.

## Runtime and inspection contract

The CLI depends on one operational `RuntimeClient` boundary rather than opening
run files, leases, session mailboxes, or transcripts itself. Its implementations
are:

1. `ServiceRuntimeClient`, which speaks a versioned newline-delimited JSON RPC
   protocol over a restrictive same-user Unix socket; and
2. `EmbeddedRuntimeClient`, an explicit debugging and legacy mode which invokes
   the same `LocalRuntimeService` in process; and
3. `SshRuntimeClient`, which opens a noninteractive OpenSSH channel to a named
   target and sends one framed request through the remote CLI's stdio bridge.

The persistent local service is the default on Linux. Windows is a
controller-only platform: it can compile local workflow source and use
`SshRuntimeClient`, but local service management, embedded execution, and
systemd-owned workers are unavailable. A named SSH runtime may be persisted as
the controller default. An unavailable configured service or target fails
closed; submission never silently falls back to embedded or another runtime.
The protocol covers readiness, submit,
inspect, wait, stop, resume, discovery, detailed events and artifacts, and all
session operations. A client-generated submission ID is printed before the RPC
and may be supplied again or resolved with `jaeger submission ID`. A private
per-state-root index atomically binds it to one request hash and one fully staged
run; publication and launch happen only after that claim is durable. Concurrent
backend instances therefore cannot create two authoritative runs for one key.
An idempotent retry checks that durable claim before resolving the current
workspace or harness registry, so accepted identity does not depend on ambient
resources that may have moved since acceptance.
This idempotency applies only to creation and does not weaken agent-step
uncertainty.

An SSH target is not a new backend kind on the execution host. It is a transport
to that host's existing persistent local backend. The remote CLI bridge reads
the host-local committed routing profile, applies its generation fence, and
forwards the request to the owner-only Unix socket. It never opens a network
listener or forwards the socket. One-shot SSH channels keep connection
lifecycle, host authentication, jump routing, and optional connection sharing
inside OpenSSH rather than creating a second Jaeger credential system.

Named targets are registered in a strict owner-only runtime registry separate
from the harness registry. An entry contains one SSH destination, one
constrained Jaeger executable, a bounded connection timeout, and the stable
instance ID discovered from the target. Keys, passwords, port settings, users,
proxy commands, and arbitrary SSH arguments are excluded. The transport uses
batch mode without a TTY, agent forwarding, port forwarding, or local commands.
Normal OpenSSH host-key verification remains authoritative.

On Windows, the client uses the platform `ssh.exe` and its normal
`%USERPROFILE%\.ssh\config`. The runtime registry inherits the user's Windows
profile ACL under `%APPDATA%\Jaeger`; it still contains no credentials or
arbitrary SSH arguments. Locally read workflow, manifest, and input paths follow
Windows rules, while every path interpreted by the Linux target is validated
and normalized as POSIX. This split prevents a controller from rewriting
`/srv/...` into a Windows path.

The backend instance ID identifies one state authority. Ordinary reinstall
generations rotate while the instance ID persists for the same state root.
Changing the state root creates a new ID, so a named target fails closed until
the operator explicitly re-registers it. Generation still protects the
host-local socket/profile handoff; instance identity protects the caller's
cross-host name binding.

The local backend is a coherent same-host bundle: a filesystem journal and
SQLite ownership lease, a continuing local workspace, transient user-systemd
worker scopes, the server-owned harness registry, session mailboxes, and local
artifacts. These parts are not exposed as an arbitrary state-provider ×
executor-provider cross-product.

Remote workflow admission keeps that bundle coherent. The initiating CLI reads
and validates workflow source and inputs, but the remote backend resolves and
pins the explicitly supplied absolute target `cwd`. The authored source path is
diagnostic; the transmitted immutable source is executable authority. Remote
launches require `--cwd`, and Jaeger does not infer path mappings or synchronize
a checkout. Remote schedule applications use the same split: local manifest,
workflow, and input contents with an absolute target workspace.

The service and transient workers have independent lifetimes. A service restart
reconciles existing state, leaves active workers running, and relaunches only
service-owned `pending` or safely `interrupted` runs. `failed`, `stopped`, and
`uncertain` runs are never automatically retried. Existing version 2 or version
3 embedded records are not silently adopted by service recovery. The service
owns one configured state root and rejects alternate roots on ordinary RPCs.

New version 4 records pin the workflow source and hash, inputs, resolved harness
definitions, runtime ABI and build version, backend kind, local workspace
identity, execution boundary, concurrency policy, and submission ID. Resume
opens that immutable snapshot by run ID; it does not depend on rereading the
original authored file. An incompatible runtime ABI or workspace identity fails
before execution. Local workspace identity includes the canonical path and the
filesystem device/inode pair, rather than merely hashing the stored path.

Operational complexity stays outside authored scripts. Jaeger should own:

- run IDs and immutable run records;
- background run ownership and lifecycle control;
- checkpoint journals and uncertainty state;
- harness scratch data and transcripts;
- durable session identity, current state, and control mailboxes;
- immutable session-turn requests, worker claims, results, and active pointers;
- concurrency and bounded resource policy;
- structured-output validation;
- phase, agent, timing, and usage events; and
- compact summary and targeted inspection views.

Workflow authors should not implement instrumentation or durable job plumbing.
Likewise, parent agents should not have to ingest a whole transcript to learn
what to do next.

A launch response is versioned, backend-qualified, and actionable, for example:

```json
{
  "schemaVersion": 1,
  "backend": { "name": "local", "kind": "local-service" },
  "runId": "20260720194512-0123456789",
  "status": "running",
  "scriptPath": "/abs/workflow.js",
  "runDir": "/home/user/.local/state/jaeger/runs/20260720194512-0123456789",
  "inspect": "jaeger inspect 20260720194512-0123456789 --summary --json",
  "wait": "jaeger wait 20260720194512-0123456789",
  "stop": "jaeger stop 20260720194512-0123456789"
}
```

Physical paths remain local diagnostic compatibility fields in this first
backend. For an SSH target those fields are explicitly target-local
diagnostics. Remote views add a target-qualified `runRef` and regenerate action
commands such as `jaeger wait build:RUN_ID`, so later operations do not depend
on the caller's environment default. Routine action commands omit state paths because the service owns a
default global run namespace. Transcript contents and journal details cross the
runtime protocol rather than being opened by the CLI.

`backend install` persists the selected socket and state root in a user profile.
Plain commands, status, and restart therefore continue to target a custom
installation without requiring a shell variable. Status correlates the socket
descriptor PID with systemd's `MainPID` and verifies the backend generation,
state root, entrypoint, harness profile, and committed admission state. The
routing profile is accepted only as an owner-only regular file beneath a fully
trusted, non-symlinked ancestor chain. The same authority-path rule applies to
the socket, state root, and user unit. Installers serialize on a process lease,
persist a pending generation, activate a replacement that may temporarily
listen on both old and new sockets, and keep all non-readiness RPCs closed until
that exact generation is committed atomically. CLI RPC envelopes carry the
committed generation. This turns the activation/profile interval into a
fail-closed handoff rather than a second mutable authority. An interrupted
install continues its pending socket, state, and harness intent on the next
install. A failed pre-commit install restores the prior unit, profiles, exact
enabled or enabled-runtime state, and active state. Before mutation, a
daemon-reloaded snapshot must prove that any prior unit is the exact regular
current-user unit at Jaeger's path with a stable active/inactive and supported
enablement state; foreign, masked, symlinked, or unstable same-named units are
refused. The compatibility socket is retired after commit; reinstall preserves
the prior custom harness registry unless explicitly replaced.

Verbose progress, transcripts, and per-agent events remain behind explicit
inspection commands so the parent agent controls its context use. A safely
resumable interrupted run may additionally report an exact resume command. An
uncertain run must report the uncertainty boundary instead of suggesting a
retry.

## Operator lifecycle hooks

Jaeger lifecycle hooks are post-checkpoint observers owned by the persistent
backend. They are distinct from provider hooks: Codex, Claude, and other
harnesses continue to own tool interception and provider-native behavior.
Jaeger hooks cannot intercept tools, change an agent, branch a workflow, or
participate in a workflow decision.

An operator installs one trusted global TOML file with `backend install
--hooks-config FILE`. Authored workflows cannot add or change hooks. A hook
subscribes to normalized lifecycle events and supplies an argv array plus a
bounded timeout:

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

Commands run directly without a shell and receive one bounded JSON event on
standard input. Event envelopes contain identifiers, timing, compact run or
schedule state, and actionable Jaeger commands. They do not contain prompts,
transcripts, arbitrary workflow results, agent outputs, or provider metadata.

The backend reconciles immutable run journals and durable schedule state into a
separate outbox. Event IDs are stable across restart, deliveries are ordered per
hook, and a zero exit status acknowledges at-least-once delivery. Timeouts,
nonzero exits, output-limit failures, and backend restarts leave retryable
delivery state with capped backoff. Hook state lives beneath the backend state
root but is not part of the run journal.

This separation is an uncertainty boundary: run or schedule state is durable
before an observer event is eligible, and hook delivery never rewrites that
state. A hook may fail forever while the originating workflow remains
authoritatively completed, failed, stopped, interrupted, or uncertain for its
own independent reasons.

The operator surface is `jaeger hooks validate`, `jaeger hooks status`, and
`jaeger hooks history`. Invalid configuration is reported as degraded observer
state rather than retroactively changing accepted work. Embedded mode can
validate a file but does not dispatch lifecycle hooks because it has no
continuing backend owner.

## Operator runtime modules

The persistent backend may load one trusted, operator-owned ESM configuration
containing in-process runtime modules. Modules register durable lifecycle-event
consumers and background services and receive a stable context for run/session
inspection, forked queries, namespaced state, and logging. They use ordinary
JavaScript package resolution and share the backend process and trust boundary;
Jaeger does not provide a sandbox or package marketplace.

Module configuration is not workflow input and cannot be changed by a workflow.
Setup failures block a replacement backend generation from becoming ready.
Later module failures remain separate from workflow correctness. Full details
and the Telegram reference contract are in
`docs/design/jaeger-runtime-modules.md`.

## Jaeger's distinguishing surface

Harness environment management is an orthogonal Jaeger control plane. Workflow
files choose a named execution surface; they do not install or mutate that
surface. `jaeger env` instead reconciles provider-native instruction files,
skills, plugins, configuration, and the optional Jaeger harness registry from a
declarative user environment. Codex and Claude remain responsible for loading
and executing their own native capabilities.

Only one environment is active at a time. Jaeger records exact content digests
and any displaced user content in a private state root. Updates and profile
switches refuse drift by default, preserve the original pre-management backup
across later updates, and restore removed targets. This ownership record avoids
both silent provider-config mutation and an overlapping second plugin runtime.

The environment plane is deliberately independent of the persistent workflow
backend: list, inspect, diff, check, apply, and uninstall are local CLI
operations. Installing the conventional Jaeger harness registry changes what a
subsequent run resolves and pins, while existing run records retain their
immutable harness definitions.

The authored primitives should remain small: `agent`, `parallel`, `phase`,
`log`, structured `inputs`, immutable `trigger` context, and normal JavaScript
control flow. Jaeger's special value belongs in routing an `agent()` call across
native harnesses and models, including model, effort, service tier, profile,
working directory, schema, label, and timeout choices.

Permission level is intentionally absent from that list. Isolation belongs to
the outer runtime boundary, not to individual agent calls. Each `agent()` call
starts a persisted provider session; session-persistence controls are not part
of the workflow language because persistence is unconditional.

Jaeger ships two drivers. The Codex driver uses the versioned app-server protocol
over stdio, with no `codex exec` compatibility path. The Claude Code driver uses
the official streaming Claude Agent SDK with persisted sessions, with no
print-mode fallback. Transport processes may be recreated between turns;
provider-native thread/session identity is the continuity boundary.

Workflow-facing harness names are registry entries, not additional protocol
implementations. The built-in `codex` and `claude` entries select the shipped
drivers and native commands. A user-owned configuration may add names that
select one shipped driver and one launcher executable. Built-in names are
reserved, project-local configuration is not discovered implicitly, and Jaeger
does not store credentials or reinterpret model aliases.

The resolved registry is pinned into each new run record, including an absolute
launcher path resolved at acceptance. Detached execution and later session turns
instantiate adapters from that pinned descriptor rather than re-reading mutable
user configuration or resolving a bare command from PATH. The service unit also
pins Node, its CLI entrypoint, `systemd-run`, and `systemctl`; its remaining PATH
entries are normalized absolute directories. Lifecycle commands use the same
persisted absolute `systemctl` path, and resolved full-authority paths must be
root/current-user owned without write authority for other users or shared
groups, including through replaceable ancestor directories. Provider credentials and gateway
behavior stay under host ownership.

## Non-goals

Jaeger does not need to reproduce:

- a permanently registered parent-harness Workflow tool;
- Claude Code's agent cache or edited-script invalidation behavior;
- per-agent session-persistence or freshness controls;
- nested saved-workflow lifecycle semantics;
- Claude's local-worktree or remote-isolation implementation;
- supervised per-worker permission selection;
- Claude-specific concurrency, retry, and cost rules;
- transparent remote execution against an arbitrary client filesystem; or
- independently selectable public state, worker, session, and artifact
  providers.

Those mechanisms can inform comparisons without defining Jaeger's architecture.

## Implemented consequences

The implementation follows this boundary:

- `access` and `fresh` are rejected rather than retained as compatibility
  options;
- `codex` and `claude` are the reserved built-in harness names;
- user-owned registry entries may add names over the shipped app-server or
  streaming Agent SDK drivers;
- resolved registry definitions are pinned into new durable run records;
- all operational CLI commands route through the shared runtime client/service
  contract;
- the persistent same-user backend is the default and embedded execution is an
  explicit override;
- accepted runs use transient workers independent of client and service
  lifetimes;
- service submission is idempotent and service recovery is restricted to safe,
  service-owned version 4 records;
- runtime ABI and continuing local workspace identity are pinned and checked;
- submission IDs are visible, reusable, directly resolvable, and atomically
  claimed across backend processes;
- a global recent-run list and a source-independent `jaeger resume RUN` command
  remove the ordinary state-directory and original-script burden from users;
- all sessions persist and all workers run with full non-interactive authority;
- workflow replay remains exact-source, exact-input, and fail-closed at uncertain
  agent boundaries;
- session list, inspect, resume, turn inspect/wait, steer, and interrupt are
  CLI-level operations, with resumed turns independently supervised;
- detached attachment, compact run inspection, waiting, resume, and stop remain
  run-level operations; and
- host isolation remains an outer runtime concern rather than a provider prompt
  or per-agent option.
