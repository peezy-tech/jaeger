const MINIMUM_PI_RPC_VERSION = [0, 80, 4] as const;
const PI_MAX_THINKING_VERSION = [0, 80, 6] as const;

export function assertSupportedPiVersion(version: string): void {
  assertPiVersionAtLeast(
    version,
    MINIMUM_PI_RPC_VERSION,
    `Pi ${version} is unsupported; pi-rpc requires Pi 0.80.4 or newer`,
    "Could not parse Pi version",
  );
}

export function assertPiMaxThinkingSupported(version: string): void {
  assertPiVersionAtLeast(
    version,
    PI_MAX_THINKING_VERSION,
    `Pi ${version} does not support max thinking; max requires Pi 0.80.6 or newer`,
    "Could not parse Pi version required for max thinking",
  );
}

function assertPiVersionAtLeast(
  version: string,
  minimumVersion: readonly number[],
  unsupportedMessage: string,
  parseMessage: string,
): void {
  const match = version.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/);
  if (!match) {
    throw new Error(`${parseMessage}: ${version || "(empty)"}`);
  }
  const installed = match.slice(1).map(Number);
  for (let index = 0; index < minimumVersion.length; index++) {
    const actual = installed[index] ?? 0;
    const minimum = minimumVersion[index] as number;
    if (actual > minimum) return;
    if (actual < minimum) throw new Error(unsupportedMessage);
  }
}
