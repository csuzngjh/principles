/**
 * CLI command tree tests for pd runtime internalization queue / wake-once.
 *
 * TDD: Tests verify the command tree is registered correctly.
 * These tests run against the built CLI (dist/index.js).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { getBuiltPdCliPath } from '../helpers/pd-cli-path.js';

function runPdHelp(args: string[]): string {
  try {
    return execFileSync('node', [getBuiltPdCliPath(), ...args], {
      encoding: 'utf8',
      cwd: process.cwd(),
    });
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'stdout' in err) {
      return String((err as { stdout: unknown }).stdout);
    }
    throw err;
  }
}

describe('CLI command tree: pd runtime internalization', () => {
  it('runtime internalization --help lists queue subcommand', () => {
    const output = runPdHelp(['runtime', 'internalization', '--help']);
    expect(output).toMatch(/queue\s/);
  });

  it('runtime internalization --help lists wake-once subcommand', () => {
    const output = runPdHelp(['runtime', 'internalization', '--help']);
    expect(output).toMatch(/wake-once\s/);
  });

  it('queue --help shows --workspace and --json options', () => {
    const output = runPdHelp(['runtime', 'internalization', 'queue', '--help']);
    expect(output).toContain('--workspace');
    expect(output).toContain('--json');
  });

  it('wake-once --help shows --dry-run, --workspace, --json options', () => {
    const output = runPdHelp(['runtime', 'internalization', 'wake-once', '--help']);
    expect(output).toContain('--dry-run');
    expect(output).toContain('--workspace');
    expect(output).toContain('--json');
  });

  it('runtime subcommand list includes internalization', () => {
    const output = runPdHelp(['runtime', '--help']);
    expect(output).toMatch(/internalization\s/);
  });
});
