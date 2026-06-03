import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

describe('PD CLI Smoke Test', () => {
  it('should run successfully and load all dependencies including better-sqlite3 without errors', () => {
    const output = execFileSync('node', ['packages/pd-cli/dist/index.js', '--help'], {
      encoding: 'utf8',
      cwd: process.cwd(),
    });
    expect(output).toContain('Usage: pd');
  });
});
