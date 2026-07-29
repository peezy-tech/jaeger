import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertCapability,
  bearerCapability,
  readOrCreateCapabilityToken,
} from "./capability.mjs";
import { CodexAppServer } from "./codex-app-server.mjs";
import {
  createJaegerReadonlyRequestHandlers,
  JAEGER_READONLY_TOOLS,
} from "./jaeger-readonly-tools.mjs";
import {
  readTelegramConfig,
  TelegramCallInvitations,
  updateTelegramCall,
} from "./telegram-call.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const publicDirectory = join(here, "public");
const port = Number(process.env.VOICE_SPIKE_PORT ?? 4319);
const host = process.env.VOICE_SPIKE_HOST ?? "127.0.0.1";
const publicOrigin = process.env.VOICE_SPIKE_PUBLIC_ORIGIN;
if (!publicOrigin) {
  throw new Error(
    "VOICE_SPIKE_PUBLIC_ORIGIN must be set to the HTTPS origin that serves this install's voice surface; every /api/ request is checked against it",
  );
}
const stateFile =
  process.env.VOICE_SPIKE_STATE_FILE ??
  join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "jaeger",
    "voice-spike",
    "operator.json",
  );
const invitationStateFile =
  process.env.VOICE_SPIKE_INVITATION_STATE_FILE ??
  join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "jaeger",
    "voice-spike",
    "telegram-call.json",
  );
const capabilityFile =
  process.env.VOICE_SPIKE_CAPABILITY_FILE ??
  join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "jaeger",
    "voice-spike",
    "capability-token",
  );
const capabilityToken = await readOrCreateCapabilityToken(capabilityFile);
const configuredTelegramEnvFile = process.env.VOICE_TELEGRAM_ENV_FILE;
const telegramEnvFile = configuredTelegramEnvFile ?? join(homedir(), ".env");
const telegram = await readTelegramConfig(telegramEnvFile, {
  optional: !configuredTelegramEnvFile,
}).catch((error) => {
  if (!configuredTelegramEnvFile && error.code === "ENOENT") return null;
  throw error;
});
const invitations = new TelegramCallInvitations({
  stateFile: invitationStateFile,
});
const jaegerEnv = {
  ...(process.env.VOICE_SPIKE_JAEGER_CONFIG_HOME
    ? { XDG_CONFIG_HOME: process.env.VOICE_SPIKE_JAEGER_CONFIG_HOME }
    : {}),
  ...(process.env.VOICE_SPIKE_JAEGER_SOCKET
    ? { JAEGER_SOCKET: process.env.VOICE_SPIKE_JAEGER_SOCKET }
    : {}),
};

const bridge = new CodexAppServer({
  codexBin: process.env.VOICE_SPIKE_CODEX_BIN ?? "codex",
  cwd: process.env.VOICE_SPIKE_CWD ?? process.cwd(),
  childEnv: jaegerEnv,
  dynamicTools: JAEGER_READONLY_TOOLS,
  requestHandlers: createJaegerReadonlyRequestHandlers({
    jaegerBin: process.env.VOICE_SPIKE_JAEGER_BIN ?? "jaeger",
    env: jaegerEnv,
  }),
  stateFile,
});
const eventClients = new Map();

bridge.on("notification", ({ method, params }) => {
  if (!method.startsWith("thread/realtime/")) return;
  void broadcast(method, params);
});
bridge.on("ready", (snapshot) => void broadcast("bridge.ready", snapshot));
bridge.on("disconnected", (error) => {
  void broadcast("bridge.disconnected", { message: error.message });
});
bridge.on("serverRequestDeclined", ({ method }) => {
  void broadcast("bridge.requestDeclined", { method });
});

