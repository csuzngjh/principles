import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('sync-plugin installation result truthfulness', () => {
  it('returns failure when gateway restart is not confirmed', () => {
    const source = readFileSync('packages/openclaw-plugin/scripts/sync-plugin.mjs', 'utf8');
    const start = source.indexOf('if (!restarted)');
    const restartFailure = source.slice(start, source.indexOf('} else {', start));

    expect(restartFailure).toContain('process.exitCode = 1');
    expect(restartFailure).toContain('INSTALLATION INCOMPLETE');
  });
});
