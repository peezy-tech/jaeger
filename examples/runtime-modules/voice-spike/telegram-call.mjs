import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";

export const DEFAULT_CALL_TTL_MS = 10 * 60 * 1_000;
export const MAX_CALL_TTL_MS = 30 * 60 * 1_000;
export const ANSWERED_ACCESS_TTL_MS = 30 * 60 * 1_000;
export const MAX_DISPOSITION_ATTEMPTS = 5;
const STATE_LOCK_WAIT_MS = 5_000;
const INVALID_STATE_LOCK_STALE_MS = 30_000;
const STATE_LOCK_TOKEN_PATTERN = /^[a-f0-9]{32}$/;

export class TelegramDeliveryUncertainError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "TelegramDeliveryUncertainError";
  }
}

/** A Telegram edit that no retry can ever satisfy, such as a deleted message. */
export class TelegramMessageUnavailableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "TelegramMessageUnavailableError";
  }
}

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
    reason = "Your assistant is calling.",
    ttlMs = DEFAULT_CALL_TTL_MS,
  } = {}) {
    return await this.#exclusive(async () => {
      const current = await this.#read();
      const currentStatus = this.#status(current);
      if (
        current?.telegramDeliveryUncertain &&
        (currentStatus === "ringing" ||
          (currentStatus === "answered" &&
            Date.parse(current.accessExpiresAt) > this.now()))
      ) {
        throw httpError(
          "The Telegram call has an uncertain delivery and must be resolved before creating another",
          409,
        );
      }
      if (currentStatus === "ringing") {
        throw httpError("A Telegram call is already ringing", 409);
      }
      if (
        currentStatus === "answered" &&
        Date.parse(current.accessExpiresAt) > this.now()
      ) {
        throw httpError(
          "The answered Telegram call still grants browser access",
          409,
        );
      }
      if (
        ["answered", "declined", "expired"].includes(currentStatus) &&
        current?.telegram &&
        !current.dispositionUpdatedAt
      ) {
        throw httpError(
          `The ${currentStatus} Telegram call must be finalized before creating another`,
          409,
        );
      }
      if (!Number.isFinite(ttlMs) || ttlMs < 60_000 || ttlMs > MAX_CALL_TTL_MS) {
        throw httpError("Call lifetime must be between 1 and 30 minutes", 400);
      }

      const token = this.createToken();
      const createdAt = new Date(this.now()).toISOString();
      const expiresAt = new Date(this.now() + ttlMs).toISOString();
      const record = {
        version: 2,
        tokenHash: hashToken(token),
        status: "ringing",
        reason: normalizeReason(reason),
        createdAt,
        expiresAt,
        telegram: null,
      };
      await writeOwnerOnlyJson(this.stateFile, record);
      return { token, invitation: publicInvitation(record, "ringing") };
    });
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

  async authorize(token) {
    const record = await this.#read();
    return Boolean(
      tokenMatches(record, token) &&
        record.status === "answered" &&
        Date.parse(record.accessExpiresAt) > this.now(),
    );
  }

  async recordTelegramDelivery(token, telegram) {
    return await this.#exclusive(async () => {
      const record = await this.#read();
      const status = this.#status(record);
      if (
        !tokenMatches(record, token) ||
        !["ringing", "answered", "declined", "expired"].includes(status)
      ) {
        throw httpError("Telegram call is no longer available", 410);
      }
      const answerUrlBase = telegram.answerUrlBase
        ? tokenlessAnswerUrl(telegram.answerUrlBase)
        : null;
      record.telegram = {
        chatId: String(telegram.chatId),
        messageThreadId: telegram.messageThreadId
          ? String(telegram.messageThreadId)
          : null,
        messageId: Number(telegram.messageId),
        answerUrlBase,
        activationPending: Boolean(answerUrlBase),
      };
      delete record.telegramDeliveryUncertain;
      if (status === "expired" && record.status !== "expired") {
        record.status = "expired";
        record.expiredAt = new Date(this.now()).toISOString();
      }
      await writeOwnerOnlyJson(this.stateFile, record);
      return {
        invitation: publicInvitation(record, status),
        invitationKey: record.tokenHash,
        telegram: record.telegram,
      };
    });
  }

  async prepareTelegramDeliveryActivation(pending) {
    return await this.#exclusive(async () => {
      const record = await this.#read();
      if (
        !dispositionMatches(record, pending) ||
        this.#status(record) !== "ringing" ||
        !record.telegram?.activationPending ||
        !record.telegram.answerUrlBase
      ) {
        return null;
      }
      const token = this.createToken();
      const answerUrl = invitationAnswerUrl(
        record.telegram.answerUrlBase,
        token,
      );
      record.tokenHash = hashToken(token);
      await writeOwnerOnlyJson(this.stateFile, record);
      return {
        answerUrl,
        pending: {
          invitation: publicInvitation(record, "ringing"),
          invitationKey: record.tokenHash,
          telegram: record.telegram,
        },
      };
    });
  }

  async markTelegramDeliveryActivated(pending) {
    return await this.#exclusive(async () => {
      const record = await this.#read();
      if (!dispositionMatches(record, pending) || !record.telegram) return false;
      delete record.telegram.activationPending;
      await writeOwnerOnlyJson(this.stateFile, record);
      return true;
    });
  }

  async markTelegramActivationFailed(pending) {
    return await this.#exclusive(async () => {
      const record = await this.#read();
      if (!dispositionMatches(record, pending) || !record.telegram) return false;
      record.status = "failed";
      record.failedAt = new Date(this.now()).toISOString();
      delete record.telegram.activationPending;
      await writeOwnerOnlyJson(this.stateFile, record);
      return true;
    });
  }

  async recordTelegramDeliveryUncertain(token, telegram) {
    return await this.#exclusive(async () => {
      const record = await this.#read();
      const status = this.#status(record);
      if (
        !tokenMatches(record, token) ||
        !["ringing", "answered", "declined", "expired"].includes(status)
      ) {
        throw httpError("Telegram call is no longer available", 410);
      }
      record.telegramDeliveryUncertain = {
        chatId: String(telegram.chatId),
        messageThreadId: telegram.messageThreadId
          ? String(telegram.messageThreadId)
          : null,
        recordedAt: new Date(this.now()).toISOString(),
      };
      if (status === "expired" && record.status !== "expired") {
        record.status = "expired";
        record.expiredAt = new Date(this.now()).toISOString();
      }
      await writeOwnerOnlyJson(this.stateFile, record);
      return publicInvitation(record, status);
    });
  }

  async fail(token) {
    return await this.#exclusive(async () => {
      const record = await this.#read();
      if (!tokenMatches(record, token)) return unavailableInvitation();
      const status = this.#status(record);
      if (status !== "ringing") return publicInvitation(record, status);
      record.status = "failed";
      record.failedAt = new Date(this.now()).toISOString();
      delete record.telegramDeliveryUncertain;
      await writeOwnerOnlyJson(this.stateFile, record);
      return publicInvitation(record, "failed");
    });
  }

  async expireCurrent() {
    const pending = await this.pendingDisposition();
    return pending?.invitation.status === "expired" ? pending : null;
  }

  async pendingDisposition() {
    return await this.#exclusive(async () => {
      const record = await this.#read();
      if (!record) return null;
      const status = this.#status(record);
      if (
        !["answered", "declined", "expired"].includes(status) &&
        !(
          status === "ringing" &&
          (record.telegramDeliveryUncertain || record.telegram?.activationPending)
        )
      ) {
        return null;
      }
      if (status === "expired" && record.status !== "expired") {
        record.status = "expired";
        record.expiredAt = new Date(this.now()).toISOString();
        await writeOwnerOnlyJson(this.stateFile, record);
      }
      if (record.dispositionUpdatedAt) return null;
      return {
        invitation: publicInvitation(record, status),
        invitationKey: record.tokenHash,
        telegram: record.telegram,
      };
    });
  }

  async markDispositionUpdated(pending, { delivered = true } = {}) {
    return await this.#exclusive(async () => {
      const record = await this.#read();
      if (!dispositionMatches(record, pending)) return false;
      record.dispositionUpdatedAt = new Date(this.now()).toISOString();
      record.dispositionDelivered = delivered;
      await writeOwnerOnlyJson(this.stateFile, record);
      return true;
    });
  }

  /**
   * Counts one failed disposition update and reports whether the retry budget
   * is spent, so a Telegram endpoint that never recovers cannot wedge the
   * invitation state forever.
   */
  async recordDispositionAttempt(pending) {
    return await this.#exclusive(async () => {
      const record = await this.#read();
      if (!dispositionMatches(record, pending)) return false;
      const attempts = (Number(record.dispositionAttempts) || 0) + 1;
      record.dispositionAttempts = attempts;
      await writeOwnerOnlyJson(this.stateFile, record);
      return attempts >= MAX_DISPOSITION_ATTEMPTS;
    });
  }

  /** Operator escape hatch: discards the invitation state under the state lock. */
  async reset() {
    return await this.#exclusive(
      async () => await removeInvitationState(this.stateFile),
    );
  }

  async current() {
    const record = await this.#read();
    if (!record) return null;
    return publicInvitation(record, this.#status(record));
  }

  async #transition(token, nextStatus) {
    return await this.#exclusive(async () => {
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
      if (nextStatus === "answered") {
        record.accessExpiresAt = new Date(
          this.now() + ANSWERED_ACCESS_TTL_MS,
        ).toISOString();
      }
      await writeOwnerOnlyJson(this.stateFile, record);
      return {
        invitation: publicInvitation(record, nextStatus),
        invitationKey: record.tokenHash,
        telegram: record.telegram,
      };
    });
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

  async #exclusive(operation) {
    return await withStateLock(this.stateFile, operation);
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
    text: telegramCallText({ reason, expiresAt, active: false }),
    disable_notification: false,
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

