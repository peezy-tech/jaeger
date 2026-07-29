# Codex realtime voice runtime module

Status: planned

## Decision

Realtime voice will be an optional Jaeger runtime module for Codex users. It
will not become:

- a `jaeger voice` command;
- a workflow primitive;
- a Jaeger backend protocol;
- a generic voice-provider abstraction; or
- a dependency of Jaeger core.

Jaeger remains provider-neutral. The module integrates Codex voice with Jaeger
entirely through existing public boundaries.

## Architecture

```text
Browser microphone
    │ WebRTC
    ▼
Codex realtime voice
    │ dedicated Codex operator thread
    ▼
Installed jaeger CLI + jaeger-workflows skill
    │
    ▼
Jaeger persistent backend
```

The runtime module also consumes Jaeger lifecycle events so it can announce
relevant progress and completion.

The dedicated voice-operator thread is separate from workflow-owned Codex
sessions. It controls those sessions through Jaeger's existing CLI commands.
It never connects directly to their private app-server processes or bypasses
Jaeger's durable session and checkpoint machinery.

## Proposed module

```text
examples/runtime-modules/voice/
├── README.md
├── package.json
├── jaeger.runtime.mjs
├── voice-module.mjs
├── codex-voice-session.mjs
├── local-server.mjs
├── public/
│   └── index.html
└── test/
```

This is a reference module that Codex users copy or install into their personal
Jaeger runtime directory. Jaeger core does not load or depend on its packages
unless the operator explicitly enables it.

## Implementation stages

### 1. Compatibility spike

Prove the complete voice path before building the polished module:

1. Start `codex app-server` with `realtime_conversation` enabled.
2. Negotiate a realtime WebRTC V3 session from a local browser.
3. Create a dedicated, non-ephemeral Codex operator thread.
4. Ask by voice for Jaeger status.
5. Receive a concise spoken answer.
6. Restart the app-server connection and resume the same operator thread.

This is a hard gate. The installed Codex must expose the required experimental
API, and the active account must have the required realtime entitlement. When
the operator uses ChatGPT login without an `OPENAI_API_KEY`, WebRTC is the
candidate path, but a successful live call remains the deciding proof.

Acceptance criteria:

- A live microphone-to-spoken-response round trip succeeds.
- The operator thread survives an app-server reconnect.
- The spike performs only read-only Jaeger inspection.
- Failure leaves no Jaeger run or provider session in an uncertain state.

### 2. Runtime module lifecycle

Implement the reference module using only `RuntimeModuleContext`:

- Start and supervise the local browser endpoint and Codex app-server child.
- Register module health and shutdown services.
- Consume Jaeger lifecycle events.
- Persist only:
  - the operator thread ID;
  - focused run and session IDs;
  - event-consumer cursor and deduplication state; and
  - non-secret preferences.
- Recover cleanly after a backend or module restart.
- Report degraded health if Codex voice is unavailable without affecting
  Jaeger itself.

The first release supports one active voice session per module instance.

Acceptance criteria:

- Enabling or removing the module requires no Jaeger core changes.
- Backend startup fails cleanly when initial module setup is invalid.
- A later voice service failure degrades only the module.
- Restart recovery does not duplicate already acknowledged announcements.

### 3. Voice bridge

The module will:

- bind only to `127.0.0.1` by default;
- serve the microphone UI;
- initialize app-server with the experimental realtime API enabled;
- create or resume the voice-operator thread;
- exchange WebRTC offer and answer data with Codex;
- relay realtime conversation events to the browser;
- detect disconnects and offer a bounded reconnect; and
- start with deliberately narrow context rather than inheriting arbitrary
  recent Codex thread history.

Raw audio will not travel through Jaeger backend frames.

Acceptance criteria:

- The browser never receives Codex or Jaeger credentials.
- Audio is exchanged directly through the Codex realtime WebRTC path.
- App-server and WebRTC failures are distinguishable in module health output.
- Reconnect attempts are bounded and can be stopped by module shutdown.

### Telegram call invitations

The optional Telegram adapter is an outbound signaling surface, not another
voice transport:

```text
Jaeger lifecycle event or operator command
    │ outbound Telegram message
    ▼
Allowlisted chat/topic with Answer button
    │ private HTTPS link
    ▼
Existing browser WebRTC voice bridge
```

The adapter does not consume Telegram updates, register a webhook, accept chat
commands, or grant Telegram any Jaeger authority. The Answer link carries a
short-lived, single-use bearer token in its URL fragment. The service persists
only a hash of that token and records answered, declined, or expired
disposition. Telegram credentials and invitation tokens never enter browser
storage, HTTP access logs, or Jaeger backend frames.

The first release permits one outstanding invitation per module instance. A
call invitation expires after ten minutes by default. Answering it joins the
same dedicated Codex operator thread used by a manually opened browser session.

