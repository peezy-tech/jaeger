export const meta = {
  name: "backend-smoke",
  description: "Exercise the persistent runtime without launching a provider session",
  phases: [{ title: "Verify", detail: "Write and return a deterministic result" }],
}

phase("Verify")
log("persistent backend worker is running")

return {
  backend: "ok",
  cwd: inputs.cwd || null,
}
