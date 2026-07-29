import { homedir } from "node:os";
import { join } from "node:path";
import { TelegramCallInvitations } from "./telegram-call.mjs";

const stateRoot =
  process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
const stateFile =
  process.env.VOICE_SPIKE_INVITATION_STATE_FILE ??
  join(stateRoot, "jaeger", "voice-spike", "telegram-call.json");

const invitations = new TelegramCallInvitations({ stateFile });
const cleared = await invitations.reset();
process.stdout.write(`${JSON.stringify({ cleared, stateFile })}\n`);
