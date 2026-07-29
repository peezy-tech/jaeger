import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateDependencyReport } from "@discordjs/voice";
import { ChannelType, Events } from "discord.js";
import {
  assertDaveSupport,
  DiscordService,
  readOwnerOnlySecret,
  validateDiscordOptions,
} from "../discord.mjs";

const GUILD_ID = "10000000000000001";
const VOICE_ID = "10000000000000002";
const USER_ID = "10000000000000003";
const BOT_ID = "10000000000000004";
const TEXT_ID = "10000000000000005";

test("configuration is explicit and does not translate removed options", () => {
  assert.throws(
    () =>
      validateDiscordOptions({
        tokenFile: "/tmp/token",
        ringingTimeoutMs: 1_000,
        silenceTimeoutMs: 1_000,
        maximumCallTimeoutMs: 2_000,
        operatorStateFile: "/tmp/operator",
      }),
    /guildId must be a Discord snowflake/,
  );
  assert.throws(
    () =>
      validateDiscordOptions({
        ...validOptions(),
        maximumCallTimeoutMs: 1_000,
        silenceTimeoutMs: 2_000,
      }),
    /must not be shorter/,
  );
});

test("bot-token files must be regular and owner-only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "discord-secret-"));
  const tokenFile = join(directory, "token");
  await writeFile(tokenFile, "secret-token\n", { mode: 0o600 });
  assert.equal(await readOwnerOnlySecret(tokenFile), "secret-token");

  await chmod(tokenFile, 0o640);
  await assert.rejects(readOwnerOnlySecret(tokenFile), /owner-only/);
  await chmod(tokenFile, 0o600);
  const link = join(directory, "link");
  await symlink(tokenFile, link);
  await assert.rejects(readOwnerOnlySecret(link), /owner-only/);
});

test("the installed voice stack reports DAVE support", () => {
  assert.doesNotThrow(() => assertDaveSupport(generateDependencyReport()));
  assert.throws(() => assertDaveSupport("no encryption provider"), /DAVE/);
  assert.throws(
    () =>
      assertDaveSupport(
        "DAVE Libraries\n- @snazzah/davey: not found\n",
      ),
    /DAVE/,
  );
});

test(
  "service abort interrupts pending Discord startup operations",
  { timeout: 2_000 },
  async () => {
    for (const stage of ["login", "commands"]) {
      const fixture = await createServiceFixture();
      const started = deferred();
      const pending = deferred();
      if (stage === "login") {
        fixture.client.login = async () => {
          started.resolve();
          return await pending.promise;
        };
      } else {
        fixture.client.application.commands.set = async () => {
          started.resolve();
          return await pending.promise;
        };
      }
      const abort = new AbortController();
      const running = fixture.service.run(abort.signal);
      await started.promise;

      abort.abort();
      await running;
      assert.equal(fixture.client.destroyCalls, 1, stage);
      assert.equal(fixture.service.ready, false, stage);
      pending.resolve();
    }
  },
);

test("attention joins and DMs before starting media, then leaves cleanly", async () => {
  const fixture = await createServiceFixture();
  await fixture.start();

  const attention = await fixture.service.requestAttention(
    "Jaeger requests attention.",
  );
  assert.deepEqual(attention, { status: "ringing", coalesced: false });
  assert.equal(fixture.connections.length, 1);
  assert.equal(fixture.connections[0].options.daveEncryption, true);
  assert.equal(fixture.bridges.length, 0);
  assert.equal(fixture.owner.messages.length, 1);
  assert.match(
    fixture.owner.messages[0].content,
    new RegExp(`https://discord.com/channels/${GUILD_ID}/${VOICE_ID}`),
  );

  fixture.voiceChannel.members.set(USER_ID, { id: USER_ID });
  fixture.client.emit(
    Events.VoiceStateUpdate,
    { id: USER_ID, channelId: null, guild: { id: GUILD_ID } },
    { id: USER_ID, channelId: VOICE_ID, guild: { id: GUILD_ID } },
  );
  await settled();
  assert.equal(fixture.bridges.length, 1);
  assert.equal(fixture.bridges[0].startCalls, 1);

  fixture.voiceChannel.members.delete(USER_ID);
  fixture.client.emit(
    Events.VoiceStateUpdate,
    { id: USER_ID, channelId: VOICE_ID, guild: { id: GUILD_ID } },
    { id: USER_ID, channelId: null, guild: { id: GUILD_ID } },
  );
  await settled();
  assert.equal(fixture.bridges[0].stopCalls, 1);
  assert.equal(fixture.connections[0].destroyCalls, 1);
  await fixture.stop();
});

