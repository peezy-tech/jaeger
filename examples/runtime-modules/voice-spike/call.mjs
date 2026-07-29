import { homedir } from "node:os";
import { join } from "node:path";
import {
  readTelegramConfig,
  sendTelegramCall,
  TelegramCallInvitations,
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
  await invitations.recordTelegramDelivery(token, {
    chatId: telegram.chatId,
    messageThreadId: telegram.messageThreadId,
    messageId: delivery.messageId,
  });
  process.stdout.write(
    `${JSON.stringify({
      delivered: true,
      status: "ringing",
      messageId: delivery.messageId,
      expiresAt: invitation.expiresAt,
    })}\n`,
  );
} catch (error) {
  await invitations.fail(token);
  throw error;
}
