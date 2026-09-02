import type { ProviderRuntimeEvent, SessionTurn } from "../types.js";

/** Serializes native event persistence without allowing a streaming transport
 * callback to race atomic session-record updates. */
export class NativeRuntimeReporter {
  private tail: Promise<void> = Promise.resolve();
  private error: unknown;

  constructor(
    private readonly session: SessionTurn,
    private readonly normalize: (message: unknown) => ProviderRuntimeEvent | undefined,
  ) {}

  observe(message: unknown): void {
    const event = this.normalize(message);
    if (!event || this.error !== undefined) return;
    this.tail = this.tail
      .then(async () => await this.session.providerEvent(event))
      .catch((error: unknown) => {
        this.error = error;
      });
  }

  async flush(): Promise<void> {
    await this.tail;
    if (this.error !== undefined) throw this.error;
  }
}
