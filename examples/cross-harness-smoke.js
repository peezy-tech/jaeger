export const meta = {
  name: "cross-harness-smoke",
  description: "Prove that one harness can consume the structured output of another",
  phases: [
    { title: "Codex", detail: "Inspect the project with Codex" },
    { title: "Claude", detail: "Verify Codex's result with Claude Code" },
  ],
}

const INSPECTION = {
  type: "object",
  additionalProperties: false,
  required: ["harness", "packageName"],
  properties: {
    harness: { type: "string" },
    packageName: { type: "string" },
  },
}

const VERIFICATION = {
  type: "object",
  additionalProperties: false,
  required: ["harness", "packageName", "matchesPrior"],
  properties: {
    harness: { type: "string" },
    packageName: { type: "string" },
    matchesPrior: { type: "boolean" },
  },
}

const cwd = inputs.cwd || "."

phase("Codex")
const inspection = await agent("Read package.json without modifying anything. Return the package name and identify your harness as codex.", {
  label: "codex inspection",
  harness: "codex",
  model: inputs.codexModel,
  effort: inputs.codexEffort || "low",
  serviceTier: inputs.codexServiceTier,
  cwd,
  schema: INSPECTION,
})

phase("Claude")
const verification = await agent(`Read package.json without modifying anything. Verify the prior result below, identify your harness as claude, and report whether its packageName matches yours.\n\nPrior result: ${JSON.stringify(inspection)}`, {
  label: "claude verification",
  harness: "claude",
  model: inputs.claudeModel,
  effort: inputs.claudeEffort || "low",
  cwd,
  schema: VERIFICATION,
})

return { inspection, verification }
