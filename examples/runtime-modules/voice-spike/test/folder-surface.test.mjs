import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  createWelcomePrompts,
  discoverFolderSurface,
} from "../folder-surface.mjs";

test("discovers bounded folder-specific welcome choices", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-folder-surface-"));
  try {
    await mkdir(join(directory, "docs"));
    await mkdir(join(directory, "tests"));
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: "folder-project",
        scripts: { test: "node --test", build: "node build.mjs" },
      }),
    );
    await writeFile(join(directory, "README.md"), "# Folder project\n");
    await writeFile(join(directory, ".env"), "PRIVATE=true\n");

    const surface = await discoverFolderSurface(directory);

    assert.equal(surface.name, basename(directory));
    assert.equal(surface.path, directory);
    assert.deepEqual(surface.package, {
      name: "folder-project",
      scripts: ["test", "build"],
    });
    assert.equal(surface.entries.some((entry) => entry.name === ".env"), false);
    assert.deepEqual(
      surface.interactables.map((choice) => choice.id),
      ["project-commands", "project-overview", "documentation", "open-question"],
    );

    const prompts = createWelcomePrompts(surface);
    assert.match(prompts.speech, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(prompts.ui, /project-commands/);
    assert.match(prompts.ui, /documentation/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps a useful fallback for an unmarked folder", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-folder-empty-"));
  try {
    const surface = await discoverFolderSurface(directory);
    assert.deepEqual(surface.interactables.map((choice) => choice.id), [
      "folder-overview",
      "open-question",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
