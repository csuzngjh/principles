import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { getBuiltPdCliPath } from './helpers/pd-cli-path.js';

describe('PD CLI Smoke Test', () => {
  it('should run successfully and load all dependencies including better-sqlite3 without errors', () => {
    const output = execFileSync('node', [getBuiltPdCliPath(), '--help'], {
      encoding: 'utf8',
      cwd: process.cwd(),
    });
    expect(output).toContain('Usage: pd');
  });
});
