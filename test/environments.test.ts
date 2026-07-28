import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyEnvironment,
  createNativePackageManager,
  createNativePluginManager,
  inspectEnvironmentStatus,
  listEnvironments,
  loadEnvironmentPlan,
  uninstallEnvironment,
  type EnvironmentPaths,
  type NativePluginManager,
  type NativePackageManager,
} from "../src/environments.js";

test("environment plans compose conditional instructions and provider assets", async () => {
  await withEnvironment(async ({ root, paths, codexHome }) => {
    const directory = await writeEnvironment(root, "workstation", {
      manifest: `
version = 1
name = "workstation"
harness_config = "harnesses.json"

[providers.codex]
instructions = ["snippets/always.md", "snippets/conditional.md"]
skills = ["skills/example-skill"]
plugins = ["github@example-marketplace"]

[[providers.codex.configs]]
source = "configs/managed.json"
target = "$CODEX_HOME/managed.json"
`,
      files: {
        "harnesses.json": `{"version":1,"harnesses":{}}\n`,
        "snippets/always.md": "# Always\n",
        "snippets/conditional.md": `+++
description = "Needs a missing program"
requires = ["definitely-not-installed"]
+++
# Conditional
`,
        "skills/example-skill/SKILL.md": "# Example skill\n",
        "configs/managed.json": "{}\n",
      },
    });
    const plan = await loadEnvironmentPlan(
      "workstation",
      paths,
      path.join(directory, "environment.toml"),
      { CODEX_HOME: codexHome, PATH: "" },
    );
    assert.equal(plan.resources.length, 4);
    assert.deepEqual(plan.plugins, [
      { provider: "codex", selector: "github@example-marketplace" },
    ]);
    assert.equal(plan.snippets.length, 2);
    assert.equal(plan.snippets[0]?.selected, true);
    assert.equal(plan.snippets[1]?.selected, false);
    const instructions = plan.resources.find((resource) => resource.category === "instructions");
    assert.equal(instructions?.target, path.join(codexHome, "AGENTS.md"));
    assert.match(instructions?.content ?? "", /# Always/);
    assert.doesNotMatch(instructions?.content ?? "", /# Conditional/);
    assert.equal(
      plan.resources.find((resource) => resource.category === "skill")?.target,
      path.join(codexHome, "skills", "example-skill"),
    );
  });
});

test("Pi environments target native instructions, skills, configs, and packages", async () => {
  await withEnvironment(async ({ root, paths, piHome }) => {
    const directory = await writeEnvironment(root, "pi_native", {
      manifest: `
version = 1
name = "pi_native"

[providers.pi]
instructions = ["snippets/pi.md"]
skills = ["skills/pi-skill"]
packages = ["npm:@acme/pi-tools@1.2.3"]

[[providers.pi.configs]]
source = "configs/settings.json"
target = "$PI_CODING_AGENT_DIR/settings.json"
`,
      files: {
        "snippets/pi.md": "# Pi instructions\n",
        "skills/pi-skill/SKILL.md": "# Pi skill\n",
        "configs/settings.json": "{}\n",
      },
    });
    const plan = await loadEnvironmentPlan(
      "pi_native",
      paths,
      path.join(directory, "environment.toml"),
      { PI_CODING_AGENT_DIR: piHome, PATH: "" },
    );

    assert.deepEqual(plan.packages, [
      { provider: "pi", source: "npm:@acme/pi-tools@1.2.3" },
    ]);
    assert.equal(
      plan.resources.find((resource) => resource.category === "instructions")
        ?.target,
      path.join(piHome, "AGENTS.md"),
    );
    assert.equal(
      plan.resources.find((resource) => resource.category === "skill")?.target,
      path.join(piHome, "skills", "pi-skill"),
    );
    assert.equal(
      plan.resources.find((resource) => resource.category === "config")?.target,
      path.join(piHome, "settings.json"),
    );
  });
});

test("Pi package ownership is idempotent and removes only environment installs", async () => {
  await withEnvironment(async ({ root, paths }) => {
    const directory = await writeEnvironment(root, "pi_packages", {
      manifest: `
version = 1
name = "pi_packages"
[providers.pi]
packages = ["npm:managed@1.0.0", "npm:existing@2.0.0"]
`,
      files: {},
    });
    const installed = new Set(["npm:existing@2.0.0"]);
    const events: string[] = [];
    const packageManager: NativePackageManager = {
      async isInstalled(source) {
        return installed.has(source);
      },
      async install(source) {
        installed.add(source);
        events.push(`install:${source}`);
      },
      async uninstall(source) {
        installed.delete(source);
        events.push(`uninstall:${source}`);
      },
    };
    const plan = await loadEnvironmentPlan(
      "pi_packages",
      paths,
      path.join(directory, "environment.toml"),
    );
    const applied = await applyEnvironment(plan, paths, { packageManager });
    assert.equal(applied.installedPackages, 1);
    assert.equal(
      (await inspectEnvironmentStatus(
        plan,
        paths,
        undefined,
        packageManager,
      )).current,
      true,
    );
    const uninstalled = await uninstallEnvironment(paths, "pi_packages", {
      packageManager,
    });
    assert.equal(uninstalled.removedPackages, 1);
    assert.deepEqual(events, [
      "install:npm:managed@1.0.0",
      "uninstall:npm:managed@1.0.0",
    ]);
    assert.equal(installed.has("npm:existing@2.0.0"), true);
  });
});

test("Pi environments restore a pre-existing package after changing its version", async () => {
  await withEnvironment(async ({ root, paths }) => {
    const directory = await writeEnvironment(root, "pi_packages", {
      manifest: `
version = 1
name = "pi_packages"
[providers.pi]
packages = ["npm:existing@2.0.0"]
`,
      files: {},
    });
    const calls: string[] = [];
    let installedSource = "npm:existing@1.0.0";
    const packageManager = createNativePackageManager(
      async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (args[0] === "install") installedSource = args[1] as string;
        if (args[0] === "remove") installedSource = "";
        return {
          stdout: args[0] === "list"
            ? `User packages:\n  ${installedSource}\n`
            : "",
          stderr: "",
        };
      },
    );
    const plan = await loadEnvironmentPlan(
      "pi_packages",
      paths,
      path.join(directory, "environment.toml"),
    );

    assert.equal(
      (await applyEnvironment(plan, paths, { packageManager }))
        .installedPackages,
      1,
    );
    const state = JSON.parse(
      await readFile(path.join(paths.stateRoot, "active.json"), "utf8"),
    ) as {
      readonly packages: readonly {
        readonly installedByEnvironment: boolean;
        readonly previousSource?: string;
      }[];
    };
    assert.deepEqual(state.packages, [
      {
        provider: "pi",
        source: "npm:existing@2.0.0",
        installedByEnvironment: false,
        previousSource: "npm:existing@1.0.0",
      },
    ]);
    assert.equal(
      (await inspectEnvironmentStatus(
        plan,
        paths,
        undefined,
        packageManager,
      )).current,
      true,
    );
    assert.equal(
      (
        await uninstallEnvironment(paths, "pi_packages", {
          packageManager,
        })
      ).removedPackages,
      0,
    );
    assert.equal(installedSource, "npm:existing@1.0.0");
    assert.deepEqual(calls, [
      "pi list --no-approve",
      "pi install npm:existing@2.0.0 --no-approve",
      "pi list --no-approve",
      "pi install npm:existing@1.0.0 --no-approve",
    ]);
  });
});

test("Pi environments restore a normalized Git package after changing its ref", async () => {
  await withEnvironment(async ({ root, paths }) => {
    const directory = await writeEnvironment(root, "pi_packages", {
      manifest: `
version = 1
name = "pi_packages"
[providers.pi]
packages = ["https://github.com/acme/pi-ext.git@v2"]
`,
      files: {},
    });
    const calls: string[] = [];
    let installedSource = "git:git@github.com:acme/pi-ext@v1";
    const packageManager = createNativePackageManager(
      async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (args[0] === "install") installedSource = args[1] as string;
        return {
          stdout:
            args[0] === "list"
              ? `User packages:\n  ${installedSource}\n`
              : "",
          stderr: "",
        };
      },
    );
    const plan = await loadEnvironmentPlan(
      "pi_packages",
      paths,
      path.join(directory, "environment.toml"),
    );

    assert.equal(
      (await applyEnvironment(plan, paths, { packageManager }))
        .installedPackages,
      1,
    );
    await uninstallEnvironment(paths, "pi_packages", { packageManager });
    assert.equal(installedSource, "git:git@github.com:acme/pi-ext@v1");
    assert.deepEqual(calls, [
      "pi list --no-approve",
      "pi install https://github.com/acme/pi-ext.git@v2 --no-approve",
      "pi install git:git@github.com:acme/pi-ext@v1 --no-approve",
    ]);
  });
});

