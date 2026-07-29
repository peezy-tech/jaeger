import assert from "node:assert/strict";
import test from "node:test";
import { HeadlessRealtimePeer } from "../headless-webrtc.mjs";

const SDP = "v=0\r\na=rtpmap:111 opus/48000/2\r\n";

test("the headless peer negotiates WebRTC and forwards PCM in both directions", async () => {
  const fixture = createFixture();
  fixture.bridge.on("error", (error) => assert.fail(error));

  await fixture.bridge.start();
  assert.equal(fixture.peer.dataChannelLabel, "oai-events");
  assert.equal(fixture.peer.direction, "sendrecv");
  assert.match(fixture.codex.offer, /^v=0/);
  assert.equal(fixture.peer.gathered, true);
  assert.deepEqual(fixture.peer.remoteDescription, {
    type: "answer",
    sdp: SDP,
  });
  assert.deepEqual(fixture.inputTrack.frames[0], {
    bytes: 960,
    durationMs: 5,
  });

  const input = Buffer.alloc(3_840, 42);
  await fixture.bridge.sendPcm(input);
  assert.deepEqual(fixture.inputTrack.frames[1], {
    bytes: 3_840,
    durationMs: 20,
  });

  const output = new Promise((resolve) => fixture.bridge.once("pcm", resolve));
  const pcm = Buffer.alloc(3_840, 7);
  fixture.remoteTrack.push(pcm);
  assert.deepEqual(await output, pcm);

  await fixture.bridge.stop();
  assert.equal(fixture.peer.closed, true);
  assert.equal(fixture.remoteTrack.stopped, true);
});

test("invalid PCM and connection failures fail closed", async () => {
  const fixture = createFixture();
  const errors = [];
  fixture.bridge.on("error", (error) => errors.push(error));
  await fixture.bridge.start();

  await assert.rejects(
    fixture.bridge.sendPcm(Buffer.alloc(2)),
    /invalid 20 ms PCM/,
  );
  fixture.peer.connectionState = "disconnected";
  fixture.peer.onconnectionstatechange();
  assert.match(errors.at(-1).message, /disconnected/);
  await fixture.bridge.stop();
});

function createFixture() {
  const webrtc = createFakeWebRtc();
  const codex = {
    offer: null,
    async startRealtime({ sdp }) {
      this.offer = sdp;
      queueMicrotask(() => {
        webrtc.peer.connectionState = "connected";
        webrtc.peer.onconnectionstatechange?.();
        webrtc.peer.ontrack?.({ track: webrtc.remoteTrack });
      });
      return { sdp: SDP };
    },
  };
  const bridge = new HeadlessRealtimePeer({
    codex,
    webrtc,
    connectionTimeoutMs: 1_000,
  });
  return {
    bridge,
    codex,
    remoteTrack: webrtc.remoteTrack,
    get inputTrack() {
      return webrtc.inputTrack;
    },
    get peer() {
      return webrtc.peer;
    },
  };
}

function createFakeWebRtc() {
  const webrtc = {
    inputTrack: null,
    peer: null,
    remoteTrack: new FakeRemoteTrack(),
  };
  webrtc.RTCPeerConnection = class {
    constructor() {
      webrtc.peer = this;
      this.connectionState = "new";
      this.localDescription = null;
      this.remoteDescription = null;
      this.closed = false;
      this.gathered = false;
      this.onconnectionstatechange = null;
      this.ontrack = null;
    }

    createDataChannel(label) {
      this.dataChannelLabel = label;
      return { close() {} };
    }

    async addTransceiver(track, { direction }) {
      this.track = track;
      this.direction = direction;
    }

    async createOffer() {
      return { type: "offer", sdp: SDP };
    }

    async setLocalDescription(description) {
      this.localDescription = description;
    }

    async gatheringComplete() {
      this.gathered = true;
    }

    async setRemoteDescription(description) {
      this.remoteDescription = description;
    }

    async closeAsync() {
      this.closed = true;
      this.connectionState = "closed";
    }
  };
  webrtc.LocalAudioTrack = class {
    frames = [];

    constructor() {
      webrtc.inputTrack = this;
    }

    async writeSample(data, durationMs) {
      this.frames.push({ bytes: data.length, durationMs });
    }

    stop() {}
  };
  return webrtc;
}

class FakeRemoteTrack {
  kind = "audio";
  stopped = false;
  queued = [];
  waiters = [];

  readSample() {
    if (this.queued.length > 0) return Promise.resolve(this.queued.shift());
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  push(pcm) {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(Buffer.from(pcm));
    else this.queued.push(Buffer.from(pcm));
  }

  stop() {
    this.stopped = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(new Error("track stopped"));
    }
  }
}
