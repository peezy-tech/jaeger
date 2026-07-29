# Telegram runtime module

This is a trusted, in-process Jaeger runtime module. It receives durable
lifecycle events and submits forked, read-only session queries from Telegram.

1. From a Jaeger source checkout, install the registry item into the shared
   runtime package project:

   ```bash
   jaeger modules add telegram
   ```

   From GitHub, pin a tag or full commit:

   ```bash
   jaeger modules add peezy-tech/jaeger/telegram#COMMIT
   ```

2. Write the BotFather token outside the installed module source, for example
   to `~/.config/jaeger/runtime/secrets/telegram-token`, with mode `0600`.
3. Copy the module factory call from
   `modules/telegram/jaeger.runtime.mjs` into the root
   `~/.config/jaeger/runtime/jaeger.runtime.mjs`. Update its import to
   `./modules/telegram/telegram.mjs`, then fill both `allowUserIds` and
   `allowChatIds`.
4. Review, validate, and activate:

   ```bash
   jaeger modules diff telegram
   jaeger modules validate ~/.config/jaeger/runtime/jaeger.runtime.mjs
   jaeger backend install \
     --runtime-config ~/.config/jaeger/runtime/jaeger.runtime.mjs
   jaeger modules status --json
   ```

Use `/runs`, then `/attach RUN_ID SESSION`. Plain messages query a fresh fork
of the latest provider session without changing the workflow-owned thread.
