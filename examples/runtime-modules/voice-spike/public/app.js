import { loadAccessTokens } from "./call-access.js";

const elements = {
  answerCall: document.querySelector("#answer-call"),
  bridgeDot: document.querySelector("#bridge-dot"),
  bridgeLabel: document.querySelector("#bridge-label"),
  callExpiry: document.querySelector("#call-expiry"),
  callInvite: document.querySelector("#call-invite"),
  callNotice: document.querySelector("#call-notice"),
  callReason: document.querySelector("#call-reason"),
  declineCall: document.querySelector("#decline-call"),
  generation: document.querySelector("#generation"),
  muteButton: document.querySelector("#mute-button"),
  reconnectButton: document.querySelector("#reconnect-button"),
  reconnectVerdict: document.querySelector("#reconnect-verdict"),
  remoteAudio: document.querySelector("#remote-audio"),
  signalState: document.querySelector("#signal-state"),
  talkButton: document.querySelector("#talk-button"),
  talkLabel: document.querySelector("#talk-label"),
  threadId: document.querySelector("#thread-id"),
  transcript: document.querySelector("#transcript"),
  typedProbe: document.querySelector("#typed-probe"),
  probeInput: document.querySelector("#probe-input"),
  waveform: document.querySelector("#waveform"),
};

const state = {
  audioContext: null,
  analyser: null,
  channel: null,
  callCountdown: null,
  callToken: null,
  capabilityToken: null,
  eventStreamStarted: false,
  inputStream: null,
  peer: null,
  sessionActive: false,
  sessionId: null,
  transcriptDrafts: new Map(),
};

const apiBaseUrl = new URL(window.location.href);
if (!apiBaseUrl.pathname.endsWith("/")) apiBaseUrl.pathname += "/";
apiBaseUrl.search = "";
apiBaseUrl.hash = "";
const apiUrl = (path) => new URL(path.replace(/^\//, ""), apiBaseUrl);

const accessTokens = loadAccessTokens();
const invitationToken = accessTokens.callToken;
state.capabilityToken = accessTokens.capabilityToken;
if (state.capabilityToken) {
  await refreshState();
  connectEvents();
} else {
  renderBridge({ connected: false, generation: "—", threadId: "—" });
  setSignal("Answer an invitation or open with the capability token");
}
drawWaveform();

elements.answerCall.addEventListener("click", async () => {
  if (!state.callToken) return;
  elements.answerCall.disabled = true;
  elements.declineCall.disabled = true;
  elements.answerCall.textContent = "Connecting…";
  try {
    const invitationCapability = state.callToken;
    await post("api/invitations/answer", {
      token: state.callToken,
    });
    state.capabilityToken = invitationCapability;
    clearCallInvitation();
    await refreshState();
    connectEvents();
    const connected = await startSession();
    if (!connected) showCallNotice("Call answered. Tap Open microphone to retry.");
  } catch (error) {
    elements.answerCall.textContent = "Answer";
    elements.answerCall.disabled = false;
    elements.declineCall.disabled = false;
    showCallNotice(error.message, true);
  }
});

elements.declineCall.addEventListener("click", async () => {
  if (!state.callToken) return;
  elements.answerCall.disabled = true;
  elements.declineCall.disabled = true;
  try {
    await post("api/invitations/decline", { token: state.callToken });
    clearCallInvitation();
    showCallNotice("Call declined.");
  } catch (error) {
    elements.answerCall.disabled = false;
    elements.declineCall.disabled = false;
    showCallNotice(error.message, true);
  }
});

await loadCallInvitation(invitationToken);

elements.talkButton.addEventListener("click", async () => {
  if (state.sessionActive) {
    await stopSession();
  } else {
    await startSession();
  }
});

elements.muteButton.addEventListener("click", () => {
  const track = state.inputStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  elements.muteButton.textContent = track.enabled ? "Mute mic" : "Unmute mic";
  elements.signalState.textContent = track.enabled ? "Listening" : "Microphone muted";
});

elements.reconnectButton.addEventListener("click", async () => {
  elements.reconnectButton.disabled = true;
  elements.reconnectVerdict.textContent = "Restarting…";
  try {
    if (state.sessionActive) await stopSession();
    const result = await post("api/reconnect", {});
    renderBridge(result.after);
    elements.reconnectVerdict.textContent = result.threadPreserved
      ? "Thread preserved"
      : "Thread changed";
  } catch (error) {
    elements.reconnectVerdict.textContent = "Reconnect failed";
    setSignal(error.message, true);
  } finally {
    elements.reconnectButton.disabled = false;
  }
});

elements.typedProbe.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    if (!state.sessionActive) await startSession();
    await post("api/text", { text: elements.probeInput.value });
    setSignal("Spoken probe sent");
  } catch (error) {
    setSignal(error.message, true);
  }
});

