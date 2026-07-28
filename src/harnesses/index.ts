import { ClaudeHarness } from "./claude.js";
import { CodexHarness } from "./codex.js";
import { PiHarness } from "./pi.js";
import { builtinHarnessDefinitions, harnessesFromDefinitions } from "./registry.js";
import type { HarnessAdapter } from "../types.js";

export function defaultHarnesses(): ReadonlyMap<string, HarnessAdapter> {
  return harnessesFromDefinitions(builtinHarnessDefinitions());
}

export { ClaudeHarness } from "./claude.js";
export { CodexHarness } from "./codex.js";
export { PiHarness } from "./pi.js";
