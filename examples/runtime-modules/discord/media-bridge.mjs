import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
} from "@discordjs/voice";
import OpusScript from "opusscript";
import { HeadlessRealtimePeer } from "./headless-webrtc.mjs";

const SAMPLE_RATE = 48_000;
const DISCORD_FRAME_SAMPLES = 960;
const PCM_FRAME_BYTES = 3_840;
const MAX_QUEUED_OUTPUT_BYTES = 256_000;
const MAX_PENDING_PCM_BYTES = 16_000;

export class DiscordRealtimeBridge extends EventEmitter {
  constructor({
    connection,
    userId,
    codexFactory,
    peerFactory = (input) => new HeadlessRealtimePeer(input),
    codecFactory = () =>
      new OpusScript(SAMPLE_RATE, 2, OpusScript.Application.AUDIO),
    voice = {},
  }) {
    super();
    this.connection = connection;
    this.userId = userId;
    this.codexFactory = codexFactory;
    this.peerFactory = peerFactory;
    this.codecFactory = codecFactory;
    this.createAudioPlayer = voice.createAudioPlayer ?? createAudioPlayer;
    this.createAudioResource = voice.createAudioResource ?? createAudioResource;
    this.endBehaviorType = voice.EndBehaviorType ?? EndBehaviorType;
    this.noSubscriberBehavior =
      voice.NoSubscriberBehavior ?? NoSubscriberBehavior;
    this.streamType = voice.StreamType ?? StreamType;
    this.codex = null;
    this.peer = null;
    this.decoder = null;
    this.encoder = null;
    this.player = null;
    this.outputStream = null;
    this.outputQueue = [];
    this.outputQueueBytes = 0;
    this.inputPcm = Buffer.alloc(0);
    this.inputWriteQueue = Promise.resolve();
    this.inputWriteQueueBytes = 0;
    this.outputPumping = false;
    this.inputSubscription = null;
    this.active = false;
    this.userSpeaking = false;
    this.stopping = null;
    this.onSpeakingStart = (id) => {
      if (id !== this.userId || !this.active) return;
      this.userSpeaking = true;
      this.#interruptOutput();
      this.emit("activity", { direction: "input" });
      this.#subscribeToAllowedUser();
    };
    this.onSpeakingEnd = (id) => {
      if (id === this.userId) this.userSpeaking = false;
    };
  }

