import { EventEmitter } from "node:events";
import {
  LocalAudioTrack,
  RTCPeerConnection,
} from "@node-webrtc-rust/sdk";

const CONNECTION_TIMEOUT_MS = 20_000;
const PCM_FRAME_BYTES = 3_840;
const PRIME_FRAME_BYTES = 960;
const OPUS_SDP = /a=rtpmap:\d+ opus\/48000\/2/im;

export class HeadlessRealtimePeer extends EventEmitter {
  constructor({
    codex,
    webrtc = { LocalAudioTrack, RTCPeerConnection },
    connectionTimeoutMs = CONNECTION_TIMEOUT_MS,
  }) {
    super();
    this.codex = codex;
    this.webrtc = webrtc;
    this.connectionTimeoutMs = connectionTimeoutMs;
    this.peer = null;
    this.inputTrack = null;
    this.remoteTrack = null;
    this.dataChannel = null;
    this.outputLoop = null;
    this.active = false;
    this.onConnectionStateChange = () => {
      const state = this.peer?.connectionState;
      if (
        this.active &&
        ["failed", "disconnected", "closed"].includes(state)
      ) {
        this.#fatal(new Error(`Headless WebRTC connection ${state}`));
      }
    };
    this.onTrack = ({ track }) => this.#acceptRemoteTrack(track);
  }

  async start() {
    if (this.active) return;
    this.active = true;
    const peer = new this.webrtc.RTCPeerConnection();
    const inputTrack = new this.webrtc.LocalAudioTrack(
      "jaeger-discord-input",
      "jaeger-discord-operator",
    );
    this.peer = peer;
    this.inputTrack = inputTrack;
    peer.onconnectionstatechange = this.onConnectionStateChange;
    peer.ontrack = this.onTrack;
    this.dataChannel = peer.createDataChannel("oai-events");
    await peer.addTransceiver(inputTrack, { direction: "sendrecv" });

    try {
      const offer = await peer.createOffer({ offerToReceiveAudio: true });
      await peer.setLocalDescription(offer);
      await peer.gatheringComplete();
      const localSdp = peer.localDescription?.sdp;
      if (
        typeof localSdp !== "string" ||
        !localSdp.startsWith("v=0") ||
        !OPUS_SDP.test(localSdp)
      ) {
        throw new Error("Headless WebRTC did not produce an Opus SDP offer");
      }
      const connected = this.#waitForConnected();
      const answer = await this.codex.startRealtime({ sdp: localSdp });
      if (
        typeof answer.sdp !== "string" ||
        !answer.sdp.startsWith("v=0") ||
        !OPUS_SDP.test(answer.sdp)
      ) {
        throw new Error("Codex realtime did not return an Opus SDP answer");
      }
      await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      await connected;
      const prime = Buffer.alloc(PRIME_FRAME_BYTES);
      await inputTrack.writeSample(prime, 5);
      prime.fill(0);
    } catch (error) {
      await this.stop().catch(() => {});
      throw error;
    }
  }

  async sendPcm(pcm) {
    if (!this.active || !this.inputTrack) return;
    if (!Buffer.isBuffer(pcm) || pcm.length !== PCM_FRAME_BYTES) {
      throw new Error("Discord supplied an invalid 20 ms PCM audio frame");
    }
    await this.inputTrack.writeSample(pcm, 20);
  }

  async stop() {
    if (!this.active && !this.peer) return;
    this.active = false;
    if (this.peer) {
      this.peer.onconnectionstatechange = null;
      this.peer.ontrack = null;
    }
    this.dataChannel?.close?.();
    this.dataChannel = null;
    this.remoteTrack?.stop?.();
    this.inputTrack?.stop?.();
    this.remoteTrack = null;
    this.inputTrack = null;
    const peer = this.peer;
    this.peer = null;
    await peer?.closeAsync?.();
    await this.outputLoop?.catch(() => {});
    this.outputLoop = null;
  }

  #acceptRemoteTrack(track) {
    if (!this.active || track?.kind !== "audio") return;
    if (this.remoteTrack) {
      this.#fatal(new Error("Headless WebRTC received multiple audio tracks"));
      return;
    }
    if (typeof track.readSample !== "function") {
      this.#fatal(new Error("Headless WebRTC received an unreadable audio track"));
      return;
    }
    this.remoteTrack = track;
    this.outputLoop = this.#readOutput(track);
  }

  async #readOutput(track) {
    try {
      while (this.active && this.remoteTrack === track) {
        const pcm = await track.readSample();
        if (!this.active || this.remoteTrack !== track) {
          pcm?.fill?.(0);
          return;
        }
        if (!Buffer.isBuffer(pcm) || pcm.length !== PCM_FRAME_BYTES) {
          pcm?.fill?.(0);
          throw new Error("Codex supplied an invalid 20 ms PCM audio frame");
        }
        this.emit("pcm", Buffer.from(pcm));
        pcm.fill(0);
      }
    } catch (error) {
      if (this.active) this.#fatal(error);
    }
  }

  #waitForConnected() {
    if (this.peer.connectionState === "connected") return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const peer = this.peer;
      const previous = peer.onconnectionstatechange;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        peer.onconnectionstatechange = previous;
        if (error) reject(error);
        else resolve();
      };
      peer.onconnectionstatechange = () => {
        previous?.();
        const state = peer.connectionState;
        if (state === "connected") finish();
        if (["failed", "disconnected", "closed"].includes(state)) {
          finish(new Error(`Headless WebRTC connection ${state}`));
        }
      };
      const timer = setTimeout(
        () => finish(new Error("Headless WebRTC connection timed out")),
        this.connectionTimeoutMs,
      );
      timer.unref?.();
      if (peer.connectionState === "connected") finish();
    });
  }

  #fatal(error) {
    if (!this.active) return;
    this.emit(
      "error",
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}