test("Pi environments preserve packages installed through equivalent Git shorthand", async () => {
  await withEnvironment(async ({ root, paths }) => {
    const directory = await writeEnvironment(root, "pi_packages", {
      manifest: `
version = 1
name = "pi_packages"
[providers.pi]
packages = ["git:github:acme/pi-ext"]
`,
      files: {},
    });
    const calls: string[] = [];
    const packageManager = createNativePackageManager(
      async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (args[0] !== "list") {
          assert.fail("pre-existing package should not be changed");
        }
        return {
          stdout: "User packages:\n  git:github.com/acme/pi-ext\n",
          stderr: "",
        };
      },
    );
    const plan = await loadEnvironmentPlan(
      "pi_packages",
      paths,
      path.join(directory, "environment.toml"),
    );

    assert.equal(
      (await applyEnvironment(plan, paths, { packageManager }))
        .installedPackages,
      0,
    );
    assert.equal(
      (await uninstallEnvironment(paths, "pi_packages", { packageManager }))
        .removedPackages,
      0,
    );
    assert.deepEqual(calls, ["pi list --no-approve"]);
  });
});

test("Pi environments capture a displaced package before replacing managed settings", async () => {
  await withEnvironment(async ({ root, paths, piHome }) => {
    const directory = await writeEnvironment(root, "pi_settings", {
      manifest: `
version = 1
name = "pi_settings"
[providers.pi]
packages = ["npm:existing@2.0.0"]

[[providers.pi.configs]]
source = "configs/settings.json"
target = "$PI_CODING_AGENT_DIR/settings.json"
`,
      files: {
        "configs/settings.json": `{"theme":"dark"}\n`,
      },
    });
    await mkdir(piHome, { recursive: true });
    const settingsPath = path.join(piHome, "settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({
        theme: "light",
        packages: ["npm:existing@1.0.0"],
      }),
    );
    const calls: string[] = [];
    const packageManager = createNativePackageManager(
      async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        const settings = JSON.parse(
          await readFile(settingsPath, "utf8"),
        ) as Record<string, unknown>;
        if (args[0] === "install") {
          await writeFile(
            settingsPath,
            JSON.stringify({ ...settings, packages: [args[1]] }),
          );
        }
        return {
          stdout:
            args[0] === "list"
              ? `User packages:\n  ${(settings.packages as string[])[0] ?? ""}\n`
              : "",
          stderr: "",
        };
      },
    );
    const plan = await loadEnvironmentPlan(
      "pi_settings",
      paths,
      path.join(directory, "environment.toml"),
      { PI_CODING_AGENT_DIR: piHome, PATH: "" },
    );

    await applyEnvironment(plan, paths, { force: true, packageManager });
    const state = JSON.parse(
      await readFile(path.join(paths.stateRoot, "active.json"), "utf8"),
    ) as {
      readonly packages: readonly {
        readonly previousSource?: string;
      }[];
    };
    assert.equal(
      state.packages[0]?.previousSource,
      "npm:existing@1.0.0",
    );
    await uninstallEnvironment(paths, "pi_settings", { packageManager });
    const restoredSettings = JSON.parse(
      await readFile(settingsPath, "utf8"),
    ) as {
      readonly theme: string;
      readonly packages: readonly string[];
    };
    assert.deepEqual(restoredSettings, {
      theme: "light",
      packages: ["npm:existing@1.0.0"],
    });
    assert.deepEqual(calls, [
      "pi list --no-approve",
      "pi install npm:existing@2.0.0 --no-approve",
      "pi install npm:existing@1.0.0 --no-approve",
    ]);
  });
});