async function startSession() {
  elements.talkButton.disabled = true;
  const requestedSessionId = crypto.randomUUID();
  setSignal("Requesting microphone");
  try {
    state.inputStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    installAnalyser(state.inputStream);

    const peer = new RTCPeerConnection();
    state.peer = peer;
    state.channel = peer.createDataChannel("oai-events");
    state.channel.addEventListener("message", handleDataChannelEvent);
    peer.addEventListener("connectionstatechange", () => {
      const connectionState = peer.connectionState;
      setSignal(`WebRTC ${connectionState}`);
      if (
        state.peer === peer &&
        ["failed", "closed"].includes(connectionState)
      ) {
        void stopSession();
      }
    });
    peer.addEventListener("track", async (event) => {
      elements.remoteAudio.srcObject = event.streams[0];
      await elements.remoteAudio.play().catch(() => {});
    });
    for (const track of state.inputStream.getTracks()) {
      state.peer.addTrack(track, state.inputStream);
    }

    const offer = await state.peer.createOffer();
    await state.peer.setLocalDescription(offer);
    await waitForIceGathering(state.peer);
    setSignal("Negotiating Codex realtime");
    const answer = await post("api/session", {
      sdp: state.peer.localDescription.sdp,
      voice: "juniper",
      sessionId: requestedSessionId,
    });
    await state.peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });

    state.sessionId = answer.sessionId;
    state.sessionActive = true;
    elements.talkButton.classList.add("active");
    elements.talkLabel.textContent = "End session";
    elements.muteButton.disabled = false;
    setSignal("Listening");
    return true;
  } catch (error) {
    await post("api/stop", { sessionId: requestedSessionId }).catch(() => {});
    closePeer();
    setSignal(error.message, true);
    return false;
  } finally {
    elements.talkButton.disabled = false;
  }
}

async function loadCallInvitation(token) {
  if (!token) return;
  try {
    const invitation = await post("api/invitations/inspect", { token });
    if (
      invitation.status === "answered" &&
      Date.parse(invitation.accessExpiresAt) > Date.now()
    ) {
      state.capabilityToken = token;
      await refreshState();
      connectEvents();
      showCallNotice("Answered call access restored.");
      return;
    }
    if (invitation.status !== "ringing") {
      showCallNotice("This Telegram call is no longer available.", true);
      return;
    }
    state.callToken = token;
    elements.callReason.textContent = invitation.reason;
    elements.callInvite.hidden = false;
    document.body.classList.add("incoming-call");
    elements.answerCall.focus();
    updateCallCountdown(invitation.expiresAt);
    state.callCountdown = window.setInterval(
      () => updateCallCountdown(invitation.expiresAt),
      1_000,
    );
  } catch (error) {
    showCallNotice(error.message, true);
  }
}

function updateCallCountdown(expiresAt) {
  const remaining = Date.parse(expiresAt) - Date.now();
  if (remaining <= 0) {
    clearCallInvitation();
    showCallNotice("This Telegram call expired.", true);
    return;
  }
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1_000);
  elements.callExpiry.textContent = `Expires in ${minutes}:${String(seconds).padStart(2, "0")}`;
}

function clearCallInvitation() {
  if (state.callCountdown) window.clearInterval(state.callCountdown);
  state.callCountdown = null;
  state.callToken = null;
  elements.callInvite.hidden = true;
  elements.answerCall.textContent = "Answer";
  elements.answerCall.disabled = false;
  elements.declineCall.disabled = false;
  document.body.classList.remove("incoming-call");
}