export async function activateTelegramCall({
  botToken,
  chatId,
  messageId,
  answerUrl,
  reason,
  expiresAt,
  fetchImpl = fetch,
}) {
  await telegramRequest({
    botToken,
    method: "editMessageText",
    payload: {
      chat_id: chatId,
      message_id: Number(messageId),
      text: telegramCallText({ reason, expiresAt, active: true }),
      reply_markup: {
        inline_keyboard: [[{ text: "Answer", url: answerUrl }]],
      },
    },
    fetchImpl,
  });
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
    answered: "✅ Voice call answered",
    declined: "↘️ Voice call declined",
    expired: "⌛ Voice call missed",
  };
  const text = [labels[status] ?? "Voice call closed", "", normalizeReason(reason)]
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

/**
 * Closes out a pending disposition. A missing Telegram message or configuration
 * leaves nothing to edit, so the disposition is final immediately; a permanent
 * Telegram rejection or an exhausted retry budget finalizes it without the edit.
 * Only a transient failure keeps the disposition pending for a later retry.
 */
export async function finalizeTelegramDisposition(
  invitations,
  telegram,
  pending,
  { fetchImpl = fetch } = {},
) {
  const status = pending.invitation.status;
  if (status === "ringing" && pending.telegram?.activationPending) {
    if (!telegram) return { finalized: false, delivered: false, error: null };
    let activation;
    try {
      activation = await invitations.prepareTelegramDeliveryActivation(pending);
      if (!activation) {
        return { finalized: false, delivered: false, error: null };
      }
      await activateTelegramCall({
        botToken: telegram.botToken,
        chatId: activation.pending.telegram.chatId,
        messageId: activation.pending.telegram.messageId,
        answerUrl: activation.answerUrl,
        reason: activation.pending.invitation.reason,
        expiresAt: activation.pending.invitation.expiresAt,
        fetchImpl,
      });
      await invitations.markTelegramDeliveryActivated(activation.pending);
      return { finalized: false, delivered: true, error: null };
    } catch (error) {
      if (activation && error instanceof TelegramMessageUnavailableError) {
        const finalized = await invitations.markTelegramActivationFailed(
          activation.pending,
        );
        return { finalized, delivered: false, error };
      }
      return { finalized: false, delivered: false, error };
    }
  }
  if (!telegram || !pending.telegram) {
    if (status === "ringing") {
      return { finalized: false, delivered: false, error: null };
    }
    await invitations.markDispositionUpdated(pending, { delivered: false });
    return { finalized: true, delivered: false, error: null };
  }
  try {
    await updateTelegramCall({
      botToken: telegram.botToken,
      chatId: pending.telegram.chatId,
      messageId: pending.telegram.messageId,
      status,
      reason: pending.invitation.reason,
      fetchImpl,
    });
  } catch (error) {
    const exhausted = await invitations.recordDispositionAttempt(pending);
    if (!exhausted && !(error instanceof TelegramMessageUnavailableError)) {
      return { finalized: false, delivered: false, error };
    }
    await invitations.markDispositionUpdated(pending, { delivered: false });
    return { finalized: true, delivered: false, error };
  }
  await invitations.markDispositionUpdated(pending, { delivered: true });
  return { finalized: true, delivered: true, error: null };
}

