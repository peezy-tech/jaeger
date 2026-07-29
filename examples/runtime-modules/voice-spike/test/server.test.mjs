import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { TelegramCallInvitations } from "../telegram-call.mjs";

test("state, transcript, and control APIs require the browser capability", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-server-auth-"));
  const capability = "s".repeat(43);
  const capabilityFile = join(directory, "capability-token");
  await writeFile(capabilityFile, `${capability}\n`, { mode: 0o600 });
  process.env.HOME = directory;
  await writeFile(
    join(directory, ".env"),
    "TELEGRAM_BOT_TOKEN=test-token\nTELEGRAM_CHAT_ID=-100123\n",
    { mode: 0o600 },
  );
  delete process.env.VOICE_TELEGRAM_ENV_FILE;
  process.env.VOICE_SPIKE_CAPABILITY_FILE = capabilityFile;
  process.env.VOICE_SPIKE_STATE_FILE = join(directory, "operator.json");
  process.env.VOICE_SPIKE_INVITATION_STATE_FILE = join(
    directory,
    "telegram-call.json",
  );
  process.env.VOICE_SPIKE_PUBLIC_ORIGIN = "https://voice.example";
  const invitationToken = "i".repeat(43);
  const invitations = new TelegramCallInvitations({
    stateFile: process.env.VOICE_SPIKE_INVITATION_STATE_FILE,
    createToken: () => invitationToken,
  });
  await invitations.create();
  await invitations.answer(invitationToken);

  const { broadcast, server } = await import(
    `../server.mjs?auth-test=${Date.now()}`,
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const callAccessModule = await fetch(`${base}/call-access.js`);
    assert.equal(callAccessModule.status, 200);
    assert.match(await callAccessModule.text(), /export function loadAccessTokens/);

    for (const pathname of ["/api/state", "/api/events"]) {
      const response = await fetch(`${base}${pathname}`);
      assert.equal(response.status, 401, pathname);
    }

    const missingCapability = await fetch(`${base}/api/reconnect`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://voice.example",
      },
      body: "{}",
    });
    assert.equal(missingCapability.status, 401);

    const crossOrigin = await fetch(`${base}/api/state`, {
      headers: {
        authorization: `Bearer ${capability}`,
        origin: "https://attacker.example",
      },
    });
    assert.equal(crossOrigin.status, 403);

    const authorized = await fetch(`${base}/api/state`, {
      headers: {
        authorization: `Bearer ${capability}`,
        origin: "https://voice.example",
      },
    });
    assert.equal(authorized.status, 200);
    const state = await authorized.json();
    assert.equal(state.connected, false);
    assert.equal(state.telegramCall.configured, true);

    const invitationAuthorized = await fetch(`${base}/api/state`, {
      headers: {
        authorization: `Bearer ${invitationToken}`,
        origin: "https://voice.example",
      },
    });
    assert.equal(invitationAuthorized.status, 200);

    const eventStream = await fetch(`${base}/api/events`, {
      headers: {
        authorization: `Bearer ${invitationToken}`,
        origin: "https://voice.example",
      },
    });
    assert.equal(eventStream.status, 200);
    const reader = eventStream.body.getReader();
    const initialEvent = await reader.read();
    assert.match(
      new TextDecoder().decode(initialEvent.value),
      /event: bridge\.state/,
    );

    const invitationState = JSON.parse(
      await readFile(process.env.VOICE_SPIKE_INVITATION_STATE_FILE, "utf8"),
    );
    invitationState.accessExpiresAt = new Date(Date.now() - 1).toISOString();
    await writeFile(
      process.env.VOICE_SPIKE_INVITATION_STATE_FILE,
      `${JSON.stringify(invitationState)}\n`,
      { mode: 0o600 },
    );
    await broadcast("bridge.ready", { connected: true });
    assert.deepEqual(await reader.read(), { value: undefined, done: true });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("a closed realtime negotiation is not promoted to the active session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-server-realtime-close-"));
  const capability = "s".repeat(43);
  const capabilityFile = join(directory, "capability-token");
  const fakeCodex = join(directory, "fake-codex.mjs");
  const port = await availablePort();
  await writeFile(capabilityFile, `${capability}\n`, { mode: 0o600 });
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
import readline from "node:readline";