test("Pi package recovery retries when the managed version is absent", async () => {
  await withEnvironment(async ({ root, paths }) => {
    const directory = await writeEnvironment(root, "pi_packages", {
      manifest: `
version = 1
name = "pi_packages"
[providers.pi]
packages = ["npm:existing@2.0.0"]
`,
      files: {},
    });
    let installedSource = "npm:existing@1.0.0";
    let failRecovery = true;
    const packageManager = createNativePackageManager(
      async (_command, args) => {
        if (
          args[0] === "install" &&
          args[1] === "npm:existing@1.0.0" &&
          failRecovery
        ) {
          failRecovery = false;
          throw new Error("recovery failed");
        }
        if (args[0] === "install") installedSource = args[1] as string;
        return {
          stdout:
            args[0] === "list"
              ? installedSource
                ? `User packages:\n  ${installedSource}\n`
                : "No packages installed.\n"
              : "",
          stderr: "",
        };
      },
    );
    const plan = await loadEnvironmentPlan(
      "pi_packages",
      paths,
      path.join(directory, "environment.toml"),
    );
    await applyEnvironment(plan, paths, { packageManager });
    installedSource = "";

    await assert.rejects(
      () => uninstallEnvironment(paths, "pi_packages", { packageManager }),
      /recovery failed/,
    );
    const checkpoint = JSON.parse(
      await readFile(path.join(paths.stateRoot, "active.json"), "utf8"),
    ) as {
      readonly packages: readonly {
        readonly previousSource?: string;
      }[];
    };
    assert.equal(
      checkpoint.packages[0]?.previousSource,
      "npm:existing@1.0.0",
    );

    await uninstallEnvironment(paths, "pi_packages", { packageManager });
    assert.equal(installedSource, "npm:existing@1.0.0");
    await assert.rejects(
      () => readFile(path.join(paths.stateRoot, "active.json")),
      /ENOENT/,
    );
  });
});

