import { once } from "node:events";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ApplicationCommandOptionType,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
} from "discord.js";
import {
  entersState,
  generateDependencyReport,
  joinVoiceChannel,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import { CodexAppServer } from "./codex-app-server.mjs";
import { DiscordRealtimeBridge } from "./media-bridge.mjs";
import {
  createJaegerReadonlyRequestHandlers,
  JAEGER_READONLY_TOOLS,
} from "./jaeger-readonly-tools.mjs";

const NOTIFICATION_EVENTS = [
  "session.available",
  "phase.changed",
  "run.terminal",
  "session.query.completed",
];
const COMMANDS = [
  {
    name: "runs",
    description: "List recent Jaeger runs",
  },
  {
    name: "attach",
    description: "Attach Discord queries to a Jaeger provider session",
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: "run",
        description: "Jaeger run ID",
        required: true,
      },
      {
        type: ApplicationCommandOptionType.String,
        name: "session",
        description: "Session ID or label",
        required: true,
      },
    ],
  },
  {
    name: "ask",
    description: "Ask a fresh forked read-only question",
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: "question",
        description: "Question for the attached session",
        required: true,
        min_length: 1,
        max_length: 2_000,
      },
    ],
  },
];

export function discordModule(options, dependencies = {}) {
  const config = validateDiscordOptions(options);
  let service = null;

  return {
    name: "discord",

    setup(runtime) {
      runtime.events.consume(
        "notifications",
        NOTIFICATION_EVENTS,
        async (event) => {
          if (!service) throw new Error("Discord service is not ready");
          await service.notifyLifecycle(event);
        },
      );
      runtime.events.consume(
        "attention",
        "session.available",
        async (event) => {
          if (!service) throw new Error("Discord service is not ready");
          await service.requestAttention(renderAttention(event));
        },
      );
      runtime.services.run("discord-gateway", async (signal) => {
        const createService =
          dependencies.createService ??
          ((input) => new DiscordService(input));
        const current = createService({
          runtime,
          config,
          dependencies,
        });
        service = current;
        try {
          await current.run(signal);
        } finally {
          if (service === current) service = null;
        }
      });
    },
  };
}