const threadId = "thread-realtime-test";
let realtimeStarts = 0;
const input = readline.createInterface({ input: process.stdin });
const send = (...messages) => {
  process.stdout.write(
    messages.map((message) => JSON.stringify(message)).join("\\n") + "\\n",
  );
};

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const reply = (result) => ({ id: message.id, result });
  switch (message.method) {
    case "initialize":
      send(reply({}));
      break;
    case "thread/start":
      send(reply({ thread: { id: threadId } }));
      break;
    case "turn/start":
      send(
        reply({ turn: { id: "turn-bootstrap" } }),
        {
          method: "turn/completed",
          params: { threadId, turn: { status: "completed" } },
        },
      );
      break;
    case "thread/realtime/start": {
      realtimeStarts += 1;
      const notifications = [
        reply({}),
        {
          method: "thread/realtime/sdp",
          params: { threadId, sdp: "v=0\\r\\nmock-answer" },
        },
      ];
      if (realtimeStarts === 1) {
        notifications.push({
          method: "thread/realtime/closed",
          params: { threadId, reason: "closed during setup" },
        });
      }
      send(...notifications);
      break;
    }
    case "thread/realtime/stop":
      send(reply({}));
      break;
    default:
      send({
        id: message.id,
        error: { message: "unexpected method: " + message.method },
      });
  }
});
`,
  );
  await chmod(fakeCodex, 0o755);

  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../server.mjs", import.meta.url))],
    {
      cwd: directory,
      env: {
        ...process.env,
        HOME: directory,
        VOICE_SPIKE_CAPABILITY_FILE: capabilityFile,
        VOICE_SPIKE_CODEX_BIN: fakeCodex,
        VOICE_SPIKE_HOST: "127.0.0.1",
        VOICE_SPIKE_INVITATION_STATE_FILE: join(directory, "invitations.json"),
        VOICE_SPIKE_PORT: String(port),
        VOICE_SPIKE_PUBLIC_ORIGIN: "https://voice.example",
        VOICE_SPIKE_STATE_FILE: join(directory, "operator.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    await waitForOutput(child.stdout, /Jaeger voice spike listening/).catch(
      (error) => {
        throw new Error(`${error.message}\n${stderr}`);
      },
    );
    const base = `http://127.0.0.1:${port}`;
    const headers = {
      authorization: `Bearer ${capability}`,
      "content-type": "application/json",
      origin: "https://voice.example",
    };
    const firstSessionId = "11111111-1111-4111-8111-111111111111";
    const first = await fetch(`${base}/api/session`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sessionId: firstSessionId,
        sdp: "v=0\r\nfirst-offer",
      }),
    });
    assert.equal(first.status, 409);
    assert.match((await first.json()).error, /cancelled during negotiation/);

    const secondSessionId = "22222222-2222-4222-8222-222222222222";
    const second = await fetch(`${base}/api/session`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sessionId: secondSessionId,
        sdp: "v=0\r\nsecond-offer",
      }),
    });
    assert.equal(second.status, 200);
    assert.equal((await second.json()).sessionId, secondSessionId);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    if (!(await settlesWithin(exited, 3_000))) {
      child.kill("SIGKILL");
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

async function availablePort() {
  const probe = createHttpServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to reserve a voice server test port");
  }
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function waitForOutput(stream, pattern, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for output matching ${pattern}`));
    }, timeoutMs);
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      stream.off("data", onData);
    };
    const onData = (chunk) => {
      output += String(chunk);
      if (!pattern.test(output)) return;
      cleanup();
      resolve();
    };
    stream.on("data", onData);
  });
}

async function settlesWithin(promise, timeoutMs) {
  return await Promise.race([
    promise.then(() => true),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref();
    }),
  ]);
}
