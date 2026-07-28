# Jaeger runtime modules

Status: implemented

## Purpose

Jaeger is a durable robot around native coding-agent harnesses. Its continuing
backend supplies the journal, leases, provider sessions, scheduling, lifecycle
events, and inspection. A machine may need additional coordination behavior
that is too local and fluid to belong in every installation: Telegram, Discord,
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
- Package installation remains the responsibility of an ordinary JavaScript
  package manager.

This is not a second provider-plugin system. Codex, Claude, and Pi continue to own
their native skills, hooks, MCP servers, and plugins.

## Configuration

The default convention is:

```text
~/.config/jaeger/runtime/
├── package.json
├── node_modules/
└── jaeger.runtime.mjs
```

The configuration has one version and uniquely named modules:

```js
export default {
  version: 1,
  modules: [{
    name: "example",
    setup(runtime) {
      runtime.events.consume("run.terminal", async event => {
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
Events have stable IDs. Each module consumer has durable delivery state and
at-least-once retry with capped backoff:

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

## Telegram reference

The reference module uses long polling, a private token file, explicit user and
chat allowlists, topic-scoped bindings, durable binding state, and a
configurable small default model. Plain Telegram messages submit fresh session
forks. `/model` changes the topic default without changing the workflow model.

The first version excludes steering, interruption, stopping, resuming, or other
workflow mutation.
