import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseEnv,
  sendTelegramCall,
  TelegramCallInvitations,
} from "../telegram-call.mjs";

test("call invitations persist only a token hash in an owner-only file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-call-state-"));
  const stateFile = join(directory, "nested", "telegram-call.json");
  const invitations = new TelegramCallInvitations({
    stateFile,
    now: () => Date.parse("2026-07-29T03:00:00Z"),
    createToken: () => "a".repeat(43),
  });

  const { token, invitation } = await invitations.create({
    reason: "A workflow needs attention.",
  });
  const serialized = await readFile(stateFile, "utf8");

  assert.equal(token, "a".repeat(43));
  assert.equal(invitation.status, "ringing");
  assert.doesNotMatch(serialized, new RegExp(token));
  assert.match(serialized, /"tokenHash"/);
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, "nested"))).mode & 0o777, 0o700);
});

test("a call can be answered exactly once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-call-answer-"));
  const token = "b".repeat(43);
  const invitations = new TelegramCallInvitations({
    stateFile: join(directory, "telegram-call.json"),
    now: () => Date.parse("2026-07-29T03:00:00Z"),
    createToken: () => token,
  });

  await invitations.create();
  assert.equal((await invitations.inspect(token)).status, "ringing");
  assert.equal((await invitations.answer(token)).invitation.status, "answered");
  assert.equal((await invitations.inspect(token)).status, "answered");
  await assert.rejects(() => invitations.answer(token), {
    message: "Telegram call is no longer available",
    statusCode: 410,
  });
  assert.equal(
    (await invitations.inspect("c".repeat(43))).status,
    "unavailable",
  );
});

test("a fast answer survives Telegram delivery recording and later failure handling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-call-fast-answer-"));
  const token = "f".repeat(43);
  const invitations = new TelegramCallInvitations({
    stateFile: join(directory, "telegram-call.json"),
    now: () => Date.parse("2026-07-29T03:00:00Z"),
    createToken: () => token,
  });

  await invitations.create();
  await invitations.answer(token);
  const recorded = await invitations.recordTelegramDelivery(token, {
    chatId: "-100123",
    messageId: 991,
  });

  assert.equal(recorded.invitation.status, "answered");
  assert.equal(recorded.telegram.messageId, 991);
  assert.equal((await invitations.fail(token)).status, "answered");
  assert.equal((await invitations.current()).status, "answered");
  assert.equal(await invitations.authorize(token), true);
});

test("parallel answer and decline requests produce exactly one transition", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-call-race-"));
  const token = "r".repeat(43);
  const invitations = new TelegramCallInvitations({
    stateFile: join(directory, "telegram-call.json"),
    now: () => Date.parse("2026-07-29T03:00:00Z"),
    createToken: () => token,
  });

  await invitations.create();
  const results = await Promise.allSettled([
    invitations.answer(token),
    invitations.decline(token),
  ]);
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  const rejected = results.find(({ status }) => status === "rejected");
  assert.equal(rejected.reason.statusCode, 410);
  assert.match((await invitations.current()).status, /^(answered|declined)$/);
});

test("a call operation recovers a lock whose owner process exited", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-call-stale-owner-"));
  const stateFile = join(directory, "telegram-call.json");
  const lockPath = `${stateFile}.lock`;
  await mkdir(lockPath);
  await writeFile(
    join(lockPath, "owner.json"),
    `${JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      token: "a".repeat(32),
    })}\n`,
  );
  const invitations = new TelegramCallInvitations({
    stateFile,
    createToken: () => "s".repeat(43),
  });

  assert.equal((await invitations.create()).invitation.status, "ringing");
  await assert.rejects(readFile(lockPath), { code: "ENOENT" });
});

test("a call operation recovers a stale legacy lock file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-call-legacy-lock-"));
  const stateFile = join(directory, "telegram-call.json");
  const lockPath = `${stateFile}.lock`;
  await writeFile(lockPath, "");
  const staleTime = new Date(Date.now() - 31_000);
  await utimes(lockPath, staleTime, staleTime);
  const invitations = new TelegramCallInvitations({
    stateFile,
    createToken: () => "l".repeat(43),
  });

  assert.equal((await invitations.create()).invitation.status, "ringing");
  await assert.rejects(readFile(lockPath), { code: "ENOENT" });
});

