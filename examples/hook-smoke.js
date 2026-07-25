export const meta = {
  name: "hook-smoke",
  description: "Prove Jaeger lifecycle hook delivery with one short provider session",
  phases: [
    { title: "Project", detail: "Return one bounded proof summary" },
  ],
}

const PROOF = {
  type: "object",
  additionalProperties: false,
  required: ["summary"],
  properties: {
    summary: { type: "string", maxLength: 160 },
  },
}

phase("Project")
const proof = await agent(
  "Return JSON only with the summary `Jaeger lifecycle hook smoke passed`.",
  {
    label: "hook smoke",
    harness: "codex",
    effort: "low",
    schema: PROOF,
  },
)

return {
  status: "clean",
  summary: proof.summary,
}