export async function readTelegramConfig(envFile, { optional = false } = {}) {
  const handle = await open(envFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  let source;
  let metadata;
  try {
    metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error(`Telegram configuration must be a regular file: ${envFile}`);
    }
    source = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  const values = parseEnv(
    source,
    new Set([
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_CHAT_ID",
      "TELEGRAM_MESSAGE_THREAD_ID",
    ]),
  );
  const botToken = values.TELEGRAM_BOT_TOKEN;
  const chatId = values.TELEGRAM_CHAT_ID;
  if (optional && !botToken && !chatId) return null;
  if (
    typeof process.getuid === "function" &&
    metadata.uid !== process.getuid()
  ) {
    throw new Error(
      `Telegram configuration must be owned by the current user: ${envFile}`,
    );
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error(`Telegram configuration must be owner-only: ${envFile}`);
  }
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

export function parseHttpsPublicUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error(`Telegram call invitations require an HTTPS public URL: ${value}`);
  }
  return url;
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
  await ensureOwnerOnlyDirectory(directory);
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
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function withStateLock(stateFile, operation) {
  const directory = dirname(stateFile);
  await ensureOwnerOnlyDirectory(directory);
  const lockPath = `${stateFile}.lock`;
  const owner = await acquireStateLock(lockPath);
  try {
    return await operation();
  } finally {
    await releaseStateLock(lockPath, owner);
  }
}

async function ensureOwnerOnlyDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(
      `Telegram invitation state directory must be a real directory: ${directory}`,
    );
  }
  if (
    typeof process.getuid === "function" &&
    metadata.uid !== process.getuid()
  ) {
    throw new Error(
      `Telegram invitation state directory must be owned by the current user: ${directory}`,
    );
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error(
      `Telegram invitation state directory must be owner-only: ${directory}`,
    );
  }
}