  async start() {
    if (this.active) return;
    this.active = true;
    this.codex = this.codexFactory();
    this.peer = this.peerFactory({ codex: this.codex });
    this.peer.on("pcm", (frame) => this.#acceptRealtimePcm(frame));
    this.peer.on("error", (error) => this.#fatal(error));
    this.decoder = this.codecFactory();
    this.encoder = this.codecFactory();

    this.player = this.createAudioPlayer({
      behaviors: {
        noSubscriber: this.noSubscriberBehavior.Pause,
      },
    });
    this.player.on?.("error", (error) => this.#fatal(error));
    this.connection.subscribe(this.player);
    this.connection.receiver.speaking.on("start", this.onSpeakingStart);
    this.connection.receiver.speaking.on("end", this.onSpeakingEnd);

    try {
      await this.codex.start();
      await this.peer.start();
    } catch (error) {
      await this.stop().catch(() => {});
      throw error;
    }
  }

  stop() {
    if (this.stopping) return this.stopping;
    this.stopping = this.#stop();
    return this.stopping;
  }

  async #stop() {
    const wasActive = this.active;
    this.active = false;
    this.userSpeaking = false;
    wipeBufferQueue(this.outputQueue);
    this.outputQueueBytes = 0;
    wipeAndReplace(this, "inputPcm");
    this.connection.receiver.speaking.off("start", this.onSpeakingStart);
    this.connection.receiver.speaking.off("end", this.onSpeakingEnd);
    this.inputSubscription?.destroy();
    this.inputSubscription = null;
    this.#interruptOutput();
    const peer = this.peer;
    this.peer = null;
    await peer?.stop().catch((error) => {
      this.emit("diagnostic", error);
    });
    await this.inputWriteQueue.catch(() => {});
    this.decoder?.delete?.();
    this.encoder?.delete?.();
    this.decoder = null;
    this.encoder = null;

    if (this.codex) {
      if (wasActive && this.codex.connected && this.codex.threadId) {
        const closed = this.codex.waitForNotification(
          "thread/realtime/closed",
          (params) => params.threadId === this.codex.threadId,
          2_000,
        );
        await this.codex.stopRealtime().catch(() => {});
        await closed.catch(() => {});
      }
      await this.codex.stop();
      this.codex = null;
    }
  }

  #subscribeToAllowedUser() {
    if (this.inputSubscription && !this.inputSubscription.destroyed) return;
    const opus = this.connection.receiver.subscribe(this.userId, {
      end: {
        behavior: this.endBehaviorType.AfterSilence,
        duration: 200,
      },
    });
    this.inputSubscription = opus;
    opus.once("close", () => {
      if (this.inputSubscription === opus) {
        this.inputSubscription = null;
        wipeAndReplace(this, "inputPcm");
      }
    });
    opus.on("error", (error) => this.#fatal(error));
    opus.on("data", (payload) => {
      if (!this.active) return;
      try {
        const decoded = this.decoder.decode(payload);
        if (
          !Buffer.isBuffer(decoded) ||
          decoded.length === 0 ||
          decoded.length % 4 !== 0
        ) {
          throw new Error("Discord supplied an invalid Opus audio packet");
        }
        this.#appendInputPcm(decoded);
        this.emit("activity", { direction: "input" });
      } catch (error) {
        this.#fatal(error);
      }
    });
  }

  #appendInputPcm(pcm) {
    if (
      this.inputPcm.length +
        this.inputWriteQueueBytes +
        pcm.length >
      MAX_PENDING_PCM_BYTES
    ) {
      pcm.fill(0);
      throw new Error("Discord input audio exceeded the bounded PCM queue");
    }
    this.inputPcm = concatAndWipe(this.inputPcm, pcm);
    while (this.inputPcm.length >= PCM_FRAME_BYTES) {
      const frame = Buffer.from(this.inputPcm.subarray(0, PCM_FRAME_BYTES));
      this.inputPcm = shiftAndWipe(this.inputPcm, PCM_FRAME_BYTES);
      this.inputWriteQueueBytes += frame.length;
      this.inputWriteQueue = this.inputWriteQueue
        .then(() => this.peer?.sendPcm(frame))
        .catch((error) => this.#fatal(error))
        .finally(() => {
          this.inputWriteQueueBytes -= frame.length;
          frame.fill(0);
        });
    }
  }

  #acceptRealtimePcm(pcm) {
    if (!this.active || this.userSpeaking) {
      pcm?.fill?.(0);
      return;
    }
    try {
      if (!Buffer.isBuffer(pcm) || pcm.length !== PCM_FRAME_BYTES) {
        pcm?.fill?.(0);
        throw new Error("Headless realtime returned an invalid PCM frame");
      }
      const packet = this.encoder.encode(pcm, DISCORD_FRAME_SAMPLES);
      pcm.fill(0);
      this.#queueOutput(packet);
    } catch (error) {
      this.#fatal(error);
    }
  }

  #queueOutput(payload) {
    if (!this.active || this.userSpeaking) {
      payload?.fill?.(0);
      return;
    }
    const packet = Buffer.isBuffer(payload)
      ? Buffer.from(payload)
      : Buffer.from(payload ?? []);
    payload?.fill?.(0);
    if (packet.length === 0) {
      this.#fatal(new Error("Headless realtime returned an empty Opus packet"));
      return;
    }
    if (this.outputQueueBytes + packet.length > MAX_QUEUED_OUTPUT_BYTES) {
      packet.fill(0);
      this.#fatal(new Error("Realtime output audio exceeded the bounded Discord queue"));
      return;
    }
    this.outputQueue.push(packet);
    this.outputQueueBytes += packet.length;
    this.emit("activity", { direction: "output" });
    if (!this.outputPumping) void this.#pumpOutput();
  }

  async #pumpOutput() {
    this.outputPumping = true;
    try {
      while (
        this.active &&
        !this.userSpeaking &&
        this.outputQueue.length > 0
      ) {
        const packet = this.outputQueue.shift();
        this.outputQueueBytes -= packet.length;
        const stream = this.#ensureOutputStream();
        if (!stream.write(packet)) await waitForDrainOrClose(stream);
      }
    } catch (error) {
      if (this.active) this.#fatal(error);
    } finally {
      this.outputPumping = false;
    }
  }

  #ensureOutputStream() {
    if (this.outputStream && !this.outputStream.destroyed) {
      return this.outputStream;
    }
    this.outputStream = new PassThrough({
      objectMode: true,
      highWaterMark: 100,
    });
    const resource = this.createAudioResource(this.outputStream, {
      inputType: this.streamType.Opus,
    });
    this.player.play(resource);
    return this.outputStream;
  }

  #interruptOutput() {
    wipeBufferQueue(this.outputQueue);
    this.outputQueueBytes = 0;
    if (this.outputStream) {
      this.outputStream.destroy();
      this.outputStream = null;
    }
    this.player?.stop?.(true);
  }

  #fatal(error) {
    if (!this.active) return;
    this.emit(
      "error",
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

function concatAndWipe(current, incoming) {
  const combined = Buffer.concat([current, incoming]);
  current.fill(0);
  incoming.fill(0);
  return combined;
}

function shiftAndWipe(current, consumedBytes) {
  const remaining = Buffer.from(current.subarray(consumedBytes));
  current.fill(0);
  return remaining;
}

function wipeAndReplace(target, property) {
  target[property]?.fill?.(0);
  target[property] = Buffer.alloc(0);
}

function wipeBufferQueue(queue) {
  for (const chunk of queue) chunk.fill(0);
  queue.length = 0;
}

async function waitForDrainOrClose(stream) {
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off("drain", onDrain);
      stream.off("close", onClose);
      stream.off("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    stream.once("drain", onDrain);
    stream.once("close", onClose);
    stream.once("error", onError);
  });
}
