/**
 * main.ts is an Electron main process and cannot be driven wholesale from
 * vitest. This suite locks the production wiring at the source level (the
 * repository already uses this pattern for evaluator gates):
 *
 *   - the Console has NO credential plumbing left (no token env probe, no
 *     encrypted token, no token IPC, no auth-mode mismatch repair);
 *   - Console supervision is the only child-process responsibility left.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAIN_SRC = fileURLToPath(new URL('../../src/main/main.ts', import.meta.url));

function src(): string {
  return fs.readFileSync(MAIN_SRC, 'utf8');
}

describe('Companion main.ts: credential-free Console control plane', () => {
  it('has removed every Console credential path', () => {
    const source = src();
    for (const gone of [
      'PD_CONSOLE_TOKEN',
      'encryptedConsoleToken',
      'configureConsoleToken',
      'getConsoleToken',
      'clearConsoleToken',
      'console_authentication_mode_mismatch',
      'Authorization: `Bearer',
    ]) {
      expect(source, `main.ts must not contain ${gone}`).not.toContain(gone);
    }
  });

  it('keeps Console supervision while worker supervision is absent', () => {
    const source = src();
    expect(source).toContain('function spawnCli()');
    expect(source).toContain("PD_INVOCATION_SOURCE: 'companion'");
    expect(source).not.toContain('WorkspaceWorkerRegistry');
    expect(source).not.toContain('workspace_worker_');
  });
});
