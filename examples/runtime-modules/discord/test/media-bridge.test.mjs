import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { DiscordRealtimeBridge } from "../media-bridge.mjs";

test("the bridge subscribes only to the allowlisted user and sends 20 ms stereo PCM", async () => {
  const fixture = createFixture();
  fixture.bridge.on("error", (error) => assert.fail(error));
  await fixture.bridge.start();

  fixture.speaking.emit("start", "other-user");
  assert.deepEqual(fixture.subscriptions, []);

  fixture.speaking.emit("start", "allowed-user");
  assert.deepEqual(fixture.subscriptions.map(({ id }) => id), ["allowed-user"]);
  fixture.subscriptions[0].stream.write(Buffer.from([1, 2, 3]));
  await settled();

  assert.equal(fixture.peer.inputFrames.length, 1);
  assert.equal(fixture.peer.inputFrames[0].length, 3_840);
  assert.equal(fixture.peer.inputFrames[0].readInt16LE(0), 1_000);
  assert.equal(fixture.peer.inputFrames[0].readInt16LE(2), 2_000);
  await fixture.bridge.stop();
  assert.equal(fixture.peer.stopCalls, 1);
  assert.equal(fixture.codex.stopRealtimeCalls, 1);
  assert.equal(fixture.codex.stopCalls, 1);
  assert.equal(fixture.codecs.every((codec) => codec.deleted), true);
});

test("headless realtime PCM is encoded into 20 ms Discord Opus packets", async () => {
  const fixture = createFixture();
  fixture.bridge.on("error", (error) => assert.fail(error));
  await fixture.bridge.start();

  fixture.peer.emit("pcm", Buffer.alloc(3_840, 7));
  await settled();

  assert.equal(fixture.player.played.length, 1);
  assert.equal(fixture.player.played[0].options.inputType, "opus");
  assert.deepEqual(
    fixture.player.played[0].stream.read(),
    Buffer.from([0xf8, 0xff, 0xfe]),
  );
  assert.equal(fixture.codecs[1].encoded[0].frameSize, 960);
  assert.equal(fixture.codecs[1].encoded[0].pcm.length, 3_840);
  await fixture.bridge.stop();
});

test("allowlisted speech interrupts output and later audio resumes", async () => {
  const fixture = createFixture();
  fixture.bridge.on("error", (error) => assert.fail(error));
  await fixture.bridge.start();

  emitOutputFrame(fixture.peer, 1);
  emitOutputFrame(fixture.peer, 2);
  fixture.speaking.emit("start", "allowed-user");
  assert.equal(fixture.player.stopCalls, 1);

  emitOutputFrame(fixture.peer, 3);
  emitOutputFrame(fixture.peer, 4);
  await settled();
  assert.equal(fixture.player.played.length, 1);

  fixture.speaking.emit("end", "allowed-user");
  emitOutputFrame(fixture.peer, 5);
  emitOutputFrame(fixture.peer, 6);
  await settled();
  assert.equal(fixture.player.played.length, 2);
  await fixture.bridge.stop();
});

test("concurrent speaking events do not create overlapping subscriptions", async () => {
  const fixture = createFixture();
  fixture.bridge.on("error", (error) => assert.fail(error));
  await fixture.bridge.start();

  fixture.speaking.emit("start", "allowed-user");
  fixture.speaking.emit("start", "allowed-user");
  assert.equal(fixture.subscriptions.length, 1);

  fixture.subscriptions[0].stream.destroy();
  await settled();
  fixture.speaking.emit("start", "allowed-user");
  assert.equal(fixture.subscriptions.length, 2);
  await fixture.bridge.stop();
});

test("peer and codec failures fail the media bridge closed", async () => {
  const fixture = createFixture();
  const failures = [];
  fixture.bridge.on("error", (error) => failures.push(error));
  await fixture.bridge.start();
  fixture.peer.emit("error", new Error("peer failed"));
  assert.match(failures.at(-1).message, /peer failed/);

  fixture.speaking.emit("start", "allowed-user");
  fixture.codecs[0].failDecode = true;
  fixture.subscriptions[0].stream.write(Buffer.from([1]));
  await settled();
  assert.match(failures.at(-1).message, /decode failed/);
  await fixture.bridge.stop();
});

