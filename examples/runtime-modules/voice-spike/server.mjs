import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServer } from "./codex-app-server.mjs";
import {
  createJaegerReadonlyRequestHandlers,
  JAEGER_READONLY_TOOLS,
} from "./jaeger-readonly-tools.mjs";
import {
  createUiRequestHandlers,
  UI_TOOLS,
} from "./dynamic-ui-tools.mjs";
import {
  createWelcomePrompts,
  discoverFolderSurface,
} from "./folder-surface.mjs";
import {
  finalizeTelegramDisposition,
  parseHttpsPublicUrl,
  readTelegramConfig,
  TelegramCallInvitations,
} from "./telegram-call.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const publicDirectory = join(here, "public");
const port = Number(process.env.VOICE_SPIKE_PORT ?? 4319);
const host = process.env.VOICE_SPIKE_HOST ?? "127.0.0.1";
const operatorCwd = process.env.VOICE_SPIKE_CWD ?? process.cwd();
const configuredPublicOrigin = process.env.VOICE_SPIKE_PUBLIC_ORIGIN;
if (!configuredPublicOrigin) {
  throw new Error(
    "VOICE_SPIKE_PUBLIC_ORIGIN must be set to the HTTPS origin that serves this install's voice surface; every /api/ request is checked against it",
  );
}
const publicOrigin = parseHttpsPublicUrl(configuredPublicOrigin).origin;
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

const eventClients = new Map();
let activeRealtimeSessionId = null;
let startingRealtimeSessionId = null;
let activeDynamicUi = null;
let realtimeExpiryTimer = null;
let broadcastQueue = Promise.resolve();
let pendingDynamicTurn = null;
let nextDynamicTurnId = 1;
const readonlyHandlers = createJaegerReadonlyRequestHandlers({
  jaegerBin: process.env.VOICE_SPIKE_JAEGER_BIN ?? "jaeger",
  env: jaegerEnv,
});
const dynamicUiHandlers = createUiRequestHandlers({
  publish: async (ui, params) => {
    assertActiveToolCall(params);
    activeDynamicUi = ui;
    await broadcast("ui.render", ui);
  },
  clear: async (params) => {
    assertActiveToolCall(params);
    activeDynamicUi = null;
    await broadcast("ui.clear", {});
  },
});

const bridge = new CodexAppServer({
  codexBin: process.env.VOICE_SPIKE_CODEX_BIN ?? "codex",
  cwd: operatorCwd,
  childEnv: jaegerEnv,
  dynamicTools: [...JAEGER_READONLY_TOOLS, ...UI_TOOLS],
  requestHandlers: {
    "item/tool/call": async (params) => {
      const dynamicResult = await dynamicUiHandlers["item/tool/call"](params);
      if (dynamicResult) {
        if (!dynamicResult.success) {
          process.stderr.write(
            `Dynamic UI tool ${params.tool} rejected: ${
              dynamicResult.contentItems?.[0]?.text ?? "unknown error"
            }\n`,
          );
        }
        return dynamicResult;
      }
      return await readonlyHandlers["item/tool/call"](params);
    },
  },
  stateFile,
});

