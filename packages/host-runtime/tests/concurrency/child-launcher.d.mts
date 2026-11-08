/** Type surface for the ESM child launcher (implementation: child-launcher.mjs). */
export function launchTelemetryChild(config: Record<string, string>): {
  stdin: { write(chunk: string): void };
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  exitCode: number | null;
  on(event: string, listener: (...args: never[]) => void): unknown;
  kill(): void;
};
