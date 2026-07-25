import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { abortableDelay } from "../src/abortable-delay.js";
import { BackendRpcError } from "../src/backend-protocol.js";
import {
  acquireProcessLease,
  ProcessLeaseBusyError,
  readProcessLease,
  releaseProcessLease,
} from "../src/process-lease.js";
import { ServiceRuntimeClient } from "../src/runtime-client.js";

test("concurrent stale-lease reclamation publishes exactly one new owner", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-session-lease-"));
  const target = path.join(root, "turn.lock");
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(target);
  await writeFile(
    path.join(target, "owner.json"),
    `${JSON.stringify({
      pid: 999_999_999,
      processStartId: "0",
      token: "0".repeat(32),
    })}\n`,
    "utf8",
  );

  const attempts = await Promise.allSettled([
    acquireProcessLease(target),
    acquireProcessLease(target),
  ]);
  const winners = attempts.filter(
    (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireProcessLease>>> =>
      result.status === "fulfilled",
  );
  const losers = attempts.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.ok(losers[0]?.reason instanceof ProcessLeaseBusyError);

  const winner = winners[0]?.value;
  assert.ok(winner);
  assert.equal((await readProcessLease(target)).token, winner.token);
  assert.equal(await releaseProcessLease(target, winner), true);
});

test("detached session submission times out with exact ambiguity recovery", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jaeger-session-client-"));
  const socketPath = path.join(root, "backend.sock");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  const runId = "20260720194512-0123456789";
  const turnId = "turn-ambiguous-timeout-0001";
  const client = new ServiceRuntimeClient(socketPath, {
    timeoutMs: 20,
    retryWindowMs: 40,
  });
  const startedAt = Date.now();
  await assert.rejects(
    client.call("session.resume", {
      runId,
      selector: "session-0123456789abcdef",
      message: "continue",
      turnId,
      detach: true,
    }),
    (error: unknown) => {
      assert.ok(error instanceof BackendRpcError);
      assert.equal(error.code, "backend_unavailable");
      assert.match(error.message, new RegExp(`--request-id ${turnId}`));
      assert.match(error.message, new RegExp(`session turn inspect ${runId} ${turnId}`));
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 1_000, "detached submission must have a finite timeout");
});

test("session polling delay removes abort listeners after normal settlement", async () => {
  const controller = new AbortController();
  for (let attempt = 0; attempt < 20; attempt++) {
    await abortableDelay(1, controller.signal, "test aborted");
  }
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