test("attention rejects when Discord disconnects during DM delivery", async () => {
  const fixture = await createServiceFixture();
  await fixture.start();
  const sendStarted = deferred();
  const releaseSend = deferred();
  fixture.owner.send = async function (message) {
    this.messages.push(message);
    sendStarted.resolve();
    await releaseSend.promise;
  };

  const attention = fixture.service.requestAttention("Attention.");
  await sendStarted.promise;
  fixture.connections[0].emit(
    "stateChange",
    { status: "ready" },
    { status: "disconnected" },
  );
  await settled();
  releaseSend.resolve();

  await assert.rejects(
    attention,
    /disconnected during attention delivery/,
  );
  assert.equal(fixture.connections[0].destroyCalls, 1);
  await fixture.stop();
});

test("attention rejects when immediate media startup fails", async () => {
  const fixture = await createServiceFixture({
    joinOnAttention: true,
    bridgeStartError: new Error("realtime negotiation failed"),
  });
  await fixture.start();

  await assert.rejects(
    fixture.service.requestAttention("Jaeger requests attention."),
    /realtime negotiation failed/,
  );
  assert.equal(fixture.bridges[0].stopCalls, 1);
  assert.equal(fixture.connections[0].destroyCalls, 1);
  assert.match(fixture.runtime.infos.at(-1), /media startup failed/);
  await fixture.stop();
});

test("attention rejects instead of acknowledging a pre-DM disconnect", async () => {
  const fixture = await createServiceFixture({
    entersState: async (connection) => {
      connection.emit(
        "stateChange",
        { status: "connecting" },
        { status: "disconnected" },
      );
      return connection;
    },
  });
  await fixture.start();

  await assert.rejects(
    fixture.service.requestAttention("Jaeger requests attention."),
    /disconnected before attention delivery/,
  );
  assert.equal(fixture.owner.messages.length, 0);
  assert.equal(fixture.connections[0].destroyCalls, 1);
  await fixture.stop();
});

test("leaving during the join refresh cannot wedge ringing", async () => {
  const clock = new FakeClock();
  const fixture = await createServiceFixture({ clock });
  await fixture.start();
  await fixture.service.requestAttention("Attention.");

  const refresh = deferred();
  fixture.client.fetchVoiceChannel = () => refresh.promise;
  fixture.voiceChannel.members.set(USER_ID, { id: USER_ID });
  fixture.client.emit(
    Events.VoiceStateUpdate,
    { id: USER_ID, channelId: null, guild: { id: GUILD_ID } },
    { id: USER_ID, channelId: VOICE_ID, guild: { id: GUILD_ID } },
  );
  await settled();
  assert.equal(clock.timers.size, 1);

  fixture.voiceChannel.members.delete(USER_ID);
  fixture.client.emit(
    Events.VoiceStateUpdate,
    { id: USER_ID, channelId: VOICE_ID, guild: { id: GUILD_ID } },
    { id: USER_ID, channelId: null, guild: { id: GUILD_ID } },
  );
  await settled();
  assert.equal(fixture.service.phase, "idle");
  assert.equal(clock.timers.size, 0);
  assert.equal(fixture.connections[0].destroyCalls, 1);

  refresh.resolve(fixture.voiceChannel);
  await settled();
  assert.equal(fixture.bridges.length, 0);
  await fixture.stop();
});

