import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertCapability,
  readOrCreateCapabilityToken,
} from "../capability.mjs";

test("creates and reuses an owner-only per-install capability token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-capability-"));
  const capabilityFile = join(directory, "nested", "capability-token");
  const token = "a".repeat(43);

  assert.equal(
    await readOrCreateCapabilityToken(capabilityFile, {
      createToken: () => token,
    }),
    token,
  );
  assert.equal((await stat(capabilityFile)).mode & 0o777, 0o600);
  assert.equal(await readFile(capabilityFile, "utf8"), `${token}\n`);
  assert.equal(
    await readOrCreateCapabilityToken(capabilityFile, {
      createToken: () => "b".repeat(43),
    }),
    token,
  );
});

test("preserves permissions on an existing capability parent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-capability-parent-"));
  const capabilityFile = join(directory, "capability-token");
  await chmod(directory, 0o755);

  await readOrCreateCapabilityToken(capabilityFile, {
    createToken: () => "p".repeat(43),
  });

  assert.equal((await stat(directory)).mode & 0o777, 0o755);
  assert.equal((await stat(capabilityFile)).mode & 0o777, 0o600);
});

test("rejects a writable capability parent without changing its mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-capability-writable-"));
  const capabilityFile = join(directory, "capability-token");
  await chmod(directory, 0o770);

  await assert.rejects(
    readOrCreateCapabilityToken(capabilityFile),
    /directory must not be writable by others/,
  );
  assert.equal((await stat(directory)).mode & 0o777, 0o770);
});

test("rejects missing, malformed, and incorrect bearer capabilities", () => {
  const expected = "c".repeat(43);
  const request = (authorization) => ({
    headers: authorization === undefined ? {} : { authorization },
  });

  assert.doesNotThrow(() =>
    assertCapability(request(`Bearer ${expected}`), expected),
  );
  assert.throws(() => assertCapability(request(), expected), {
    message: "Capability token required",
    statusCode: 401,
  });
  assert.throws(() => assertCapability(request("Bearer short"), expected), {
    statusCode: 401,
  });
  assert.throws(
    () => assertCapability(request(`Bearer ${"d".repeat(43)}`), expected),
    { statusCode: 401 },
  );
});

test("rejects an existing capability file with group or world access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-capability-mode-"));
  const capabilityFile = join(directory, "capability-token");
  await writeFile(capabilityFile, `${"e".repeat(43)}\n`, { mode: 0o644 });
  await chmod(capabilityFile, 0o644);

  await assert.rejects(
    readOrCreateCapabilityToken(capabilityFile),
    /must be owner-only/,
  );
});
