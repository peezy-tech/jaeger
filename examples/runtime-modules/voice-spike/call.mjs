import { homedir } from "node:os";
import { join } from "node:path";
import {
  finalizeTelegramDisposition,
  activateTelegramCall,
  parseHttpsPublicUrl,
  readTelegramConfig,
  sendTelegramCall,
  TelegramDeliveryUncertainError,
  TelegramCallInvitations,
} from "./telegram-call.mjs";

const stateRoot =
  process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
const stateFile =
  process.env.VOICE_SPIKE_INVITATION_STATE_FILE ??
  join(stateRoot, "jaeger", "voice-spike", "telegram-call.json");
const envFile =
  process.env.VOICE_TELEGRAM_ENV_FILE ?? join(homedir(), ".env");
const configuredPublicUrl = process.env.VOICE_SPIKE_PUBLIC_URL;
if (!configuredPublicUrl) {
  throw new Error(
    "VOICE_SPIKE_PUBLIC_URL must be set to this install's own HTTPS voice-surface URL; the invitation bearer token is placed in its fragment",
  );
}
const publicUrl = parseHttpsPublicUrl(configuredPublicUrl);
const reason = process.argv.slice(2).join(" ").trim() || "Jaeger wants to talk.";

const invitations = new TelegramCallInvitations({ stateFile });
const telegram = await readTelegramConfig(envFile);
const pending = await invitations.pendingDisposition();
// A rejected close-out must not abort the preflight: create() below reports
// whether the previous call still blocks this one.
if (pending) {
  reportDisposition(
    await finalizeTelegramDisposition(invitations, telegram, pending),
  );
}
const { token, invitation } = await invitations.create({ reason });
const answerUrl = new URL(publicUrl);
answerUrl.hash = new URLSearchParams({ call: token }).toString();

await invitations.recordTelegramDeliveryUncertain(token, {
  chatId: telegram.chatId,
  messageThreadId: telegram.messageThreadId,
});

let delivery;
try {
  delivery = await sendTelegramCall({
    ...telegram,
    answerUrl: answerUrl.href,
    reason: invitation.reason,
    expiresAt: invitation.expiresAt,
  });
} catch (error) {
  if (error instanceof TelegramDeliveryUncertainError) {
    // The uncertainty marker was persisted before the request, so a crash at
    // any point after Telegram accepts the message cannot look like a clean
    // ringing invitation on the next recovery pass.
  } else {
    await invitations.fail(token);
  }
  throw error;
}

const recorded = await invitations.recordTelegramDelivery(token, {
  chatId: telegram.chatId,
  messageThreadId: telegram.messageThreadId,
  messageId: delivery.messageId,
  answerUrl: answerUrl.href,
});
await activateTelegramCall({
  ...telegram,
  messageId: delivery.messageId,
  answerUrl: answerUrl.href,
  reason: invitation.reason,
  expiresAt: invitation.expiresAt,
});
await invitations.markTelegramDeliveryActivated(recorded);
if (["answered", "declined", "expired"].includes(recorded.invitation.status)) {
  reportDisposition(
    await finalizeTelegramDisposition(invitations, telegram, recorded),
  );
}
process.stdout.write(
  `${JSON.stringify({
    delivered: true,
    status: recorded.invitation.status,
    messageId: delivery.messageId,
    expiresAt: invitation.expiresAt,
  })}\n`,
);

function reportDisposition(outcome) {
  if (!outcome.error) return;
  process.stderr.write(
    `Telegram call disposition update failed${
      outcome.finalized ? " and was finalized without updating Telegram" : ""
    }: ${outcome.error.message}\n`,
  );
}
