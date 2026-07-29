import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
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

test("rejects a filesystem root and preserves existing project directory permissions", async () => {
  const fixture = await registryFixture();
  try {
    await assert.rejects(
      addModules({
        root: path.parse(fixture.root).root,
        references: [`${fixture.catalogPath}#alpha`],
        dryRun: true,
      }),
      /must not be a filesystem root/,
    );

    await chmod(fixture.runtimeRoot, 0o755);
    await addModules({
      root: fixture.runtimeRoot,
      references: [`${fixture.catalogPath}#alpha`],
      install: false,
    });
    assert.equal((await stat(fixture.runtimeRoot)).mode & 0o777, 0o755);

    await syncModules({ root: fixture.runtimeRoot, install: false });
    assert.equal((await stat(fixture.runtimeRoot)).mode & 0o777, 0o755);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("failed dependency installs restore manifests and the installed dependency tree", async () => {
  for (const action of ["add", "remove", "sync"] as const) {
    const fixture = await registryFixture();
    try {
      await writeJson(path.join(fixture.runtimeRoot, "package.json"), {
        name: "operator-runtime",
        private: true,
        type: "module",
        dependencies: { "operator-only": "^9.0.0" },
      });
      if (action !== "add") {
        await addModules({
          root: fixture.runtimeRoot,
          references: [`${fixture.catalogPath}#alpha`],
          install: false,
        });
      }
      if (action === "sync") {
        const packagePath = path.join(fixture.runtimeRoot, "package.json");
        const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
          dependencies: Record<string, string>;
        };
        packageJson.dependencies["fixture-dependency"] = ">=2 <5";
        await writeJson(packagePath, packageJson);
      }

      const packagePath = path.join(fixture.runtimeRoot, "package.json");
      const shrinkwrapPath = path.join(fixture.runtimeRoot, "npm-shrinkwrap.json");
      const packageLockPath = path.join(fixture.runtimeRoot, "package-lock.json");
      const treeMarker = path.join(fixture.runtimeRoot, "node_modules", "graph.txt");
      await mkdir(path.dirname(treeMarker), { recursive: true });
      await writeFile(treeMarker, `old-${action}-tree\n`);
      await writeFile(shrinkwrapPath, `old-${action}-shrinkwrap\n`);
      await writeFile(packageLockPath, `old-${action}-lock\n`);
      const packageBefore = await readFile(packagePath);

      const bin = path.join(fixture.root, "bin");
      await mkdir(bin);
      const npm = path.join(bin, "npm");
      await writeFile(
        npm,
        "#!/bin/sh\n" +
          "/bin/mkdir -p node_modules\n" +
          `printf '%s\\n' ${JSON.stringify(`new-${action}-tree`)} > node_modules/graph.txt\n` +
          `printf '%s\\n' ${JSON.stringify(`new-${action}-shrinkwrap`)} > npm-shrinkwrap.json\n` +
          `printf '%s\\n' ${JSON.stringify(`new-${action}-lock`)} > package-lock.json\n` +
          "exit 17\n",
      );
      await chmod(npm, 0o755);
      const env = { ...process.env, PATH: bin };

      const operation =
        action === "add"
          ? addModules({
              root: fixture.runtimeRoot,
              references: [`${fixture.catalogPath}#alpha`],
              env,
            })
          : action === "remove"
            ? removeModules({
                root: fixture.runtimeRoot,
                names: ["alpha"],
                env,
              })
            : syncModules({ root: fixture.runtimeRoot, env });
      await assert.rejects(operation, /dependency installation failed/);

      assert.deepEqual(await readFile(packagePath), packageBefore);
      assert.equal(
        await readFile(shrinkwrapPath, "utf8"),
        `old-${action}-shrinkwrap\n`,
      );
      assert.equal(await readFile(packageLockPath, "utf8"), `old-${action}-lock\n`);
      assert.equal(await readFile(treeMarker, "utf8"), `old-${action}-tree\n`);
      const installedNames = (await listInstalledModules(fixture.runtimeRoot)).modules.map(
        ({ name }) => name,
      );
      assert.deepEqual(installedNames, action === "add" ? [] : ["alpha"]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("rejects Yarn Plug'n'Play runtime projects before installation", async () => {
  const fixture = await registryFixture();
  try {
    await writeFile(
      path.join(fixture.runtimeRoot, ".yarnrc.yml"),
      "nodeLinker: pnp\n",
    );
    const bin = path.join(fixture.root, "bin");
    await mkdir(bin);

    await assert.rejects(
      addModules({
        root: fixture.runtimeRoot,
        references: [`${fixture.catalogPath}#alpha`],
        env: { ...process.env, PATH: bin },
      }),
      /require nodeLinker: node-modules/,
    );
    await assert.rejects(
      readFile(path.join(fixture.runtimeRoot, "package.json")),
      hasCode("ENOENT"),
    );
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
    await mkdir(path.join(fixture.runtimeRoot, ".yarn/cache"), { recursive: true });
    await writeFile(
      path.join(fixture.runtimeRoot, ".yarn/cache/fixture.zip"),
      "old-cache\n",
    );
    const yarn = path.join(bin, "yarn");
    await writeFile(
      yarn,
      "#!/bin/sh\n" +
        "test -f .yarn/cache/fixture.zip || exit 18\n" +
        "printf 'new-cache\\n' > .yarn/cache/new.zip\n" +
        `printf '%s\\n' "$*" >> ${JSON.stringify(calls)}\n`,
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
    assert.equal(
      await readFile(path.join(fixture.runtimeRoot, ".yarn/cache/fixture.zip"), "utf8"),
      "old-cache\n",
    );
    assert.equal(
      await readFile(path.join(fixture.runtimeRoot, ".yarn/cache/new.zip"), "utf8"),
      "new-cache\n",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects symlinked Yarn state before moving dependency data", async () => {
  const fixture = await registryFixture();
  try {
    const outside = path.join(fixture.root, "outside-yarn");
    await mkdir(path.join(outside, "unplugged"), { recursive: true });
    await writeFile(path.join(outside, "unplugged", "operator.txt"), "keep\n");
    await symlink(outside, path.join(fixture.runtimeRoot, ".yarn"));

    await assert.rejects(
      addModules({
        root: fixture.runtimeRoot,
        references: [`${fixture.catalogPath}#alpha`],
        install: false,
      }),
      /unsafe path/,
    );
    assert.equal(
      await readFile(path.join(outside, "unplugged", "operator.txt"), "utf8"),
      "keep\n",
    );
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

test("rolls back an interrupted durable module transaction before the next mutation", async () => {
  const fixture = await registryFixture();
  try {
    await addModules({
      root: fixture.runtimeRoot,
      references: [`${fixture.catalogPath}#alpha`],
      install: false,
    });
    const packagePath = path.join(fixture.runtimeRoot, "package.json");
    const lockPath = path.join(fixture.runtimeRoot, "modules.lock.json");
    const packageBefore = await readFile(packagePath);
    const lockBefore = await readFile(lockPath);
    const staging = path.join(fixture.runtimeRoot, ".modules-stage-interrupted");
    const fileNames = [
      "package.json",
      "npm-shrinkwrap.json",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      ".pnp.cjs",
      ".pnp.loader.mjs",
      ".yarn/build-state.yml",
      ".yarn/install-state.gz",
      "modules.lock.json",
    ];
    await mkdir(path.join(staging, "package-files"), { recursive: true });
    const files = [];
    for (const [index, name] of fileNames.entries()) {
      const target = path.join(fixture.runtimeRoot, name);
      try {
        const contents = await readFile(target);
        await writeFile(
          path.join(staging, "package-files", String(index)),
          contents,
        );
        files.push({ name, existed: true, mode: 0o600 });
      } catch (error) {
        if (!hasCode("ENOENT")(error)) throw error;
        files.push({ name, existed: false });
      }
    }
    await writeJson(path.join(staging, "transaction.json"), {
      schemaVersion: 1,
      phase: "active",
      action: "add",
      modules: [{ name: "beta", existed: false }],
      files,
      directories: [],
    });

    await writeFile(packagePath, '{"private":false}\n');
    await writeFile(lockPath, '{"invalid":"interrupted"}\n');
    const interruptedModule = path.join(
      fixture.runtimeRoot,
      "modules",
      "beta",
    );
    await mkdir(interruptedModule, { recursive: true });
    await writeFile(path.join(interruptedModule, "beta.mjs"), "partial\n");

    await syncModules({ root: fixture.runtimeRoot, install: false });

    assert.deepEqual(await readFile(packagePath), packageBefore);
    assert.deepEqual(await readFile(lockPath), lockBefore);
    await assert.rejects(readFile(path.join(interruptedModule, "beta.mjs")), hasCode("ENOENT"));
    await assert.rejects(readFile(staging), hasCode("ENOENT"));
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

test("rejects module dependencies owned by operator optionalDependencies", async () => {
  const fixture = await registryFixture();
  try {
    const packagePath = path.join(fixture.runtimeRoot, "package.json");
    await writeJson(packagePath, {
      name: "operator-runtime",
      private: true,
      type: "module",
      optionalDependencies: {
        "fixture-dependency": "^5.0.0",
      },
    });
    const packageBefore = await readFile(packagePath);

    await assert.rejects(
      addModules({
        root: fixture.runtimeRoot,
        references: [`${fixture.catalogPath}#alpha`],
        install: false,
      }),
      /operator-owned in optionalDependencies; move it to dependencies/,
    );
    assert.deepEqual(await readFile(packagePath), packageBefore);
    await assert.rejects(
      readFile(path.join(fixture.runtimeRoot, "modules.lock.json")),
      hasCode("ENOENT"),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("refuses to replace an unmanaged module directory without overwrite", async () => {
  const fixture = await registryFixture();
  const moduleRoot = path.join(fixture.runtimeRoot, "modules", "alpha");
  const operatorFile = path.join(moduleRoot, "operator.mjs");
  try {
    await mkdir(moduleRoot, { recursive: true });
    await writeFile(operatorFile, "export const operator = true\n");

    await assert.rejects(
      addModules({
        root: fixture.runtimeRoot,
        references: [`${fixture.catalogPath}#alpha`],
        install: false,
      }),
      /exists outside modules\.lock\.json; use --overwrite to replace it/,
    );

    assert.equal(
      await readFile(operatorFile, "utf8"),
      "export const operator = true\n",
    );
    await assert.rejects(
      readFile(path.join(fixture.runtimeRoot, "modules.lock.json")),
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

test("forced removal reconciles lock ownership when the module directory is missing", async () => {
  const fixture = await registryFixture();
  try {
    await addModules({
      root: fixture.runtimeRoot,
      references: [`${fixture.catalogPath}#alpha`],
      install: false,
    });
    await rm(path.join(fixture.runtimeRoot, "modules", "alpha"), {
      recursive: true,
    });

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

    assert.deepEqual((await listInstalledModules(fixture.runtimeRoot)).modules, []);
    const packageJson = JSON.parse(
      await readFile(path.join(fixture.runtimeRoot, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    assert.deepEqual(packageJson.dependencies, {});
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('installs and removes the valid module name "constructor"', async () => {
  const fixture = await registryFixture();
  try {
    await addModules({
      root: fixture.runtimeRoot,
      references: [`${fixture.catalogPath}#constructor`],
      install: false,
    });

    assert.deepEqual(
      (await listInstalledModules(fixture.runtimeRoot)).modules.map(({ name }) => name),
      ["constructor"],
    );
    assert.equal((await diffModule(fixture.runtimeRoot, "constructor")).clean, true);
    await removeModules({
      root: fixture.runtimeRoot,
      names: ["constructor"],
      install: false,
    });
    assert.deepEqual((await listInstalledModules(fixture.runtimeRoot)).modules, []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('preserves the valid dependency name "__proto__"', async () => {
  const fixture = await registryFixture();
  try {
    await writeJson(path.join(fixture.runtimeRoot, "package.json"), {
      name: "operator-runtime",
      private: true,
      type: "module",
      dependencies: { ["__proto__"]: "^9.0.0" },
    });
    await addModules({
      root: fixture.runtimeRoot,
      references: [`${fixture.catalogPath}#alpha`],
      install: false,
    });

    const packageJson = JSON.parse(
      await readFile(path.join(fixture.runtimeRoot, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    assert.equal(Object.hasOwn(packageJson.dependencies, "__proto__"), true);
    assert.equal(packageJson.dependencies["__proto__"], "^9.0.0");

    await removeModules({
      root: fixture.runtimeRoot,
      names: ["alpha"],
      install: false,
    });
    const removedPackageJson = JSON.parse(
      await readFile(path.join(fixture.runtimeRoot, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    assert.equal(Object.hasOwn(removedPackageJson.dependencies, "__proto__"), true);
    assert.equal(removedPackageJson.dependencies["__proto__"], "^9.0.0");
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
    await writeFile(
      path.join(fixture.runtimeRoot, "jaeger.runtime.mjs"),
      'const alpha = await import(new URL("modules/alpha/alpha.mjs", import.meta.url))\n' +
        "export default { version: 1, modules: [alpha] }\n",
    );
    await assert.rejects(
      removeModules({
        root: fixture.runtimeRoot,
        names: ["alpha"],
        install: false,
      }),
      /referenced by jaeger\.runtime\.mjs/,
    );
    await writeFile(
      path.join(fixture.runtimeRoot, "jaeger.runtime.mjs"),
      'const name = "alpha"\n' +
        'const alpha = await import(`./modules/${name}/alpha.mjs`)\n' +
        "export default { version: 1, modules: [alpha] }\n",
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

test("GitHub shorthand falls back from an empty GITHUB_TOKEN to GH_TOKEN", async () => {
  const originalFetch = globalThis.fetch;
  let authorization: string | null = null;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    authorization = new Headers(init?.headers).get("authorization");
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  try {
    await assert.rejects(
      resolveModuleItem("owner/repository/alpha#main", {
        GITHUB_TOKEN: "",
        GH_TOKEN: "fallback-token",
      }),
      /HTTP 404/,
    );
    assert.equal(authorization, "Bearer fallback-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub shorthand authenticates the pinned catalog and module files", async () => {
  const originalFetch = globalThis.fetch;
  const commit = "a".repeat(40);
  const authorizations: Array<string | null> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    authorizations.push(new Headers(init?.headers).get("authorization"));
    if (url === "https://api.github.com/repos/owner/repository/commits/main") {
      return Response.json({ sha: commit });
    }
    if (
      url ===
      `https://raw.githubusercontent.com/owner/repository/${commit}/jaeger.registry.json`
    ) {
      return Response.json({
        schemaVersion: 1,
        name: "private-fixture",
        items: [{ name: "alpha", path: "alpha/jaeger.module.json" }],
      });
    }
    if (
      url ===
      `https://raw.githubusercontent.com/owner/repository/${commit}/alpha/jaeger.module.json`
    ) {
      return Response.json({
        schemaVersion: 1,
        name: "alpha",
        files: ["alpha.mjs"],
        dependencies: {},
      });
    }
    if (
      url ===
      `https://raw.githubusercontent.com/owner/repository/${commit}/alpha/alpha.mjs`
    ) {
      return new Response("export const alpha = true\n");
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  try {
    const resolved = await resolveModuleItem("owner/repository/alpha#main", {
      GITHUB_TOKEN: "private-token",
    });
    assert.equal(resolved.item.name, "alpha");
    assert.deepEqual(authorizations, [
      "Bearer private-token",
      "Bearer private-token",
      "Bearer private-token",
      "Bearer private-token",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("file URL locators decode escaped path characters", async () => {
  const fixture = await registryFixture();
  try {
    const locator = pathToFileURL(fixture.catalogPath).href.replace(
      "jaeger.registry.json",
      "%6Aaeger.registry.json",
    );
    const resolved = await resolveModuleItem(`${locator}#alpha`);
    assert.equal(resolved.item.name, "alpha");
    assert.equal(
      resolved.files.get("alpha.mjs")?.toString("utf8"),
      "export const alpha = true\n",
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

test("rejects percent-encoded remote traversal before fetching source bytes", async () => {
  const originalFetch = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    fetched.push(url);
    if (url === "https://registry.example/modules/jaeger.module.json") {
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          name: "escape",
          files: ["%2e%2e/private.mjs"],
          dependencies: {},
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  try {
    await assert.rejects(
      resolveModuleItem("https://registry.example/modules/jaeger.module.json"),
      /escapes or is not normalized/,
    );
    assert.deepEqual(fetched, [
      "https://registry.example/modules/jaeger.module.json",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
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
    mkdir(path.join(sourceRoot, "constructor"), { recursive: true }),
    mkdir(runtimeRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(sourceRoot, "alpha", "alpha.mjs"), "export const alpha = true\n"),
    writeFile(path.join(sourceRoot, "beta", "beta.mjs"), "export const beta = true\n"),
    writeFile(
      path.join(sourceRoot, "constructor", "constructor.mjs"),
      "export const constructor = true\n",
    ),
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
    writeJson(path.join(sourceRoot, "constructor", "jaeger.module.json"), {
      schemaVersion: 1,
      name: "constructor",
      files: ["constructor.mjs"],
      dependencies: { constructor: "^1.0.0" },
    }),
  ]);
  const catalogPath = path.join(sourceRoot, "jaeger.registry.json");
  await writeJson(catalogPath, {
    schemaVersion: 1,
    name: "fixture",
    items: [
      { name: "alpha", path: "alpha/jaeger.module.json" },
      { name: "beta", path: "beta/jaeger.module.json" },
      {
        name: "constructor",
        path: "constructor/jaeger.module.json",
      },
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