function showCallNotice(message, error = false) {
  elements.callNotice.hidden = false;
  elements.callNotice.textContent = message;
  elements.callNotice.classList.toggle("error", error);
}

async function stopSession() {
  elements.talkButton.disabled = true;
  try {
    if (state.sessionId) {
      await post("api/stop", { sessionId: state.sessionId });
    }
  } catch {
    // Local teardown still matters if the upstream session already closed.
  }
  closePeer();
  resetSessionUi();
  setSignal("Channel idle");
  elements.talkButton.disabled = false;
}

function closePeer() {
  const channel = state.channel;
  const peer = state.peer;
  const inputStream = state.inputStream;
  const audioContext = state.audioContext;
  state.channel = null;
  state.peer = null;
  state.inputStream = null;
  state.audioContext = null;
  state.analyser = null;
  channel?.close();
  peer?.close();
  for (const track of inputStream?.getTracks() ?? []) track.stop();
  audioContext?.close().catch(() => {});
}

function resetSessionUi() {
  state.sessionActive = false;
  state.sessionId = null;
  elements.talkButton.classList.remove("active");
  elements.talkLabel.textContent = "Open microphone";
  elements.muteButton.textContent = "Mute mic";
  elements.muteButton.disabled = true;
}

async function refreshState() {
  try {
    renderBridge(await get("api/state"));
  } catch (error) {
    renderBridge({ connected: false, generation: "—", threadId: "—" });
    setSignal(error.message, true);
  }
}

function renderBridge(bridge) {
  elements.bridgeDot.classList.toggle("live", bridge.connected);
  elements.bridgeLabel.textContent = bridge.connected
    ? "Codex app-server ready"
    : "Codex app-server unavailable";
  elements.threadId.textContent = bridge.threadId ?? "—";
  elements.threadId.title = bridge.threadId ?? "";
  elements.generation.textContent = bridge.generation ?? "—";
}

function connectEvents() {
  if (state.eventStreamStarted) return;
  state.eventStreamStarted = true;
  const source = new EventTarget();
  source.addEventListener("bridge.state", (event) => {
    renderBridge(JSON.parse(event.data));
  });
  source.addEventListener("bridge.ready", (event) => {
    renderBridge(JSON.parse(event.data));
  });
  source.addEventListener("bridge.disconnected", () => {
    elements.bridgeDot.classList.remove("live");
    elements.bridgeLabel.textContent = "Codex app-server disconnected";
  });
  source.addEventListener("thread/realtime/started", () => {
    setSignal("Realtime accepted");
  });
  source.addEventListener("thread/realtime/transcript/delta", (event) => {
    const params = JSON.parse(event.data);
    renderTranscriptDelta(params.role, params.delta);
  });
  source.addEventListener("thread/realtime/transcript/done", (event) => {
    const params = JSON.parse(event.data);
    renderTranscriptDone(params.role, params.text);
  });
  source.addEventListener("thread/realtime/error", (event) => {
    const params = JSON.parse(event.data);
    setSignal(params.message, true);
  });
  source.addEventListener("thread/realtime/closed", (event) => {
    const params = JSON.parse(event.data);
    closePeer();
    resetSessionUi();
    setSignal(
      params.reason === "requested"
        ? "Channel idle"
        : params.reason || "Realtime channel closed",
    );
  });
  void consumeEvents(source);
}

async function consumeEvents(target) {
  while (state.capabilityToken) {
    try {
      const response = await fetch(apiUrl("api/events"), {
        cache: "no-store",
        headers: authorizationHeaders(),
      });
      if (!response.ok) await parseResponse(response);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      while (true) {
        const { done, value } = await reader.read();
        buffered += decoder.decode(value ?? new Uint8Array(), {
          stream: !done,
        });
        const frames = buffered.replace(/\r\n/g, "\n").split("\n\n");
        buffered = frames.pop() ?? "";
        for (const frame of frames) dispatchServerEvent(target, frame);
        if (done) break;
      }
    } catch (error) {
      setSignal(`Event stream disconnected: ${error.message}`, true);
    }
    await new Promise((resolve) => window.setTimeout(resolve, 1_000));
  }
}

