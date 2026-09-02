import type {
  HarnessDriver,
  HarnessName,
  JsonValue,
} from "./types.js";

export type ProviderAuthStatus =
  | "unknown"
  | "authenticating"
  | "authenticated"
  | "unauthenticated"
  | "error";

export type ProviderIdentityFreshness = "unknown" | "fresh" | "stale" | "uncertain";

export interface ProviderAccountIdentity {
  readonly id?: string;
  readonly email?: string;
  readonly label?: string;
  readonly type?: string;
}

export interface ProviderAuthState {
  readonly status: ProviderAuthStatus;
  readonly error?: string;
  readonly observedAt?: string;
}

/**
 * Public provider identity state. This is deliberately an allowlisted
 * projection: native account/auth payloads may contain credentials, cookies,
 * or refresh tokens, but none of those values are part of this record.
 */
export interface ProviderIdentitySnapshot {
  readonly provider: HarnessName;
  readonly driver: HarnessDriver;
  readonly account?: ProviderAccountIdentity | null;
  readonly auth: ProviderAuthState;
  readonly freshness: ProviderIdentityFreshness;
  readonly observedAt?: string;
  readonly lastError?: string;
}

export interface ProviderIdentityUpdate {
  readonly account?: unknown;
  readonly auth?: unknown;
  readonly observedAt?: string;
}

const MAX_IDENTITY_FIELD_LENGTH = 256;
const MAX_ERROR_LENGTH = 512;
const SENSITIVE_KEY_PATTERN =
  /(?:access[_-]?token|api[_-]?key|authorization|bearer|cookie|credential|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token)/i;

export function createInitialProviderIdentity(
  provider: HarnessName,
  driver: HarnessDriver,
): ProviderIdentitySnapshot {
  return {
    provider,
    driver,
    auth: { status: "unknown" },
    freshness: "unknown",
  };
}

export function applyProviderIdentityUpdate(
  current: ProviderIdentitySnapshot,
  update: ProviderIdentityUpdate,
  observedAt = new Date().toISOString(),
): ProviderIdentitySnapshot {
  const account = update.account === undefined
    ? current.account
    : normalizeAccount(update.account);
  const auth = update.auth === undefined
    ? current.auth
    : normalizeAuth(update.auth, observedAt);
  const observation = update.observedAt ?? observedAt;
  const { lastError: _lastError, ...withoutPriorError } = current;
  return {
    ...withoutPriorError,
    ...(account === undefined ? {} : { account }),
    auth,
    freshness: "fresh",
    observedAt: observation,
    ...(auth.error ? { lastError: auth.error } : {}),
  };
}

export function markProviderIdentityStale(
  identity: ProviderIdentitySnapshot,
): ProviderIdentitySnapshot {
  if (identity.freshness === "uncertain") return identity;
  return { ...identity, freshness: "stale" };
}

export function markProviderIdentityUncertain(
  identity: ProviderIdentitySnapshot,
  error?: unknown,
): ProviderIdentitySnapshot {
  const lastError = error === undefined ? identity.lastError : redactSensitiveText(error);
  return {
    ...identity,
    freshness: "uncertain",
    ...(lastError ? { lastError } : {}),
  };
}

export function parseProviderIdentitySnapshot(value: unknown): ProviderIdentitySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid provider identity snapshot");
  }
  const record = value as Record<string, unknown>;
  assertStoredIdentityShape(record);
  if (
    typeof record.provider !== "string" ||
    record.provider.trim().length === 0 ||
    !isHarnessDriver(record.driver) ||
    !isProviderAuthStatus(recordAuth(record.auth).status) ||
    !isProviderIdentityFreshness(record.freshness)
  ) {
    throw new Error("Invalid provider identity snapshot");
  }
  const observedAt = optionalIso(record.observedAt);
  const auth = normalizeAuth(record.auth, record.observedAt);
  const authObservedAt = auth.observedAt ?? observedAt;
  const account = record.account === undefined ? undefined : normalizeAccount(record.account);
  return {
    provider: record.provider,
    driver: record.driver,
    ...(account === undefined ? {} : { account }),
    auth: authObservedAt ? { ...auth, observedAt: authObservedAt } : auth,
    freshness: record.freshness,
    ...(observedAt ? { observedAt } : {}),
    ...(typeof record.lastError === "string"
      ? { lastError: redactSensitiveText(record.lastError) }
      : {}),
  };
}

function assertStoredIdentityShape(record: Record<string, unknown>): void {
  assertKnownKeys(record, [
    "provider",
    "driver",
    "account",
    "auth",
    "freshness",
    "observedAt",
    "lastError",
  ]);
  if (
    (record.observedAt !== undefined && optionalIso(record.observedAt) === undefined) ||
    (record.lastError !== undefined &&
      (typeof record.lastError !== "string" || record.lastError.length > MAX_ERROR_LENGTH))
  ) {
    throw new Error("Invalid provider identity snapshot");
  }
  if (record.account !== undefined && record.account !== null) {
    const account = jsonRecord(record.account);
    if (!account) throw new Error("Invalid provider identity snapshot");
    assertKnownKeys(account, ["id", "email", "label", "type"]);
    for (const value of Object.values(account)) {
      if (typeof value !== "string" || value.length > MAX_IDENTITY_FIELD_LENGTH) {
        throw new Error("Invalid provider identity snapshot");
      }
    }
  }
  const auth = jsonRecord(record.auth);
  if (!auth) throw new Error("Invalid provider identity snapshot");
  assertKnownKeys(auth, ["status", "error", "observedAt"]);
  if (
    (auth.error !== undefined &&
      (typeof auth.error !== "string" || auth.error.length > MAX_ERROR_LENGTH)) ||
    (auth.observedAt !== undefined && optionalIso(auth.observedAt) === undefined)
  ) {
    throw new Error("Invalid provider identity snapshot");
  }
}

function assertKnownKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = new Set(allowed);
  if (Object.keys(record).some((key) => !keys.has(key))) {
    throw new Error("Invalid provider identity snapshot");
  }
}

export function providerIdentityUpdateFromCodexMessage(
  message: unknown,
): ProviderIdentityUpdate | undefined {
  const record = jsonRecord(message);
  if (record?.method !== "account/updated") return undefined;
  const params = jsonRecord(record.params);
  if (!params || !("account" in params)) return { auth: { status: "unknown" } };
  const account = params.account;
  return {
    account,
    auth: { status: account === null ? "unauthenticated" : "authenticated" },
  };
}

export function providerIdentityUpdateFromClaudeMessage(
  message: unknown,
): ProviderIdentityUpdate | undefined {
  const record = jsonRecord(message);
  if (record?.type !== "auth_status") return undefined;
  const error = typeof record.error === "string" ? record.error : undefined;
  const status: ProviderAuthStatus =
    record.isAuthenticating === true
      ? "authenticating"
      : error
        ? "error"
        : record.isAuthenticated === true
          ? "authenticated"
          : record.isAuthenticated === false
            ? "unauthenticated"
            : "unknown";
  return {
    auth: {
      status,
      ...(error ? { error } : {}),
    },
  };
}

export function redactSensitiveText(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  const redacted = text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      new RegExp(
        `(${SENSITIVE_KEY_PATTERN.source})\\s*[:=]\\s*([^\\s,;]+)`,
        "gi",
      ),
      "$1=[REDACTED]",
    )
    .replace(/\b(?:sk|sess|tok|key)_[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
  return redacted.slice(0, MAX_ERROR_LENGTH);
}

function normalizeAccount(value: unknown): ProviderAccountIdentity | null | undefined {
  if (value === null) return null;
  const record = jsonRecord(value);
  if (!record) return undefined;
  const nested = jsonRecord(record.account);
  const candidate = nested ?? record;
  const id = firstSafeString(candidate, ["id", "accountId", "account_id", "userId", "user_id"]);
  const email = firstSafeString(candidate, ["email", "emailAddress", "email_address"]);
  const label = firstSafeString(candidate, ["label", "name", "subscriptionType", "planType"]);
  const type = firstSafeString(candidate, ["type", "authType", "auth_type", "tokenSource"]);
  if (!id && !email && !label && !type) return undefined;
  return {
    ...(id ? { id } : {}),
    ...(email ? { email } : {}),
    ...(label ? { label } : {}),
    ...(type ? { type } : {}),
  };
}

function normalizeAuth(value: unknown, observedAt?: unknown): ProviderAuthState {
  const record = recordAuth(value);
  const status = authStatus(record);
  const error = typeof record.error === "string" ? redactSensitiveText(record.error) : undefined;
  const at = optionalIso(observedAt) ?? optionalIso(record.observedAt);
  const normalizedAuth: ProviderAuthState = {
    status,
    ...(error ? { error } : {}),
    ...(at ? { observedAt: at } : {}),
  };
  return normalizedAuth;
}

function recordAuth(value: unknown): Record<string, unknown> {
  return jsonRecord(value) ?? {};
}

function authStatus(record: Record<string, unknown>): ProviderAuthStatus {
  if (isProviderAuthStatus(record.status)) return record.status;
  if (record.isAuthenticating === true) return "authenticating";
  if (typeof record.authenticated === "boolean") {
    return record.authenticated ? "authenticated" : "unauthenticated";
  }
  if (typeof record.isAuthenticated === "boolean") {
    return record.isAuthenticated ? "authenticated" : "unauthenticated";
  }
  if (typeof record.error === "string" && record.error.trim().length > 0) return "error";
  return "unknown";
}

function firstSafeString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    if (SENSITIVE_KEY_PATTERN.test(key)) continue;
    const value = record[key];
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (!normalized || SENSITIVE_KEY_PATTERN.test(normalized)) continue;
    return normalized.slice(0, MAX_IDENTITY_FIELD_LENGTH);
  }
  return undefined;
}

function optionalIso(value: unknown): string | undefined {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function isHarnessDriver(value: unknown): value is HarnessDriver {
  return value === "codex-app-server" || value === "claude-agent-sdk" || value === "pi-rpc";
}

function isProviderAuthStatus(value: unknown): value is ProviderAuthStatus {
  return value === "unknown" || value === "authenticating" || value === "authenticated" || value === "unauthenticated" || value === "error";
}

function isProviderIdentityFreshness(value: unknown): value is ProviderIdentityFreshness {
  return value === "unknown" || value === "fresh" || value === "stale" || value === "uncertain";
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export type ProviderIdentityJson = JsonValue;
