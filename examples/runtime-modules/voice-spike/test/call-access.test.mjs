import assert from "node:assert/strict";
import test from "node:test";
import {
  answerInvitationWithRecovery,
  isCurrentRealtimeSession,
  loadAccessTokens,
} from "../public/call-access.js";

test("an invitation token is returned from the fragment and kept out of storage", () => {
  const replacements = [];

  assert.deepEqual(
    loadAccessTokens({
      location: {
        hash: "#call=still-valid",
        pathname: "/jaeger-voice/",
        search: "?source=telegram",
      },
      history: {
        replaceState: (...args) => replacements.push(args),
      },
    }),
    { callToken: "still-valid" },
  );
  assert.deepEqual(replacements, [
    [null, "", "/jaeger-voice/?source=telegram"],
  ]);
  assert.deepEqual(
    loadAccessTokens({
      location: {
        hash: "",
        pathname: "/jaeger-voice/",
        search: "?source=telegram",
      },
      history: {
        replaceState: () => assert.fail("a clean reload must not rewrite history"),
      },
    }),
    { callToken: null },
  );
});

test("a legacy capability fragment is scrubbed without granting access", () => {
  const replacements = [];
  assert.deepEqual(
    loadAccessTokens({
      location: {
        hash: "#capability=memory-only",
        pathname: "/jaeger-voice/",
        search: "",
      },
      history: {
        replaceState: (...args) => replacements.push(args),
      },
    }),
    { callToken: null },
  );
  assert.deepEqual(replacements, [[null, "", "/jaeger-voice/"]]);
});

test("a lost answer response is reconciled with the still-held invitation token", async () => {
  const token = "memory-only-invitation";
  const invitation = {
    status: "answered",
    accessExpiresAt: "2030-01-01T00:00:00.000Z",
  };
  const result = await answerInvitationWithRecovery(token, {
    answer: async () => {
      throw new Error("answer response was lost");
    },
    inspect: async (receivedToken) => {
      assert.equal(receivedToken, token);
      return invitation;
    },
    now: Date.parse("2029-01-01T00:00:00.000Z"),
  });

  assert.equal(result, invitation);
});

test("an invitation answer failure remains an error when access was not granted", async () => {
  const answerError = new Error("answer rejected");
  await assert.rejects(
    answerInvitationWithRecovery("still-ringing", {
      answer: async () => {
        throw answerError;
      },
      inspect: async () => ({
        status: "ringing",
        accessExpiresAt: "2030-01-01T00:00:00.000Z",
      }),
      now: Date.parse("2029-01-01T00:00:00.000Z"),
    }),
    (error) => error === answerError,
  );
});

test("realtime close events are scoped to the browser session that owns them", () => {
  const ownership = {
    activeSessionId: "replacement",
    startingSessionId: null,
  };
  assert.equal(
    isCurrentRealtimeSession({ sessionId: "previous" }, ownership),
    false,
  );
  assert.equal(
    isCurrentRealtimeSession({ sessionId: "replacement" }, ownership),
    true,
  );
  assert.equal(isCurrentRealtimeSession({}, ownership), true);
});