test("Pi package changes coexist with a managed settings file", async () => {
  await withEnvironment(async ({ root, paths, piHome }) => {
    const directory = await writeEnvironment(root, "pi_settings", {
      manifest: `
version = 1
name = "pi_settings"
[providers.pi]
packages = ["npm:managed@1.0.0"]

[[providers.pi.configs]]
source = "configs/settings.json"
target = "$PI_CODING_AGENT_DIR/settings.json"
`,
      files: {
        "configs/settings.json": `{"theme":"dark"}\n`,
      },
    });
    const settingsPath = path.join(piHome, "settings.json");
    const installed = new Set<string>();
    const packageManager: NativePackageManager = {
      async isInstalled(source) {
        const settings = JSON.parse(
          await readFile(settingsPath, "utf8").catch((error: unknown) => {
            if (
              error &&
              typeof error === "object" &&
              "code" in error &&
              error.code === "ENOENT"
            ) {
              return "{}";
            }
            throw error;
          }),
        ) as { readonly packages?: readonly string[] };
        return settings.packages?.includes(source) === true;
      },
      async install(source) {
        installed.add(source);
        const settings = JSON.parse(
          await readFile(settingsPath, "utf8"),
        ) as Record<string, unknown>;
        await writeFile(
          settingsPath,
          JSON.stringify({ ...settings, packages: [source] }, null, 2),
        );
      },
      async uninstall(source) {
        installed.delete(source);
        const settings = JSON.parse(
          await readFile(settingsPath, "utf8"),
        ) as Record<string, unknown>;
        await writeFile(
          settingsPath,
          JSON.stringify({ ...settings, packages: [] }, null, 2),
        );
      },
    };
    const plan = await loadEnvironmentPlan(
      "pi_settings",
      paths,
      path.join(directory, "environment.toml"),
      { PI_CODING_AGENT_DIR: piHome, PATH: "" },
    );

    assert.equal(
      (await applyEnvironment(plan, paths, { packageManager }))
        .installedPackages,
      1,
    );
    assert.equal(
      (await inspectEnvironmentStatus(
        plan,
        paths,
        undefined,
        packageManager,
      )).current,
      true,
    );
    const repeated = await applyEnvironment(plan, paths, { packageManager });
    assert.equal(repeated.changed, 0);
    assert.equal(repeated.installedPackages, 0);
    assert.deepEqual(installed, new Set(["npm:managed@1.0.0"]));
    const changedSettings = JSON.parse(
      await readFile(settingsPath, "utf8"),
    ) as Record<string, unknown>;
    await writeFile(
      settingsPath,
      JSON.stringify({ ...changedSettings, theme: "light" }, null, 2),
    );
    assert.equal(
      (await inspectEnvironmentStatus(
        plan,
        paths,
        undefined,
        packageManager,
      )).current,
      false,
    );
    await assert.rejects(
      () => applyEnvironment(plan, paths, { packageManager }),
      /local changes/,
    );
    await writeFile(
      settingsPath,
      JSON.stringify({ ...changedSettings, theme: "dark" }, null, 2),
    );
    assert.equal(
      (
        await uninstallEnvironment(paths, "pi_settings", {
          packageManager,
        })
      ).removedPackages,
      1,
    );
    assert.deepEqual(installed, new Set());
    await assert.rejects(() => readFile(settingsPath), /ENOENT/);
  });
});

