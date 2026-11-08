/**
 * Child launcher for the PRI-1151 cross-process concurrency tests.
 *
 * Launches the REAL built production code (dist/) in a separate OS process:
 * fork() with a LITERAL module path, no dynamic argv and no dynamic env —
 * every child input (home dir, mode, mode args) travels on the child's
 * stdin as a CONFIG line. The vitest working directory (the package root)
 * resolves the literal; a wrong cwd fails loudly in the child's stderr.
 */

import { fork } from 'node:child_process';

export function launchTelemetryChild(config) {
  const child = fork('tests/concurrency/telemetry-child.mjs', [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  child.stdin.write(`CONFIG ${JSON.stringify(config)}\n`);
  return child;
}
