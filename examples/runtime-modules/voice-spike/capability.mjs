import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";

export async function readOrCreateCapabilityToken(
  capabilityFile,
  {
    createToken = () => randomBytes(32).toString("base64url"),
  } = {},
) {
  if (!capabilityFile) throw new Error("A capability-token file is required");
  const directory = dirname(capabilityFile);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryMode = (await stat(directory)).mode & 0o777;
  if ((directoryMode & 0o022) !== 0) {
    throw new Error(`Capability-token directory must not be writable by others: ${directory}`);
  }
  try {
    const handle = await open(capabilityFile, "wx", 0o600);
    try {
      await handle.writeFile(`${createToken()}\n`, "utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  const mode = (await stat(capabilityFile)).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`Capability-token file must be owner-only: ${capabilityFile}`);
  }
  const token = (await readFile(capabilityFile, "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error(`Capability-token file contains an invalid token: ${capabilityFile}`);
  }
  return token;
}

export function assertCapability(request, expectedToken) {
  const token = bearerCapability(request);
  if (!token || !safeEqual(token, expectedToken)) {
    const error = new Error("Capability token required");
    error.statusCode = 401;
    throw error;
  }
}

export function bearerCapability(request) {
  const authorization = request.headers.authorization;
  const match =
    typeof authorization === "string"
      ? /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization)
      : null;
  return match?.[1] ?? null;
}

function safeEqual(actual, expected) {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}
