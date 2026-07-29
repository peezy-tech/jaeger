import assert from "node:assert/strict";
import test from "node:test";
import {
  createJaegerReadonlyRequestHandlers,
  JAEGER_READONLY_TOOLS,
} from "../jaeger-readonly-tools.mjs";

test("the spike exposes only a zero-argument status tool", () => {
  assert.deepEqual(
    JAEGER_READONLY_TOOLS.map(({ name }) => name),
    ["jaeger_status"],
  );
  assert.deepEqual(JAEGER_READONLY_TOOLS[0].inputSchema.properties, {});
  assert.equal(JAEGER_READONLY_TOOLS[0].inputSchema.additionalProperties, false);
});

test("jaeger_status invokes the installed CLI with fixed read-only arguments", async () => {
  const calls = [];
  const handlers = createJaegerReadonlyRequestHandlers({
    jaegerBin: "/opt/jaeger",
    execute: async (...args) => {
      calls.push(args);
      return { stdout: '{"runtime":"local-service"}\n' };
    },
  });

  const result = await handlers["item/tool/call"]({
    namespace: null,
    tool: "jaeger_status",
    arguments: {},
  });

  assert.equal(result.success, true);
  assert.equal(result.contentItems[0].text, '{"runtime":"local-service"}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/opt/jaeger");
  assert.deepEqual(calls[0][1], ["status", "--json"]);
});

test("all other dynamic calls fail closed without executing", async () => {
  let executed = false;
  const handlers = createJaegerReadonlyRequestHandlers({
    execute: async () => {
      executed = true;
      return { stdout: "{}" };
    },
  });

  const result = await handlers["item/tool/call"]({
    namespace: null,
    tool: "jaeger_status",
    arguments: { unexpected: true },
  });

  assert.equal(result.success, false);
  assert.equal(executed, false);
});
