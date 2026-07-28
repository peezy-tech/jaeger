import assert from "node:assert/strict";
import test from "node:test";
import { assertSupportedPiVersion } from "../src/doctor.js";

test("Pi RPC doctor requires the agent_settled protocol generation", () => {
  assert.doesNotThrow(() => assertSupportedPiVersion("0.80.4"));
  assert.doesNotThrow(() => assertSupportedPiVersion("pi 0.82.1"));
  assert.throws(
    () => assertSupportedPiVersion("0.80.3"),
    /requires Pi 0\.80\.4 or newer/,
  );
  assert.throws(
    () => assertSupportedPiVersion("development"),
    /Could not parse Pi version/,
  );
});
