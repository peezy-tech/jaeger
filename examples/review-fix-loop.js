export const meta = {
  name: "review-fix-loop",
  description: "Pass structured review findings between independently configured harnesses",
  phases: [
    { title: "Review", detail: "Launch an independent reviewer" },
    { title: "Fix", detail: "Give concrete findings to an editing agent" },
  ],
}

const REVIEW = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings"],
  properties: {
    verdict: { type: "string", enum: ["clean", "changes_requested", "blocked"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "summary", "evidence"],
        properties: {
          file: { type: "string" },
          summary: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
  },
}

const FIX = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "validation"],
  properties: {
    status: { type: "string", enum: ["fixed", "blocked"] },
    summary: { type: "string" },
    validation: { type: "array", items: { type: "string" } },
  },
}

const cwd = inputs.cwd || "."
const maxRounds = Math.max(1, Math.min(Number(inputs.maxRounds || 3), 5))

for (let round = 1; round <= maxRounds; round++) {
  phase(`Review ${round}`)
  const review = await agent("Review the current working-tree change. Do not modify files. Report only concrete actionable defects and return the requested structure.", {
    label: `review ${round}`,
    harness: inputs.reviewerHarness || "codex",
    model: inputs.reviewerModel,
    effort: inputs.reviewerEffort,
    cwd,
    schema: REVIEW,
  })

  if (review.verdict === "clean" || review.verdict === "blocked") return review

  phase(`Fix ${round}`)
  const fix = await agent(`Address every actionable finding below in the working tree, run focused validation, and return the requested structure. Do not hide or reinterpret findings.\n\n${JSON.stringify(review.findings)}`, {
    label: `fix ${round}`,
    harness: inputs.fixerHarness || "claude",
    model: inputs.fixerModel,
    effort: inputs.fixerEffort,
    cwd,
    schema: FIX,
  })

  if (fix.status === "blocked") return fix
  log(`Round ${round}: ${fix.summary}`)
}

return { status: "exhausted", summary: `Review still had findings after ${maxRounds} rounds` }