export class DiscordService {
  constructor({ runtime, config, dependencies = {} }) {
    this.runtime = runtime;
    this.config = config;
    this.voice = {
      entersState: dependencies.entersState ?? entersState,
      joinVoiceChannel: dependencies.joinVoiceChannel ?? joinVoiceChannel,
      VoiceConnectionStatus:
        dependencies.VoiceConnectionStatus ?? VoiceConnectionStatus,
    };
    this.dependencyReport =
      dependencies.generateDependencyReport ?? generateDependencyReport;
    this.client =
      dependencies.client ??
      new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildVoiceStates,
        ],
      });
    this.codexFactory =
      dependencies.codexFactory ??
      (() =>
        new CodexAppServer({
          codexBin: config.codexBin,
          cwd: config.cwd,
          childEnv: config.jaegerEnv,
          dynamicTools: JAEGER_READONLY_TOOLS,
          requestHandlers: createJaegerReadonlyRequestHandlers({
            jaegerBin: config.jaegerBin,
            env: config.jaegerEnv,
          }),
          stateFile: config.operatorStateFile,
        }));
    this.bridgeFactory =
      dependencies.bridgeFactory ??
      ((input) => new DiscordRealtimeBridge(input));
    this.clock = {
      setTimeout: dependencies.setTimeout ?? setTimeout,
      clearTimeout: dependencies.clearTimeout ?? clearTimeout,
    };
    this.ready = false;
    this.phase = "idle";
    this.connection = null;
    this.bridge = null;
    this.voiceChannel = null;
    this.notificationChannel = null;
    this.ringingTimer = null;
    this.silenceTimer = null;
    this.maximumCallTimer = null;
    this.operation = Promise.resolve();
    this.onInteraction = (interaction) => {
      void this.#handleInteraction(interaction).catch((error) => {
        this.runtime.log.error("Discord interaction failed", error);
      });
    };
    this.onVoiceState = (oldState, newState) => {
      void this.#enqueue(() => this.#handleVoiceState(oldState, newState)).catch(
        (error) => this.runtime.log.error("Discord voice-state handling failed", error),
      );
    };
  }

  async run(signal) {
    assertDaveSupport(this.dependencyReport());
    let token = await readOwnerOnlySecret(this.config.tokenFile);
    this.client.on(Events.InteractionCreate, this.onInteraction);
    this.client.on(Events.VoiceStateUpdate, this.onVoiceState);
    const ready = once(this.client, Events.ClientReady);
    try {
      try {
        await this.client.login(token);
      } catch (error) {
        throw sanitizeDiscordError(error, token);
      } finally {
        token = "";
      }
      await ready;
      await this.#initializeGuildSurface();
      this.ready = true;
      this.runtime.log.info("Discord bot connected");
      if (signal.aborted) return;
      await once(signal, "abort");
    } finally {
      token = "";
      this.ready = false;
      this.client.off(Events.InteractionCreate, this.onInteraction);
      this.client.off(Events.VoiceStateUpdate, this.onVoiceState);
      await this.#enqueue(() => this.#endCall("service shutdown")).catch(() => {});
      await this.client.destroy();
    }
  }

  requestAttention(reason) {
    return this.#enqueue(() => this.#requestAttention(reason));
  }

  async notifyLifecycle(event) {
    this.#assertReady();
    const destination = await this.#notificationDestination();
    await destination.send({
      content: renderLifecycle(event),
      allowedMentions: { parse: [] },
    });
  }

  async #initializeGuildSurface() {
    const guild = await this.client.guilds.fetch(this.config.guildId);
    if (!guild || guild.id !== this.config.guildId) {
      throw new Error("Configured Discord guild is unavailable");
    }
    this.voiceChannel = await this.client.channels.fetch(
      this.config.voiceChannelId,
    );
    if (
      !this.voiceChannel ||
      this.voiceChannel.guildId !== this.config.guildId ||
      this.voiceChannel.type !== ChannelType.GuildVoice
    ) {
      throw new Error("Configured Discord voice channel is unavailable");
    }
    if (this.config.notificationChannelId) {
      this.notificationChannel = await this.client.channels.fetch(
        this.config.notificationChannelId,
      );
      if (
        !this.notificationChannel?.isTextBased?.() ||
        this.notificationChannel.guildId !== this.config.guildId
      ) {
        throw new Error("Configured Discord notification channel is unavailable");
      }
    }
    await this.client.application.commands.set(COMMANDS, this.config.guildId);
  }

  async #requestAttention(reason) {
    this.#assertReady();
    if (this.phase !== "idle") {
      return { status: this.phase, coalesced: true };
    }
    await this.#refreshVoiceChannel();
    if (this.#allowedUserPresent()) {
      throw new Error(
        "Allowlisted Discord user must join only after the attention DM",
      );
    }
    this.#assertExpectedParticipants();

    const connection = this.voice.joinVoiceChannel({
      guildId: this.config.guildId,
      channelId: this.config.voiceChannelId,
      adapterCreator: this.voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
      daveEncryption: true,
      group: "jaeger-discord",
    });
    this.connection = connection;
    this.phase = "ringing";
    connection.on?.("stateChange", (_oldState, newState) => {
      if (
        this.phase !== "idle" &&
        this.phase !== "stopping" &&
        [
          this.voice.VoiceConnectionStatus.Disconnected,
          this.voice.VoiceConnectionStatus.Destroyed,
        ].includes(newState.status)
      ) {
        void this.#enqueue(() =>
          this.#endCall("Discord voice disconnected"),
        ).catch((error) => {
          this.runtime.log.error("Discord disconnect cleanup failed", error);
        });
      }
    });

    try {
      await this.voice.entersState(
        connection,
        this.voice.VoiceConnectionStatus.Ready,
        20_000,
      );
      await this.#refreshVoiceChannel();
      this.#assertExpectedParticipants();
      const user = await this.client.users.fetch(this.config.allowUserId);
      await user.send({
        content: [
          reason,
          `Join the private voice channel: https://discord.com/channels/${this.config.guildId}/${this.config.voiceChannelId}`,
        ].join("\n"),
        allowedMentions: { parse: [] },
      });
      this.ringingTimer = this.clock.setTimeout(() => {
        void this.#enqueue(() => this.#endCall("ringing timeout"));
      }, this.config.ringingTimeoutMs);
      this.ringingTimer.unref?.();
      if (this.#allowedUserPresent()) await this.#startMedia();
      return { status: this.phase, coalesced: false };
    } catch (error) {
      await this.#endCall("attention delivery failed");
      throw error;
    }
  }

  async #handleVoiceState(oldState, newState) {
    if (!this.ready || newState.guild?.id !== this.config.guildId) return;
    const userId = newState.id;
    const entered =
      oldState.channelId !== this.config.voiceChannelId &&
      newState.channelId === this.config.voiceChannelId;
    const left =
      oldState.channelId === this.config.voiceChannelId &&
      newState.channelId !== this.config.voiceChannelId;

    if (
      entered &&
      userId !== this.config.allowUserId &&
      userId !== this.client.user?.id
    ) {
      if (this.phase !== "idle") {
        await this.#endCall("unexpected participant entered");
      }
      return;
    }
    if (userId === this.config.allowUserId && entered && this.phase === "ringing") {
      await this.#startMedia();
      return;
    }
    if (
      userId === this.config.allowUserId &&
      left &&
      ["starting", "active"].includes(this.phase)
    ) {
      await this.#endCall("allowlisted user left");
      return;
    }
    if (
      userId === this.client.user?.id &&
      left &&
      this.phase !== "idle" &&
      this.phase !== "stopping"
    ) {
      await this.#endCall("bot left configured voice channel");
    }
  }

  async #startMedia() {
    if (this.phase !== "ringing") return;
    this.clock.clearTimeout(this.ringingTimer);
    this.ringingTimer = null;
    await this.#refreshVoiceChannel();
    this.#assertExpectedParticipants();
    if (!this.#allowedUserPresent()) return;
    this.phase = "starting";
    this.maximumCallTimer = this.clock.setTimeout(() => {
      void this.#enqueue(() => this.#endCall("maximum-call timeout"));
    }, this.config.maximumCallTimeoutMs);
    this.maximumCallTimer.unref?.();

    const bridge = this.bridgeFactory({
      connection: this.connection,
      userId: this.config.allowUserId,
      codexFactory: this.codexFactory,
    });
    this.bridge = bridge;
    bridge.on("activity", () => this.#resetSilenceTimer());
    bridge.on("error", (error) => {
      this.runtime.log.error("Discord media bridge failed", error);
      void this.#enqueue(() => this.#endCall("media bridge failed"));
    });
    try {
      await bridge.start();
      await this.#refreshVoiceChannel();
      this.#assertExpectedParticipants();
      if (!this.#allowedUserPresent()) {
        await this.#endCall("allowlisted user left during startup");
        return;
      }
      this.phase = "active";
      this.#resetSilenceTimer();
    } catch (error) {
      await this.#endCall("media startup failed");
      throw error;
    }
  }

  async #endCall(reason) {
    if (this.phase === "idle") return;
    this.phase = "stopping";
    this.clock.clearTimeout(this.ringingTimer);
    this.clock.clearTimeout(this.silenceTimer);
    this.clock.clearTimeout(this.maximumCallTimer);
    this.ringingTimer = null;
    this.silenceTimer = null;
    this.maximumCallTimer = null;
    const bridge = this.bridge;
    const connection = this.connection;
    this.bridge = null;
    this.connection = null;
    await bridge?.stop().catch((error) => {
      this.runtime.log.error("Discord media shutdown failed", error);
    });
    connection?.destroy?.();
    this.phase = "idle";
    this.runtime.log.info(`Discord voice disconnected: ${reason}`);
  }

  #resetSilenceTimer() {
    this.clock.clearTimeout(this.silenceTimer);
    if (this.phase !== "active" && this.phase !== "starting") return;
    this.silenceTimer = this.clock.setTimeout(() => {
      void this.#enqueue(() => this.#endCall("silence timeout"));
    }, this.config.silenceTimeoutMs);
    this.silenceTimer.unref?.();
  }

  async #handleInteraction(interaction) {
    if (!interaction.isChatInputCommand?.()) return;
    if (
      interaction.guildId !== this.config.guildId ||
      interaction.user?.id !== this.config.allowUserId
    ) {
      await interaction.reply({
        content: "Not authorized.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (interaction.commandName === "runs") {
      const runs = await this.runtime.runs.list();
      const lines = Array.isArray(runs)
        ? runs.slice(0, 10).map((run) => `${run.runId}  ${run.status}`)
        : [];
      await interaction.reply({
        content: lines.length > 0 ? lines.join("\n") : "No Jaeger runs found.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (interaction.commandName === "attach") {
      const runId = interaction.options.getString("run", true);
      const selector = interaction.options.getString("session", true);
      const session = await this.runtime.sessions.inspect(runId, selector);
      await this.runtime.storage.set("discord-binding", {
        guildId: this.config.guildId,
        userId: this.config.allowUserId,
        runId,
        sessionId: session.id,
      });
      await interaction.reply({
        content: `Attached to ${runId}/${session.id}${
          session.label ? ` (${session.label})` : ""
        }.`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (interaction.commandName === "ask") {
      const binding = await this.runtime.storage.get("discord-binding");
      if (
        !binding ||
        binding.guildId !== this.config.guildId ||
        binding.userId !== this.config.allowUserId
      ) {
        await interaction.reply({
          content: "Attach a Jaeger session first with /attach.",
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const result = await this.runtime.sessions.query(
          binding.runId,
          binding.sessionId,
          {
            message: interaction.options.getString("question", true),
          },
        );
        const output =
          typeof result.output === "string"
            ? result.output
            : JSON.stringify(result.output, null, 2);
        const parts = splitDiscordMessage(output || "The query returned no output.");
        await interaction.editReply({
          content: parts.shift(),
          allowedMentions: { parse: [] },
        });
        for (const part of parts) {
          await interaction.followUp({
            content: part,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
          });
        }
      } catch (error) {
        await interaction.editReply({
          content: `Query failed: ${errorMessage(error)}`,
          allowedMentions: { parse: [] },
        });
      }
    }
  }

  async #notificationDestination() {
    if (this.notificationChannel) return this.notificationChannel;
    return await this.client.users.fetch(this.config.allowUserId);
  }

  async #refreshVoiceChannel() {
    this.voiceChannel = await this.client.channels.fetch(
      this.config.voiceChannelId,
      { force: true },
    );
    if (
      !this.voiceChannel ||
      this.voiceChannel.guildId !== this.config.guildId ||
      this.voiceChannel.type !== ChannelType.GuildVoice
    ) {
      throw new Error("Configured Discord voice channel is unavailable");
    }
  }

  #assertExpectedParticipants() {
    const unexpected = [...(this.voiceChannel.members?.values?.() ?? [])]
      .map((member) => member.id ?? member.user?.id)
      .filter(
        (id) =>
          id &&
          id !== this.config.allowUserId &&
          id !== this.client.user?.id,
      );
    if (unexpected.length > 0) {
      throw new Error("Configured Discord voice channel has an unexpected participant");
    }
  }

  #allowedUserPresent() {
    return Boolean(this.voiceChannel.members?.has?.(this.config.allowUserId));
  }

  #assertReady() {
    if (!this.ready) throw new Error("Discord service is not ready");
  }

  #enqueue(operation) {
    const next = this.operation.then(operation, operation);
    this.operation = next.catch(() => {});
    return next;
  }
}

export function validateDiscordOptions(options = {}) {
  const config = {
    tokenFile: absolutePath(options.tokenFile, "tokenFile"),
    guildId: snowflake(options.guildId, "guildId"),
    voiceChannelId: snowflake(options.voiceChannelId, "voiceChannelId"),
    allowUserId: snowflake(options.allowUserId, "allowUserId"),
    notificationChannelId:
      options.notificationChannelId == null
        ? null
        : snowflake(options.notificationChannelId, "notificationChannelId"),
    ringingTimeoutMs: timeout(options.ringingTimeoutMs, "ringingTimeoutMs"),
    silenceTimeoutMs: timeout(options.silenceTimeoutMs, "silenceTimeoutMs"),
    maximumCallTimeoutMs: timeout(
      options.maximumCallTimeoutMs,
      "maximumCallTimeoutMs",
    ),
    operatorStateFile: absolutePath(
      options.operatorStateFile,
      "operatorStateFile",
    ),
    codexBin: options.codexBin ?? "codex",
    jaegerBin: options.jaegerBin ?? "jaeger",
    cwd: options.cwd ?? process.cwd(),
    jaegerEnv: {
      ...(options.jaegerConfigHome
        ? { XDG_CONFIG_HOME: String(options.jaegerConfigHome) }
        : {}),
      ...(options.jaegerSocket
        ? { JAEGER_SOCKET: String(options.jaegerSocket) }
        : {}),
    },
  };
  if (config.maximumCallTimeoutMs < config.silenceTimeoutMs) {
    throw new Error("maximumCallTimeoutMs must not be shorter than silenceTimeoutMs");
  }
  return config;
}

function absolutePath(value, name) {
  const result =
    value instanceof URL
      ? fileURLToPath(value)
      : typeof value === "string"
        ? value
        : "";
  if (!isAbsolute(result)) {
    throw new Error(`${name} must be an absolute file path`);
  }
  return result;
}

export async function readOwnerOnlySecret(path) {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error("Discord bot-token file must be a regular owner-only file");
  }
  const secret = (await readFile(path, "utf8")).trim();
  if (!secret) throw new Error("Discord bot-token file is empty");
  return secret;
}