test("an expired call cannot be answered", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-call-expiry-"));
  let now = Date.parse("2026-07-29T03:00:00Z");
  const token = "d".repeat(43);
  const invitations = new TelegramCallInvitations({
    stateFile: join(directory, "telegram-call.json"),
    now: () => now,
    createToken: () => token,
  });

  await invitations.create({ ttlMs: 60_000 });
  now += 60_001;
  assert.equal((await invitations.inspect(token)).status, "expired");
  await assert.rejects(() => invitations.answer(token), { statusCode: 410 });
});

test("an answered invitation grants bounded bearer access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-call-access-"));
  let now = Date.parse("2026-07-29T03:00:00Z");
  const token = "g".repeat(43);
  const invitations = new TelegramCallInvitations({
    stateFile: join(directory, "telegram-call.json"),
    now: () => now,
    createToken: () => token,
  });

  await invitations.create();
  assert.equal(await invitations.authorize(token), false);
  await invitations.answer(token);
  assert.equal(await invitations.authorize(token), true);
  now += 30 * 60 * 1_000 + 1;
  assert.equal(await invitations.authorize(token), false);
});

test("a new call cannot discard an expired call before its disposition is finalized", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-call-replace-expired-"));
  let now = Date.parse("2026-07-29T03:00:00Z");
  let sequence = 0;
  const invitations = new TelegramCallInvitations({
    stateFile: join(directory, "telegram-call.json"),
    now: () => now,
    createToken: () => String(++sequence).repeat(43),
  });

  const first = await invitations.create({ ttlMs: 60_000 });
  await invitations.recordTelegramDelivery(first.token, {
    chatId: "-100123",
    messageId: 991,
  });
  now += 60_001;

  await assert.rejects(() => invitations.create(), {
    message: "The expired Telegram call must be finalized before creating another",
    statusCode: 409,
  });
  const expired = await invitations.expireCurrent();
  assert.equal(expired.invitation.status, "expired");
  assert.equal(expired.telegram.messageId, 991);
  assert.equal((await invitations.expireCurrent()).telegram.messageId, 991);
  await assert.rejects(() => invitations.create(), { statusCode: 409 });
  assert.equal(await invitations.markDispositionUpdated("expired"), true);
  assert.equal(await invitations.expireCurrent(), null);
  assert.equal((await invitations.create()).invitation.status, "ringing");
});

test("Telegram delivery uses a loud notification and an HTTPS answer button", async () => {
  let request;
  const result = await sendTelegramCall({
    botToken: "secret",
    chatId: "-100123",
    messageThreadId: "42",
    answerUrl:
      "https://hq.peezy.tech/jaeger-voice/#call=opaque-invitation",
    reason: "Review finished.",
    expiresAt: "2026-07-29T03:10:00Z",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 991 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const body = JSON.parse(request.options.body);
  assert.equal(result.messageId, 991);
  assert.equal(body.chat_id, "-100123");
  assert.equal(body.message_thread_id, 42);
  assert.equal(body.disable_notification, false);
  assert.equal(body.reply_markup.inline_keyboard[0][0].text, "Answer");
  assert.match(
    body.reply_markup.inline_keyboard[0][0].url,
    /^https:\/\/hq\.peezy\.tech\/jaeger-voice\/#call=/,
  );
});

test("env parsing supports quoted values without evaluating shell syntax", () => {
  const values = parseEnv(
    `
      TELEGRAM_BOT_TOKEN="bot-token"
      export TELEGRAM_CHAT_ID='-100123'
      TELEGRAM_MESSAGE_THREAD_ID=42
      OTHER_SECRET=not-loaded
      IGNORED LINE
    `,
    new Set([
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_CHAT_ID",
      "TELEGRAM_MESSAGE_THREAD_ID",
    ]),
  );
  assert.deepEqual(values, {
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_CHAT_ID: "-100123",
    TELEGRAM_MESSAGE_THREAD_ID: "42",
  });
});
