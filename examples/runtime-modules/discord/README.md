# Discord runtime and realtime voice module

This bundled source-registry item provides one Discord-native operator surface:

- durable lifecycle notifications to one configured private destination;
- guild-scoped `/runs`, `/attach`, and `/ask` interactions;
- a bot-owned voice connection to one configured private guild channel; and
- an in-memory audio bridge to a dedicated restricted Codex realtime operator.

There is no HTTP server, public listener, web page, invitation token, microphone
site, or alternate media transport.

## Discord application setup

1. Create an application in the
   [Discord Developer Portal](https://discord.com/developers/applications), add
   an official bot user, and keep automated-user or self-bot accounts out of the
   design.
2. Under **Installation**, enable only the `bot` and `applications.commands`
   scopes for guild installation.
3. Grant only these guild permissions:
   `View Channel`, `Connect`, `Speak`, and `Send Messages`. The combined
   permission integer is `3148800`. `Send Messages` is needed only for a
   configured lifecycle-notification text channel. Direct messages do not have
   a separate guild permission and still depend on the allowlisted user's
   Discord privacy settings.
4. Enable the standard `GUILDS` and `GUILD_VOICE_STATES` Gateway intents in the
   client. Leave every privileged intent, including Message Content, disabled.
5. Install the bot only in the private guild and grant it access only to the
   configured voice channel and optional notification channel.

Discord documents Voice Gateway v8 as the recommended version and requires
DAVE end-to-end encryption for calls. This item uses `@discordjs/voice` 0.19.2,
which supplies Voice Gateway v8 and the `@snazzah/davey` DAVE implementation.
Startup fails if the DAVE dependency is unavailable. See Discord's current
[voice connection guide](https://docs.discord.com/developers/topics/voice-connections),
[Gateway events reference](https://docs.discord.com/developers/events/gateway-events),
and [change log](https://docs.discord.com/developers/change-log).

## Install and configure

Mount the one source item into the operator-owned shared project:

```bash
jaeger modules add discord
```

The registry reconciles all four dependency declarations into the runtime
root's one `package.json`, one lockfile, one dependency tree, and one
package-manager invocation. The module directory is source, not another package
project. Dependency lifecycle scripts remain disabled.

Copy `modules/discord/jaeger.runtime.mjs` to the runtime root and replace every
placeholder. Configuration is intentionally explicit:

| Option | Required | Purpose |
| --- | --- | --- |
| `tokenFile` | yes | Regular owner-only file containing the bot token. |
| `guildId` | yes | Private guild snowflake. |
| `voiceChannelId` | yes | Private voice-channel snowflake. |
| `allowUserId` | yes | Sole Discord account allowed to control commands and provide call audio. |
| `notificationChannelId` | no | Exact private text-channel snowflake. Direct messages are used when omitted. |
| `ringingTimeoutMs` | yes | Maximum wait for the allowlisted user to join. |
| `silenceTimeoutMs` | yes | Maximum media inactivity after the call starts. |
| `maximumCallTimeoutMs` | yes | Hard total call limit. |
| `operatorStateFile` | yes | Owner-only file containing only the dedicated Codex thread ID. |

Create the token file without putting its value in shell history:

```bash
install -d -m 0700 ~/.config/jaeger/runtime/secrets
install -m 0600 /path/from-a-secure-transfer/discord-bot-token \
  ~/.config/jaeger/runtime/secrets/discord-bot-token
```

Validate and activate through the ordinary runtime-module gate:

```bash
jaeger modules diff discord
jaeger modules validate ~/.config/jaeger/runtime/jaeger.runtime.mjs
jaeger backend install \
  --runtime-config ~/.config/jaeger/runtime/jaeger.runtime.mjs
```

## Behavior

The `session.available` lifecycle event is the attention request. The bot joins
the configured voice channel, sends the allowlisted user a direct Discord
channel link, and waits. It does not start Codex realtime until that exact user
joins.

The module observes `VOICE_STATE_UPDATE`. If the allowlisted user joins, it
starts or resumes the dedicated operator and forwards only that user's
in-memory PCM frames through a Rust-backed headless WebRTC peer. Realtime
output is encoded directly into Discord Opus packets without an intermediate
file. User speech immediately stops queued output and the upstream voice
activity detector handles interruption where available.

Audio from every other participant is never subscribed. If another participant
enters while ringing or connected, the call fails closed. Leaving, ringing
expiry, media silence, the maximum-call limit, a media error, or a voice
disconnect stops realtime and removes the bot from the voice channel.

`/attach` stores an allowlisted binding to an existing provider session.
`/ask` always calls Jaeger's session-query API, which forks a fresh read-only
provider session and does not resume, steer, or mutate the workflow-owned
thread. Queries are capped at ten minutes so the result or timeout remains
within Discord's interaction-response lifetime.

## Authority and persistence boundary

The dedicated Codex app-server disables shell, browser, computer, image,
memory, skill, workspace-dependency, app, plugin, MCP, multi-agent, hook, goal,
and web-search surfaces. It runs with a restricted permission profile that
denies the local filesystem and command network, and exposes exactly one
module-owned dynamic tool:
`jaeger_status`. That tool accepts no arguments and executes only
`jaeger status --json`.

Codex app-server's realtime media and transcript notifications are ephemeral
transport events rather than persisted thread items. The module ignores
transcript notifications and writes no audio, transcript, Discord frame, bot
token, or voice secret. The only module-owned operator state is the opaque
thread ID in the configured `0600` state file. Discord and Codex necessarily
retain data according to their own service policies.
