import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { BackendRpcError } from "./backend-protocol.js";
import { assertRegularFile, hasCode, publishJsonExclusive, syncDirectory } from "./durable-json.js";
import { RunJournal, type StagedRunJournal } from "./journal.js";
import { ensurePrivateDirectory } from "./paths.js";

const SUBMISSION_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const RUN_ID_PATTERN = /^\d{14}-[a-f0-9]{10}$/;

export interface SubmissionClaim {
  readonly version: 1;
  readonly submissionId: string;
  readonly submissionHash: string;
  readonly runId: string;
  readonly runRecordHash: string;
  readonly backend: "embedded" | "local-service";
  readonly createdAt: string;
}

export async function claimSubmission(
  stateDir: string,
  candidate: SubmissionClaim,
): Promise<{ readonly claim: SubmissionClaim; readonly created: boolean }> {
  validateClaim(candidate);
  const root = await submissionRoot(stateDir);
  const target = claimPath(root, candidate.submissionId);
  let created: boolean;
  let observed: SubmissionClaim | undefined;
  try {
    created = await publishJsonExclusive(target, candidate);
  } catch (error) {
    // A directory fsync error may occur after the no-replace hard link became
    // visible. Re-read and sync that authority before deciding whether the
    // candidate stage may be discarded.
    try {
      observed = await readClaimFile(target, candidate.submissionId);
      created =
        observed.runId === candidate.runId &&
        observed.runRecordHash === candidate.runRecordHash;
    } catch {
      throw error;
    }
  }
  const claim =
    observed ??
    (created ? candidate : await readClaimFile(target, candidate.submissionId));
  if (claim.runId === candidate.runId && claim.runRecordHash !== candidate.runRecordHash) {
    throw new Error(
      `Submission ${candidate.submissionId} names run ${candidate.runId} with a different record hash`,
    );
  }
  if (
    claim.submissionHash !== candidate.submissionHash ||
    claim.backend !== candidate.backend
  ) {
    throw new BackendRpcError(
      "idempotency_conflict",
      `Submission id ${candidate.submissionId} was already used for a different run request`,
    );
  }
  return { claim, created };
}

export async function readSubmissionClaim(
  stateDir: string,
  submissionId: string,
): Promise<SubmissionClaim | undefined> {
  validateSubmissionId(submissionId);
  const root = path.join(path.resolve(stateDir), ".submissions", "v1");
  try {
    return await readClaimFile(claimPath(root, submissionId), submissionId);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      try {
        await syncDirectory(root);
      } catch (syncError) {
        if (!hasCode(syncError, "ENOENT")) throw syncError;
      }
      return undefined;
    }
    throw error;
  }
}

export async function listSubmissionClaims(stateDir: string): Promise<SubmissionClaim[]> {
  const root = path.join(path.resolve(stateDir), ".submissions", "v1");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
  await syncDirectory(root);
  const claims: SubmissionClaim[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || entry.isSymbolicLink() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) {
      if (entry.name.startsWith(".")) continue;
      throw new Error(`Invalid entry in Jaeger submission index: ${entry.name}`);
    }
    const target = path.join(root, entry.name);
    const claim = await readClaimFile(target);
    if (entry.name !== `${submissionKey(claim.submissionId)}.json`) {
      throw new Error(`Jaeger submission claim filename does not match ${claim.submissionId}`);
    }
    claims.push(claim);
  }
  return claims;
}

export async function reconcileClaimedRun(
  stateDir: string,
  claim: SubmissionClaim,
): Promise<RunJournal> {
  validateClaim(claim);
  const resolvedStateDir = path.resolve(stateDir);
  try {
    const journal = await RunJournal.open(resolvedStateDir, claim.runId);
    await verifyPublishedClaim(journal, claim);
    return journal;
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  let staged: StagedRunJournal;
  try {
    staged = await RunJournal.openStaged(resolvedStateDir, claim.runId);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      try {
        const journal = await RunJournal.open(resolvedStateDir, claim.runId);
        await verifyPublishedClaim(journal, claim);
        return journal;
      } catch (publishedError) {
        if (!hasCode(publishedError, "ENOENT")) throw publishedError;
      }
      throw new Error(
        `Submission ${claim.submissionId} is durably claimed but run ${claim.runId} is missing`,
      );
    }
    throw error;
  }
  verifyStagedClaim(staged, claim);
  try {
    return await RunJournal.publish(staged);
  } catch (error) {
    try {
      const journal = await RunJournal.open(resolvedStateDir, claim.runId);
      await verifyPublishedClaim(journal, claim);
      return journal;
    } catch {
      throw error;
    }
  }
}

