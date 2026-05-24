/**
 * CLI command tree structure tests — verify command placement.
 *
 * These tests ensure that commands are registered at the correct path in the CLI tree.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

import * as path from 'node:path';

function runPdHelp(args: string[]): string {
  try {
    const monorepoRoot = path.resolve(process.cwd(), '../..');
    return execFileSync('node', ['packages/pd-cli/dist/index.js', ...args], {
      encoding: 'utf8',
      cwd: monorepoRoot,
    });
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'stdout' in err) {
      return String((err as { stdout: unknown }).stdout);
    }
    throw err;
  }
}

describe('CLI command tree structure', () => {
  it('uat command exists under runtime (pd runtime uat --help)', () => {
    const output = runPdHelp(['runtime', 'uat', '--help']);
    // Should contain UAT-specific options
    expect(output).toContain('--workspace');
    expect(output).toContain('--count');
    expect(output).toContain('--min-success-rate');
    expect(output).toContain('--json');
  });

  it('uat command description mentions Runtime V2 chain UAT', () => {
    const output = runPdHelp(['runtime', 'uat', '--help']);
    expect(output).toContain('UAT');
  });

  it('runtime subcommand list includes uat (pd runtime --help)', () => {
    const output = runPdHelp(['runtime', '--help']);
    // Should list 'uat' as a subcommand
    expect(output).toMatch(/uat\s/);
  });

  it('pruning subcommand list does NOT include uat (pd runtime pruning --help)', () => {
    const output = runPdHelp(['runtime', 'pruning', '--help']);
    // Should only have report, explain, review
    expect(output).toContain('report');
    expect(output).toContain('explain');
    expect(output).toContain('review');
    // Should NOT have uat
    expect(output).not.toMatch(/uat\s/);
  });

  it('health snapshot command exists under runtime health (pd runtime health snapshot --help)', () => {
    const output = runPdHelp(['runtime', 'health', 'snapshot', '--help']);
    expect(output).toContain('--workspace');
    expect(output).toContain('--json');
  });

  it('runtime subcommand list includes health (pd runtime --help)', () => {
    const output = runPdHelp(['runtime', '--help']);
    expect(output).toMatch(/health\s/);
  });

  it('run-once command exposes --openclaw-local and --openclaw-gateway flags', () => {
    const output = runPdHelp(['runtime', 'internalization', 'run-once', '--help']);
    expect(output).toContain('--openclaw-local');
    expect(output).toContain('--openclaw-gateway');
  });
});
