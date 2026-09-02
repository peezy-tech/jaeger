const ID_PATTERN = /^[a-z][a-z0-9_-]{0,47}$/;
const MAX_COMPONENTS = 8;
const MAX_OPTIONS = 6;
const MAX_STATS = 6;
const MAX_LIST_ITEMS = 8;
const MAX_TEXT = 720;
const MAX_LABEL = 120;

const textProperty = (description) => ({
  type: "string",
  description,
});

const nullableTextProperty = (description) => ({
  type: ["string", "null"],
  description,
});

const componentSchemas = [
  {
    type: "object",
    required: ["type", "title", "body"],
    properties: {
      type: { const: "text" },
      kicker: nullableTextProperty("Optional short context label."),
      title: textProperty("A concise section heading."),
      body: textProperty("A concise explanation or answer."),
    },
    additionalProperties: false,
  },
  {
    type: "object",
    required: ["type", "items"],
    properties: {
      type: { const: "stats" },
      items: {
        type: "array",
        maxItems: MAX_STATS,
        items: {
          type: "object",
          required: ["label", "value"],
          properties: {
            label: textProperty("Short stat label."),
            value: textProperty("Formatted stat value."),
            detail: nullableTextProperty("Optional supporting detail."),
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  {
    type: "object",
    required: ["type", "title", "items"],
    properties: {
      type: { const: "list" },
      title: textProperty("List heading."),
      items: {
        type: "array",
        maxItems: MAX_LIST_ITEMS,
        items: textProperty("One concise list item."),
      },
    },
    additionalProperties: false,
  },
  {
    type: "object",
    required: ["type", "label", "body"],
    properties: {
      type: { const: "callout" },
      label: textProperty("Short callout label."),
      body: textProperty("Callout content."),
      tone: { enum: ["neutral", "good", "warning"] },
    },
    additionalProperties: false,
  },
  {
    type: "object",
    required: ["type", "title", "options"],
    properties: {
      type: { const: "choices" },
      title: textProperty("Choice heading."),
      description: nullableTextProperty("Why a choice is useful."),
      options: {
        type: "array",
        minItems: 2,
        maxItems: MAX_OPTIONS,
        items: {
          type: "object",
          required: ["id", "label"],
          properties: {
            id: {
              type: "string",
              pattern: ID_PATTERN.source,
              description: "Stable lowercase option ID.",
            },
            label: textProperty("Button label."),
            description: nullableTextProperty("One-line option explanation."),
            detail: nullableTextProperty("Short supporting metadata."),
            value: nullableTextProperty(
              "Value returned to the conversation; defaults to the label.",
            ),
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
];

const UI_TOOL_CATALOG = [
  {
    type: "function",
    name: "generate_ui",
    description:
      "Generate a fresh, phone-first interface in the caller's browser. Use it only when a visual would materially help the conversation, such as explaining information, comparing items, showing a short list, or offering bounded choices. A new interface replaces the previous one.",
    inputSchema: {
      type: "object",
      required: ["id", "title", "components"],
      properties: {
        id: {
          type: "string",
          pattern: ID_PATTERN.source,
          description: "Stable ID for this generated interface.",
        },
        kicker: nullableTextProperty("Optional short context label."),
        title: textProperty("Primary interface heading."),
        subtitle: nullableTextProperty("One concise supporting sentence."),
        tone: {
          enum: ["neutral", "accent", "positive", "caution"],
          description: "Overall visual tone; defaults to neutral.",
        },
        components: {
          type: "array",
          minItems: 1,
          maxItems: MAX_COMPONENTS,
          items: { oneOf: componentSchemas },
        },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "clear_ui",
    description:
      "Remove the generated interface and return the caller to the empty listening canvas.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

export const UI_TOOLS = ["generate_ui", "clear_ui"].map((name) =>
  UI_TOOL_CATALOG.find((tool) => tool.name === name),
);

export function createUiRequestHandlers({ publish, clear } = {}) {
  if (typeof publish !== "function" || typeof clear !== "function") {
    throw new TypeError("UI publish and clear handlers are required");
  }

  return {
    "item/tool/call": async (params) => {
      if (params.namespace != null) {
        return rejected("Namespaced tools are unavailable");
      }
      try {
        if (params.tool === "generate_ui") {
          const ui = normalizeGeneratedUi(params.arguments);
          await publish(ui, params);
          return accepted(
            "Generated " +
              JSON.stringify(ui.title) +
              " with " +
              ui.actions.length +
              " interactive choice" +
              (ui.actions.length === 1 ? "" : "s") +
              ".",
          );
        }
        if (params.tool === "clear_ui") {
          if (
            !isRecord(params.arguments) ||
            Object.keys(params.arguments).length > 0
          ) {
            return rejected("clear_ui does not accept arguments");
          }
          await clear(params);
          return accepted("Cleared the generated interface.");
        }
        return null;
      } catch (error) {
        return rejected(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function normalizeGeneratedUi(value) {
  if (!isRecord(value)) {
    throw invalid("generate_ui requires an object");
  }
  const id = String(value.id ?? "").trim();
  const title = compactText(value.title, MAX_LABEL);
  if (!ID_PATTERN.test(id)) {
    throw invalid("The UI id is invalid");
  }
  if (!title) {
    throw invalid("The UI title is required");
  }
  if (!Array.isArray(value.components) || value.components.length === 0) {
    throw invalid("At least one UI component is required");
  }
  if (value.components.length > MAX_COMPONENTS) {
    throw invalid("A UI can contain at most " + MAX_COMPONENTS + " components");
  }

  const components = value.components.map((component, index) =>
    normalizeComponent(component, index),
  );
  const optionIds = new Set();
  const actions = [];
  for (const component of components) {
    if (component.type !== "choices") continue;
    for (const option of component.options) {
      if (optionIds.has(option.id)) {
        throw invalid("Duplicate option id: " + option.id);
      }
      optionIds.add(option.id);
      actions.push({
        id: option.id,
        label: option.label,
        value: option.value ?? option.label,
      });
    }
  }

  const normalized = {
    id,
    title,
    kicker: compactText(value.kicker, MAX_LABEL) || null,
    subtitle: compactText(value.subtitle, MAX_TEXT) || null,
    tone: ["neutral", "accent", "positive", "caution"].includes(value.tone)
      ? value.tone
      : "neutral",
    components,
    actions,
    renderedAt: new Date().toISOString(),
  };
  return { ...normalized, spec: generatedUiSpec(normalized) };
}

export function generatedUiSpec(ui) {
  const elements = {
    "generated-root": {
      type: "GeneratedCanvas",
      props: {
        kicker: ui.kicker,
        title: ui.title,
        subtitle: ui.subtitle,
        tone: ui.tone,
      },
      children: [],
    },
  };

  ui.components.forEach((component, index) => {
    const key = "generated-" + index;
    elements["generated-root"].children.push(key);
    if (component.type === "choices") {
      const optionKeys = component.options.map(
        (option) => key + "-" + option.id,
      );
      elements[key] = {
        type: "GeneratedChoiceGroup",
        props: {
          title: component.title,
          description: component.description,
        },
        children: optionKeys,
      };
      component.options.forEach((option, optionIndex) => {
        elements[optionKeys[optionIndex]] = {
          type: "GeneratedChoiceButton",
          props: {
            optionId: option.id,
            label: option.label,
            description: option.description,
            detail: option.detail,
          },
          on: {
            press: {
              action: "generatedRespond",
              params: { uiId: ui.id, actionId: option.id },
            },
          },
          children: [],
        };
      });
      return;
    }

    const componentNames = {
      stats: "GeneratedStats",
      text: "GeneratedText",
      list: "GeneratedList",
      callout: "GeneratedCallout",
    };
    elements[key] = {
      type: componentNames[component.type],
      props: { ...component },
      children: [],
    };
    delete elements[key].props.type;
  });

  return { root: "generated-root", elements };
}

function normalizeComponent(value, index) {
  if (!isRecord(value)) {
    throw invalid("Component " + (index + 1) + " must be an object");
  }
  if (value.type === "stats") {
    if (!Array.isArray(value.items) || value.items.length === 0) {
      throw invalid("Stats require at least one item");
    }
    return {
      type: "stats",
      items: value.items.slice(0, MAX_STATS).map((item) => ({
        label: requiredText(item?.label, "Stat label", MAX_LABEL),
        value: requiredText(item?.value, "Stat value", MAX_LABEL),
        detail: compactText(item?.detail, MAX_TEXT) || null,
      })),
    };
  }
  if (value.type === "text") {
    return {
      type: "text",
      kicker: compactText(value.kicker, MAX_LABEL) || null,
      title: requiredText(value.title, "Text title", MAX_LABEL),
      body: requiredText(value.body, "Text body", MAX_TEXT),
    };
  }
  if (value.type === "list") {
    if (!Array.isArray(value.items) || value.items.length === 0) {
      throw invalid("A list requires at least one item");
    }
    return {
      type: "list",
      title: requiredText(value.title, "List title", MAX_LABEL),
      items: value.items
        .slice(0, MAX_LIST_ITEMS)
        .map((item, itemIndex) =>
          requiredText(item, "List item " + (itemIndex + 1), MAX_TEXT),
        ),
    };
  }
  if (value.type === "callout") {
    return {
      type: "callout",
      label: requiredText(value.label, "Callout label", MAX_LABEL),
      body: requiredText(value.body, "Callout body", MAX_TEXT),
      tone: ["neutral", "good", "warning"].includes(value.tone)
        ? value.tone
        : "neutral",
    };
  }
  if (value.type === "choices") {
    if (!Array.isArray(value.options) || value.options.length < 2) {
      throw invalid("Choices require at least two options");
    }
    return {
      type: "choices",
      title: requiredText(value.title, "Choice title", MAX_LABEL),
      description: compactText(value.description, MAX_TEXT) || null,
      options: value.options.slice(0, MAX_OPTIONS).map((option, optionIndex) => {
        const id = String(option?.id ?? "").trim();
        if (!ID_PATTERN.test(id)) {
          throw invalid("Choice " + (optionIndex + 1) + " has an invalid id");
        }
        return {
          id,
          label: requiredText(
            option?.label,
            "Choice " + (optionIndex + 1) + " label",
            MAX_LABEL,
          ),
          description: compactText(option?.description, MAX_TEXT) || null,
          detail: compactText(option?.detail, MAX_LABEL) || null,
          value: compactText(option?.value, MAX_TEXT) || null,
        };
      }),
    };
  }
  throw invalid("Unsupported component type");
}

function requiredText(value, label, limit) {
  const result = compactText(value, limit);
  if (!result) throw invalid(label + " is required");
  return result;
}

function compactText(value, limit) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function accepted(text) {
  return {
    success: true,
    contentItems: [{ type: "inputText", text }],
  };
}

function rejected(message) {
  return {
    success: false,
    contentItems: [{ type: "inputText", text: message }],
  };
}
