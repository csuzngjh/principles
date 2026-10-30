import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';

const response = vi.hoisted(() => ({ workspaceDir: '' }));

vi.mock('node:child_process', () => ({
  spawn: () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ dryRun: true, workspaceDir: response.workspaceDir })));
      child.emit('close', 0);
    });
    return child;
  },
}));

import { probeCliDeactivateDryRun } from '../src/cli-recovery-probe.js';

describe('CLI recovery workspace matching', () => {
  it.each([
    ['C:\\Governed\\Project\\\\', 'c:/governed/project///', true],
    ['C:/governed/project', 'C:/governed/project-other', false],
    ['/', '////', true],
    ['', '', true],
    ['C:/governed//project/', 'c:/governed/project', false],
  ])('preserves matching semantics for %s versus %s', async (workspaceDir, reported, expected) => {
    response.workspaceDir = reported;
    const result = await probeCliDeactivateDryRun({ cliEntry: 'unused-mocked-entry', workspaceDir });
    expect(result.workspaceMatched).toBe(expected);
    expect(result.ok).toBe(expected);
  });

  it('rejects an adversarial nonmatching path without quadratic slash rescanning', async () => {
    // A long slash run followed by a non-slash forces an unanchored trailing
    // slash regex to retry at every position. The CLI JSON is untrusted;
    // workspace checks must remain bounded even for a malicious response.
    response.workspaceDir = `C:/governed/${'/'.repeat(250_000)}different`;
    const startedAt = performance.now();
    const result = await probeCliDeactivateDryRun({ cliEntry: 'unused-mocked-entry', workspaceDir: 'C:/governed/project' });
    expect(result.ok).toBe(false);
    expect(result.workspaceMatched).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(3000);
  });
});
