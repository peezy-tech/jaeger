import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TelegramCallInvitations } from "../telegram-call.mjs";

test("state, transcript, and control APIs require the browser capability", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-server-auth-"));
  const capability = "s".repeat(43);
  const capabilityFile = join(directory, "capability-token");
  await writeFile(capabilityFile, `${capability}\n`, { mode: 0o600 });
  process.env.VOICE_SPIKE_CAPABILITY_FILE = capabilityFile;
  process.env.VOICE_SPIKE_STATE_FILE = join(directory, "operator.json");
  process.env.VOICE_SPIKE_INVITATION_STATE_FILE = join(
    directory,
    "telegram-call.json",
  );
  process.env.VOICE_SPIKE_PUBLIC_ORIGIN = "https://voice.example";
  const invitationToken = "i".repeat(43);
  const invitations = new TelegramCallInvitations({
    stateFile: process.env.VOICE_SPIKE_INVITATION_STATE_FILE,
    createToken: () => invitationToken,
  });
  await invitations.create();
  await invitations.answer(invitationToken);

  const { server } = await import(`../server.mjs?auth-test=${Date.now()}`);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const pathname of ["/api/state", "/api/events"]) {
      const response = await fetch(`${base}${pathname}`);
      assert.equal(response.status, 401, pathname);
    }

    const missingCapability = await fetch(`${base}/api/reconnect`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://voice.example",
      },
      body: "{}",
    });
    assert.equal(missingCapability.status, 401);

    const crossOrigin = await fetch(`${base}/api/state`, {
      headers: {
        authorization: `Bearer ${capability}`,
        origin: "https://attacker.example",
      },
    });
    assert.equal(crossOrigin.status, 403);

    const authorized = await fetch(`${base}/api/state`, {
      headers: {
        authorization: `Bearer ${capability}`,
        origin: "https://voice.example",
      },
    });
    assert.equal(authorized.status, 200);
    assert.equal((await authorized.json()).connected, false);

    const invitationAuthorized = await fetch(`${base}/api/state`, {
      headers: {
        authorization: `Bearer ${invitationToken}`,
        origin: "https://voice.example",
      },
    });
    assert.equal(invitationAuthorized.status, 200);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
