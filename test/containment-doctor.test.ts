import assert from "node:assert/strict";
import test from "node:test";
import { providerContainmentDoctor } from "../src/harnesses/active-process.js";

test("containment doctor proves a disposable scope's cgroup.kill path", () => {
  const fixture = doctorFixture();

  assert.deepEqual(providerContainmentDoctor(fixture.dependencies), {
    available: true,
    kind: "systemd-user-scope",
  });

  assert.equal(fixture.started.length, 1);
  const start = fixture.started[0];
  assert.ok(start);
  assert.equal(start.command, "systemd-run");
  assert.deepEqual(start.args.slice(0, 5), [
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    `--unit=jaeger-doctor-probe-${process.pid}-${"a".repeat(24)}.scope`,
  ]);
  assert.deepEqual(fixture.writes, [
    {
      filePath: "/sys/fs/cgroup/user.slice/jaeger-doctor.scope/cgroup.kill",
      value: "1",
    },
  ]);
  assert.deepEqual(fixture.childSignals, ["SIGKILL"]);
  assert.ok(
    fixture.commands.some(
      ({ command, args }) =>
        command === "systemctl" &&
        args.includes("kill") &&
        args.includes("--kill-whom=all") &&
        args.includes("--signal=KILL"),
    ),
  );
  assert.ok(
    fixture.commands.some(
      ({ command, args }) => command === "systemctl" && args.includes("reset-failed"),
    ),
  );
});

test("containment doctor fails closed when systemd-run or the user manager is unavailable", () => {
  const missingRun = doctorFixture({
    command: (command, args) =>
      command === "systemd-run"
        ? { status: null, stdout: "", stderr: "", error: new Error("ENOENT") }
        : successfulCommand(),
  });
  const runResult = providerContainmentDoctor(missingRun.dependencies);
  assert.equal(runResult.available, false);
  assert.match(runResult.error ?? "", /systemd-run is unavailable: ENOENT/);
  assert.equal(missingRun.started.length, 0);

  const missingManager = doctorFixture({
    command: (command, args) =>
      command === "systemctl" && args.includes("show-environment")
        ? { status: 1, stdout: "", stderr: "Failed to connect to bus" }
        : successfulCommand(),
  });
  const managerResult = providerContainmentDoctor(missingManager.dependencies);
  assert.equal(managerResult.available, false);
  assert.match(managerResult.error ?? "", /systemd user manager.*Failed to connect to bus/);
  assert.equal(missingManager.started.length, 0);
});

test("containment doctor requires a unified cgroup v2 membership", () => {
  const fixture = doctorFixture({ selfCgroup: "2:cpu:/user.slice\n1:name=systemd:/user.slice\n" });

  const result = providerContainmentDoctor(fixture.dependencies);

  assert.equal(result.available, false);
  assert.match(result.error ?? "", /not using unified cgroup v2/);
  assert.equal(fixture.started.length, 0);
});

test("containment doctor fails closed when the transient scope has no writable cgroup.kill", () => {
  const fixture = doctorFixture({
    write: () => {
      throw new Error("EACCES");
    },
  });

  const result = providerContainmentDoctor(fixture.dependencies);

  assert.equal(result.available, false);
  assert.match(result.error ?? "", /does not expose a controllable cgroup\.kill: EACCES/);
  assert.deepEqual(fixture.childSignals, ["SIGKILL"]);
  assert.ok(
    fixture.commands.some(
      ({ command, args }) => command === "systemctl" && args.includes("stop"),
    ),
  );
});

test("containment doctor requires cgroup.kill to actually stop the probe scope", () => {
  const fixture = doctorFixture({ remainActive: true });

  const result = providerContainmentDoctor(fixture.dependencies);

  assert.equal(result.available, false);
  assert.match(result.error ?? "", /cgroup\.kill did not stop transient user scope/);
  assert.deepEqual(fixture.childSignals, ["SIGKILL"]);
});

function doctorFixture(options: {
  readonly selfCgroup?: string;
  readonly remainActive?: boolean;
  readonly command?: (
    command: string,
    args: readonly string[],
  ) => {
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly error?: Error;
  };
  readonly write?: (filePath: string, value: string) => void;
} = {}) {
  const commands: Array<{ command: string; args: readonly string[] }> = [];
  const started: Array<{ command: string; args: readonly string[] }> = [];
  const writes: Array<{ filePath: string; value: string }> = [];
  const childSignals: NodeJS.Signals[] = [];
  let cgroupKilled = false;
  const dependencies = {
    platform: "linux" as const,
    randomHex: () => "a".repeat(24),
    pause: () => undefined,
    readFile: (filePath: string) => {
      if (filePath === "/sys/fs/cgroup/cgroup.controllers") return "cpu memory\n";
      if (filePath === "/proc/self/cgroup") return options.selfCgroup ?? "0::/user.slice\n";
      throw new Error(`unexpected read ${filePath}`);
    },
    writeFile: (filePath: string, value: string) => {
      options.write?.(filePath, value);
      writes.push({ filePath, value });
      cgroupKilled = true;
    },
    start: (command: string, args: readonly string[]) => {
      started.push({ command, args: [...args] });
      return {
        kill: (signal: NodeJS.Signals) => {
          childSignals.push(signal);
          return true;
        },
      };
    },
    run: (command: string, args: readonly string[]) => {
      commands.push({ command, args: [...args] });
      const overridden = options.command?.(command, args);
      if (overridden) return overridden;
      if (command === "systemctl" && args.includes("--property=ControlGroup")) {
        return successfulCommand("/user.slice/jaeger-doctor.scope\n");
      }
      if (command === "systemctl" && args.includes("--property=ActiveState")) {
        return successfulCommand(cgroupKilled && !options.remainActive ? "inactive\n" : "active\n");
      }
      return successfulCommand();
    },
  };
  return { dependencies, commands, started, writes, childSignals };
}

function successfulCommand(stdout = ""): {
  readonly status: 0;
  readonly stdout: string;
  readonly stderr: "";
} {
  return { status: 0, stdout, stderr: "" };
}
