---
name: jaeger-workflows
description: Author and operate file-first Jaeger workflows across native coding-agent harnesses. Use when Codex needs to create or edit a Jaeger JavaScript or TypeScript workflow, validate it, launch a detached run, inspect or stop durable run state, wait for completion, safely resume an exact pinned run, interact with a workflow-launched provider session, or explain Jaeger's authority and checkpoint boundaries.
---

# Jaeger Workflows

Use Jaeger's CLI as the only operational interface. Keep workflows as ordinary,
reviewable files; do not invent a second wrapper, tool protocol, or save registry.

## Check the local interface

Run `jaeger --help`, `jaeger runtime list`, and `jaeger doctor` before authoring
against an unfamiliar installation. On Linux, the installed CLI uses its
persistent same-user backend by default. If it is not installed or active, run
`jaeger backend install` once, then repeat doctor. For a named SSH runtime, run
`jaeger runtime doctor NAME` or `jaeger --runtime NAME doctor` and confirm the
target, stable instance identity, Linux user-systemd containment, and intended
harness. Treat installed help as authoritative if command spelling has evolved.
Never silently fall back to another runtime when the selected backend is
unavailable.

On Windows, Jaeger is an SSH controller only. Do not attempt `backend install`,
embedded execution, or local environment management there. Confirm `ssh.exe`
can already use the intended `%USERPROFILE%\.ssh\config` profile, then register
and persist the Linux target:

```text
jaeger runtime add build --ssh build-host --default
jaeger runtime doctor build
```

Once selected, bare `jaeger` and ordinary operational commands route to that
runtime. Workflow, manifest, and input files are local Windows paths; `--cwd`
and any path interpreted by the Linux runtime must be absolute POSIX paths.

## Author a workflow

Write a small `.js` or `.ts` coordinator with one `export const meta`, then
use top-level `await` and `return`. Jaeger supplies `inputs`, `trigger`, `phase`,
`log`, `parallel`, and `agent` as globals. `trigger` is undefined for an
ordinary launch and contains immutable schedule occurrence metadata for a
scheduled launch.

```js
export const meta = { name: "review", phases: [{ title: "Review" }] }

phase("Review")
const findings = await agent(
  "Review the current change without editing it. Return concrete findings.",
  {
    harness: "codex",
    cwd: inputs.cwd || ".",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["findings"],
      properties: { findings: { type: "array", items: { type: "string" } } },
    },
  },
)
return findings
```

Keep coordinator computation deterministic. Outside Jaeger primitives, do not
read the filesystem, run commands, call the network, inspect the environment,
read the clock, or use randomness. Put every external effect in an `agent()`
call so completion can be checkpointed.

Use `await` instead of `.then()`, `.catch()`, or `.finally()`. Do not use
locale-sensitive or reflective property methods, dynamically computed string
member access, or mutate captured state from async/`parallel` callbacks. Return
each task's value and combine `parallel()` results after awaiting them. Numeric
array indexes remain available; coerce a dynamic input with `Number(...)`.

Select built-in `codex`, `claude`, or `pi`, or a custom harness listed by `jaeger
doctor`, and use native behavior with agent options such as `harness`, `model`,
`effort`, `serviceTier`, `profile`, `cwd`, `schema`, `label`, and `timeoutMs`.
Custom harnesses reuse a shipped Codex app-server, Claude Agent SDK, or Pi RPC
driver;
omit `model` when their launcher owns the mapping. Do not add
per-agent permission or session-persistence options. Every call starts a
persisted native provider session with full non-interactive technical authority.
Do not use the removed `claude-code` harness name or invent a Codex exec/Claude
print compatibility path.

Instructions such as "review without editing" are prompt-only behavioral
constraints. They are not sandboxes. If the workflow must be contained, run the
entire Jaeger process and all workers inside an appropriate constrained
workspace, sandbox, container, or VM.

Jaeger's per-provider systemd scopes are lifecycle controls, not permission
boundaries. They let stop empty ordinary descendant trees; they do not make a
full-authority worker adversarially isolated from the host.

## Validate and launch intentionally

Validate before launch:

```text
jaeger validate ./workflow.js
```

When the operator supplied a non-default harness registry, prefer configuring
the same-host service with `jaeger backend install --harness-config FILE`, then
validate it through `jaeger doctor`. An explicit per-run `--harness-config FILE`
is also accepted on the same host. The backend resolves and pins definitions in
the new run; do not supply them again when resuming it.

Review the workflow and inputs before starting it. Starting a run authorizes the
whole workflow; Jaeger does not ask for approval at each worker action.

Use detached client attachment for work that should immediately return control:

```text
jaeger run ./workflow.js --input ./input.json --detach
```

To use a registered SSH runtime, select it explicitly and provide an absolute
working directory that already exists on the target:

```text
jaeger --runtime build run ./workflow.js --input ./input.json \
  --cwd /srv/checkouts/project --detach
```

Workflow and input contents come from the initiating machine and are pinned by
the remote backend. `--cwd` and any per-run harness configuration path refer to
the remote host. Jaeger does not synchronize the checkout. Do not guess a path
mapping or silently substitute the local workspace.

The backend owns the run in both attached and detached cases. `--detach` only
controls whether this CLI waits; it does not choose the runtime or determine
durability. Capture the returned JSON, especially the opaque `runId`,
target-qualified `runRef` when present, and exact inspect, wait, stop, or resume
commands. Do not preserve or reconstruct the backend's state-directory path for
ordinary operation.

Also preserve the `submissionId` printed before launch. If the submit response
is ambiguous, do not issue a fresh run blindly: retry the identical command with
`--submission-id ID`, or run `jaeger submission ID` to resolve the durable
claim.

