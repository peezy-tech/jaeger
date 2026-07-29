import assert from "node:assert/strict";
import test from "node:test";
import { loadAccessTokens } from "../public/call-access.js";

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
    }),
    { callToken: null, capabilityToken: null },
  );
});

test("a direct capability token is returned while its fragment is scrubbed", () => {
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
    { callToken: null, capabilityToken: "memory-only" },
  );
  assert.deepEqual(replacements, [[null, "", "/jaeger-voice/"]]);
});
