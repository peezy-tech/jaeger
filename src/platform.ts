export function supportsLocalRuntime(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "linux";
}

export function assertLocalRuntimeSupported(
  operation: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (supportsLocalRuntime(platform)) return;
  throw new Error(
    `${operation} is available only on a Linux Jaeger runtime host. ` +
      "This Windows installation is an SSH controller: register a Linux host with " +
      "'jaeger runtime add NAME --ssh HOST --default' and run the operation against that target",
  );
}