function dispatchServerEvent(target, frame) {
  let event = "message";
  const data = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length > 0) {
    target.dispatchEvent(new MessageEvent(event, { data: data.join("\n") }));
  }
}

function handleDataChannelEvent(event) {
  try {
    const message = JSON.parse(event.data);
    if (message.type === "error") {
      setSignal(message.error?.message ?? "Realtime data channel error", true);
    }
  } catch {
    // App-server notifications are the transcript source for this spike.
  }
}

function renderTranscriptDelta(role, delta) {
  const normalizedRole = role || "voice";
  let row = state.transcriptDrafts.get(normalizedRole);
  if (!row) {
    clearEmptyTranscript();
    row = createUtterance(normalizedRole, "");
    row.dataset.draft = "true";
    elements.transcript.append(row);
    state.transcriptDrafts.set(normalizedRole, row);
  }
  row.querySelector("p").textContent += delta;
}

function renderTranscriptDone(role, text) {
  const normalizedRole = role || "voice";
  const draft = state.transcriptDrafts.get(normalizedRole);
  if (draft) {
    draft.querySelector("p").textContent = text;
    delete draft.dataset.draft;
    state.transcriptDrafts.delete(normalizedRole);
    return;
  }
  clearEmptyTranscript();
  elements.transcript.append(createUtterance(normalizedRole, text));
}

function createUtterance(role, text) {
  const row = document.createElement("div");
  row.className = "utterance";
  const label = document.createElement("span");
  label.textContent = role;
  const copy = document.createElement("p");
  copy.textContent = text;
  row.append(label, copy);
  return row;
}

function clearEmptyTranscript() {
  elements.transcript.querySelector(".empty-transcript")?.remove();
}

function setSignal(message, error = false) {
  elements.signalState.textContent = message;
  elements.signalState.style.color = error ? "var(--danger)" : "";
}

function installAnalyser(stream) {
  state.audioContext = new AudioContext();
  state.analyser = state.audioContext.createAnalyser();
  state.analyser.fftSize = 256;
  const source = state.audioContext.createMediaStreamSource(stream);
  source.connect(state.analyser);
}

function drawWaveform() {
  const canvas = elements.waveform;
  const context = canvas.getContext("2d");
  const render = () => {
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
      canvas.width = width * ratio;
      canvas.height = height * ratio;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const bars = 42;
    const samples = new Uint8Array(state.analyser?.frequencyBinCount ?? bars);
    state.analyser?.getByteFrequencyData(samples);
    const gap = 5;
    const barWidth = Math.max(2, (width - gap * (bars - 1)) / bars);
    context.fillStyle = "#e5ff67";
    for (let index = 0; index < bars; index += 1) {
      const value = state.analyser
        ? samples[Math.floor((index / bars) * samples.length)] / 255
        : 0.025 + Math.sin(Date.now() / 900 + index * 0.35) * 0.012;
      const barHeight = Math.max(2, value * height * 0.52);
      context.globalAlpha = 0.2 + value * 0.8;
      context.fillRect(
        index * (barWidth + gap),
        (height - barHeight) / 2,
        barWidth,
        barHeight,
      );
    }
    requestAnimationFrame(render);
  };
  render();
}

function waitForIceGathering(peer) {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 5_000);
    const listener = () => {
      if (peer.iceGatheringState !== "complete") return;
      clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", listener);
      resolve();
    };
    peer.addEventListener("icegatheringstatechange", listener);
  });
}

async function get(path) {
  const response = await fetch(apiUrl(path), {
    cache: "no-store",
    headers: authorizationHeaders(),
  });
  return parseResponse(response);
}

async function post(path, body) {
  const response = await fetch(apiUrl(path), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authorizationHeaders(),
    },
    body: JSON.stringify(body),
  });
  return parseResponse(response);
}

async function parseResponse(response) {
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `Request failed: ${response.status}`);
  return value;
}

function authorizationHeaders() {
  return state.capabilityToken
    ? { authorization: `Bearer ${state.capabilityToken}` }
    : {};
}
