import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const MAX_DIRECTORY_ENTRIES = 64;
const MAX_INTERACTABLES = 4;

export async function discoverFolderSurface(
  cwd,
  { readDirectory = readdir, readFileImpl = readFile } = {},
) {
  const path = resolve(cwd || process.cwd());
  const entries = await readFolderEntries(path, readDirectory);
  const names = new Set(entries.map((entry) => entry.name));
  const packageInfo = await readPackageInfo(path, names, readFileImpl);
  const interactables = deriveInteractables(names);

  return {
    path,
    name: basename(path) || path,
    entries,
    package: packageInfo,
    interactables,
  };
}

export function createWelcomePrompts(surface) {
  const folderFacts = JSON.stringify(surface, null, 2);
  const optionFacts = JSON.stringify(surface.interactables, null, 2);

  return {
    speech: [
      "A caller has just connected to the voice channel.",
      `Greet them briefly and say exactly that you are working in the folder ${JSON.stringify(surface.path)}.`,
      "Tell them you found a few starting points based on that folder and invite them to choose one on screen or speak naturally.",
      "Do not claim that the interface is already visible; the backend is generating it separately.",
      "Keep this spoken welcome under 45 words.",
    ].join("\n"),
    ui: [
      "The caller has just connected. Generate the first bounded welcome interface now.",
      "Use generate_ui exactly once; do not merely describe the interface.",
      "The options below were discovered from the operator's current folder. Use them as the complete choices list without inventing or removing options.",
      `Folder facts:\n${folderFacts}`,
      `Choice definitions:\n${optionFacts}`,
      "Use interface id `folder-welcome`, a concise title asking where to start, and a subtitle that includes the exact working folder path.",
      "Include one short text component explaining that the choices are read-only starting points, followed by one choices component using the supplied IDs, labels, descriptions, and values exactly.",
      "This is a non-binding welcome surface. Do not claim that any folder action has already happened.",
    ].join("\n"),
  };
}

async function readFolderEntries(path, readDirectory) {
  try {
    const directoryEntries = await readDirectory(path, { withFileTypes: true });
    return directoryEntries
      .filter(
        (entry) =>
          !entry.name.startsWith(".") || entry.name === ".git",
      )
      .slice(0, MAX_DIRECTORY_ENTRIES)
      .map((entry) => ({
        name: entry.name,
        type: entry.isDirectory()
          ? "directory"
          : entry.isFile()
            ? "file"
            : "other",
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

async function readPackageInfo(path, names, readFileImpl) {
  if (!names.has("package.json")) return null;
  try {
    const packageJson = JSON.parse(
      await readFileImpl(join(path, "package.json"), "utf8"),
    );
    return {
      name: typeof packageJson.name === "string" ? packageJson.name : null,
      scripts:
        packageJson.scripts && typeof packageJson.scripts === "object"
          ? Object.keys(packageJson.scripts).slice(0, 16)
          : [],
    };
  } catch {
    return null;
  }
}

function deriveInteractables(names) {
  const discovered = [];
  if (names.has("package.json")) {
    discovered.push({
      id: "project-commands",
      label: "Inspect project commands",
      description: "Review the available package scripts.",
      value: "What commands or scripts are available in this project?",
    });
  }
  if (names.has("README.md") || names.has("README")) {
    discovered.push({
      id: "project-overview",
      label: "Explain this project",
      description: "Get a concise orientation to the folder.",
      value: "Explain what this project is for and how its top-level pieces fit together.",
    });
  }
  if (names.has("docs") || names.has("documentation")) {
    discovered.push({
      id: "documentation",
      label: "Explore documentation",
      description: "Start from the folder's documentation surface.",
      value: "What documentation should I start with in this folder?",
    });
  }
  if (names.has("test") || names.has("tests")) {
    discovered.push({
      id: "tests",
      label: "Review the tests",
      description: "Understand how this folder verifies behavior.",
      value: "What do the tests in this folder cover?",
    });
  }
  if (
    ["src", "app", "lib", "examples", "modules"].some((name) =>
      names.has(name),
    )
  ) {
    discovered.push({
      id: "source-layout",
      label: "Explore the source",
      description: "Get oriented to the implementation layout.",
      value: "Give me a read-only overview of the source layout in this folder.",
    });
  }
  if (names.has("jaeger.module.json")) {
    discovered.push({
      id: "module-manifest",
      label: "Inspect the module",
      description: "Review this folder's runtime module surface.",
      value: "Explain the runtime module described by this folder.",
    });
  }

  const selected = discovered.slice(0, MAX_INTERACTABLES - 1);
  if (selected.length === 0) {
    selected.push({
      id: "folder-overview",
      label: "Map this folder",
      description: "See the small read-only surface discovered here.",
      value: "Give me a read-only overview of this folder's discovered surface.",
    });
  }
  selected.push({
    id: "open-question",
    label: "Ask a question",
    description: "Speak naturally about whatever you need.",
    value: "I have a question about this folder.",
  });
  return selected;
}
