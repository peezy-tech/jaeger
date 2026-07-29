# Codex realtime voice compatibility spike

This is the Stage 1 proof for
[`docs/design/codex-realtime-voice-module.md`](../../../docs/design/codex-realtime-voice-module.md).
It is intentionally not a Jaeger runtime module and is not included in the
backend composition. It is distributed as an inspectable source-registry item
and is included in the published package so the proven compatibility tool can
be mounted into the same shared runtime project:

```bash
jaeger modules add voice-spike
VOICE_SPIKE_PUBLIC_ORIGIN=https://voice.example \
  node ~/.config/jaeger/runtime/modules/voice-spike/server.mjs
```

The item contributes no package dependency of its own. If it is installed
together with Telegram or future modules, Jaeger still performs one dependency
installation for the complete runtime project.

The spike proves:

- browser microphone and output audio over WebRTC;
- Codex app-server's experimental realtime V3 negotiation;
- a dedicated, persistent Codex operator thread;
- read-only Jaeger status inspection;
- exact thread resumption after an app-server restart; and
- outbound Telegram call invitations into the same browser voice session.

The backend binds only to `127.0.0.1`. On the HQ VPS it is exposed privately at
`https://hq.peezy.tech/jaeger-voice/` through the existing Tailscale-only
Traefik listener. Codex and ChatGPT credentials never enter the browser.

## Requirements

- Codex CLI with the `realtime_conversation` feature;
- an active ChatGPT login with realtime entitlement;
- a modern browser with microphone and WebRTC support; and
- the installed `jaeger` CLI.

Verify the installed surface:

```bash
codex --version
codex features list
codex login status
```

## Configuration

Every install must declare its own public surface. Nothing defaults to another
operator's host.

| Variable | Required | Purpose |
| --- | --- | --- |
| `VOICE_SPIKE_PUBLIC_ORIGIN` | yes, for `start` | HTTPS origin that serves this install. Every `/api/` request is checked against it, and the service refuses to start without it. |
| `VOICE_SPIKE_PUBLIC_URL` | yes, for `call` | HTTPS URL of this install's voice surface, including any path prefix. Invitation bearer tokens are placed in its fragment, so it must be a host you control. `call` fails closed without it. |
| `VOICE_SPIKE_CWD` | no | Working directory for the Codex app-server thread. Defaults to the process working directory. |
| `VOICE_SPIKE_CAPABILITY_FILE` | no | Capability token path. Defaults to `~/.local/state/jaeger/voice-spike/capability-token`. |
| `VOICE_TELEGRAM_ENV_FILE` | no | Telegram credential file. Defaults to `~/.env`. |

On the HQ VPS those values are `https://hq.peezy.tech` and
`https://hq.peezy.tech/jaeger-voice/`; substitute your own throughout this
document.

## Run

```bash
cd examples/runtime-modules/voice-spike
npm test
VOICE_SPIKE_PUBLIC_ORIGIN=https://voice.example \
  VOICE_SPIKE_PORT=4319 \
  npm start
```

On first startup the service creates a 256-bit capability at
`~/.local/state/jaeger/voice-spike/capability-token` with mode `0600`. Copy that
value into the URL fragment when opening the browser directly:

```text
<VOICE_SPIKE_PUBLIC_URL>#capability=<copied capability token>
```

The browser removes the fragment immediately and keeps the token only in
memory. State, transcript events, realtime controls, and reconnect requests
require the token as a bearer capability. A valid Telegram invitation receives
30 minutes of browser access only after its single-use answer transition
succeeds; it never receives the per-install capability.

The operator thread ID is the only durable conversation state written by the
spike. It lives at
`~/.local/state/jaeger/voice-spike/operator.json` with mode `0600`. Audio and
transcripts are not written to disk.

## Telegram call invitations

Telegram is a signaling adapter only. It never carries live audio and it does
not expose chat commands, polling, or webhook authority. The outbound command
reads only `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and the optional
`TELEGRAM_MESSAGE_THREAD_ID` from `VOICE_TELEGRAM_ENV_FILE`, which defaults to
`~/.env`.

Place a call:

```bash
cd examples/runtime-modules/voice-spike
VOICE_SPIKE_PUBLIC_URL=https://voice.example/jaeger-voice/ \
  npm run call -- "A Jaeger workflow needs your attention."
```

`VOICE_SPIKE_PUBLIC_URL` must point at the surface this install serves. The
invitation's 256-bit bearer token is placed in that URL's fragment, so pointing
it at a host you do not control hands the token to that host. The command
refuses to send when the variable is unset.

The command sends one Telegram notification with an **Answer** button. The
button opens that private route and joins the existing Codex operator thread
through the proven WebRTC path.

Invitation properties:

- one active invitation at a time;
- ten-minute lifetime;
- answer or decline exactly once;
- 256-bit random bearer token in the URL fragment, so it is not sent in HTTP
  requests or Traefik access logs;
- only the SHA-256 token hash is persisted; and
- owner-only state at
  `~/.local/state/jaeger/voice-spike/telegram-call.json`.

The managed service reads the same Telegram configuration so it can replace the
Answer button with an answered, declined, or missed disposition. Telegram
delivery failures fail closed and do not expose the invitation URL on stdout.

A disposition that Telegram rejects permanently — the message was deleted, the
bot lost the chat, or the message is too old to edit — is finalized locally
instead of blocking the next call. Transient failures are retried, and the
invitation is finalized after five failed attempts. `npm run reset` discards the
invitation state outright if an operator needs to clear it by hand.

Codex's read-only Linux sandbox maps root-owned ancestors to uid `65534`, which
causes Jaeger's authority-path validation to reject direct CLI startup. For
this compatibility spike only, the app-server thread receives one
client-executed dynamic tool, `jaeger_status`. The loopback service implements
that tool with exactly `jaeger status --json`. It accepts no arguments and
cannot mutate Jaeger. This finding must be resolved before the planned module
claims direct in-sandbox CLI operation.

With the managed web service stopped, `npm run probe` performs one direct
read-only operator turn and reports the exact command exit code. The HQ service
sets the required Codex, Jaeger socket, and private client-profile environment
automatically; copy those environment values from its unit when running the
probe manually.

## Live proof

1. Open the private route with the capability-token fragment described above.
2. Select **Open microphone** and allow microphone access.
3. Ask: “Give me the current Jaeger status.”
4. Confirm the spoken reply matches `jaeger status --json`.
5. Select **Restart app-server**.
6. Confirm the generation increments and the displayed operator thread ID does
   not change.
7. Open the microphone again and ask a follow-up that depends on the earlier
   exchange.

For the Telegram path:

1. Run `npm run call -- "Live Telegram acceptance test."`.
2. Confirm the configured Telegram topic receives the incoming-call message.
3. Select **Answer** on the phone.
4. Confirm the invitation screen transitions into a live WebRTC session.
5. Confirm the Telegram message changes to the answered disposition.

The spoken-output probe exercises the realtime conversation and audio output
path without requiring speech recognition. It does not verify Jaeger
delegation and does not replace the microphone acceptance test.

## Authority boundary

The Codex app-server starts with its shell, apps, plugins, subagents, hooks,
goals, MCP servers, and web search disabled. Every start and resume persists a
restricted read-only sandbox policy with no project or home-directory roots.
The only operational tool exposed to the thread is the module-owned,
zero-argument `jaeger_status` dynamic tool, which invokes the fixed
`jaeger status --json` command. Approval policy remains `never`, and unknown
server requests are declined.
