import assert from "node:assert/strict";
import test from "node:test";
import {
  forgetCallToken,
  loadAccessTokens,
  rememberCallToken,
} from "../public/call-access.js";

test("an invitation token survives fragment scrubbing and a page reload", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
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
      storage,
    }),
    { callToken: "still-valid", capabilityToken: null },
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
      storage,
    }),
    { callToken: "still-valid", capabilityToken: null },
  );
});

test("remembered invitation access can be explicitly discarded", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };

  rememberCallToken("expired", storage);
  forgetCallToken(storage);
  assert.equal(values.size, 0);
});
