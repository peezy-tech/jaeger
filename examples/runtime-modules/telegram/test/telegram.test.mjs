import assert from "node:assert/strict";
import test from "node:test";
import { notifyTelegramBindings } from "../telegram.mjs";

test("lifecycle notifications only reach currently allowed chats", async () => {
  const values = new Map([
    ["bindings-index", ["allowed", "revoked"]],
    ["allowed", { chatId: 101, runId: "run-1", sessionId: "session-1" }],
    ["revoked", { chatId: 202, runId: "run-1", sessionId: "session-1" }],
  ]);
  const sends = [];
  const runtime = {
    storage: {
      get: async (key) => values.get(key),
    },
  };
  const bot = {
    api: {
      sendMessage: async (...args) => sends.push(args),
    },
  };
  const event = {
    type: "session.available",
    run: { runId: "run-1" },
    subject: { id: "session-1", sessionId: "session-1" },
  };

  await notifyTelegramBindings({
    runtime,
    bot,
    event,
    allowChatIds: [101],
  });
  assert.deepEqual(sends.map(([chatId]) => chatId), [101]);

  sends.length = 0;
  await notifyTelegramBindings({
    runtime,
    bot,
    event,
    allowChatIds: [],
  });
  assert.deepEqual(sends, []);
});