bridge.on("notification", ({ method, params }) => {
  if (!method.startsWith("thread/realtime/")) return;
  if (
    method === "thread/realtime/transcript/done" &&
    params.role === "user" &&
    typeof params.text === "string" &&
    params.text.trim()
  ) {
    pendingDynamicTurn = {
      id: nextDynamicTurnId++,
      sessionId: activeRealtimeSessionId,
      text: params.text.trim(),
    };
  } else if (
    method === "thread/realtime/itemAdded" &&
    isRealtimeHandoff(params.item)
  ) {
    pendingDynamicTurn = null;
  } else if (
    method === "thread/realtime/transcript/done" &&
    params.role === "assistant" &&
    pendingDynamicTurn
  ) {
    const turn = pendingDynamicTurn;
    pendingDynamicTurn = null;
    if (turn.sessionId && turn.sessionId === activeRealtimeSessionId) {
      void bridge.runOperatorTurn(turn.text).catch((error) => {
        process.stderr.write(`Dynamic operator fallback failed: ${error.message}\n`);
      });
    }
  }
  let eventParams = params;
  if (method === "thread/realtime/closed") {
    const sessionId = activeRealtimeSessionId ?? startingRealtimeSessionId;
    activeRealtimeSessionId = null;
    startingRealtimeSessionId = null;
    activeDynamicUi = null;
    pendingDynamicTurn = null;
    clearRealtimeExpiryTimer();
    if (sessionId) eventParams = { ...params, sessionId };
  }
  void broadcast(method, eventParams);
});
bridge.on("ready", (snapshot) => void broadcast("bridge.ready", snapshot));
bridge.on("disconnected", (error) => {
  activeRealtimeSessionId = null;
  startingRealtimeSessionId = null;
  activeDynamicUi = null;
  pendingDynamicTurn = null;
  clearRealtimeExpiryTimer();
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
      return sendJson(response, 200, {
        ...bridge.snapshot(),
        telegramCall: await callSnapshot(),
        dynamicUi: activeDynamicUi,
      });
    }

    if (request.method === "GET" && url.pathname === "/api/events") {
      const invitationToken = await optionalInvitationToken(request);
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      response.write(
        `event: bridge.state\ndata: ${JSON.stringify({
          ...bridge.snapshot(),
          dynamicUi: activeDynamicUi,
        })}\n\n`,
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
      void updateDisposition(result);
      return sendJson(response, 200, result.invitation);
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/invitations/decline"
    ) {
      const body = await readJson(request);
      const result = await invitations.decline(body.token);
      void broadcast("telegram.call.declined", result.invitation);
      void updateDisposition(result);
      return sendJson(response, 200, result.invitation);
    }

    if (request.method === "POST" && url.pathname === "/api/session") {
      const invitationToken = await optionalInvitationToken(request);
      const body = await readJson(request);
      const sessionId = assertRealtimeSessionId(body.sessionId);
      if (activeRealtimeSessionId || startingRealtimeSessionId) {
        const error = new Error("A voice session is already active");
        error.statusCode = 409;
        throw error;
      }
      startingRealtimeSessionId = sessionId;
      activeDynamicUi = null;
      pendingDynamicTurn = null;
      void broadcast("ui.clear", {});
      response.once("close", () => {
        if (!response.writableFinished) {
          void stopOwnedRealtimeSession(sessionId).catch((error) => {
            process.stderr.write(
              `Lost voice response cleanup failed: ${error.message}\n`,
            );
          });
        }
      });
      try {
        const answer = await bridge.startRealtime({
          sdp: body.sdp,
          voice: body.voice,
        });
        if (startingRealtimeSessionId !== sessionId) {
          await bridge.stopRealtime().catch(() => {});
          const error = new Error("Voice session was cancelled during negotiation");
          error.statusCode = 409;
          throw error;
        }
        startingRealtimeSessionId = null;
        activeRealtimeSessionId = sessionId;
        if (
          invitationToken &&
          !(await armRealtimeInvitationExpiry(sessionId, invitationToken))
        ) {
          const error = new Error("Telegram call access expired");
          error.statusCode = 410;
          throw error;
        }
        void beginSessionWelcome(sessionId).catch((error) => {
          process.stderr.write(`Session welcome failed: ${error.message}\n`);
        });
        return sendJson(response, 200, { ...answer, sessionId });
      } catch (error) {
        if (startingRealtimeSessionId === sessionId) {
          startingRealtimeSessionId = null;
        }
        throw error;
      }
    }

    if (request.method === "POST" && url.pathname === "/api/text") {
      const body = await readJson(request);
      await bridge.appendText(body.text);
      return sendJson(response, 202, { accepted: true });
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/ui/actions"
    ) {
      const body = await readJson(request);
      const sessionId = assertRealtimeSessionId(body.sessionId);
      if (activeRealtimeSessionId !== sessionId) {
        const error = new Error("The voice session is not active");
        error.statusCode = 409;
        throw error;
      }
      if (
        !activeDynamicUi ||
        body.uiId !== activeDynamicUi.id ||
        typeof body.actionId !== "string"
      ) {
        const error = new Error("That on-screen choice is no longer available");
        error.statusCode = 409;
        throw error;
      }
      const action = activeDynamicUi.actions.find(
        (candidate) => candidate.id === body.actionId,
      );
      if (!action) {
        const error = new Error("That on-screen choice is unavailable");
        error.statusCode = 404;
        throw error;
      }
      const selectedUi = activeDynamicUi;
      await bridge.appendText(
        [
          `The caller selected an on-screen option in "${selectedUi.title}".`,
          `Selection label: ${action.label}`,
          `Selection value: ${action.value}`,
          "Treat this as the caller's answer and continue the conversation naturally.",
          "If the selection resolves this visual, replace it with the next useful interface or call clear_ui.",
        ].join("\n"),
      );
      if (activeDynamicUi?.id === selectedUi.id) {
        activeDynamicUi = null;
        await broadcast("ui.clear", {});
      }
      return sendJson(response, 202, {
        accepted: true,
        uiId: selectedUi.id,
        actionId: action.id,
        label: action.label,
      });
    }

    if (request.method === "POST" && url.pathname === "/api/stop") {
      const body = await readJson(request);
      const stopped = await stopOwnedRealtimeSession(
        assertRealtimeSessionId(body.sessionId),
      );
      return sendJson(response, 200, { stopped });
    }

    if (request.method === "POST" && url.pathname === "/api/reconnect") {
      activeRealtimeSessionId = null;
      startingRealtimeSessionId = null;
      activeDynamicUi = null;
      pendingDynamicTurn = null;
      void broadcast("ui.clear", {});
      clearRealtimeExpiryTimer();
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

function assertRealtimeSessionId(value) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    const error = new Error("A valid voice session ID is required");
    error.statusCode = 400;
    throw error;
  }
  return value;
}

async function beginSessionWelcome(sessionId) {
  const surface = await discoverFolderSurface(operatorCwd);
  if (activeRealtimeSessionId !== sessionId) return;
  const prompts = createWelcomePrompts(surface);
  await bridge.appendText(prompts.speech, "developer");
  if (activeRealtimeSessionId !== sessionId) return;
  await bridge.runOperatorTurn(prompts.ui);
}

function isRealtimeHandoff(item) {
  if (!item || typeof item !== "object") return false;
  return (
    ["handoff_request", "handoffRequest", "delegation"].includes(item.type) ||
    item.name === "background_agent"
  );
}

async function stopOwnedRealtimeSession(sessionId) {
  const ownsSession =
    activeRealtimeSessionId === sessionId ||
    startingRealtimeSessionId === sessionId;
  if (!ownsSession) return false;
  const threadId = bridge.threadId;
  const closed = bridge.waitForNotification(
    "thread/realtime/closed",
    (params) => params.threadId === threadId,
  );
  await Promise.all([bridge.stopRealtime(), closed]);
  let clearedOwnership = false;
  if (activeRealtimeSessionId === sessionId) {
    activeRealtimeSessionId = null;
    clearedOwnership = true;
  }
  if (startingRealtimeSessionId === sessionId) {
    startingRealtimeSessionId = null;
    clearedOwnership = true;
  }
  if (clearedOwnership) {
    activeDynamicUi = null;
    void broadcast("ui.clear", {});
  }
  if (clearedOwnership) clearRealtimeExpiryTimer();
  return true;
}

function assertActiveToolCall(params) {
  if (
    !activeRealtimeSessionId ||
    params?.threadId !== bridge.threadId
  ) {
    const error = new Error(
      "UI tools require the active voice conversation",
    );
    error.statusCode = 409;
    throw error;
  }
}

async function armRealtimeInvitationExpiry(sessionId, invitationToken) {
  const invitation = await invitations.inspect(invitationToken);
  const expiresAt = Date.parse(invitation.accessExpiresAt);
  const remaining = expiresAt - Date.now();
  if (
    invitation.status !== "answered" ||
    !Number.isFinite(expiresAt) ||
    remaining <= 0 ||
    !(await invitations.authorize(invitationToken))
  ) {
    await stopOwnedRealtimeSession(sessionId);
    return false;
  }
  clearRealtimeExpiryTimer();
  realtimeExpiryTimer = setTimeout(() => {
    if (
      activeRealtimeSessionId !== sessionId &&
      startingRealtimeSessionId !== sessionId
    ) {
      return;
    }
    void stopOwnedRealtimeSession(sessionId).catch((error) => {
      process.stderr.write(`Expired voice session cleanup failed: ${error.message}\n`);
    });
  }, remaining);
  realtimeExpiryTimer.unref();
  return true;
}

function clearRealtimeExpiryTimer() {
  if (!realtimeExpiryTimer) return;
  clearTimeout(realtimeExpiryTimer);
  realtimeExpiryTimer = null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await bridge.start();
  let expiryBroadcastFor = null;
  const expiryTimer = setInterval(async () => {
    try {
      const result = await invitations.pendingDisposition();
      if (!result) return;
      // A disposition can stay pending across ticks while Telegram is retried;
      // announce each expiry once instead of on every tick.
      if (
        result.invitation.status === "expired" &&
        expiryBroadcastFor !== result.invitation.createdAt
      ) {
        expiryBroadcastFor = result.invitation.createdAt;
        void broadcast("telegram.call.expired", result.invitation);
      }
      await updateDisposition(result);
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
    clearRealtimeExpiryTimer();
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
  if (pathname === "/workspace.js") {
    return { file: "workspace.js", type: "text/javascript; charset=utf-8" };
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

async function optionalInvitationToken(request) {
  const token = invitationBearer(request);
  if (!token) return null;
  if (await invitations.authorize(token)) return token;
  const error = new Error("Telegram invitation access expired or was revoked");
  error.statusCode = 401;
  throw error;
}

function invitationBearer(request) {
  const authorization = request.headers.authorization;
  const match =
    typeof authorization === "string"
      ? /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization)
      : null;
  return match?.[1] ?? null;
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

export function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const delivery = broadcastQueue.then(() => deliverBroadcast(frame));
  broadcastQueue = delivery.catch(() => {});
  return delivery;
}

async function deliverBroadcast(frame) {
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
        if (!client.write(frame)) {
          eventClients.delete(client);
          client.destroy();
        }
      } catch {
        eventClients.delete(client);
        client.destroy();
      }
    }),
  );
}

async function callSnapshot() {
  const current = await invitations.current();
  return {
    configured: Boolean(telegram),
    status: current?.status ?? "idle",
    reason: current?.reason ?? null,
    expiresAt: current?.expiresAt ?? null,
  };
}

async function updateDisposition(result) {
  try {
    const outcome = await finalizeTelegramDisposition(
      invitations,
      telegram,
      result,
    );
    if (!outcome.error) return;
    process.stderr.write(
      `Telegram call disposition update failed${
        outcome.finalized ? " and was finalized without updating Telegram" : ""
      }: ${outcome.error.message}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `Telegram call disposition update failed: ${error.message}\n`,
    );
  }
}
