/**
 * main.ts is an Electron main process and cannot be driven wholesale from
 * vitest. This suite locks the production wiring at the source level (the
 * repository already uses this pattern for evaluator gates):
 *
 *   - the Console has NO credential plumbing left (no token env probe, no
 *     encrypted token, no token IPC, no auth-mode mismatch repair);
 *   - workspace-worker supervision still coexists in the same main.ts.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAIN_SRC = fileURLToPath(new URL('../../src/main/main.ts', import.meta.url));

function src(): string {
  return fs.readFileSync(MAIN_SRC, 'utf8');
}

describe('Companion main.ts: credential-free Console + workspace workers', () => {
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

  it('still wires workspace-worker supervision and its degraded projection', () => {
    const source = src();
    expect(source).toContain('workspaceWorkers');
    expect(source).toContain('buildDegradedWorkspacesTrayView([');
    expect(source).toContain("event === 'workspace_worker_degraded'");
    expect(source).toContain("event === 'workspace_worker_stopped'");
    expect(source).toContain('notifyWorkspaceDegraded(workspace)');
  });
});
