export const meta = {
  name: "mixed-review",
  description: "Review one workspace with two different harnesses, then synthesize the findings",
  phases: [
    { title: "Review", detail: "Codex and Claude inspect the same change independently" },
    { title: "Synthesize", detail: "A selected harness reconciles their structured findings" },
  ],
}

const FINDINGS = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "summary", "evidence"],
        properties: {
          severity: { type: "string", enum: ["high", "medium", "low"] },
          summary: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
  },
}

const SYNTHESIS = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "findings"],
  properties: {
    verdict: { type: "string", enum: ["clean", "changes_requested", "blocked"] },
    findings: FINDINGS.properties.findings,
  },
}

const target = inputs.target || "Review the current working-tree diff against HEAD."
const cwd = inputs.cwd || "."

phase("Review")
const reviews = await parallel([
  () => agent(`${target}\nDo not modify files. Return only concrete defects with evidence.`, {
    label: "codex review",
    harness: "codex",
    model: inputs.codexModel,
    effort: inputs.codexEffort,
    cwd,
    schema: FINDINGS,
  }),
  () => agent(`${target}\nDo not modify files. Return only concrete defects with evidence.`, {
    label: "claude review",
    harness: "claude",
    model: inputs.claudeModel,
    effort: inputs.claudeEffort,
    cwd,
    schema: FINDINGS,
  }),
])

phase("Synthesize")
const result = await agent(`Adversarially reconcile these two independent reviews. Refute duplicates and unsupported claims. Return only the structured verdict.\n\n${JSON.stringify(reviews)}`, {
  label: "synthesis",
  harness: inputs.synthesisHarness || "codex",
  model: inputs.synthesisModel,
  effort: inputs.synthesisEffort,
  cwd,
  schema: SYNTHESIS,
})

return result