export function assertDaveSupport(report) {
  if (
    typeof report !== "string" ||
    !/DAVE Libraries[\s\S]*@snazzah\/davey:\s+(?!not found\b)\S+/.test(
      report,
    )
  ) {
    throw new Error("Discord DAVE support is unavailable");
  }
}

function renderAttention(event) {
  const runId = event.run?.runId ?? "unknown";
  const sessionId = event.subject?.sessionId ?? event.subject?.id ?? "unknown";
  return `Jaeger requests attention for ${runId}/${sessionId}.`;
}

function renderLifecycle(event) {
  const run = event.run?.runId ?? "unknown";
  if (event.type === "session.available") {
    return `Jaeger ${run}: session ${
      event.subject?.sessionId ?? event.subject?.id ?? "unknown"
    } is available.`;
  }
  if (event.type === "phase.changed") {
    return `Jaeger ${run}: phase ${event.subject?.name ?? "unknown"}.`;
  }
  if (event.type === "run.terminal") {
    return `Jaeger ${run}: ${event.subject?.status ?? "terminal"}.`;
  }
  return `Jaeger ${run}: read-only query ${
    event.subject?.queryId ?? "unknown"
  } completed.`;
}

function splitDiscordMessage(message) {
  const parts = [];
  let remaining = String(message);
  while (remaining.length > 1_900) {
    let split = remaining.lastIndexOf("\n", 1_900);
    if (split < 500) split = 1_900;
    parts.push(remaining.slice(0, split));
    remaining = remaining.slice(split).trimStart();
  }
  parts.push(remaining);
  return parts;
}

function snowflake(value, name) {
  const result = String(value ?? "");
  if (!/^[0-9]{17,20}$/.test(result)) {
    throw new Error(`${name} must be a Discord snowflake`);
  }
  return result;
}

function timeout(value, name) {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 86_400_000) {
    throw new Error(`${name} must be an integer from 1000 through 86400000`);
  }
  return value;
}

function sanitizeDiscordError(error, token) {
  const message = errorMessage(error);
  const safeMessage =
    typeof token === "string" && token.length > 0
      ? message.replaceAll(token, "[redacted]")
      : message;
  return new Error(safeMessage || "Discord bot startup failed");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