test("Pi package ownership survives a later install failure", async () => {
  await withEnvironment(async ({ root, paths }) => {
    const directory = await writeEnvironment(root, "pi_packages", {
      manifest: `
version = 1
name = "pi_packages"
[providers.pi]
packages = ["npm:first@1.0.0", "npm:second@2.0.0"]
`,
      files: {},
    });
    const installed = new Set<string>();
    const events: string[] = [];
    let failSecondInstall = true;
    const packageManager: NativePackageManager = {
      async isInstalled(source) {
        return installed.has(source);
      },
      async install(source) {
        events.push(`install:${source}`);
        if (source === "npm:second@2.0.0" && failSecondInstall) {
          failSecondInstall = false;
          throw new Error("second install failed");
        }
        installed.add(source);
      },
      async uninstall(source) {
        installed.delete(source);
        events.push(`uninstall:${source}`);
      },
    };
    const plan = await loadEnvironmentPlan(
      "pi_packages",
      paths,
      path.join(directory, "environment.toml"),
    );

    await assert.rejects(
      () => applyEnvironment(plan, paths, { packageManager }),
      /second install failed/,
    );
    assert.deepEqual([...installed], ["npm:first@1.0.0"]);
    const checkpoint = JSON.parse(
      await readFile(path.join(paths.stateRoot, "active.json"), "utf8"),
    ) as {
      readonly packages: readonly {
        readonly source: string;
        readonly installedByEnvironment: boolean;
      }[];
    };
    assert.deepEqual(
      checkpoint.packages.map(({ source, installedByEnvironment }) => ({
        source,
        installedByEnvironment,
      })),
      [
        { source: "npm:first@1.0.0", installedByEnvironment: true },
        { source: "npm:second@2.0.0", installedByEnvironment: true },
      ],
    );

    assert.equal(
      (await applyEnvironment(plan, paths, { packageManager }))
        .installedPackages,
      1,
    );
    assert.equal(
      (
        await uninstallEnvironment(paths, "pi_packages", {
          packageManager,
        })
      ).removedPackages,
      2,
    );
    assert.deepEqual(events, [
      "install:npm:first@1.0.0",
      "install:npm:second@2.0.0",
      "install:npm:second@2.0.0",
      "uninstall:npm:first@1.0.0",
      "uninstall:npm:second@2.0.0",
    ]);
  });
});

