# Telegram runtime module

This is a trusted, in-process Jaeger runtime module. It receives durable
lifecycle events and submits forked, read-only session queries from Telegram.

1. Copy this directory to `~/.config/jaeger/runtime`.
2. Run `npm install` in that directory.
3. Write the BotFather token to `secrets/telegram-token` with mode `0600`.
4. Fill both `allowUserIds` and `allowChatIds` in `jaeger.runtime.mjs`.
5. Validate and install:

   ```bash
   jaeger modules validate ~/.config/jaeger/runtime/jaeger.runtime.mjs
   jaeger backend install \
     --runtime-config ~/.config/jaeger/runtime/jaeger.runtime.mjs
   jaeger modules status --json
   ```

Use `/runs`, then `/attach RUN_ID SESSION`. Plain messages query a fresh fork
of the latest provider session without changing the workflow-owned thread.
