import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import {
  ActionProvider,
  Renderer,
  StateProvider,
  VisibilityProvider,
  defineRegistry,
} from "@json-render/react";
import { z } from "zod";

const statSchema = z.object({
  label: z.string(),
  value: z.string(),
  detail: z.string().nullable(),
});

const catalog = defineCatalog(schema, {
  components: {
    GeneratedCanvas: {
      props: z.object({
        kicker: z.string().nullable(),
        title: z.string(),
        subtitle: z.string().nullable(),
        tone: z.enum(["neutral", "accent", "positive", "caution"]),
      }),
      description: "The complete bounded interface generated for the call.",
    },
    GeneratedStats: {
      props: z.object({ items: z.array(statSchema) }),
      description: "A compact group of generated facts or measurements.",
    },
    GeneratedText: {
      props: z.object({
        kicker: z.string().nullable(),
        title: z.string(),
        body: z.string(),
      }),
      description: "A concise generated explanation.",
    },
    GeneratedList: {
      props: z.object({
        title: z.string(),
        items: z.array(z.string()),
      }),
      description: "A short generated list.",
    },
    GeneratedCallout: {
      props: z.object({
        label: z.string(),
        body: z.string(),
        tone: z.enum(["neutral", "good", "warning"]),
      }),
      description: "A highlighted generated note.",
    },
    GeneratedChoiceGroup: {
      props: z.object({
        title: z.string(),
        description: z.string().nullable(),
      }),
      description: "A generated set of bounded choices.",
    },
    GeneratedChoiceButton: {
      props: z.object({
        optionId: z.string(),
        label: z.string(),
        description: z.string().nullable(),
        detail: z.string().nullable(),
      }),
      description: "A server-resolved choice returned to the conversation.",
    },
  },
  actions: {
    generatedRespond: {
      params: z.object({
        uiId: z.string(),
        actionId: z.string(),
      }),
      description: "Return a generated on-screen choice to the live conversation.",
    },
  },
});

let generatedRespond = async () => undefined;

const { registry } = defineRegistry(catalog, {
  components: {
    GeneratedCanvas: ({ props, children }) => (
      <section
        className={"generated-canvas generated-tone-" + props.tone}
        aria-live="polite"
      >
        <header className="generated-heading">
          {props.kicker ? (
            <p className="generated-kicker">{props.kicker}</p>
          ) : null}
          <h2>{props.title}</h2>
          {props.subtitle ? <p>{props.subtitle}</p> : null}
        </header>
        <div className="generated-content">{children}</div>
      </section>
    ),
    GeneratedStats: ({ props }) => (
      <section className="generated-stats" aria-label="Summary">
        {props.items.map((item) => (
          <div key={item.label}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
            {item.detail ? <small>{item.detail}</small> : null}
          </div>
        ))}
      </section>
    ),
    GeneratedText: ({ props }) => (
      <section className="generated-text">
        {props.kicker ? <span>{props.kicker}</span> : null}
        <h3>{props.title}</h3>
        <p>{props.body}</p>
      </section>
    ),
    GeneratedList: ({ props }) => (
      <section className="generated-list">
        <h3>{props.title}</h3>
        <ol>
          {props.items.map((item, index) => (
            <li key={item}>
              <i>{String(index + 1).padStart(2, "0")}</i>
              <span>{item}</span>
            </li>
          ))}
        </ol>
      </section>
    ),
    GeneratedCallout: ({ props }) => (
      <aside className={"generated-callout callout-" + props.tone}>
        <strong>{props.label}</strong>
        <p>{props.body}</p>
      </aside>
    ),
    GeneratedChoiceGroup: ({ props, children }) => (
      <section className="generated-choices">
        <header>
          <p>Choose on screen</p>
          <h3>{props.title}</h3>
          {props.description ? <span>{props.description}</span> : null}
        </header>
        <div>{children}</div>
      </section>
    ),
    GeneratedChoiceButton: ({ props, emit }) => (
      <button
        className="generated-choice"
        type="button"
        onClick={() => emit("press")}
      >
        <span>
          <strong>{props.label}</strong>
          {props.description ? <small>{props.description}</small> : null}
        </span>
        {props.detail ? <b>{props.detail}</b> : null}
        <i aria-hidden="true">→</i>
      </button>
    ),
  },
  actions: {
    generatedRespond: async (params) => {
      await generatedRespond(params);
    },
  },
});

const actionHandlers = {
  generatedRespond: async (params) => {
    await generatedRespond(params);
  },
};

function WorkspaceApp() {
  const [generatedUi, setGeneratedUi] = useState(null);

  useEffect(() => {
    window.jaegerWorkspace = {
      update: () => {},
      renderGenerated: (nextUi) => setGeneratedUi(nextUi),
      clearGenerated: () => setGeneratedUi(null),
      setSession: () => {},
    };
    return () => {
      delete window.jaegerWorkspace;
    };
  }, []);

  useEffect(() => {
    document.body.dataset.generatedUi = generatedUi ? "active" : "empty";
    return () => {
      delete document.body.dataset.generatedUi;
    };
  }, [generatedUi]);

  generatedRespond = async (params) => {
    await window.jaegerVoice.respondToUi(params);
  };

  if (!generatedUi?.spec) return null;

  return (
    <StateProvider initialState={{}}>
      <VisibilityProvider>
        <ActionProvider handlers={actionHandlers}>
          <Renderer spec={generatedUi.spec} registry={registry} />
        </ActionProvider>
      </VisibilityProvider>
    </StateProvider>
  );
}

createRoot(document.querySelector("#generated-workspace")).render(<WorkspaceApp />);
