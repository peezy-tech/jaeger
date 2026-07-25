import { telegramModule } from "./telegram.mjs";

export default {
  version: 1,
  modules: [
    telegramModule({
      tokenFile: new URL("./secrets/telegram-token", import.meta.url),
      allowUserIds: [],
      allowChatIds: [],
    }),
  ],
};