test("a join refresh failure ends the ringing call", async () => {
  const clock = new FakeClock();
  const fixture = await createServiceFixture({ clock });
  await fixture.start();
  await fixture.service.requestAttention("Attention.");

  fixture.client.fetchVoiceChannel = async () => {
    throw new Error("voice channel refresh failed");
  };
  fixture.voiceChannel.members.set(USER_ID, { id: USER_ID });
  fixture.client.emit(
    Events.VoiceStateUpdate,
    { id: USER_ID, channelId: null, guild: { id: GUILD_ID } },
    { id: USER_ID, channelId: VOICE_ID, guild: { id: GUILD_ID } },
  );
  await settled();

  assert.equal(fixture.service.phase, "idle");
  assert.equal(clock.timers.size, 0);
  assert.equal(fixture.connections[0].destroyCalls, 1);
  assert.match(fixture.runtime.errors.at(-1).error.message, /refresh failed/);
  await fixture.stop();
});

test("an unexpected participant ends the call without subscribing to media", async () => {
  const fixture = await createServiceFixture();
  await fixture.start();
  await fixture.service.requestAttention("Attention.");

  fixture.voiceChannel.members.set("10000000000000009", {
    id: "10000000000000009",
  });
  fixture.client.emit(
    Events.VoiceStateUpdate,
    {
      id: "10000000000000009",
      channelId: null,
      guild: { id: GUILD_ID },
    },
    {
      id: "10000000000000009",
      channelId: VOICE_ID,
      guild: { id: GUILD_ID },
    },
  );
  await settled();

  assert.equal(fixture.bridges.length, 0);
  assert.equal(fixture.connections[0].destroyCalls, 1);
  await fixture.stop();
});

test("voice transport errors end only the current call", async () => {
  const fixture = await createServiceFixture();
  await fixture.start();
  await fixture.service.requestAttention("Attention.");

  fixture.connections[0].emit("error", new Error("UDP failed"));
  await settled();

  assert.equal(fixture.connections[0].destroyCalls, 1);
  assert.match(
    fixture.runtime.errors.at(-1).message,
    /Discord voice transport failed/,
  );
  await fixture.stop();
});

test("attention never starts while the allowlisted user is already present", async () => {
  const fixture = await createServiceFixture();
  await fixture.start();
  fixture.voiceChannel.members.set(USER_ID, { id: USER_ID });

  await assert.rejects(
    fixture.service.requestAttention("Attention."),
    /must join only after the attention DM/,
  );
  assert.equal(fixture.connections.length, 0);
  assert.equal(fixture.bridges.length, 0);
  assert.equal(fixture.owner.messages.length, 0);
  await fixture.stop();
});

test("ringing, silence, and total-call timeouts disconnect the bot", async () => {
  for (const scenario of [
    {
      name: "ringing",
      startMedia: false,
      advanceMs: 30_000,
      reason: "ringing timeout",
    },
    {
      name: "silence",
      startMedia: true,
      advanceMs: 30_000,
      reason: "silence timeout",
    },
    {
      name: "maximum",
      startMedia: true,
      advanceMs: 60_000,
      reason: "maximum-call timeout",
      silenceTimeoutMs: 60_000,
    },
  ]) {
    const clock = new FakeClock();
    const fixture = await createServiceFixture({
      clock,
      options: {
        silenceTimeoutMs: scenario.silenceTimeoutMs ?? 30_000,
      },
    });
    await fixture.start();
    await fixture.service.requestAttention(`${scenario.name} timeout.`);
    if (scenario.startMedia) {
      fixture.voiceChannel.members.set(USER_ID, { id: USER_ID });
      fixture.client.emit(
        Events.VoiceStateUpdate,
        { id: USER_ID, channelId: null, guild: { id: GUILD_ID } },
        { id: USER_ID, channelId: VOICE_ID, guild: { id: GUILD_ID } },
      );
      await settled();
    }
    clock.advance(scenario.advanceMs);
    await settled();
    assert.equal(fixture.connections[0].destroyCalls, 1, scenario.name);
    assert.match(fixture.runtime.infos.at(-1), new RegExp(scenario.reason));
    await fixture.stop();
  }
});

