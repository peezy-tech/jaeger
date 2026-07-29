# Discord Codex realtime voice runtime module

Status: implemented

## Decision

Realtime voice is an optional, Discord-native Jaeger runtime module for Codex
users. It is not a workflow primitive, a Jaeger backend protocol, a generic
voice-provider abstraction, or a dependency of Jaeger core.

The module has one supported live transport: an official Discord bot account
connected to one configured private guild voice channel. It has no HTTP
listener, public endpoint, microphone site, invitation bearer, or alternate
media path.

## Architecture

```text
allowlisted Discord user
    │ Discord Opus through Voice Gateway v8 and DAVE
    ▼
official Discord bot in one private voice channel
    │ bounded in-memory Opus/PCM bridge
    ▼
headless WebRTC peer negotiated by Codex app-server
    │ dedicated restricted operator thread
    ▼
fixed zero-argument jaeger_status operation
    │
    ▼
installed Jaeger backend
```

The dedicated operator thread is separate from workflow-owned provider
sessions. Its only operational capability executes `jaeger status --json`.
Discord interactions use Jaeger's runtime context: `/runs` lists recent runs,
`/attach` records an allowlisted binding, and `/ask` performs a fresh forked
read-only session query rather than resuming or steering the workflow-owned
thread.

## Attention and call lifecycle

`session.available` is both a durable lifecycle notification and the attention
trigger. The bot:

1. joins the configured private voice channel;
2. verifies that no unexpected participant is present;
3. sends the exact allowlisted Discord account a direct channel link; and
4. waits without starting Codex realtime.

The module observes Discord voice-state events. When the allowlisted user joins
the configured channel, it starts or resumes the dedicated operator and begins
the media bridge. When that user leaves, or when the bot disconnects, the
module stops the realtime media session and disconnects the bot.

Ringing, media-silence, and total-call timeouts are independently configured.
A request received while another call is ringing or active coalesces into the
current call rather than creating another voice connection.

## Media boundary

The Discord receiver subscribes only to the allowlisted user ID. Its Opus
packets are decoded into bounded 20 ms PCM frames and written to the headless
Codex WebRTC peer. Returned WebRTC PCM frames are encoded into packetized Opus
for the Discord voice stack. The WebRTC binding ships platform packages rather
than running a native build during installation. No media file is created.

Allowlisted speech immediately discards queued operator output and stops
playback, permitting server-side voice activity handling and talk-over where
the realtime API allows it. Input and output queues are bounded. Queued buffers
are zeroed on completion, interruption, and shutdown.

Audio from other participants is never subscribed. An unexpected participant
entering while the bot is ringing or connected ends the call. A participant
already present prevents the call from starting.

Discord documents Voice Gateway v8 as recommended and requires DAVE
end-to-end encryption for calls. The module uses `@discordjs/voice` 0.19.2 and
fails startup unless its `@snazzah/davey` implementation is present:

- https://docs.discord.com/developers/topics/voice-connections
- https://docs.discord.com/developers/events/gateway-events
- https://docs.discord.com/developers/change-log

## Authority boundary

The app-server launch disables shell, browser, computer, image, memory, skill,
workspace-dependency, app, plugin, MCP, multi-agent, hook, goal, and web-search
surfaces. It sets approval policy to `never`, selects a dedicated permission
profile that denies the filesystem and command network, and supplies no runtime
workspace, environment, or capability roots.

The app-server dynamic-tool list contains exactly `jaeger_status`. It accepts
no arguments and invokes only:

```text
jaeger status --json
```

Unknown tool requests are declined. The voice operator cannot start, resume,
steer, interrupt, or stop Jaeger runs or sessions, edit files, or use ambient
Codex capabilities.

The `/ask` interaction is separate from that voice tool boundary. It calls
Jaeger's existing durable session-query API, which forks a new read-only
provider session. The parent workflow session remains unchanged.

## Discord application boundary

The bot uses only the standard `GUILDS` and `GUILD_VOICE_STATES` Gateway
intents. It does not request privileged Message Content or member intents.
Guild installation needs the `bot` and `applications.commands` scopes and only
these channel permissions:

- View Channel
- Connect
- Speak
- Send Messages, only when a lifecycle-notification text channel is configured

Direct messages have no separate guild permission and depend on the
allowlisted user's privacy settings.

Slash commands are registered to the configured guild rather than globally.
Every interaction must match both the guild ID and the allowlisted user ID.

## Configuration and persistence

Configuration requires explicit values for the owner-only bot-token file,
guild ID, voice-channel ID, allowlisted user ID, operator-state file, ringing
timeout, silence timeout, and total-call timeout. A lifecycle-notification text
channel is optional; direct messages are used when it is omitted.

The token and operator-state files must be regular, owner-owned, and have no
group or other permission bits. The operator-state directory must also be
owner-only. The module stores only the opaque dedicated operator thread ID.

The module never writes audio, transcripts, Discord media frames, bot tokens,
or ephemeral Discord voice-server data. It ignores realtime transcript
notifications. Discord and Codex remain independent services with their own
retention policies.

## Source registry and verification

`discord` is one bundled source-registry item. Its sources are copied beneath
`modules/discord`, but that directory is not a package project. Dependencies
are reconciled into the operator-owned runtime root's one `package.json`, one
lockfile, and one `node_modules` tree, using one package-manager invocation per
mutation with package lifecycle scripts disabled.

Verification covers:

- DAVE dependency presence, Opus compatibility, and headless WebRTC cleanup;
- owner-only token and operator-state protections;
- exact user and guild authorization;
- attention, join, leave, timeout, and unexpected-participant behavior;
- bidirectional Opus/PCM bridging, bounded queues, and interruption;
- the fixed read-only Jaeger tool and disabled ambient authority;
- source registry view, add, list, diff, dry-run sync, remove, re-add, and
  runtime-config validation;
- dependency-install rollback and source ownership; and
- source, portable, and packed-artifact installation.