export const server = createServer(async (request, response) => {
  try {
    setSecurityHeaders(response);
    const url = new URL(request.url, "http://voice-spike.local");

    if (request.method === "GET" && url.pathname === "/healthz") {
      return sendJson(response, bridge.connected ? 200 : 503, {
        ok: bridge.connected,
      });
    }

    if (url.pathname.startsWith("/api/")) assertOrigin(request);

    if (request.method === "GET" && url.pathname === "/api/state") {
      await assertApiCapability(request);
      return sendJson(response, 200, {
        ...bridge.snapshot(),
        telegramCall: await callSnapshot(),
      });
    }

    if (request.method === "GET" && url.pathname === "/api/events") {
      const invitationToken = await assertApiCapability(request);
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      response.write(
        `event: bridge.state\ndata: ${JSON.stringify(bridge.snapshot())}\n\n`,
      );
      eventClients.set(response, invitationToken);
      response.once("close", () => eventClients.delete(response));
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/invitations/inspect"
    ) {
      const body = await readJson(request);
      return sendJson(response, 200, await invitations.inspect(body.token));
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/invitations/answer"
    ) {
      if (!bridge.connected) {
        const error = new Error("Codex app-server is not ready");
        error.statusCode = 503;
        throw error;
      }
      const body = await readJson(request);
      const result = await invitations.answer(body.token);
      void broadcast("telegram.call.answered", result.invitation);
      void updateDisposition(result, "answered");
      return sendJson(response, 200, result.invitation);
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/invitations/decline"
    ) {
      const body = await readJson(request);
      const result = await invitations.decline(body.token);
      void broadcast("telegram.call.declined", result.invitation);
      void updateDisposition(result, "declined");
      return sendJson(response, 200, result.invitation);
    }

    if (url.pathname.startsWith("/api/")) {
      await assertApiCapability(request);
    }

    if (request.method === "POST" && url.pathname === "/api/session") {
      const body = await readJson(request);
      const answer = await bridge.startRealtime({
        sdp: body.sdp,
        voice: body.voice,
      });
      return sendJson(response, 200, answer);
    }

    if (request.method === "POST" && url.pathname === "/api/text") {
      const body = await readJson(request);
      await bridge.appendText(body.text);
      return sendJson(response, 202, { accepted: true });
    }

    if (request.method === "POST" && url.pathname === "/api/stop") {
      await bridge.stopRealtime();
      return sendJson(response, 200, { stopped: true });
    }

    if (request.method === "POST" && url.pathname === "/api/reconnect") {
      const before = bridge.snapshot();
      const after = await bridge.reconnect();
      return sendJson(response, 200, {
        before,
        after,
        threadPreserved: before.threadId === after.threadId,
      });
    }

    if (request.method === "GET" || request.method === "HEAD") {
      const asset = staticAsset(url.pathname);
      if (asset) {
        const content = await readFile(join(publicDirectory, asset.file));
        response.writeHead(200, {
          "content-type": asset.type,
          "cache-control": asset.file === "index.html" ? "no-store" : "no-cache",
        });
        return response.end(request.method === "HEAD" ? undefined : content);
      }
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, error.statusCode ?? 500, {
      error: error.message ?? String(error),
    });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await bridge.start();
  const expiryTimer = setInterval(async () => {
    try {
      const result = await invitations.pendingDisposition();
      if (!result) return;
      if (result.invitation.status === "expired") {
        void broadcast("telegram.call.expired", result.invitation);
      }
      await updateDisposition(result, result.invitation.status);
    } catch (error) {
      process.stderr.write(
        `Telegram call disposition recovery failed: ${error.message}\n`,
      );
    }
  }, 30_000);
  expiryTimer.unref();
  server.listen(port, host, () => {
    process.stdout.write(
      `Jaeger voice spike listening on ${host}:${port}; public origin ${publicOrigin}\n`,
    );
  });

  const shutdown = async () => {
    clearInterval(expiryTimer);
    server.close();
    await bridge.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function staticAsset(pathname) {
  if (pathname === "/" || pathname === "/index.html") {
    return { file: "index.html", type: "text/html; charset=utf-8" };
  }
  if (pathname === "/app.js") {
    return { file: "app.js", type: "text/javascript; charset=utf-8" };
  }
  if (pathname === "/call-access.js") {
    return { file: "call-access.js", type: "text/javascript; charset=utf-8" };
  }
  if (pathname === "/styles.css") {
    return { file: "styles.css", type: "text/css; charset=utf-8" };
  }
  if (pathname === "/favicon.svg") {
    return { file: "favicon.svg", type: "image/svg+xml" };
  }
  return null;
}

function setSecurityHeaders(response) {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("permissions-policy", "microphone=(self)");
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; connect-src 'self'; media-src 'self' blob:; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
  );
}

function assertOrigin(request) {
  const origin = request.headers.origin;
  const fetchSite = request.headers["sec-fetch-site"];
  const rejected =
    (origin && origin !== publicOrigin) ||
    fetchSite === "cross-site" ||
    (request.method === "POST" && origin !== publicOrigin);
  if (rejected) {
    const error = new Error("Origin rejected");
    error.statusCode = 403;
    throw error;
  }
}

async function assertApiCapability(request) {
  try {
    assertCapability(request, capabilityToken);
    return null;
  } catch {
    const invitationToken = bearerCapability(request);
    if (invitationToken && await invitations.authorize(invitationToken)) {
      return invitationToken;
    }
    assertCapability(request, capabilityToken);
  }
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 1_000_000) {
      const error = new Error("Request body is too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  // Decode once: a multi-byte UTF-8 sequence can straddle a chunk boundary.
  const body = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(body || "{}");
  } catch {
    const error = new Error("Invalid JSON");
    error.statusCode = 400;
    throw error;
  }
}

function sendJson(response, status, value) {
  if (response.headersSent) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(value)}\n`);
}

export async function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  await Promise.all(
    [...eventClients].map(async ([client, invitationToken]) => {
      try {
        if (
          invitationToken &&
          !(await invitations.authorize(invitationToken))
        ) {
          eventClients.delete(client);
          client.end();
          return;
        }
        client.write(frame);
      } catch {
        eventClients.delete(client);
        client.end();
      }
    }),
  );
}

async function callSnapshot() {
  const current = await invitations.current();
  return {
    configured: Boolean(telegram),
    status: current?.status ?? "idle",
    expiresAt: current?.expiresAt ?? null,
  };
}

async function updateDisposition(result, status) {
  if (!telegram || !result.telegram) return;
  try {
    await updateTelegramCall({
      botToken: telegram.botToken,
      chatId: result.telegram.chatId,
      messageId: result.telegram.messageId,
      status,
      reason: result.invitation.reason,
    });
    await invitations.markDispositionUpdated(status);
  } catch (error) {
    process.stderr.write(
      `Telegram call disposition update failed: ${error.message}\n`,
    );
  }
}