test("maximum timeout and shutdown interrupt stalled media startup", async () => {
  for (const ending of ["maximum-call timeout", "service shutdown"]) {
    const clock = new FakeClock();
    const fixture = await createServiceFixture({
      clock,
      bridgeStartPending: true,
    });
    await fixture.start();
    await fixture.service.requestAttention("Attention.");
    fixture.voiceChannel.members.set(USER_ID, { id: USER_ID });
    fixture.client.emit(
      Events.VoiceStateUpdate,
      { id: USER_ID, channelId: null, guild: { id: GUILD_ID } },
      { id: USER_ID, channelId: VOICE_ID, guild: { id: GUILD_ID } },
    );
    await settled();
    assert.equal(fixture.bridges[0].startCalls, 1);

    if (ending === "maximum-call timeout") {
      clock.advance(60_000);
      await settled();
    } else {
      await fixture.stop();
    }

    assert.equal(fixture.bridges[0].stopCalls, 1, ending);
    assert.equal(fixture.connections[0].destroyCalls, 1, ending);
    assert.match(fixture.runtime.infos.at(-1), new RegExp(ending));
    if (ending === "maximum-call timeout") await fixture.stop();
  }
});

test("guild-scoped allowlisted interactions expose runs, attach, and fresh query", async () => {
  const fixture = await createServiceFixture();
  await fixture.start();

  const denied = fakeInteraction({
    commandName: "runs",
    userId: "10000000000000009",
  });
  fixture.client.emit(Events.InteractionCreate, denied);
  await denied.done;
  assert.equal(denied.replies[0].content, "Not authorized.");

  const runs = fakeInteraction({ commandName: "runs" });
  fixture.client.emit(Events.InteractionCreate, runs);
  await runs.done;
  assert.match(runs.edits[0].content, /run-1  running/);

  const attach = fakeInteraction({
    commandName: "attach",
    values: { run: "run-1", session: "reviewer" },
  });
  fixture.client.emit(Events.InteractionCreate, attach);
  await attach.done;
  assert.match(attach.edits[0].content, /run-1\/session-1/);

  const ask = fakeInteraction({
    commandName: "ask",
    values: { question: "What is the status?" },
  });
  fixture.client.emit(Events.InteractionCreate, ask);
  await ask.done;
  assert.deepEqual(fixture.runtime.queries, [
    {
      runId: "run-1",
      sessionId: "session-1",
      input: {
        message: "What is the status?",
        timeoutMs: 10 * 60_000,
      },
    },
  ]);
  assert.equal(ask.edits[0].content, "Fresh read-only answer.");

  await fixture.stop();
});

test("slash commands defer before awaiting Jaeger or storage", async () => {
  const fixture = await createServiceFixture();
  await fixture.start();

  const listRuns = deferred();
  fixture.runtime.runs.list = () => listRuns.promise;
  const runs = fakeInteraction({ commandName: "runs" });
  fixture.client.emit(Events.InteractionCreate, runs);
  await settled();
  assert.equal(runs.replies.length, 1);
  assert.equal(runs.edits.length, 0);
  listRuns.resolve([{ runId: "run-slow", status: "running" }]);
  await runs.done;

  const inspectSession = deferred();
  fixture.runtime.sessions.inspect = () => inspectSession.promise;
  const attach = fakeInteraction({
    commandName: "attach",
    values: { run: "run-slow", session: "reviewer" },
  });
  fixture.client.emit(Events.InteractionCreate, attach);
  await settled();
  assert.equal(attach.replies.length, 1);
  assert.equal(attach.edits.length, 0);
  inspectSession.resolve({ id: "session-slow", label: "reviewer" });
  await attach.done;

  const binding = deferred();
  fixture.runtime.storage.get = () => binding.promise;
  const ask = fakeInteraction({
    commandName: "ask",
    values: { question: "Status?" },
  });
  fixture.client.emit(Events.InteractionCreate, ask);
  await settled();
  assert.equal(ask.replies.length, 1);
  assert.equal(ask.edits.length, 0);
  binding.resolve({
    guildId: GUILD_ID,
    userId: USER_ID,
    runId: "run-slow",
    sessionId: "session-slow",
  });
  await ask.done;

  await fixture.stop();
});

