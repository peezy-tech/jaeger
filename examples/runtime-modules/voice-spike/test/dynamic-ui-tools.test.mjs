import assert from "node:assert/strict";
import test from "node:test";
import {
  createUiRequestHandlers,
  generatedUiSpec,
  normalizeGeneratedUi,
  UI_TOOLS,
} from "../dynamic-ui-tools.mjs";

test("the browser-facing tools are generate_ui and clear_ui", () => {
  assert.deepEqual(
    UI_TOOLS.map(({ name }) => name),
    ["generate_ui", "clear_ui"],
  );
  assert.equal(
    UI_TOOLS[0].inputSchema.properties.components.maxItems,
    8,
  );
  assert.equal(
    UI_TOOLS[0].inputSchema.properties.components.items.oneOf.length,
    5,
  );
});

test("generate_ui normalizes a general-purpose interface and server actions", () => {
  const ui = normalizeGeneratedUi({
    id: "trip-options",
    kicker: "A useful visual",
    title: "Three ways forward",
    subtitle: "Choose a direction and I will continue the conversation.",
    tone: "accent",
    components: [
      {
        type: "text",
        title: "The short version",
        body: "The important context belongs on screen while we talk.",
      },
      {
        type: "stats",
        items: [
          { label: "Options", value: "3", detail: "All bounded" },
          { label: "Mode", value: "Read-only", detail: null },
        ],
      },
      {
        type: "choices",
        title: "What should we do next?",
        description: "The selected value returns to the voice conversation.",
        options: [
          {
            id: "compare",
            label: "Compare them",
            description: "Hear the trade-offs.",
            detail: "Talk",
            value: "Compare the options out loud.",
          },
          {
            id: "summarize",
            label: "Summarize",
            description: "Get the concise answer.",
            detail: "Short",
          },
        ],
      },
    ],
  });

  assert.equal(ui.title, "Three ways forward");
  assert.equal(ui.tone, "accent");
  assert.equal(ui.components.length, 3);
  assert.deepEqual(ui.actions, [
    {
      id: "compare",
      label: "Compare them",
      value: "Compare the options out loud.",
    },
    { id: "summarize", label: "Summarize", value: "Summarize" },
  ]);
  assert.deepEqual(ui.spec, generatedUiSpec(ui));
  assert.deepEqual(
    ui.spec.elements["generated-2-compare"].on.press,
    {
      action: "generatedRespond",
      params: { uiId: "trip-options", actionId: "compare" },
    },
  );
});

test("generate_ui rejects unsupported or unsafe component types", () => {
  assert.throws(
    () =>
      normalizeGeneratedUi({
        id: "bad",
        title: "Unsafe",
        components: [{ type: "browser", url: "https://example.com" }],
      }),
    /Unsupported component type/,
  );
  assert.throws(
    () =>
      normalizeGeneratedUi({
        id: "bad-choice",
        title: "Not enough",
        components: [
          {
            type: "choices",
            title: "Pick",
            options: [{ id: "only", label: "Only option" }],
          },
        ],
      }),
    /at least two options/,
  );
});

test("generate and clear calls publish only normalized interfaces", async () => {
  const published = [];
  let cleared = 0;
  const handlers = createUiRequestHandlers({
    publish: async (ui) => published.push(ui),
    clear: async () => {
      cleared += 1;
    },
  });

  const generated = await handlers["item/tool/call"]({
    tool: "generate_ui",
    arguments: {
      id: "simple-brief",
      title: "A useful brief",
      components: [
        {
          type: "callout",
          label: "Read-only",
          body: "This interface is presentation only.",
          tone: "good",
        },
      ],
    },
  });
  assert.equal(generated.success, true);
  assert.equal(published[0].spec.root, "generated-root");

  assert.equal(
    await handlers["item/tool/call"]({
      tool: "jaeger_status",
      arguments: {},
    }),
    null,
  );
  assert.equal(
    (
      await handlers["item/tool/call"]({
        tool: "clear_ui",
        arguments: {},
      })
    ).success,
    true,
  );
  assert.equal(cleared, 1);
});