async function acquireStateLock(lockPath) {
  const owner = {
    version: 1,
    pid: process.pid,
    processStartId: await processStartId(process.pid),
    token: randomBytes(16).toString("hex"),
  };
  const candidate = `${lockPath}.candidate-${owner.token}`;
  await mkdir(candidate, { mode: 0o700 });
  await writeOwnerOnlyJson(join(candidate, "owner.json"), owner);

  const deadline = Date.now() + STATE_LOCK_WAIT_MS;
  let published = false;
  try {
    while (true) {
      try {
        await rename(candidate, lockPath);
        published = true;
        return owner;
      } catch (error) {
        if (!isOccupiedLockError(error)) throw error;
      }

      let current;
      try {
        current = await inspectStateLock(lockPath);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      if (current.owner && await isStateLockOwnerActive(current.owner)) {
        if (Date.now() >= deadline) {
          throw new Error(`Another Telegram call operation holds ${lockPath}`);
        }
        await delay(10);
        continue;
      }
      if (
        !current.owner &&
        Date.now() - current.stats.mtimeMs < INVALID_STATE_LOCK_STALE_MS
      ) {
        if (Date.now() >= deadline) {
          throw new Error(`Another Telegram call operation holds ${lockPath}`);
        }
        await delay(10);
        continue;
      }

      const generation = current.owner?.token ??
        `legacy-${current.stats.dev}-${current.stats.ino}-${Math.trunc(current.stats.mtimeMs)}`;
      try {
        await rename(lockPath, `${lockPath}.stale-${generation}`);
      } catch (error) {
        if (!isOccupiedLockError(error) && error.code !== "ENOENT") throw error;
      }
    }
  } finally {
    if (!published) {
      await rm(candidate, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function releaseStateLock(lockPath, expected) {
  let current;
  try {
    current = await inspectStateLock(lockPath);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (current.owner?.token !== expected.token) return false;
  await rm(lockPath, { recursive: true });
  return true;
}

async function inspectStateLock(lockPath) {
  const stats = await stat(lockPath);
  let source;
  try {
    source = stats.isDirectory()
      ? await readFile(join(lockPath, "owner.json"), "utf8")
      : await readFile(lockPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { owner: null, stats };
    throw error;
  }
  try {
    const owner = JSON.parse(source);
    if (
      owner?.version !== 1 ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      (owner.processStartId !== undefined &&
        typeof owner.processStartId !== "string") ||
      typeof owner.token !== "string" ||
      !STATE_LOCK_TOKEN_PATTERN.test(owner.token)
    ) {
      return { owner: null, stats };
    }
    return { owner, stats };
  } catch {
    return { owner: null, stats };
  }
}

async function isStateLockOwnerActive(owner) {
  const currentStartId = await processStartId(owner.pid);
  if (currentStartId !== undefined && owner.processStartId !== undefined) {
    return currentStartId === owner.processStartId;
  }
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function processStartId(pid) {
  try {
    const source = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = source.lastIndexOf(")");
    if (close < 0) return undefined;
    return source.slice(close + 2).split(" ")[19] || undefined;
  } catch {
    return undefined;
  }
}

function isOccupiedLockError(error) {
  return ["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes(error.code);
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeReason(reason) {
  const value = String(reason ?? "").replace(/\s+/g, " ").trim();
  if (!value) return "Your assistant is calling.";
  return value.slice(0, 240);
}

function telegramCallText({ reason, expiresAt, active }) {
  return [
    active ? "☎️ Your assistant is calling" : "☎️ Preparing your voice call",
    "",
    normalizeReason(reason),
    "",
    active
      ? `Answer before ${formatUtc(expiresAt)}.`
      : "The secure Answer button is being prepared.",
  ].filter((line) => line !== null).join("\n");
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function tokenlessAnswerUrl(value) {
  const url = parseHttpsPublicUrl(value);
  url.hash = "";
  return url.href;
}

function invitationAnswerUrl(answerUrlBase, token) {
  const url = parseHttpsPublicUrl(answerUrlBase);
  url.hash = new URLSearchParams({ call: token }).toString();
  return url.href;
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

function dispositionMatches(record, pending) {
  return Boolean(
    record &&
      pending?.invitationKey &&
      record.tokenHash === pending.invitationKey &&
      record.status === pending.invitation?.status,
  );
}

function publicInvitation(record, status) {
  if (!record) return unavailableInvitation();
  return {
    status,
    reason: record.reason,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    accessExpiresAt:
      status === "answered" ? record.accessExpiresAt ?? null : null,
  };
}

function unavailableInvitation() {
  return {
    status: "unavailable",
    reason: null,
    createdAt: null,
    expiresAt: null,
    accessExpiresAt: null,
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
    if (method === "sendMessage") {
      throw new TelegramDeliveryUncertainError(
        `Telegram ${method} delivery is uncertain: ${error.message}`,
        { cause: error },
      );
    }
    throw new Error(`Telegram ${method} failed: ${error.message}`);
  }
  let value;
  try {
    value = await response.json();
  } catch {
    if (method === "sendMessage") {
      throw new TelegramDeliveryUncertainError(
        `Telegram ${method} delivery is uncertain because its response was invalid`,
      );
    }
    throw new Error(`Telegram ${method} returned an invalid response`);
  }
  if (!response.ok || !value.ok) {
    const description = String(value.description ?? "");
    if (
      method === "editMessageText" &&
      value.error_code === 400 &&
      /(?:MESSAGE_NOT_MODIFIED|message is not modified)/i.test(description)
    ) {
      return undefined;
    }
    // A 400/403 on an edit is Telegram's final answer: the message is gone, the
    // chat is unreachable, or the bot lost the rights to touch it. Retrying the
    // same edit can only fail again, so callers must be able to give up on it.
    if (
      method === "editMessageText" &&
      (value.error_code === 400 || value.error_code === 403)
    ) {
      throw new TelegramMessageUnavailableError(
        `Telegram ${method} was rejected permanently: ${value.description ?? response.status}`,
      );
    }
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