test("notification channels must expose a message send operation", async () => {
  const fixture = await createServiceFixture({
    options: { notificationChannelId: TEXT_ID },
    notificationChannel: {
      id: TEXT_ID,
      guildId: GUILD_ID,
      isTextBased: () => true,
    },
  });

  await fixture.start();
  await assert.rejects(
    fixture.waitForExit(),
    /Configured Discord notification channel is unavailable/,
  );
});

test("lifecycle notifications target only the configured owner destination", async () => {
  const fixture = await createServiceFixture();
  await fixture.start();
  await fixture.service.notifyLifecycle({
    type: "run.terminal",
    run: { runId: "run-1" },
    subject: { status: "complete" },
  });
  assert.equal(fixture.owner.messages.at(-1).content, "Jaeger run-1: complete.");
  await fixture.stop();
});

async function createServiceFixture({
  clock,
  options = {},
  notificationChannel = null,
  bridgeStartPending = false,
  bridgeStartError = null,
  joinOnAttention = false,
  entersState = async (connection) => connection,
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "discord-service-"));
  const tokenFile = join(directory, "token");
  await writeFile(tokenFile, "test-token\n", { mode: 0o600 });
  const owner = {
    messages: [],
    async send(message) {
      this.messages.push(message);
      if (joinOnAttention) {
        voiceChannel.members.set(USER_ID, { id: USER_ID });
      }
    },
  };
  const voiceChannel = {
    id: VOICE_ID,
    guildId: GUILD_ID,
    type: ChannelType.GuildVoice,
    guild: { voiceAdapterCreator: {} },
    members: new Map([[BOT_ID, { id: BOT_ID }]]),
  };
  const client = new FakeClient({
    owner,
    voiceChannel,
    notificationChannel,
  });
  const connections = [];
  const bridges = [];
  const runtime = fakeRuntime();
  const service = new DiscordService({
    runtime,
    config: validateDiscordOptions({
      ...validOptions(),
      ...options,
      tokenFile,
      operatorStateFile: join(directory, "state", "operator.json"),
    }),
    dependencies: {
      client,
      generateDependencyReport: () =>
        "DAVE Libraries\n- @snazzah/davey: 0.1.12\n",
      entersState,
      VoiceConnectionStatus: {
        Ready: "ready",
        Disconnected: "disconnected",
        Destroyed: "destroyed",
      },
      joinVoiceChannel: (options) => {
        const connection = new FakeConnection(options);
        connections.push(connection);
        return connection;
      },
      bridgeFactory: () => {
        const bridge = new FakeBridge({
          startPending: bridgeStartPending,
          startError: bridgeStartError,
        });
        bridges.push(bridge);
        return bridge;
      },
      ...(clock
        ? {
            setTimeout: clock.setTimeout.bind(clock),
            clearTimeout: clock.clearTimeout.bind(clock),
          }
        : {}),
    },
  });
  let abort;
  let running;
  return {
    service,
    client,
    connections,
    bridges,
    owner,
    runtime,
    voiceChannel,
    async start() {
      abort = new AbortController();
      running = service.run(abort.signal);
      void running.catch(() => {});
      await client.ready;
      await settled();
    },
    async stop() {
      abort.abort();
      await running;
    },
    waitForExit() {
      return running;
    },
  };
}

