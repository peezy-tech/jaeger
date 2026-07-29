import { readFile } from "node:fs/promises";
import { Bot } from "grammy";

export function telegramModule(options) {
  let bot;
  let runtime;

  return {
    name: "telegram",

    setup(context) {
      runtime = context;
      runtime.events.consume(
        [
          "session.available",
          "phase.changed",
          "run.terminal",
          "session.query.completed",
        ],
        async (event) =>
          await notifyTelegramBindings({
            runtime,
            bot,
            event,
            allowChatIds: options.allowChatIds,
          }),
      );
      runtime.services.run("telegram-polling", async (signal) => {
        const token = (await readFile(options.tokenFile, "utf8")).trim();
        if (!token) throw new Error("Telegram token file is empty");
        bot = new Bot(token);
        installHandlers(bot);
        signal.addEventListener("abort", () => bot.stop(), { once: true });
        await bot.start({
          drop_pending_updates: false,
          onStart: ({ username }) => runtime.log.info(`Telegram bot @${username} started`),
        });
      });
    },
  };

  function installHandlers(instance) {
    instance.use(async (ctx, next) => {
      if (!allowed(ctx)) return;
      await next();
    });

    instance.command("runs", async (ctx) => {
      const runs = await runtime.runs.list();
      const lines = Array.isArray(runs)
        ? runs.slice(0, 10).map((run) => `${run.runId}  ${run.status}`)
        : [];
      await ctx.reply(lines.length > 0 ? lines.join("\n") : "No Jaeger runs found.");
    });

    instance.command("attach", async (ctx) => {
      const [runId, selector] = commandArgs(ctx);
      if (!runId || !selector) {
        await ctx.reply("Usage: /attach RUN_ID SESSION");
        return;
      }
      const session = await runtime.sessions.inspect(runId, selector);
      const binding = {
        runId,
        sessionId: session.id,
        model: options.defaultModel,
      };
      await saveBinding(ctx, binding);
      await ctx.reply(
        `Attached to ${runId}/${session.id}${
          session.label ? ` (${session.label})` : ""
        }.`,
      );
    });

    instance.command("model", async (ctx) => {
      const [model] = commandArgs(ctx);
      const binding = await loadBinding(ctx);
      if (!binding) {
        await ctx.reply("Attach a Jaeger session first with /attach.");
        return;
      }
      binding.model = model || options.defaultModel;
      await saveBinding(ctx, binding);
      await ctx.reply(`Side-chat model: ${binding.model}`);
    });

    instance.command("status", async (ctx) => {
      const binding = await loadBinding(ctx);
      if (!binding) {
        await ctx.reply("Not attached. Use /attach RUN_ID SESSION.");
        return;
      }
      const session = await runtime.sessions.inspect(binding.runId, binding.sessionId);
      await ctx.reply(
        [
          `Run: ${binding.runId}`,
          `Session: ${binding.sessionId}`,
          `State: ${session.status}`,
          `Model: ${binding.model || options.defaultModel || "inherit"}`,
        ].join("\n"),
      );
    });

    instance.on("message:text", async (ctx) => {
      if (ctx.message.text.startsWith("/")) return;
      const binding = await loadBinding(ctx);
      if (!binding) {
        await ctx.reply("Attach a Jaeger session first with /attach RUN_ID SESSION.");
        return;
      }
      const progress = await ctx.reply("Querying the current agent thread…");
      try {
        const result = await runtime.sessions.query(
          binding.runId,
          binding.sessionId,
          {
            message: ctx.message.text,
            ...(binding.model ? { model: binding.model } : {}),
          },
        );
        const output =
          typeof result.output === "string"
            ? result.output
            : JSON.stringify(result.output, null, 2);
        const parts = splitTelegramMessage(output || "The query returned no output.");
        await ctx.api.editMessageText(ctx.chat.id, progress.message_id, parts.shift());
        for (const part of parts) await ctx.reply(part);
      } catch (error) {
        await ctx.api.editMessageText(
          ctx.chat.id,
          progress.message_id,
          `Query failed: ${errorMessage(error)}`,
        );
      }
    });

    instance.catch((error) => {
      runtime.log.error("Telegram update failed", error.error);
    });
  }

  function allowed(ctx) {
    const users = options.allowUserIds ?? [];
    return (
      users.length > 0 &&
      users.includes(ctx.from?.id) &&
      chatAllowed(options.allowChatIds, ctx.chat?.id)
    );
  }

  async function loadBinding(ctx) {
    return await runtime.storage.get(bindingKey(ctx));
  }

  async function saveBinding(ctx, binding) {
    const key = bindingKey(ctx);
    const value = {
      ...binding,
      chatId: ctx.chat.id,
      ...(ctx.message?.message_thread_id
        ? { threadId: ctx.message.message_thread_id }
        : {}),
    };
    await runtime.storage.set(key, value);
    const current = (await runtime.storage.get("bindings-index")) ?? [];
    const keys = Array.isArray(current) ? current.filter((item) => typeof item === "string") : [];
    if (!keys.includes(key)) {
      keys.push(key);
      await runtime.storage.set("bindings-index", keys);
    }
  }

  function bindingKey(ctx) {
    return `binding-${ctx.chat.id}-${ctx.message?.message_thread_id ?? 0}`;
  }
}

export async function notifyTelegramBindings({
  runtime,
  bot,
  event,
  allowChatIds,
}) {
  if (!bot) throw new Error("Telegram bot is not connected");
  const keys = (await runtime.storage.get("bindings-index")) ?? [];
  if (!Array.isArray(keys)) return;
  for (const key of keys) {
    if (typeof key !== "string") continue;
    const binding = await runtime.storage.get(key);
    if (
      !binding ||
      !chatAllowed(allowChatIds, binding.chatId) ||
      binding.runId !== event.run?.runId
    ) {
      continue;
    }
    if (
      event.subject?.sessionId &&
      binding.sessionId !== event.subject.sessionId
    ) {
      continue;
    }
    await bot.api.sendMessage(
      binding.chatId,
      renderEvent(event),
      binding.threadId ? { message_thread_id: binding.threadId } : {},
    );
  }
}

function chatAllowed(allowChatIds, chatId) {
  const chats = allowChatIds ?? [];
  return chats.length > 0 && chats.includes(chatId);
}

function commandArgs(ctx) {
  return ctx.match.trim().split(/\s+/).filter(Boolean);
}

function renderEvent(event) {
  const run = event.run?.runId ?? "unknown";
  if (event.type === "session.available") {
    return `Jaeger ${run}: session ${event.subject?.id} is available for side chat.`;
  }
  if (event.type === "phase.changed") {
    return `Jaeger ${run}: phase ${event.subject?.name}.`;
  }
  if (event.type === "run.terminal") {
    return `Jaeger ${run}: ${event.subject?.status}.`;
  }
  return `Jaeger ${run}: side-chat query ${event.subject?.queryId} completed.`;
}

function splitTelegramMessage(message) {
  const parts = [];
  let remaining = String(message);
  while (remaining.length > 4000) {
    let split = remaining.lastIndexOf("\n", 4000);
    if (split < 1000) split = 4000;
    parts.push(remaining.slice(0, split));
    remaining = remaining.slice(split).trimStart();
  }
  parts.push(remaining);
  return parts;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
