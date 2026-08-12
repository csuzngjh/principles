/**
 * PRI-455: CLI help snapshot test — pins the visible command set.
 *
 * Asserts that `pd --help` shows only MVP owner-facing commands,
 * and that operator/debug commands are hidden (de-surfaced, not deleted).
 *
 * Hidden commands still work when invoked explicitly — this test only
 * checks --help visibility, not functional behavior.
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
    if (err && typeof err === 'object' && Object.hasOwn(err, 'stdout')) {
      return String(Reflect.get(err, 'stdout'));
    }
    throw err;
  }
}

describe('PRI-455: pd --help shows only MVP owner commands', () => {
  const helpOutput = runPdHelp(['--help']);

  // ── Owner-facing commands that MUST be visible ──────────────────────────
  const OWNER_COMMANDS = [
    'pain',          // Step 1: Capture
    'diagnose',      // Step 2: Diagnose
    'candidate',     // Step 3: Proposal
    'console',       // Step 4: Review
    'activation',    // Step 5-6: Activate & Observe (promoted)
    'trace',         // Step 6: Observe (promoted)
    'health',        // Global health
    'config',        // Onboarding
    'task',          // Async diagnosis progress
    'runtime',       // runtime features (MVP-Core flag verification)
  ];

  for (const cmd of OWNER_COMMANDS) {
    it(`pd --help shows owner command: ${cmd}`, () => {
      // Anchor to line beginnings (like the hidden-command check) so the
      // assertion matches the command list entry, not description text.
      expect(helpOutput).toMatch(new RegExp(`^\\s+${cmd}\\b`, 'm'));
    });
  }

  // ── Operator commands that MUST be hidden from --help ───────────────────
  const HIDDEN_COMMANDS = [
    'samples',
    'evolution',
    'central',    // MVP-Gone, deleted
    'trajectory',
    'history',
    'context',
    'legacy',
    'artifact',
    'demo',
    'mvp',
    'quality',
    'rulecode',
  ];

  for (const cmd of HIDDEN_COMMANDS) {
    it(`pd --help does NOT show operator command: ${cmd}`, () => {
      expect(helpOutput).not.toMatch(new RegExp(`^\\s+${cmd}\\b`, 'm'));
    });
  }
});

describe('PRI-455: pd runtime --help shows only MVP owner subcommands', () => {
  const runtimeHelp = runPdHelp(['runtime', '--help']);

  // Owner-facing subcommands under runtime
  it('runtime --help shows features', () => {
    expect(runtimeHelp).toMatch(/\bfeatures\b/);
  });

  // Operator subcommands that should be hidden
  const HIDDEN_RUNTIME_SUBCOMMANDS = [
    'canary',
    'synthetic',
    'uat',
    'recovery',
    'pruning',
    'diagnostics',
    'probe',
    'flow',
  ];

  for (const cmd of HIDDEN_RUNTIME_SUBCOMMANDS) {
    it(`runtime --help does NOT show operator subcommand: ${cmd}`, () => {
      expect(runtimeHelp).not.toMatch(new RegExp(`^\\s+${cmd}\\b`, 'm'));
    });
  }
});

describe('PRI-455: promoted commands work at top-level', () => {
  it('pd trace --help shows trace subcommand', () => {
    const output = runPdHelp(['trace', '--help']);
    expect(output).toContain('show');
  });

  it('pd activation --help shows list and deactivate', () => {
    const output = runPdHelp(['activation', '--help']);
    expect(output).toContain('list');
    expect(output).toContain('deactivate');
  });
});

describe('PRI-455: hidden commands still function (de-surface, not delete)', () => {
  it('pd runtime probe --help still works (hidden but callable)', () => {
    const output = runPdHelp(['runtime', 'probe', '--help']);
    expect(output).toContain('--workspace');
    expect(output).toContain('--json');
  });

  it('pd runtime internalization queue --help still works', () => {
    const output = runPdHelp(['runtime', 'internalization', 'queue', '--help']);
    expect(output).toContain('--workspace');
    expect(output).toContain('--json');
  });

  it('pd legacy cleanup --help still works (hidden but callable)', () => {
    const output = runPdHelp(['legacy', 'cleanup', '--help']);
    expect(output).toContain('--dry-run');
    expect(output).toContain('--apply');
  });
});

describe('pd demo first-principle alias (Fix-24)', () => {
  // cli-7-test-wiring: verify the alias resolves to the same command as story-a.
  it('pd demo first-principle --help works and matches story-a', () => {
    const aliasOutput = runPdHelp(['demo', 'first-principle', '--help']);
    const storyAOutput = runPdHelp(['demo', 'story-a', '--help']);

    // Both should show the same options
    expect(aliasOutput).toContain('--workspace');
    expect(aliasOutput).toContain('--json');
    expect(aliasOutput).toContain('--channels');
    // Alias output should be identical to story-a output
    expect(aliasOutput).toBe(storyAOutput);
  });
});