class FakeClient extends EventEmitter {
  constructor({ owner, voiceChannel, notificationChannel }) {
    super();
    this.user = { id: BOT_ID };
    this.guilds = { fetch: async () => ({ id: GUILD_ID }) };
    this.channels = {
      fetch: async (id) =>
        id === VOICE_ID
          ? this.fetchVoiceChannel()
          : id === TEXT_ID
            ? notificationChannel
            : null,
    };
    this.fetchVoiceChannel = async () => voiceChannel;
    this.users = { fetch: async (id) => (id === USER_ID ? owner : null) };
    this.application = {
      commands: {
        set: async (commands, guildId) => {
          this.commands = commands;
          this.commandGuildId = guildId;
        },
      },
    };
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
    this.destroyCalls = 0;
  }

  async login(token) {
    assert.equal(token, "test-token");
    queueMicrotask(() => {
      this.emit(Events.ClientReady, this);
      this.resolveReady();
    });
    return token;
  }

  async destroy() {
    this.destroyCalls += 1;
  }
}

class FakeConnection extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.destroyCalls = 0;
  }

  destroy() {
    this.destroyCalls += 1;
  }
}

class FakeBridge extends EventEmitter {
  startCalls = 0;
  stopCalls = 0;

  constructor({ startPending = false, startError = null } = {}) {
    super();
    this.startPending = startPending;
    this.startError = startError;
  }

  async start() {
    this.startCalls += 1;
    if (this.startError) throw this.startError;
    if (this.startPending) await new Promise(() => {});
  }

  async stop() {
    this.stopCalls += 1;
  }
}

function fakeRuntime() {
  const storage = new Map();
  const runtime = {
    queries: [],
    infos: [],
    errors: [],
    runs: {
      list: async () => [{ runId: "run-1", status: "running" }],
    },
    sessions: {
      inspect: async () => ({ id: "session-1", label: "reviewer" }),
      query: async (runId, sessionId, input) => {
        runtime.queries.push({ runId, sessionId, input });
        return { output: "Fresh read-only answer." };
      },
    },
    storage: {
      get: async (key) => storage.get(key),
      set: async (key, value) => storage.set(key, value),
    },
    log: {
      info(message) {
        runtime.infos.push(message);
      },
      error(message, error) {
        runtime.errors.push({ message, error });
      },
    },
  };
  return runtime;
}

class FakeClock {
  now = 0;
  nextId = 1;
  timers = new Map();

  setTimeout(callback, delay) {
    const timer = {
      id: this.nextId++,
      at: this.now + delay,
      callback,
      unref() {},
    };
    this.timers.set(timer.id, timer);
    return timer;
  }

  clearTimeout(timer) {
    if (timer) this.timers.delete(timer.id);
  }

  advance(duration) {
    const target = this.now + duration;
    while (true) {
      const due = [...this.timers.values()]
        .filter((timer) => timer.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0];
      if (!due) break;
      this.now = due.at;
      this.timers.delete(due.id);
      due.callback();
    }
    this.now = target;
  }
}

function fakeInteraction({
  commandName,
  userId = USER_ID,
  values = {},
} = {}) {
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const interaction = {
    commandName,
    guildId: GUILD_ID,
    user: { id: userId },
    replies: [],
    edits: [],
    followUps: [],
    done,
    isChatInputCommand: () => true,
    options: {
      getString: (name) => values[name],
    },
    async reply(value) {
      this.replies.push(value);
      resolveDone();
    },
    async deferReply(value) {
      this.replies.push(value);
    },
    async editReply(value) {
      this.edits.push(value);
      resolveDone();
    },
    async followUp(value) {
      this.followUps.push(value);
    },
  };
  return interaction;
}

function validOptions() {
  return {
    tokenFile: "/tmp/token",
    guildId: GUILD_ID,
    voiceChannelId: VOICE_ID,
    allowUserId: USER_ID,
    notificationChannelId: null,
    ringingTimeoutMs: 30_000,
    silenceTimeoutMs: 30_000,
    maximumCallTimeoutMs: 60_000,
    operatorStateFile: "/tmp/operator.json",
  };
}

async function settled() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