test("a Pi package probe failure leaves managed resources untouched", async () => {
  await withEnvironment(async ({ root, paths, piHome }) => {
    const directory = await writeEnvironment(root, "pi_probe", {
      manifest: `
version = 1
name = "pi_probe"
[providers.pi]
instructions = ["snippets/pi.md"]
packages = ["npm:managed@1.0.0"]
`,
      files: {
        "snippets/pi.md": "# Managed Pi instructions\n",
      },
    });
    await mkdir(piHome, { recursive: true });
    const instructionsTarget = path.join(piHome, "AGENTS.md");
    await writeFile(instructionsTarget, "# Original Pi instructions\n");
    let probeFails = true;
    const installed = new Set<string>();
    const packageManager: NativePackageManager = {
      async isInstalled(source) {
        if (probeFails) {
          probeFails = false;
          throw new Error("Pi unavailable");
        }
        return installed.has(source);
      },
      async install(source) {
        installed.add(source);
      },
      async uninstall(source) {
        installed.delete(source);
      },
    };
    const plan = await loadEnvironmentPlan(
      "pi_probe",
      paths,
      path.join(directory, "environment.toml"),
      { PI_CODING_AGENT_DIR: piHome, PATH: "" },
    );

    await assert.rejects(
      () => applyEnvironment(plan, paths, { force: true, packageManager }),
      /Pi unavailable/,
    );
    assert.equal(
      await readFile(instructionsTarget, "utf8"),
      "# Original Pi instructions\n",
    );
    await assert.rejects(
      () => readFile(path.join(paths.stateRoot, "active.json")),
      /ENOENT/,
    );

    await applyEnvironment(plan, paths, { force: true, packageManager });
    await uninstallEnvironment(paths, "pi_probe", { packageManager });
    assert.equal(
      await readFile(instructionsTarget, "utf8"),
      "# Original Pi instructions\n",
    );
  });
});

test("apply is idempotent, detects drift, and uninstall restores prior content", async () => {
  await withEnvironment(async ({ root, paths, codexHome }) => {
    const directory = await writeEnvironment(root, "default", {
      manifest: `
version = 1
name = "default"

[providers.codex]
instructions = ["snippets/instructions.md"]
skills = ["skills/example-skill"]
plugins = ["example@test-marketplace"]
`,
      files: {
        "snippets/instructions.md": "# Managed instructions\n",
        "skills/example-skill/SKILL.md": "# Managed skill\n",
      },
    });
    await mkdir(codexHome, { recursive: true });
    const instructionsTarget = path.join(codexHome, "AGENTS.md");
    const installedPlugins = new Set<string>();
    const pluginEvents: string[] = [];
    const pluginManager: NativePluginManager = {
      async isInstalled(provider, selector) {
        return installedPlugins.has(`${provider}:${selector}`);
      },
      async install(provider, selector) {
        installedPlugins.add(`${provider}:${selector}`);
        pluginEvents.push(`install:${provider}:${selector}`);
      },
      async uninstall(provider, selector) {
        installedPlugins.delete(`${provider}:${selector}`);
        pluginEvents.push(`uninstall:${provider}:${selector}`);
      },
    };
    await writeFile(instructionsTarget, "# Original instructions\n");
    const plan = await loadEnvironmentPlan(
      "default",
      paths,
      path.join(directory, "environment.toml"),
      { CODEX_HOME: codexHome, PATH: process.env.PATH },
    );
    await assert.rejects(() => applyEnvironment(plan, paths, { pluginManager }), /unmanaged target/);
    const applied = await applyEnvironment(plan, paths, { force: true, pluginManager });
    assert.equal(applied.changed, 2);
    assert.equal(applied.installedPlugins, 1);
    assert.match(await readFile(instructionsTarget, "utf8"), /Generated by jaeger env/);
    assert.equal((await inspectEnvironmentStatus(plan, paths, pluginManager)).current, true);
    const repeated = await applyEnvironment(plan, paths, { pluginManager });
    assert.equal(repeated.changed, 0);
    assert.equal(repeated.unchanged, 2);
    await writeFile(instructionsTarget, "# Local edit\n");
    assert.equal((await inspectEnvironmentStatus(plan, paths, pluginManager)).current, false);
    await assert.rejects(() => applyEnvironment(plan, paths, { pluginManager }), /local changes/);
    await applyEnvironment(plan, paths, { force: true, pluginManager });
    await writeFile(
      path.join(directory, "environment.toml"),
      `version = 1\nname = "default"\n[providers.codex]\ninstructions = ["snippets/instructions.md"]\n`,
    );
    const reducedPlan = await loadEnvironmentPlan(
      "default",
      paths,
      path.join(directory, "environment.toml"),
      { CODEX_HOME: codexHome, PATH: process.env.PATH },
    );
    assert.equal(
      (await inspectEnvironmentStatus(reducedPlan, paths, pluginManager)).resources.some(
        (resource) => resource.status === "obsolete",
      ),
      true,
    );
    const reduced = await applyEnvironment(reducedPlan, paths, { pluginManager });
    assert.equal(reduced.removed, 1);
    assert.equal(reduced.removedPlugins, 1);
    const uninstalled = await uninstallEnvironment(paths, "default", { pluginManager });
    assert.equal(uninstalled.restored, 1);
    assert.equal(uninstalled.removed, 0);
    assert.equal(await readFile(instructionsTarget, "utf8"), "# Original instructions\n");
    assert.deepEqual(pluginEvents, [
      "install:codex:example@test-marketplace",
      "uninstall:codex:example@test-marketplace",
    ]);
    await assert.rejects(() => readFile(path.join(codexHome, "skills", "example-skill", "SKILL.md")), /ENOENT/);
  });
});

