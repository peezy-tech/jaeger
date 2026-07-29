import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";

export const DEFAULT_CALL_TTL_MS = 10 * 60 * 1_000;
export const MAX_CALL_TTL_MS = 30 * 60 * 1_000;

export class TelegramCallInvitations {
  constructor({
    stateFile,
    now = () => Date.now(),
    createToken = () => randomBytes(32).toString("base64url"),
  }) {
    if (!stateFile) throw new Error("An invitation state file is required");
    this.stateFile = stateFile;
    this.now = now;
    this.createToken = createToken;
  }

  async create({
    reason = "Jaeger wants to talk.",
    ttlMs = DEFAULT_CALL_TTL_MS,
  } = {}) {
    const current = await this.#read();
    if (this.#status(current) === "ringing") {
      throw httpError("A Telegram call is already ringing", 409);
    }
    if (!Number.isFinite(ttlMs) || ttlMs < 60_000 || ttlMs > MAX_CALL_TTL_MS) {
      throw httpError("Call lifetime must be between 1 and 30 minutes", 400);
    }

    const token = this.createToken();
    const createdAt = new Date(this.now()).toISOString();
    const expiresAt = new Date(this.now() + ttlMs).toISOString();
    const record = {
      version: 1,
      tokenHash: hashToken(token),
      status: "ringing",
      reason: normalizeReason(reason),
      createdAt,
      expiresAt,
      telegram: null,
    };
    await writeOwnerOnlyJson(this.stateFile, record);
    return { token, invitation: publicInvitation(record, "ringing") };
  }

