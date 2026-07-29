import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { satisfies } from "semver";
import {
  addModules,
  diffModule,
  listInstalledModules,
  removeModules,
  resolveModuleItem,
  syncModules,
} from "../src/module-registry.js";

test("adds several source items to one runtime package and reconciles one dependency graph", async () => {
  const fixture = await registryFixture();
  try {
    await writeJson(path.join(fixture.runtimeRoot, "package.json"), {
      name: "operator-runtime",
      private: true,
      type: "module",
      dependencies: {
        "fixture-dependency": ">=1",
        "operator-only": "^9.0.0",
      },
    });
    const result = await addModules({
      root: fixture.runtimeRoot,
      references: [
        `${fixture.catalogPath}#alpha`,
        `${fixture.catalogPath}#beta`,
      ],
      install: false,
    });

    assert.deepEqual(result.modules, ["alpha", "beta"]);
    assert.equal(result.dependenciesInstalled, false);
    const packageJson = JSON.parse(
      await readFile(path.join(fixture.runtimeRoot, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    const applied = packageJson.dependencies["fixture-dependency"];
    assert.ok(applied);
    assert.equal(satisfies("2.5.0", applied), true);
    assert.equal(satisfies("3.5.0", applied), false);
    assert.equal(packageJson.dependencies["operator-only"], "^9.0.0");
    assert.equal(
      await readFile(
        path.join(fixture.runtimeRoot, "modules", "alpha", "alpha.mjs"),
        "utf8",
      ),
      "export const alpha = true\n",
    );
    await assert.rejects(
      readFile(path.join(fixture.runtimeRoot, "modules", "alpha", "package.json")),
      hasCode("ENOENT"),
    );

    const installed = await listInstalledModules(fixture.runtimeRoot);
    assert.deepEqual(installed.modules.map(({ name }) => name), ["alpha", "beta"]);
    assert.equal(
      installed.dependencies["fixture-dependency"]?.operatorRange,
      ">=1",
    );
    assert.deepEqual(
      installed.dependencies["fixture-dependency"]?.requestedBy,
      {
        alpha: ">=1 <4",
        beta: "^2.0.0",
      },
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a multi-module add invokes the shared package manager exactly once", async () => {
  const fixture = await registryFixture();
  try {
    const bin = path.join(fixture.root, "bin");
    const calls = path.join(fixture.root, "package-manager-calls.txt");
    await mkdir(bin);
    const npm = path.join(bin, "npm");
    await writeFile(
      npm,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\n`,
    );
    await chmod(npm, 0o755);

    const result = await addModules({
      root: fixture.runtimeRoot,
      references: [
        `${fixture.catalogPath}#alpha`,
        `${fixture.catalogPath}#beta`,
      ],
      env: {
        ...process.env,
        PATH: bin,
      },
    });
    assert.equal(result.dependenciesInstalled, true);
    const invocations = (await readFile(calls, "utf8")).trim().split("\n");
    assert.deepEqual(invocations, [
      "install --ignore-scripts --no-audit --no-fund",
    ]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Yarn Modern installs dependencies with build scripts disabled", async () => {
  const fixture = await registryFixture();
  try {
    const bin = path.join(fixture.root, "bin");
    const calls = path.join(fixture.root, "package-manager-calls.txt");
    await mkdir(bin);
    await writeFile(path.join(fixture.runtimeRoot, ".yarnrc.yml"), "nodeLinker: node-modules\n");
    const yarn = path.join(bin, "yarn");
    await writeFile(
      yarn,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\n`,
    );
    await chmod(yarn, 0o755);

    const result = await addModules({
      root: fixture.runtimeRoot,
      references: [`${fixture.catalogPath}#alpha`],
      env: {
        ...process.env,
        PATH: bin,
      },
    });

    assert.equal(result.packageManager, "yarn");
    assert.equal((await readFile(calls, "utf8")).trim(), "install --mode=skip-build");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("serializes concurrent module additions without losing lock state", async () => {
  const fixture = await registryFixture();
  try {
    await Promise.all([
      addModules({
        root: fixture.runtimeRoot,
        references: [`${fixture.catalogPath}#alpha`],
        install: false,
      }),
      addModules({
        root: fixture.runtimeRoot,
        references: [`${fixture.catalogPath}#beta`],
        install: false,
      }),
    ]);

    const installed = await listInstalledModules(fixture.runtimeRoot);
    assert.deepEqual(installed.modules.map(({ name }) => name), ["alpha", "beta"]);
    assert.deepEqual(
      installed.dependencies["fixture-dependency"]?.requestedBy,
      {
        alpha: ">=1 <4",
        beta: "^2.0.0",
      },
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("recovers a module mutation lock whose owner process exited", async () => {
  const fixture = await registryFixture();
  try {
    const lockPath = path.join(fixture.runtimeRoot, ".modules-mutation.lock");
    await mkdir(lockPath);
    await writeJson(path.join(lockPath, "owner.json"), {
      pid: process.pid,
      processStartId: "0",
      token: "a".repeat(32),
    });

    await addModules({
      root: fixture.runtimeRoot,
      references: [`${fixture.catalogPath}#alpha`],
      install: false,
    });

    assert.deepEqual(
      (await listInstalledModules(fixture.runtimeRoot)).modules.map(({ name }) => name),
      ["alpha"],
    );
    await assert.rejects(readFile(lockPath), hasCode("ENOENT"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("fails closed on conflicting module dependency requirements before writing the project", async () => {
  const fixture = await registryFixture({
    betaDependencies: { "fixture-dependency": "^5.0.0" },
  });
  try {
    await assert.rejects(
      addModules({
        root: fixture.runtimeRoot,
        references: [
          `${fixture.catalogPath}#alpha`,
          `${fixture.catalogPath}#beta`,
        ],
        install: false,
      }),
      /incompatible requirements/,
    );
    await assert.rejects(
      readFile(path.join(fixture.runtimeRoot, "package.json")),
      hasCode("ENOENT"),
    );
    await assert.rejects(
      readFile(path.join(fixture.runtimeRoot, "modules", "alpha", "alpha.mjs")),
      hasCode("ENOENT"),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("diff protects local source edits and removal restores operator dependency ownership", async () => {
  const fixture = await registryFixture();
  try {
    await writeJson(path.join(fixture.runtimeRoot, "package.json"), {
      name: "operator-runtime",
      private: true,
      type: "module",
      dependencies: {
        "fixture-dependency": ">=1",
      },
    });
    await addModules({
      root: fixture.runtimeRoot,
      references: [`${fixture.catalogPath}#alpha`],
      install: false,
    });
    const moduleRoot = path.join(fixture.runtimeRoot, "modules", "alpha");
    await writeFile(path.join(moduleRoot, "alpha.mjs"), "export const alpha = false\n");
    await writeFile(path.join(moduleRoot, "operator-note.txt"), "keep me\n");

    const diff = await diffModule(fixture.runtimeRoot, "alpha");
    assert.equal(diff.clean, false);
    assert.deepEqual(diff.modified, ["alpha.mjs"]);
    assert.deepEqual(diff.added, ["operator-note.txt"]);
    await assert.rejects(
      removeModules({
        root: fixture.runtimeRoot,
        names: ["alpha"],
        install: false,
      }),
      /local changes/,
    );

    await removeModules({
      root: fixture.runtimeRoot,
      names: ["alpha"],
      install: false,
      force: true,
    });
    const packageJson = JSON.parse(
      await readFile(path.join(fixture.runtimeRoot, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    assert.deepEqual(packageJson.dependencies, {
      "fixture-dependency": ">=1",
    });
    assert.deepEqual((await listInstalledModules(fixture.runtimeRoot)).modules, []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("removal refuses a module still referenced by the runtime composition", async () => {
  const fixture = await registryFixture();
  try {
    await addModules({
      root: fixture.runtimeRoot,
      references: [`${fixture.catalogPath}#alpha`],
      install: false,
    });
    await writeFile(
      path.join(fixture.runtimeRoot, "jaeger.runtime.mjs"),
      'import "./modules/alpha/alpha.mjs"\nexport default { version: 1, modules: [] }\n',
    );
    await assert.rejects(
      removeModules({
        root: fixture.runtimeRoot,
        names: ["alpha"],
        install: false,
      }),
      /referenced by jaeger\.runtime\.mjs/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("sync adopts an operator dependency edit without losing module requirements", async () => {
  const fixture = await registryFixture();
  try {
    await addModules({
      root: fixture.runtimeRoot,
      references: [`${fixture.catalogPath}#alpha`],
      install: false,
    });
    const packagePath = path.join(fixture.runtimeRoot, "package.json");
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
      dependencies: Record<string, string>;
    };
    packageJson.dependencies["fixture-dependency"] = ">=2 <5";
    await writeJson(packagePath, packageJson);

    await syncModules({ root: fixture.runtimeRoot, install: false });
    const syncedPackage = JSON.parse(await readFile(packagePath, "utf8")) as {
      dependencies: Record<string, string>;
    };
    const applied = syncedPackage.dependencies["fixture-dependency"];
    assert.ok(applied);
    assert.equal(satisfies("2.5.0", applied), true);
    assert.equal(satisfies("4.5.0", applied), false);
    assert.equal(
      (await listInstalledModules(fixture.runtimeRoot)).dependencies[
        "fixture-dependency"
      ]?.operatorRange,
      ">=2 <5",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects module file traversal before reading source bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-registry-traversal-"));
  try {
    const manifest = path.join(root, "jaeger.module.json");
    await writeJson(manifest, {
      schemaVersion: 1,
      name: "escape",
      files: ["../secret"],
      dependencies: {},
    });
    await assert.rejects(resolveModuleItem(manifest), /escapes or is not normalized/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a local module source below a symlinked directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-registry-source-link-"));
  try {
    const source = path.join(root, "source");
    const outside = path.join(root, "outside");
    await Promise.all([mkdir(source), mkdir(outside)]);
    await writeFile(path.join(outside, "secret.mjs"), "export const secret = true\n");
    await symlink(outside, path.join(source, "linked"));
    const manifest = path.join(source, "jaeger.module.json");
    await writeJson(manifest, {
      schemaVersion: 1,
      name: "escape",
      files: ["linked/secret.mjs"],
      dependencies: {},
    });

    await assert.rejects(resolveModuleItem(manifest), /path contains a symlink/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an HTTPS module source redirect to HTTP", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://registry.example/jaeger.module.json") {
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          name: "redirect",
          files: ["source.mjs"],
          dependencies: {},
        }),
        { status: 200 },
      );
    }
    if (url === "https://registry.example/source.mjs") {
      return new Response(null, {
        status: 302,
        headers: { location: "http://registry.example/source.mjs" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  try {
    await assert.rejects(
      resolveModuleItem("https://registry.example/jaeger.module.json"),
      /Remote module sources require HTTPS: http:\/\/registry\.example\/source\.mjs/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stops reading an oversized streamed HTTPS module source", async () => {
  const originalFetch = globalThis.fetch;
  let sourceChunks = 0;
  let sourceCancelled = false;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://registry.example/jaeger.module.json") {
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          name: "oversized",
          files: ["source.mjs"],
          dependencies: {},
        }),
        { status: 200 },
      );
    }
    if (url === "https://registry.example/source.mjs") {
      return new Response(
        new ReadableStream({
          pull(controller) {
            sourceChunks += 1;
            controller.enqueue(new Uint8Array(1024 * 1024));
          },
          cancel() {
            sourceCancelled = true;
          },
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  try {
    await assert.rejects(
      resolveModuleItem("https://registry.example/jaeger.module.json"),
      /Remote module source is too large/,
    );
    assert.equal(sourceCancelled, true);
    assert.ok(sourceChunks <= 7);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refuses a symlinked destination module tree", async () => {
  const fixture = await registryFixture();
  try {
    const outside = path.join(fixture.root, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(fixture.runtimeRoot, "modules"));
    await assert.rejects(
      addModules({
        root: fixture.runtimeRoot,
        references: [`${fixture.catalogPath}#alpha`],
        install: false,
      }),
      /unsafe path/,
    );
    await assert.rejects(
      readFile(path.join(outside, "alpha", "alpha.mjs")),
      hasCode("ENOENT"),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

interface RegistryFixture {
  readonly root: string;
  readonly runtimeRoot: string;
  readonly catalogPath: string;
}

async function registryFixture(
  options: {
    readonly betaDependencies?: Readonly<Record<string, string>>;
  } = {},
): Promise<RegistryFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-registry-"));
  const sourceRoot = path.join(root, "source");
  const runtimeRoot = path.join(root, "runtime");
  await Promise.all([
    mkdir(path.join(sourceRoot, "alpha"), { recursive: true }),
    mkdir(path.join(sourceRoot, "beta"), { recursive: true }),
    mkdir(runtimeRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(sourceRoot, "alpha", "alpha.mjs"), "export const alpha = true\n"),
    writeFile(path.join(sourceRoot, "beta", "beta.mjs"), "export const beta = true\n"),
    writeJson(path.join(sourceRoot, "alpha", "jaeger.module.json"), {
      schemaVersion: 1,
      name: "alpha",
      files: ["alpha.mjs"],
      dependencies: {
        "fixture-dependency": ">=1 <4",
      },
    }),
    writeJson(path.join(sourceRoot, "beta", "jaeger.module.json"), {
      schemaVersion: 1,
      name: "beta",
      files: ["beta.mjs"],
      dependencies: options.betaDependencies ?? {
        "fixture-dependency": "^2.0.0",
      },
    }),
  ]);
  const catalogPath = path.join(sourceRoot, "jaeger.registry.json");
  await writeJson(catalogPath, {
    schemaVersion: 1,
    name: "fixture",
    items: [
      { name: "alpha", path: "alpha/jaeger.module.json" },
      { name: "beta", path: "beta/jaeger.module.json" },
    ],
  });
  return { root, runtimeRoot, catalogPath };
}

async function writeJson(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
}

function hasCode(expected: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === expected;
}
