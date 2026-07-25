export class JaegerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class WorkflowCompileError extends JaegerError {}
export class WorkflowChangedError extends JaegerError {}
export class UncertainAgentRunError extends JaegerError {}
export class StructuredOutputError extends JaegerError {}
export class JournalCorruptionError extends JaegerError {}
export class RunOwnedError extends JaegerError {}
export class RunTerminalError extends JaegerError {}
export class RunStoppedError extends JaegerError {}

export class HarnessExecutionError extends JaegerError {
  readonly command: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;

  constructor(input: {
    readonly command: string;
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stderr: string;
    readonly message: string;
  }) {
    super(input.message);
    this.command = input.command;
    this.exitCode = input.exitCode;
    this.signal = input.signal;
    this.stderr = input.stderr;
  }
}
