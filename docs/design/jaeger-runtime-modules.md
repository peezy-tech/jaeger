# Jaeger runtime modules

Status: implemented

## Purpose

Jaeger is a durable robot around native coding-agent harnesses. Its continuing
backend supplies the journal, leases, provider sessions, scheduling, lifecycle
events, and inspection. A machine may need additional coordination behavior
that is too local and fluid to belong in every installation: Discord,
home-command-center projection, lab control, or another operator channel.

Runtime modules are the machine-level composition seam for that behavior. They
are ordinary trusted ESM JavaScript running in the persistent backend process
with normal package resolution.

## Boundary

- The operator owns one runtime configuration file and its package project.
- Authored workflows cannot install, select, or alter runtime modules.
- Modules share the backend PID, memory space, credentials, and Unix identity.
- There is no sandbox or capability security model.
- Module setup failures fail backend admission before a new installation
  generation commits.
- Later handler or service failures degrade the module but do not rewrite
  workflow state.
- Configuration changes take effect on backend restart; there is no hot reload.
- Registry items contribute source files and dependency requirements to the
  operator's one package project. Jaeger delegates the resulting single
  dependency installation to an ordinary JavaScript package manager.

This is not a second provider-plugin system. Codex, Claude, and Pi continue to own
their native skills, hooks, MCP servers, and plugins.

## Configuration

The default convention is:

```text
~/.config/jaeger/runtime/
├── package.json
├── package-lock.json
├── node_modules/
├── modules.lock.json
├── modules/
│   └── discord/
└── jaeger.runtime.mjs
```

## Source registry

Jaeger modules use a source-distribution model. A `jaeger.module.json` item
declares inspectable files, dependency requirements, compatibility metadata,
configuration requirements, declared access, and optional commands. A
`jaeger.registry.json` catalog maps short item names to manifests. An item may
be loaded from a local file, an HTTPS URL, a catalog reference such as
`jaeger.registry.json#discord`, or the GitHub shorthand
`OWNER/REPOSITORY/ITEM#REF`. Items in Jaeger's bundled catalog can be selected
by bare name.

`modules add` copies every item beneath `modules/NAME`. Item directories are
source ownership units, not package projects: every dependency requirement is
reconciled into the runtime root's one `package.json`, one package-manager
lockfile, and one `node_modules`. Adding several modules performs at most one
dependency installation:

```bash
jaeger modules add \
  peezy-tech/jaeger/discord#0123456789abcdef0123456789abcdef01234567
```

`modules.lock.json` records the resolved manifest, source digest, per-file
hashes, each module's dependency requirements, and any operator-owned range
that was present before Jaeger began managing a dependency. Conflicting ranges
fail before source is installed. Removing a module restores or retains an
operator-owned dependency and removes a registry-introduced dependency only
when no installed module still requires it.

Registry installation never imports module code, changes secrets, edits
`jaeger.runtime.mjs`, or activates the backend. Package lifecycle scripts are
disabled. The explicit trust boundary remains:

```bash
jaeger modules diff discord
jaeger modules validate ~/.config/jaeger/runtime/jaeger.runtime.mjs
jaeger backend install \
  --runtime-config ~/.config/jaeger/runtime/jaeger.runtime.mjs
```

The access declaration is review metadata, not an enforced permission model.
Installed source still has the full authority of the backend once the operator
imports and activates it.

When `modules.lock.json` is present, the backend's reported runtime-module
digest covers the root package metadata and lockfile plus the complete installed
module source tree, not only `jaeger.runtime.mjs`. Local source edits remain
allowed, but they produce a new loaded digest.

The configuration has one version and uniquely named modules:

```js
export default {
  version: 1,
  modules: [{
    name: "example",
    setup(runtime) {
      runtime.events.consume("terminal", "run.terminal", async event => {
        runtime.log.info(`${event.run.runId} finished`);
      });
      runtime.services.run("listener", async signal => {
        await listenUntilAborted(signal);
      });
    },
  }],
};
```

`backend install --runtime-config FILE` resolves and validates the entrypoint
before systemd handoff. The private backend profile pins the resolved path and
the backend reports the loaded source digest.

## Runtime context

Version 1 exposes durable lifecycle-event consumption, backend-owned background
services, run and session inspection, forked session queries, namespaced
durable JSON storage, and module-prefixed logging. The context is a stability
and convenience seam, not an authority boundary.

## Lifecycle and events

Backend startup loads and sets up modules before run recovery. After recovery,
the backend starts schedules, hook reconciliation, event delivery, and module
services. Shutdown aborts services and waits for registered work.

Hooks and modules consume the same normalized post-checkpoint event store.
Events have stable IDs. Each named module consumer has durable delivery state
and at-least-once retry with capped backoff. Its name is the stable identity
across configuration generations, so registration order does not reassign
delivery state:

```text
run.accepted
phase.changed
session.available
agent.completed
run.terminal
schedule.changed
schedule.occurrence
session.query.completed
```

`session.available` becomes eligible after a provider-native session ID is
durable. Event envelopes remain bounded metadata rather than transcript or
prompt replication.

## Forked session queries

A side-channel question must not resume or steer the workflow-owned provider
session. Jaeger records a separate query request, forks the latest native
session, and executes the question in a separately contained worker.

Codex uses app-server `thread/fork`. Claude uses the Agent SDK's forked-session
resume. The child runs read-only by default. Its result and provider child ID
are durable, while the parent session record is unchanged.

Each query has an idempotency ID and the states `queued`, `running`, `orphaned`,
`completed`, or `uncertain`. A claimed worker that disappears without a durable
result is never replayed automatically.

## Discord reference

The reference module uses an official Discord bot in one configured private
guild and voice channel, a private token file, one exact user allowlist, and
guild-scoped interactions. `/runs` lists recent workflows, `/attach` stores a
private binding, and `/ask` submits a fresh read-only session fork without
mutating the workflow-owned provider thread.

On an attention event, the bot joins the configured voice channel and sends the
allowlisted user a direct channel link. Codex realtime starts only after that
user joins. The bridge accepts only that user's audio, disconnects on an
unexpected participant, and has no HTTP, browser, or alternate media surface.
Its dedicated Codex operator exposes only the fixed zero-argument read-only
Jaeger status operation.
