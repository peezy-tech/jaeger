import { homedir } from "node:os";
import { join } from "node:path";
import {
  finalizeTelegramDisposition,
  parseHttpsPublicUrl,
  readTelegramConfig,
  TelegramDeliveryUncertainError,
  TelegramCallInvitations,
  sendTelegramCall,
} from "./telegram-call.mjs";

const configuredPublicUrl = process.env.VOICE_SPIKE_PUBLIC_URL;
if (!configuredPublicUrl) {
  throw new Error(
    "VOICE_SPIKE_PUBLIC_URL must be set to the HTTPS URL that serves this install's voice surface",
  );
}
const publicUrl = parseHttpsPublicUrl(configuredPublicUrl);
const reason = parseCallReason(process.argv.slice(2));
const stateFile =
  process.env.VOICE_SPIKE_INVITATION_STATE_FILE ??
  join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "jaeger",
    "voice-spike",
    "telegram-call.json",
  );
const telegram = await readTelegramConfig(
  process.env.VOICE_TELEGRAM_ENV_FILE ?? join(homedir(), ".env"),
);
const invitations = new TelegramCallInvitations({ stateFile });
const pending = await invitations.pendingDisposition();
if (pending) {
  const outcome = await finalizeTelegramDisposition(invitations, telegram, pending);
  if (outcome.error) {
    throw new Error(
      "Previous voice call disposition is still unresolved: " +
        outcome.error.message,
    );
  }
}

const { token, invitation } = await invitations.create({ reason });
const answerUrl = new URL(publicUrl);
answerUrl.hash = "";
await invitations.recordTelegramDeliveryUncertain(token, {
  chatId: telegram.chatId,
  messageThreadId: telegram.messageThreadId,
});

let delivery;
try {
  delivery = await sendTelegramCall({
    botToken: telegram.botToken,
    chatId: telegram.chatId,
    messageThreadId: telegram.messageThreadId,
    answerUrl: answerUrl.href,
    reason: invitation.reason,
    expiresAt: invitation.expiresAt,
  });
} catch (error) {
  if (!(error instanceof TelegramDeliveryUncertainError)) {
    await invitations.fail(token).catch(() => {});
  }
  throw error;
}

let recorded;
try {
  recorded = await invitations.recordTelegramDelivery(token, {
    chatId: telegram.chatId,
    messageThreadId: telegram.messageThreadId,
    messageId: delivery.messageId,
    answerUrlBase: answerUrl.href,
  });
} catch (error) {
  process.stderr.write(
    "Telegram message was sent but could not be recorded safely: " +
      error.message +
      "\n",
  );
  throw error;
}

const activation = await finalizeTelegramDisposition(
  invitations,
  telegram,
  await invitations.pendingDisposition(),
);
if (activation.error) {
  throw new Error("Telegram call activation failed: " + activation.error.message);
}

process.stdout.write(
  JSON.stringify({
    delivered: true,
    reason: recorded.invitation.reason,
    messageId: delivery.messageId,
    expiresAt: invitation.expiresAt,
  }) + "\n",
);

function parseCallReason(argv) {
  if (argv.some((value) => value.startsWith("-"))) {
    throw new Error("Call reason must be plain text; no options are supported");
  }
  return argv.join(" ").trim() || "Your assistant is calling.";
}
