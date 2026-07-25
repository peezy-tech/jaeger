import path from "node:path";

export function systemdRunCommand(env: NodeJS.ProcessEnv = process.env): string {
  return configuredLauncher(env.JAEGER_SYSTEMD_RUN, "systemd-run", "JAEGER_SYSTEMD_RUN");
}

export function systemctlCommand(env: NodeJS.ProcessEnv = process.env): string {
  return configuredLauncher(env.JAEGER_SYSTEMCTL, "systemctl", "JAEGER_SYSTEMCTL");
}

function configuredLauncher(
  configured: string | undefined,
  fallback: string,
  variable: string,
): string {
  if (configured === undefined) return fallback;
  if (
    !path.isAbsolute(configured) ||
    configured.includes("\0") ||
    configured.includes("\n") ||
    configured.includes("\r")
  ) {
    throw new Error(`${variable} must be an absolute path without control characters`);
  }
  return configured;
}