## Operate a durable run

Start with the compact summary and request detailed state only when needed:

```text
jaeger inspect RUN_ID --summary --json
jaeger wait RUN_ID
jaeger stop RUN_ID
```

For a remote run, prefer the exact qualified commands returned by Jaeger, such
as `jaeger wait build:RUN_ID`. A qualified reference preserves the target even
when `JAEGER_RUNTIME` later changes. Treat physical paths in remote output as
target-local diagnostics.

Each launched agent also exposes a durable provider session:

```text
jaeger session list RUN_ID --json
jaeger session inspect RUN_ID SESSION --json
jaeger session resume RUN_ID SESSION --message -
jaeger session turn inspect RUN_ID TURN_ID
jaeger session turn wait RUN_ID TURN_ID
jaeger session steer RUN_ID SESSION --message -
jaeger session interrupt RUN_ID SESSION
```

Use `resume` only for an idle session and `steer` or `interrupt` only for an
active turn. Prefer the exact state-appropriate command returned by list or
inspect. Surfaces using the Codex app-server driver append steering to the active
turn. Surfaces using the Claude Agent SDK driver use native interrupt and
immediately continue with the message in the same persisted session.
Surfaces using the Pi RPC driver use native steer and abort commands. Wait for
Pi's `agent_settled` boundary, and issue Pi session queries only after the
parent is idle.

Persistent-backend session resumes run in independent durable turn workers. For
a long continuation, use `--detach`, retain the printed turn ID, and use its
returned inspect or wait command. If submission is ambiguous, retry the same
message with `--request-id TURN_ID`; never invent a new turn ID until the prior
one is resolved. Backend restart or client disconnect stops only the wait.

A `rejected` turn lost admission to another next-turn request and never reached
the provider; it is terminal and safe to replace after the accepted turn is
resolved. Do not treat it as an uncertain provider effect.

If Jaeger reports an uncertain stale session turn, do not resume it. The lost
controller may have produced provider effects that were not durably recorded;
reconcile that conversation before starting replacement work.

A resumed session turn after workflow completion does not rewrite the workflow's
durable result. Steering the original in-flight turn can affect the result that
the workflow eventually checkpoints.

Use `wait` when completion is the next decision point. Use `stop` only when the
user wants execution terminated; stopping an in-flight worker may leave an
uncertain side-effect boundary.

Resume only when Jaeger reports that the run is safely resumable. Execute the
exact `jaeger resume RUN_ID` command returned for that run. The backend reopens
the pinned workflow source, inputs, harnesses, runtime ABI, and continuing
workspace; the original workflow file is not the authority. Never edit source
or inputs and try to reconcile them into the old run; start a new run.

Treat an uncertain step as terminal. It may already have changed external state,
so do not retry it or suggest a resume command. Reconcile its possible effects
first, then start a new run if appropriate.

Use `--runtime embedded` or `JAEGER_RUNTIME=embedded` only for explicit local
debugging and compatibility work. `--state-dir` is likewise an advanced local
override. Do not put either in routine workflow instructions. A backend restart
does not stop active transient workers; use the returned `stop` action when the
user intends to terminate a run.

## Operate standing schedules

Schedules require the persistent backend because they grant standing authority
and need a continuing clock owner. Keep their manifests in version control,
validate them locally, apply an immutable revision, and enable it explicitly:

```text
jaeger schedule validate ./daily.toml
jaeger schedule apply ./daily.toml
jaeger schedule enable daily
```

For a named SSH runtime, select it on apply and every name-scoped operation.
The manifest and workflow source are local, but `cwd` must be an absolute path
on the target:

```text
jaeger --runtime build schedule apply ./daily.toml
jaeger --runtime build schedule enable daily
```

Applying changed source, inputs, harness definitions, workspace identity, or
policy creates a new disabled revision. Re-enable it only after reviewing the
reported revision. Use `schedule apply --activate` only when immediate activation
is intentional.

Inspect the schedule and its occurrence history without treating it as a
long-lived workflow run:

```text
jaeger schedule list --json
jaeger schedule inspect daily --json
jaeger schedule history daily --json
jaeger schedule trigger daily --json
jaeger schedule disable daily
```

Each occurrence creates an ordinary Jaeger run with its own run ID, sessions,
checkpoints, and uncertainty boundary. A manual trigger prints a request ID
before admission; retry an ambiguous trigger with the same `--request-id`.
Disabling prevents future occurrences but does not stop an active run.

Never put `cron()`, clock reads, timers, or infinite scheduling loops in a
workflow. Never automatically retry an uncertain occurrence. The backend pauses
the schedule on uncertainty, interruption, or its configured consecutive
failure threshold; reconcile the run before enabling the schedule again.
Embedded mode deliberately rejects schedule operations.

## Operate lifecycle hooks

Lifecycle hooks are operator-configured observers, not workflow-authored steps
and not provider hooks. Validate one global configuration before installing it:

```text
jaeger hooks validate ~/.config/jaeger/hooks.toml
jaeger backend install --hooks-config ~/.config/jaeger/hooks.toml
jaeger hooks status --json
jaeger hooks history --limit 50 --json
```

The persistent backend delivers normalized post-checkpoint events at least once
with stable event IDs. Hook commands receive JSON on standard input and must be
idempotent. A hook failure is independent delivery state: it must never be
reported as workflow uncertainty or used as a reason to resume a completed run.
Use `hooks status` for backlog health and `hooks history` for individual
attempts. Embedded mode validates configuration but does not dispatch hooks.

## Reuse successful workflows

Keep successful workflow and input files in the project with meaningful names.
Reuse happens through normal files and version control, not a Jaeger registry.
