export async function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
  abortMessage = "Operation aborted",
): Promise<void> {
  const reason = (): Error =>
    signal?.reason instanceof Error ? signal.reason : new Error(abortMessage);
  if (signal?.aborted) throw reason();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      operation();
    };
    const timeout = setTimeout(() => finish(resolve), milliseconds);
    const onAbort = (): void => {
      clearTimeout(timeout);
      finish(() => reject(reason()));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