export function submissionClaimFor(
  staged: StagedRunJournal,
  submissionId: string,
  submissionHash: string,
  backend: "embedded" | "local-service",
): SubmissionClaim {
  return {
    version: 1,
    submissionId,
    submissionHash,
    runId: staged.runId,
    runRecordHash: staged.recordHash,
    backend,
    createdAt: new Date().toISOString(),
  };
}

async function verifyPublishedClaim(
  journal: RunJournal,
  claim: SubmissionClaim,
): Promise<void> {
  verifyRecordClaim(journal.record, claim);
  const recordBytes = await readFile(path.join(journal.runDir, "run.json"), "utf8");
  if (sha256(recordBytes) !== claim.runRecordHash) {
    throw new Error(`Claimed run record hash does not match submission ${claim.submissionId}`);
  }
  const source = await journal.source();
  if (sha256(source) !== journal.record.workflowHash) {
    throw new Error(`Claimed workflow source is corrupt for submission ${claim.submissionId}`);
  }
  // Reconciliation is also the recovery path for a rename that became visible
  // before its directory fsync reported failure. Re-establish both rename
  // barriers before the claimed run is eligible to launch.
  await syncDirectory(path.dirname(journal.runDir));
  await syncDirectory(path.join(path.dirname(journal.runDir), ".staged-runs")).catch(
    (error: unknown) => {
      if (!hasCode(error, "ENOENT")) throw error;
    },
  );
}

function verifyStagedClaim(staged: StagedRunJournal, claim: SubmissionClaim): void {
  verifyRecordClaim(staged.record, claim);
  if (staged.recordHash !== claim.runRecordHash) {
    throw new Error(`Staged run record hash does not match submission ${claim.submissionId}`);
  }
  if (staged.sourceHash !== staged.record.workflowHash) {
    throw new Error(`Staged workflow source is corrupt for submission ${claim.submissionId}`);
  }
}

function verifyRecordClaim(
  record: RunJournal["record"],
  claim: SubmissionClaim,
): void {
  if (
    record.version !== 4 ||
    record.runId !== claim.runId ||
    record.submissionId !== claim.submissionId ||
    record.submissionHash !== claim.submissionHash ||
    record.runtime.backend !== claim.backend
  ) {
    throw new Error(`Claimed run does not match submission ${claim.submissionId}`);
  }
}

async function submissionRoot(stateDir: string): Promise<string> {
  const submissions = path.join(path.resolve(stateDir), ".submissions");
  const versioned = path.join(submissions, "v1");
  await ensurePrivateDirectory(path.resolve(stateDir), "Jaeger state directory");
  await ensurePrivateDirectory(submissions, "Jaeger submission index directory");
  await ensurePrivateDirectory(versioned, "Jaeger submission index directory");
  await Promise.all([syncDirectory(path.resolve(stateDir)), syncDirectory(submissions)]);
  return versioned;
}

function claimPath(root: string, submissionId: string): string {
  validateSubmissionId(submissionId);
  return path.join(root, `${submissionKey(submissionId)}.json`);
}

async function readClaimFile(
  target: string,
  expectedSubmissionId?: string,
): Promise<SubmissionClaim> {
  await assertRegularFile(target, "Jaeger submission claim");
  const parsed = JSON.parse(await readFile(target, "utf8")) as unknown;
  validateClaim(parsed);
  if (expectedSubmissionId !== undefined && parsed.submissionId !== expectedSubmissionId) {
    throw new Error(`Jaeger submission index collision for ${expectedSubmissionId}`);
  }
  await syncDirectory(path.dirname(target));
  return parsed;
}

function validateClaim(value: unknown): asserts value is SubmissionClaim {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Jaeger submission claim");
  }
  const claim = value as Record<string, unknown>;
  if (
    claim.version !== 1 ||
    typeof claim.submissionId !== "string" ||
    !SUBMISSION_ID_PATTERN.test(claim.submissionId) ||
    typeof claim.submissionHash !== "string" ||
    !HASH_PATTERN.test(claim.submissionHash) ||
    typeof claim.runId !== "string" ||
    !RUN_ID_PATTERN.test(claim.runId) ||
    typeof claim.runRecordHash !== "string" ||
    !HASH_PATTERN.test(claim.runRecordHash) ||
    (claim.backend !== "embedded" && claim.backend !== "local-service") ||
    typeof claim.createdAt !== "string" ||
    Number.isNaN(Date.parse(claim.createdAt))
  ) {
    throw new Error("Invalid Jaeger submission claim");
  }
}

function validateSubmissionId(submissionId: string): void {
  if (!SUBMISSION_ID_PATTERN.test(submissionId)) {
    throw new BackendRpcError("invalid_request", "submissionId is invalid");
  }
}

function submissionKey(submissionId: string): string {
  return sha256(`submission\0${submissionId}`);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