test("list returns only valid environment directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-env-list-"));
  try {
    await Promise.all([
      mkdir(path.join(root, "default")),
      mkdir(path.join(root, "work_station")),
      mkdir(path.join(root, "Invalid")),
      writeFile(path.join(root, "file"), "not a directory"),
    ]);
    assert.deepEqual(await listEnvironments(root), ["default", "work_station"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uninstall preserves plugins that predated the environment", async () => {
  await withEnvironment(async ({ root, paths }) => {
    const directory = await writeEnvironment(root, "plugins", {
      manifest: `
version = 1
name = "plugins"
[providers.claude]
plugins = ["existing@test-marketplace"]
`,
      files: {},
    });
    let uninstallCalls = 0;
    const pluginManager: NativePluginManager = {
      async isInstalled() {
        return true;
      },
      async install() {
        assert.fail("pre-existing plugin should not be installed");
      },
      async uninstall() {
        uninstallCalls += 1;
      },
    };
    const plan = await loadEnvironmentPlan(
      "plugins",
      paths,
      path.join(directory, "environment.toml"),
    );
    assert.equal((await applyEnvironment(plan, paths, { pluginManager })).installedPlugins, 0);
    assert.equal((await uninstallEnvironment(paths, "plugins", { pluginManager })).removedPlugins, 0);
    assert.equal(uninstallCalls, 0);
  });
});

test("native plugin manager uses provider plugin commands and reads their JSON", async () => {
  const calls: string[] = [];
  const manager = createNativePluginManager(async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (args[1] === "list") {
      return command === "codex"
        ? {
            stdout: JSON.stringify({
              installed: [{ pluginId: "github@openai-curated" }],
            }),
            stderr: "",
          }
        : {
            stdout: JSON.stringify([
              { name: "review", marketplace: "team-marketplace" },
            ]),
            stderr: "",
          };
    }
    return { stdout: "", stderr: "" };
  });
  assert.equal(await manager.isInstalled("codex", "github@openai-curated"), true);
  assert.equal(await manager.isInstalled("claude", "review@team-marketplace"), true);
  await manager.install("codex", "github@openai-curated");
  await manager.install("claude", "review@team-marketplace");
  await manager.uninstall("codex", "github@openai-curated");
  await manager.uninstall("claude", "review@team-marketplace");
  assert.deepEqual(calls, [
    "codex plugin list --json",
    "claude plugin list --json",
    "codex plugin add github@openai-curated --json",
    "claude plugin install review@team-marketplace --scope user",
    "codex plugin remove github@openai-curated --json",
    "claude plugin uninstall review@team-marketplace",
  ]);
});

