import assert from "node:assert/strict"
import { copyFile, mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
const expectedVersion = packageJson.devDependencies?.["@anthropic-ai/claude-agent-sdk"]
assert.equal(
  typeof expectedVersion,
  "string",
  "@anthropic-ai/claude-agent-sdk must be pinned as a development dependency",
)

const source = path.join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk")
const sourcePackage = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"))
assert.equal(
  sourcePackage.version,
  expectedVersion,
  "installed Claude Agent SDK does not match the pinned development dependency",
)

const destination = path.join(root, "dist", "vendor", "claude-agent-sdk")
await mkdir(destination, { recursive: true })
for (const file of ["LICENSE.md", "README.md", "package.json", "sdk.mjs"]) {
  await copyFile(path.join(source, file), path.join(destination, file))
}