Acceptance criteria:

- Telegram delivery targets only the configured chat and optional topic.
- A valid invitation can be answered or declined once.
- Expired, replayed, malformed, and superseded invitations fail closed.
- The Telegram message is updated when the call is answered, declined, or
  missed.
- Removing Telegram configuration disables call invitations without disabling
  the browser voice bridge.

### 4. Operator behavior

The Codex operator receives stable instructions to:

- use the installed `jaeger` CLI and `jaeger-workflows` skill;
- prefer detached runs for substantial workflows;
- preserve and report exact run and session IDs;
- inspect summaries before requesting full transcripts;
- never blindly retry or resume an uncertain operation;
- treat Jaeger's durable state as authoritative; and
- ask for spoken confirmation before high-authority operations.

Consumer-facing capabilities for the first version:

- List active workflows.
- Start a known workflow with supplied input and confirmation.
- Focus on a run or session.
- Report run status and the current phase.
- Inspect recent results or failure summaries.
- Query a workflow-owned session.
- Resume, steer, interrupt, or stop through existing Jaeger commands.
- Announce focused lifecycle events such as phase changes, agent completion,
  and terminal results.

The operator uses Jaeger's ordinary CLI for every mutation. The runtime module
does not receive a parallel mutation API.

Acceptance criteria:

- Every mutating command is preceded by an explicit confirmation.
- The operator repeats the exact target run or session before acting.
- Returned opaque IDs and target-qualified commands are preserved verbatim.
- An uncertain operation is reported as terminal and is not retried.

### 5. Event announcements

The module consumes Jaeger events but speaks only events relevant to the
current focus:

- Deduplicate events using their stable identities.
- Suppress noisy intermediate activity.
- Coalesce rapid progress events.
- Never announce another unrelated run merely because it is active.
- Allow announcements to be muted while preserving conversational control.

An example announcement is:

> The review session completed. Two findings were recorded. The run is waiting
> for the fixer.

Acceptance criteria:

- At-least-once event delivery does not produce repeated speech.
- Focus changes take effect before later events are announced.
- Muting announcements does not disconnect the operator conversation.
- Spoken summaries stay within a fixed length bound.

### 6. Security and privacy

The reference module will require:

- localhost binding;
- strict browser-origin checks;
- an unguessable per-install capability token;
- secret and token files with owner-only permissions;
- no public exposure by default;
- no retained audio;
- no general transcript archive; and
- explicit confirmation for run, resume, steer, interrupt, and stop
  operations.

The documentation must be clear that the Codex operator has real technical
authority. Prompt-based confirmation is a behavioral guard, not an
operating-system sandbox.

Acceptance criteria:

- Requests without the capability token are rejected.
- Cross-origin browser requests are rejected.
- No audio or transcript content is written to module storage.
- The README identifies the authority granted by starting the module and by
  approving a voice action.

### 7. Verification

Automated coverage will include:

- mock app-server initialization and realtime session negotiation;
- realtime event, transcript, error, disconnect, and close handling;
- focus filtering and event deduplication;
- module storage and restart recovery;
- child-process failure and degraded-health behavior;
- browser flow with mocked microphone and WebRTC interfaces; and
- module validation and clean temporary installation.

Repository gates:

```text
jaeger modules validate
<module-specific test command>
pnpm verify
jaeger modules status
```

The installation and status checks must run against a clean temporary runtime
configuration and backend installation. After the automated gates pass, run an
opt-in live microphone smoke test against the installed Codex account.

## Installation documentation

The module README will document:

- required Codex version and realtime capability;
- supported authentication and entitlement paths;
- browser microphone and WebRTC requirements;
- copying or installing the module under
  `~/.config/jaeger/runtime/`;
- creating the capability-token file with owner-only permissions;
- adding the module to `jaeger.runtime.mjs`;
- validating the runtime configuration;
- reinstalling the backend with that configuration;
- inspecting module health; and
- troubleshooting feature availability, authentication, WebRTC negotiation,
  degraded health, and reconnect behavior.

## Explicit non-goals

The module will not initially support:

- direct attachment to workflow-owned Codex app-server connections;
- voice support for Pi, Claude, or other harnesses;
- remote or public hosting;
- multiple simultaneous users;
- persistent audio or transcript archives;
- workflow-authored voice primitives; or
- any new Jaeger core CLI or backend API solely for voice.

If implementation exposes a genuinely generic deficiency in the runtime-module
API, that deficiency should be proposed separately and justified without
reference to voice. Otherwise, the work stops at the optional module.

## Completion criterion

The work is complete when a Codex user can install the module, open its local
page, talk to a persistent Codex operator, operate Jaeger through its existing
CLI and skill, receive focused spoken lifecycle updates, reconnect safely, and
remove the module without leaving any voice-specific surface in Jaeger core.