  async inspect(token) {
    const record = await this.#read();
    if (!tokenMatches(record, token)) return unavailableInvitation();
    return publicInvitation(record, this.#status(record));
  }

  async answer(token) {
    return this.#transition(token, "answered");
  }

  async decline(token) {
    return this.#transition(token, "declined");
  }

  async recordTelegramDelivery(token, telegram) {
    const record = await this.#read();
    if (!tokenMatches(record, token) || this.#status(record) !== "ringing") {
      throw httpError("Telegram call is no longer available", 410);
    }
    record.telegram = {
      chatId: String(telegram.chatId),
      messageThreadId: telegram.messageThreadId
        ? String(telegram.messageThreadId)
        : null,
      messageId: Number(telegram.messageId),
    };
    await writeOwnerOnlyJson(this.stateFile, record);
    return publicInvitation(record, "ringing");
  }

  async fail(token) {
    const record = await this.#read();
    if (!tokenMatches(record, token)) return unavailableInvitation();
    record.status = "failed";
    record.failedAt = new Date(this.now()).toISOString();
    await writeOwnerOnlyJson(this.stateFile, record);
    return publicInvitation(record, "failed");
  }

  async expireCurrent() {
    const record = await this.#read();
    if (!record || this.#status(record) !== "expired") return null;
    if (record.status === "expired") return null;
    record.status = "expired";
    record.expiredAt = new Date(this.now()).toISOString();
    await writeOwnerOnlyJson(this.stateFile, record);
    return {
      invitation: publicInvitation(record, "expired"),
      telegram: record.telegram,
    };
  }

  async current() {
    const record = await this.#read();
    if (!record) return null;
    return publicInvitation(record, this.#status(record));
  }

  async #transition(token, nextStatus) {
    const record = await this.#read();
    if (!tokenMatches(record, token)) {
      throw httpError("Telegram call is no longer available", 410);
    }
    const status = this.#status(record);
    if (status !== "ringing") {
      throw httpError("Telegram call is no longer available", 410);
    }
    record.status = nextStatus;
    record[`${nextStatus}At`] = new Date(this.now()).toISOString();
    await writeOwnerOnlyJson(this.stateFile, record);
    return {
      invitation: publicInvitation(record, nextStatus),
      telegram: record.telegram,
    };
  }

  #status(record) {
    if (!record) return "unavailable";
    if (
      record.status === "ringing" &&
      Date.parse(record.expiresAt) <= this.now()
    ) {
      return "expired";
    }
    return record.status;
  }

  async #read() {
    try {
      return JSON.parse(await readFile(this.stateFile, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
}

export async function sendTelegramCall({
  botToken,
  chatId,
  messageThreadId,
  answerUrl,
  reason,
  expiresAt,
  fetchImpl = fetch,
}) {
  const payload = {
    chat_id: chatId,
    text: [
      "☎️ Jaeger is calling",
      "",
      normalizeReason(reason),
      "",
      `Answer before ${formatUtc(expiresAt)}.`,
    ].join("\n"),
    disable_notification: false,
    reply_markup: {
      inline_keyboard: [[{ text: "Answer", url: answerUrl }]],
    },
  };
  if (messageThreadId) payload.message_thread_id = Number(messageThreadId);

  const result = await telegramRequest({
    botToken,
    method: "sendMessage",
    payload,
    fetchImpl,
  });
  return { messageId: result.message_id };
}

export async function updateTelegramCall({
  botToken,
  chatId,
  messageId,
  status,
  reason,
  fetchImpl = fetch,
}) {
  if (!botToken || !chatId || !messageId) return;
  const labels = {
    answered: "✅ Jaeger call answered",
    declined: "↘️ Jaeger call declined",
    expired: "⌛ Jaeger call missed",
  };
  const text = [labels[status] ?? "Jaeger call closed", "", normalizeReason(reason)]
    .join("\n");
  await telegramRequest({
    botToken,
    method: "editMessageText",
    payload: {
      chat_id: chatId,
      message_id: Number(messageId),
      text,
      reply_markup: { inline_keyboard: [] },
    },
    fetchImpl,
  });
}

export async function readTelegramConfig(envFile) {
  const values = parseEnv(
    await readFile(envFile, "utf8"),
    new Set([
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_CHAT_ID",
      "TELEGRAM_MESSAGE_THREAD_ID",
    ]),
  );
  const botToken = values.TELEGRAM_BOT_TOKEN;
  const chatId = values.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    throw new Error(
      "Telegram configuration requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID",
    );
  }
  return {
    botToken,
    chatId,
    messageThreadId: values.TELEGRAM_MESSAGE_THREAD_ID || null,
  };
}

export function parseEnv(source, allowedKeys = null) {
  const result = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    if (allowedKeys && !allowedKeys.has(match[1])) continue;
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}

export async function writeOwnerOnlyJson(path, value) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = join(
    directory,
    `.${randomBytes(12).toString("hex")}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function assertOwnerOnlyFile(path) {
  return (await stat(path)).mode & 0o777;
}

export async function removeInvitationState(path) {
  await unlink(path).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

function normalizeReason(reason) {
  const value = String(reason ?? "").replace(/\s+/g, " ").trim();
  if (!value) return "Jaeger wants to talk.";
  return value.slice(0, 240);
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function tokenMatches(record, token) {
  if (
    !record?.tokenHash ||
    typeof token !== "string" ||
    token.length < 32 ||
    token.length > 200
  ) {
    return false;
  }
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(record.tokenHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function publicInvitation(record, status) {
  if (!record) return unavailableInvitation();
  return {
    status,
    reason: record.reason,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

function unavailableInvitation() {
  return {
    status: "unavailable",
    reason: null,
    createdAt: null,
    expiresAt: null,
  };
}

async function telegramRequest({ botToken, method, payload, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(
      `https://api.telegram.org/bot${botToken}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(12_000),
      },
    );
  } catch (error) {
    throw new Error(`Telegram ${method} failed: ${error.message}`);
  }
  let value;
  try {
    value = await response.json();
  } catch {
    throw new Error(`Telegram ${method} returned an invalid response`);
  }
  if (!response.ok || !value.ok) {
    throw new Error(
      `Telegram ${method} was rejected: ${value.description ?? response.status}`,
    );
  }
  return value.result;
}

function formatUtc(value) {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(value));
}

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
