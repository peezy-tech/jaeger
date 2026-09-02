import assert from "node:assert/strict";
import test from "node:test";
import {
  applyProviderIdentityUpdate,
  createInitialProviderIdentity,
  markProviderIdentityUncertain,
  parseProviderIdentitySnapshot,
  providerIdentityUpdateFromClaudeMessage,
  providerIdentityUpdateFromCodexMessage,
} from "../src/provider-identity.js";

test("normalizes provider account updates without retaining credentials", () => {
  const initial = createInitialProviderIdentity("codex", "codex-app-server");
  const update = providerIdentityUpdateFromCodexMessage({
    method: "account/updated",
    params: {
      account: {
        id: "acct-1",
        email: "operator@example.com",
        planType: "pro",
        accessToken: "secret-token",
      },
    },
  });
  assert.ok(update);
  const current = applyProviderIdentityUpdate(initial, update, "2026-08-07T20:00:00.000Z");
  assert.deepEqual(current.account, {
    id: "acct-1",
    email: "operator@example.com",
    label: "pro",
  });
  assert.equal(current.auth.status, "authenticated");
  assert.equal(JSON.stringify(current).includes("secret-token"), false);
});

test("normalizes Claude auth lifecycle and redacts auth errors", () => {
  const initial = createInitialProviderIdentity("claude", "claude-agent-sdk");
  const update = providerIdentityUpdateFromClaudeMessage({
    type: "auth_status",
    isAuthenticating: false,
    error: "authorization: Bearer top-secret-token",
  });
  assert.ok(update);
  const current = applyProviderIdentityUpdate(initial, update, "2026-08-07T20:00:00.000Z");
  assert.equal(current.auth.status, "error");
  assert.match(current.auth.error ?? "", /\[REDACTED\]/u);
  assert.doesNotMatch(current.auth.error ?? "", /top-secret-token/u);
});

test("does not invent a Claude authentication state", () => {
  assert.deepEqual(
    providerIdentityUpdateFromClaudeMessage({ type: "auth_status", isAuthenticated: false }),
    { auth: { status: "unauthenticated" } },
  );
  assert.deepEqual(
    providerIdentityUpdateFromClaudeMessage({ type: "auth_status" }),
    { auth: { status: "unknown" } },
  );
});

test("invalidates or marks uncertain identity state without exposing secrets", () => {
  const initial = createInitialProviderIdentity("claude", "claude-agent-sdk");
  const uncertain = markProviderIdentityUncertain(initial, "refreshToken=hidden-value");
  assert.equal(uncertain.freshness, "uncertain");
  assert.doesNotMatch(uncertain.lastError ?? "", /hidden-value/u);
  assert.deepEqual(
    parseProviderIdentitySnapshot(uncertain),
    uncertain,
  );
});

test("rejects non-allowlisted fields in a persisted identity snapshot", () => {
  assert.throws(
    () => parseProviderIdentitySnapshot({
      provider: "codex",
      driver: "codex-app-server",
      auth: { status: "authenticated", accessToken: "must-not-surface" },
      freshness: "fresh",
    }),
    /Invalid provider identity snapshot/u,
  );
});