test("native Pi package manager uses package commands and parses user package sources", async () => {
  const calls: string[] = [];
  const manager = createNativePackageManager(async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (args[0] === "list") {
      return {
        stdout:
          "User packages:\n  npm:@acme/tools@1.2.3\n    /tmp/acme\n  git:github.com/acme/pi-ext@v2 (filtered)\nProject packages:\n  npm:project-only@1.0.0\n    /tmp/project\n",
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  });
  assert.equal(await manager.isInstalled("npm:@acme/tools@1.2.3"), true);
  assert.equal(await manager.isInstalled("npm:@acme/tools@9.9.9"), false);
  assert.equal(
    await manager.isInstalled("git:github.com/acme/pi-ext@v2"),
    true,
  );
  assert.equal(
    await manager.isInstalled("git:github.com/acme/pi-ext@v3"),
    false,
  );
  assert.equal(
    await manager.isInstalled("https://github.com/acme/pi-ext.git@v3"),
    false,
  );
  assert.equal(await manager.isInstalled("npm:project-only@1.0.0"), false);
  await manager.install("npm:@acme/tools@1.2.3");
  await manager.uninstall("npm:@acme/tools@1.2.3");
  assert.deepEqual(calls, [
    "pi list --no-approve",
    "pi list --no-approve",
    "pi list --no-approve",
    "pi list --no-approve",
    "pi list --no-approve",
    "pi list --no-approve",
    "pi install npm:@acme/tools@1.2.3 --no-approve",
    "pi remove npm:@acme/tools@1.2.3 --no-approve",
  ]);
});

test("native Pi package manager canonicalizes hosted Git shorthand aliases", async () => {
  const manager = createNativePackageManager(async () => ({
    stdout:
      "User packages:\n" +
      "  git:github.com/acme/pi-ext@v2\n" +
      "  git:gitlab.com/acme/pi-ext\n" +
      "  git:bitbucket.org/acme/pi-ext\n" +
      "  git:gist.github.com/acme/abc123\n" +
      "  git:git.sr.ht/~acme/pi-ext\n",
    stderr: "",
  }));

  assert.equal(
    await manager.isInstalled("git:github:acme/pi-ext@v2"),
    true,
  );
  assert.equal(await manager.isInstalled("git:gitlab:acme/pi-ext"), true);
  assert.equal(
    await manager.isInstalled("git:bitbucket:acme/pi-ext"),
    true,
  );
  assert.equal(await manager.isInstalled("git:gist:acme/abc123"), true);
  assert.equal(
    await manager.isInstalled("git:sourcehut:~acme/pi-ext"),
    true,
  );
});

test("native Pi package manager matches local packages relative to Pi settings", async () => {
  const settingsDirectory = path.join(
    path.parse(process.cwd()).root,
    "tmp",
    "pi",
    "agent",
  );
  const localPackage = path.join(
    path.parse(process.cwd()).root,
    "tmp",
    "jaeger",
    "packages",
    "local-tools",
  );
  const configuredSource = path.relative(settingsDirectory, localPackage);
  const manager = createNativePackageManager(
    async () => ({
      stdout: `User packages:\n  ${configuredSource}\n    ${localPackage}\n`,
      stderr: "",
    }),
    settingsDirectory,
  );

  assert.equal(await manager.isInstalled(localPackage), true);
  assert.equal(
    await manager.installedSource?.(localPackage),
    localPackage,
  );
});

async function withEnvironment(
  callback: (context: {
    readonly root: string;
    readonly paths: EnvironmentPaths;
    readonly codexHome: string;
    readonly piHome: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-environment-"));
  const paths = {
    configRoot: path.join(root, "config", "jaeger", "environments"),
    stateRoot: path.join(root, "state", "jaeger", "environment"),
  };
  const codexHome = path.join(root, "codex");
  const piHome = path.join(root, "pi", "agent");
  try {
    await callback({ root, paths, codexHome, piHome });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeEnvironment(
  root: string,
  name: string,
  input: { readonly manifest: string; readonly files: Readonly<Record<string, string>> },
): Promise<string> {
  const directory = path.join(root, "config", "jaeger", "environments", name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "environment.toml"), input.manifest.trimStart());
  for (const [relative, content] of Object.entries(input.files)) {
    const target = path.join(directory, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return directory;
}
