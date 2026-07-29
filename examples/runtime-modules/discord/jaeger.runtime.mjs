import { homedir } from "node:os";
import { join } from "node:path";
import { discordModule } from "./modules/discord/discord.mjs";

const home = homedir();

export default {
  version: 1,
  modules: [
    discordModule({
      tokenFile: join(
        home,
        ".config",
        "jaeger",
        "runtime",
        "secrets",
        "discord-bot-token",
      ),
      guildId: "00000000000000000",
      voiceChannelId: "00000000000000000",
      allowUserId: "00000000000000000",
      notificationChannelId: null,
      ringingTimeoutMs: 600_000,
      silenceTimeoutMs: 120_000,
      maximumCallTimeoutMs: 1_800_000,
      operatorStateFile: join(
        home,
        ".local",
        "state",
        "jaeger",
        "discord",
        "operator.json",
      ),
    }),
  ],
};
