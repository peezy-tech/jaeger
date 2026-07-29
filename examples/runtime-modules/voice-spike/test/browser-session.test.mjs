import assert from "node:assert/strict";
import test from "node:test";

test("concurrent browser entry points share one session start", async () => {
  const globalNames = [
    "AudioContext",
    "RTCPeerConnection",
    "document",
    "fetch",
    "navigator",
    "requestAnimationFrame",
    "window",
  ];
  const originalGlobals = new Map(
    globalNames.map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  const elements = new Map();
  const requests = [];
  let mediaRequests = 0;
  let peerCount = 0;
  let resolveStream;
  const streamRequested = new Promise((resolve) => {
    resolveStream = resolve;
  });
  const track = {
    enabled: true,
    stopCalls: 0,
    stop() {
      this.stopCalls += 1;
    },
  };
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  };

  const installGlobal = (name, value) => {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value,
      writable: true,
    });
  };
  const createElement = (selector) => {
    const listeners = new Map();
    const element = {
      classList: {
        add() {},
        remove() {},
        toggle() {},
      },
      clientHeight: 40,
      clientWidth: 320,
      disabled: false,
      hidden: false,
      listeners,
      style: {},
      textContent: "",
      value: "",
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      append() {},
      focus() {},
      getContext() {
        return {
          clearRect() {},
          fillRect() {},
          setTransform() {},
          fillStyle: "",
          globalAlpha: 1,
        };
      },
      querySelector() {
        return { textContent: "" };
      },
    };
    elements.set(selector, element);
    return element;
  };

  class MockAudioContext {
    createAnalyser() {
      return {
        fftSize: 0,
        frequencyBinCount: 42,
        getByteFrequencyData() {},
      };
    }

    createMediaStreamSource() {
      return { connect() {} };
    }

    async close() {}
  }

  class MockPeerConnection extends EventTarget {
    constructor() {
      super();
      peerCount += 1;
      this.connectionState = "new";
      this.iceGatheringState = "complete";
      this.localDescription = null;
    }

    addTrack() {}

    close() {
      this.connectionState = "closed";
    }

    createDataChannel() {
      const channel = new EventTarget();
      channel.close = () => {};
      return channel;
    }

    async createOffer() {
      return { type: "offer", sdp: "offer-sdp" };
    }

    async setLocalDescription(description) {
      this.localDescription = description;
    }

    async setRemoteDescription() {}
  }

  try {
    installGlobal("window", {
      clearInterval,
      devicePixelRatio: 1,
      history: { replaceState() {} },
      location: {
        hash: "",
        href: "https://voice.example/",
        pathname: "/",
        search: "",
      },
      setInterval,
      setTimeout,
    });
    installGlobal("document", {
      body: { classList: { add() {}, remove() {} } },
      createElement: () => createElement(`created-${elements.size}`),
      querySelector: (selector) => elements.get(selector) ?? createElement(selector),
    });
    installGlobal("navigator", {
      mediaDevices: {
        async getUserMedia() {
          mediaRequests += 1;
          return await streamRequested;
        },
      },
    });
    installGlobal("AudioContext", MockAudioContext);
    installGlobal("RTCPeerConnection", MockPeerConnection);
    installGlobal("requestAnimationFrame", () => 0);
    installGlobal("fetch", async (input, options = {}) => {
      const url = new URL(String(input));
      const body = options.body ? JSON.parse(String(options.body)) : undefined;
      requests.push({ pathname: url.pathname, body });
      if (url.pathname === "/api/session") {
        return Response.json({
          sdp: "answer-sdp",
          sessionId: body.sessionId,
        });
      }
      if (url.pathname === "/api/text" || url.pathname === "/api/stop") {
        return Response.json({ ok: true });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });

    await import(`../public/app.js?session-start-test=${Date.now()}`);
    const talk = elements.get("#talk-button").listeners.get("click");
    const submit = elements.get("#typed-probe").listeners.get("submit");
    assert.equal(typeof talk, "function");
    assert.equal(typeof submit, "function");

    const talkStart = talk();
    const probeStart = submit({ preventDefault() {} });
    await Promise.resolve();
    assert.equal(mediaRequests, 1);

    resolveStream(stream);
    await Promise.all([talkStart, probeStart]);

    assert.equal(mediaRequests, 1);
    assert.equal(peerCount, 1);
    assert.equal(
      requests.filter(({ pathname }) => pathname === "/api/session").length,
      1,
    );
    assert.equal(
      requests.filter(({ pathname }) => pathname === "/api/text").length,
      1,
    );

    await talk();
    assert.equal(track.stopCalls, 1);
  } finally {
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});
