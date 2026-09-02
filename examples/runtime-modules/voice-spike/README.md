# General-purpose voice surface

This example is a private WebRTC voice surface backed by one persistent Codex
app-server thread. It can:

- start a read-only realtime voice conversation;
- reconnect the app-server without changing the operator thread;
- expose only the fixed 'jaeger_status' inspection tool;
- generate a bounded interface in the caller's browser when a visual helps; and
- send an outbound Telegram call invitation into the same browser session.

Realtime calls request the `ember` speaking voice through Codex app-server's
experimental v3 WebRTC surface. Codex owns model selection for that surface;
the bridge does not send an unsupported caller-selected model override.

The generated workspace is intentionally empty at first. The assistant does
not preload a subject, dashboard, example data, or decision. It can call
'generate_ui' during the conversation, and the new interface replaces the
previous one. 'clear_ui' returns the browser to the empty listening canvas.
The outer surface is a fixed, single-viewport stage and never becomes a
scrolling document. Generated content is composed to fit that stage; unusually
long generated content may scroll only inside its own bounded content region.

When the microphone connects, the assistant greets the caller, states the exact
working folder, and generates a small read-only welcome menu from that folder's
bounded top-level surface. The menu may include project commands, an overview,
documentation, tests, or source orientation when those markers are present.

The backend binds only to '127.0.0.1'. On an HQ install it is exposed privately
by the surrounding service or reverse proxy.

## Run locally

The example has its own package root:

```text
cd examples/runtime-modules/voice-spike
npm install
npm run build:ui
```

Set the public origin used for browser requests:

```text
export VOICE_SPIKE_PUBLIC_ORIGIN=https://voice.example
export VOICE_SPIKE_PUBLIC_URL=https://voice.example/jaeger-voice/
npm run start
```

Open the public URL directly through the private reverse proxy. The page can
also be opened through an answered Telegram invitation.

## Make a call

With Telegram configuration available through 'VOICE_TELEGRAM_ENV_FILE' or the
optional supported environment file:

```text
cd examples/runtime-modules/voice-spike
npm run call
```

An optional plain-text reason is shown in the invitation:

```text
npm run call -- "I have something to ask you about."
```

The call command accepts no feature-specific mode. The assistant starts as a
general conversational surface and decides whether a generated interface is
useful.

## Generated UI boundary

The app-server exposes two browser-facing dynamic tools:

- 'generate_ui' creates one interface from the committed component catalog;
- 'clear_ui' removes it.

The catalog supports only:

- concise text;
- compact stats;
- short lists;
- highlighted callouts; and
- bounded choices whose IDs and values are resolved by the server.

The model cannot provide arbitrary HTML, CSS, JavaScript, URLs, browser APIs, or
tool names. The server normalizes every generated request before publishing it
as a JSON-render tree. A choice sends only its server-known value back into the
live voice conversation, then the generated interface is cleared.

The committed browser bundle is built from 'ui/workspace.jsx':

```text
npm run build:ui
```

Node dependencies are not required by the installed runtime after the bundle
has been built.

## Read-only authority

The operator thread starts with the installed app-server ':read-only'
permission profile. Shell, apps, plugins, subagents, goals, hooks, web search,
and ambient MCP servers are disabled. The only backend tools are the fixed
'jaeger_status' read-only bridge and the bounded UI tools above.

The generated interface is presentation only. This example does not start,
resume, steer, interrupt, stop, purchase, trade, submit, or otherwise mutate
external state on the caller's behalf.

## HTTP surface

The private server provides:

- 'GET /healthz' for process readiness;
- 'GET /api/state' and 'GET /api/events' for the browser;
- invitation inspect, answer, and decline routes;
- 'POST /api/session' for WebRTC negotiation;
- 'POST /api/text' for the typed probe;
- 'POST /api/ui/actions' for server-resolved generated choices;
- 'POST /api/stop' and 'POST /api/reconnect' for session control; and
- static 'workspace.js', 'app.js', 'call-access.js', and 'styles.css' assets.

Every API request is origin-checked. The live route is intended to remain behind
the private reverse proxy; no bearer capability is required. Answered Telegram
invitation access remains separately time-limited.

## Probes and tests

Run the focused example suite:

```text
cd examples/runtime-modules/voice-spike
npm test
```

The browser acceptance path should verify that:

1. the generated workspace is absent before any 'generate_ui' call;
2. a spoken request for a visual causes a successful 'generate_ui' call;
3. the generated interface appears without reloading;
4. generated choices return their server-known values to the conversation;
5. 'clear_ui' removes the interface completely; and
6. reconnect preserves the persistent operator thread.

The manual probe remains available for the realtime audio path:

```text
npm run probe
```
