import { rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const allowedTargets = new Map([
  ["dist", path.join(root, "dist")],
  [".test-dist", path.join(root, ".test-dist")],
])

const targets = process.argv.slice(2)
if (targets.length === 0) throw new Error("Specify at least one build directory to clean")

for (const target of targets) {
  const resolved = allowedTargets.get(target)
  if (!resolved) throw new Error(`Refusing to clean unsupported path: ${target}`)
  await rm(resolved, { recursive: true, force: true })
}