test("Codex realtime errors and closures fail the media bridge closed", async () => {
  for (const scenario of [
    {
      method: "thread/realtime/error",
      params: { threadId: "thread-voice", message: "realtime failed" },
      expected: /realtime failed/,
    },
    {
      method: "thread/realtime/closed",
      params: { threadId: "thread-voice", reason: "transport closed" },
      expected: /transport closed/,
    },
  ]) {
    const fixture = createFixture();
    const failures = [];
    fixture.bridge.on("error", (error) => failures.push(error));
    await fixture.bridge.start();

    fixture.codex.emit(scenario.method, {
      ...scenario.params,
      threadId: "another-thread",
    });
    assert.equal(failures.length, 0);
    fixture.codex.emit(scenario.method, scenario.params);
    assert.match(failures.at(-1).message, scenario.expected);

    await fixture.bridge.stop();
    fixture.codex.emit(scenario.method, scenario.params);
    assert.equal(failures.length, 1);
  }
});

test(
  "shutdown closes the peer before draining a stalled PCM write",
  { timeout: 1_000 },
  async () => {
    const fixture = createFixture();
    const sendStarted = deferred();
    const releaseSend = deferred();
    fixture.peer.sendPcm = async (pcm) => {
      fixture.peer.inputFrames.push(Buffer.from(pcm));
      sendStarted.resolve();
      await releaseSend.promise;
    };
    fixture.peer.stop = async () => {
      fixture.peer.stopCalls += 1;
      releaseSend.resolve();
    };
    fixture.bridge.on("error", (error) => assert.fail(error));
    await fixture.bridge.start();

    fixture.speaking.emit("start", "allowed-user");
    fixture.subscriptions[0].stream.write(Buffer.from([1]));
    await sendStarted.promise;
    await fixture.bridge.stop();

    assert.equal(fixture.peer.stopCalls, 1);
    assert.equal(fixture.peer.inputFrames.length, 1);
  },
);

function createFixture() {
  const speaking = new EventEmitter();
  const subscriptions = [];
  const receiver = {
    speaking,
    subscribe(id, options) {
      const stream = new PassThrough();
      subscriptions.push({ id, options, stream });
      return stream;
    },
  };
  const player = new EventEmitter();
  player.played = [];
  player.stopCalls = 0;
  player.play = (resource) => player.played.push(resource);
  player.stop = () => {
    player.stopCalls += 1;
  };
  const connection = {
    receiver,
    subscribe(candidate) {
      assert.equal(candidate, player);
    },
  };
  const codex = new FakeCodex();
  const peer = new FakePeer();
  const codecs = [];
  const bridge = new DiscordRealtimeBridge({
    connection,
    userId: "allowed-user",
    codexFactory: () => codex,
    peerFactory: ({ codex: candidate }) => {
      assert.equal(candidate, codex);
      return peer;
    },
    codecFactory: () => {
      const codec = new FakeCodec();
      codecs.push(codec);
      return codec;
    },
    voice: {
      createAudioPlayer: () => player,
      createAudioResource: (stream, options) => ({ stream, options }),
      EndBehaviorType: { AfterSilence: "after-silence" },
      NoSubscriberBehavior: { Pause: "pause" },
      StreamType: { Opus: "opus" },
    },
  });
  return { bridge, codecs, codex, peer, player, speaking, subscriptions };
}

class FakeCodex extends EventEmitter {
  connected = false;
  threadId = "thread-voice";
  stopRealtimeCalls = 0;
  stopCalls = 0;

  async start() {
    this.connected = true;
  }

  async stopRealtime() {
    this.stopRealtimeCalls += 1;
  }

  waitForNotification() {
    return Promise.resolve({});
  }

  async stop() {
    this.connected = false;
    this.stopCalls += 1;
  }
}

class FakePeer extends EventEmitter {
  inputFrames = [];
  stopCalls = 0;

  async start() {}

  async sendPcm(pcm) {
    this.inputFrames.push(Buffer.from(pcm));
  }

  async stop() {
    this.stopCalls += 1;
  }
}

class FakeCodec {
  deleted = false;
  failDecode = false;
  encoded = [];

  decode() {
    if (this.failDecode) throw new Error("decode failed");
    const pcm = Buffer.alloc(960 * 2 * 2);
    for (let offset = 0; offset < pcm.length; offset += 4) {
      pcm.writeInt16LE(1_000, offset);
      pcm.writeInt16LE(2_000, offset + 2);
    }
    return pcm;
  }

  encode(pcm, frameSize) {
    this.encoded.push({ pcm: Buffer.from(pcm), frameSize });
    return Buffer.from([0xf8, 0xff, 0xfe]);
  }

  delete() {
    this.deleted = true;
  }
}

function emitOutputFrame(peer, value) {
  peer.emit("pcm", Buffer.alloc(3_840, value));
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
