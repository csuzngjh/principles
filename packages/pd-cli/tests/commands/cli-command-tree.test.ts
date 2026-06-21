/**
 * CLI command tree structure tests — verify command placement.
 *
 * These tests ensure that commands are registered at the correct path in the CLI tree.
 *
 * Performance: help output is cached per unique command path so that repeated
 * assertions on the same subcommand (e.g. "runtime uat --help") only spawn
 * one child process instead of one per test.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { getBuiltPdCliPath } from '../helpers/pd-cli-path.js';

const helpCache = new Map<string, string>();

function runPdHelp(args: string[]): string {
  const key = args.join(' ');
  const cached = helpCache.get(key);
  if (cached !== undefined) return cached;

  try {
    const output = execFileSync('node', [getBuiltPdCliPath(), ...args], {
      encoding: 'utf8',
      cwd: process.cwd(),
    });
    helpCache.set(key, output);
    return output;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'stdout' in err) {
      const output = String((err as { stdout: unknown }).stdout);
      helpCache.set(key, output);
      return output;
    }
    throw err;
  }
}

describe('CLI command tree structure', () => {
  // Pre-warm the cache for the most commonly used help paths.
  // This runs the expensive child-process spawns once, and all individual
  // tests read from the cache (effectively instant).
  beforeAll(() => {
    runPdHelp(['runtime', 'uat', '--help']);
    runPdHelp(['runtime', '--help']);
    runPdHelp(['runtime', 'pruning', '--help']);
    runPdHelp(['runtime', 'health', 'snapshot', '--help']);
    runPdHelp(['runtime', 'activation', 'edit', '--help']);
    runPdHelp(['runtime', 'activation', '--help']);
    runPdHelp(['rulecode', '--help']);
    runPdHelp(['rulecode', 'spec', '--help']);
    runPdHelp(['rulecode', 'validate', '--help']);
    runPdHelp(['rulecode', 'replay', '--help']);
    runPdHelp(['legacy', 'cleanup', '--help']);
  });

  it('uat command exists under runtime (pd runtime uat --help)', () => {
    const output = runPdHelp(['runtime', 'uat', '--help']);
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
    expect(output).toMatch(/uat\s/);
  });

  it('pruning subcommand list does NOT include uat (pd runtime pruning --help)', () => {
    const output = runPdHelp(['runtime', 'pruning', '--help']);
    expect(output).toContain('report');
    expect(output).toContain('explain');
    expect(output).toContain('review');
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

  it('activation edit command exists under runtime activation (pd runtime activation edit --help)', () => {
    const output = runPdHelp(['runtime', 'activation', 'edit', '--help']);
    expect(output).toContain('--approval-id');
    expect(output).toContain('--new-artifact-id');
    expect(output).toContain('--edit-reason');
    expect(output).toContain('--workspace');
    expect(output).toContain('--json');
  });

  it('activation subcommand list includes edit (pd runtime activation --help)', () => {
    const output = runPdHelp(['runtime', 'activation', '--help']);
    expect(output).toMatch(/edit\s/);
  });

  it('rulecode command exists with spec/validate/replay subcommands (pd rulecode --help)', () => {
    const output = runPdHelp(['rulecode', '--help']);
    expect(output).toContain('spec');
    expect(output).toContain('validate');
    expect(output).toContain('replay');
  });

  it('rulecode spec subcommand has --json and --workspace (pd rulecode spec --help)', () => {
    const output = runPdHelp(['rulecode', 'spec', '--help']);
    expect(output).toContain('--json');
    expect(output).toContain('--workspace');
  });

  it('rulecode validate subcommand has --code, --code-file, --json (pd rulecode validate --help)', () => {
    const output = runPdHelp(['rulecode', 'validate', '--help']);
    expect(output).toContain('--code');
    expect(output).toContain('--code-file');
    expect(output).toContain('--json');
  });

  it('rulecode replay subcommand has --golden-trace (required), --code, --json (pd rulecode replay --help)', () => {
    const output = runPdHelp(['rulecode', 'replay', '--help']);
    expect(output).toContain('--golden-trace');
    expect(output).toContain('--code');
    expect(output).toContain('--json');
  });

  it('legacy cleanup subcommand has --dry-run, --apply, --json (pd legacy cleanup --help)', () => {
    const output = runPdHelp(['legacy', 'cleanup', '--help']);
    expect(output).toContain('--dry-run');
    expect(output).toContain('--apply');
    expect(output).toContain('--json');
    expect(output).toContain('--workspace');
  });

  it('legacy cleanup description mentions V1 Artificer artifacts', () => {
    const output = runPdHelp(['legacy', 'cleanup', '--help']);
    expect(output).toContain('V1 Artificer');
  });
});
