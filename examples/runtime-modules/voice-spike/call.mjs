import { homedir } from "node:os";
import { join } from "node:path";
import {
  readTelegramConfig,
  sendTelegramCall,
  TelegramCallInvitations,
  updateTelegramCall,
} from "./telegram-call.mjs";

const stateRoot =
  process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
const stateFile =
  process.env.VOICE_SPIKE_INVITATION_STATE_FILE ??
  join(stateRoot, "jaeger", "voice-spike", "telegram-call.json");
const envFile =
  process.env.VOICE_TELEGRAM_ENV_FILE ?? join(homedir(), ".env");
const publicUrl =
  process.env.VOICE_SPIKE_PUBLIC_URL ??
  "https://hq.peezy.tech/jaeger-voice/";
const reason = process.argv.slice(2).join(" ").trim() || "Jaeger wants to talk.";

const invitations = new TelegramCallInvitations({ stateFile });
const telegram = await readTelegramConfig(envFile);
const expired = await invitations.expireCurrent();
if (expired?.telegram) {
  await updateTelegramCall({
    ...telegram,
    ...expired.telegram,
    status: "expired",
    reason: expired.invitation.reason,
  });
  await invitations.markDispositionUpdated("expired");
}
const { token, invitation } = await invitations.create({ reason });
const answerUrl = new URL(publicUrl);
answerUrl.hash = new URLSearchParams({ call: token }).toString();

try {
  const delivery = await sendTelegramCall({
    ...telegram,
    answerUrl: answerUrl.href,
    reason: invitation.reason,
    expiresAt: invitation.expiresAt,
  });
  const recorded = await invitations.recordTelegramDelivery(token, {
    chatId: telegram.chatId,
    messageThreadId: telegram.messageThreadId,
    messageId: delivery.messageId,
  });
  if (["answered", "declined", "expired"].includes(recorded.invitation.status)) {
    await updateTelegramCall({
      ...telegram,
      ...recorded.telegram,
      status: recorded.invitation.status,
      reason: recorded.invitation.reason,
    });
    await invitations.markDispositionUpdated(recorded.invitation.status);
  }
  process.stdout.write(
    `${JSON.stringify({
      delivered: true,
      status: recorded.invitation.status,
      messageId: delivery.messageId,
      expiresAt: invitation.expiresAt,
    })}\n`,
  );
} catch (error) {
  await invitations.fail(token);
  throw error;
}
