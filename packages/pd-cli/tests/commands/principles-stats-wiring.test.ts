/**
 * Parser-level tests for `pd principles stats` flags (CLI gate rule 7).
 *
 * Mirrors `runtime-activation-list-flag-wiring.test.ts`. Exercises the real
 * `registerPrinciplesCommand` helper (single source of truth shared with
 * index.ts). Flag typos in the production surface fail here at parseAsync
 * time, not at handler dispatch.
 *
 * Covers:
 *   - --json is registered; --no-json is NOT (no accidental negation)
 *   - --workspace / -w shorthand is registered
 *   - --days is registered with parseInt coercer
 *   - --dry-run / --confirm are NOT registered (read-only command, cli-4 N/A)
 *
 * Handler-level behavior (aggregation, JSON output shape) is covered by
 * principles-stats.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';

import { registerPrinciplesCommand } from '../../src/commands/principles-stats.js';

type ActionOptions = Record<string, unknown>;

interface CapturedAction {
  opts: ActionOptions | null;
}

function freshProgram(): Command {
  const program = new Command();
  program.name('pd').exitOverride();
  return program;
}

function registerWithCapture(program: Command, state: CapturedAction): Command {
  const principles = registerPrinciplesCommand(program);
  const statsCmd = principles.commands.find((c) => c.name() === 'stats');
  if (!statsCmd) throw new Error('stats subcommand not registered');
  statsCmd.action(function captureAction(...args: unknown[]): void {
    let optsArg: unknown = null;
    for (let i = args.length - 1; i >= 0; i--) {
      const arg: unknown = args[i];
      if (arg !== null && typeof arg === 'object' && !(arg instanceof Command)) {
        optsArg = arg;
        break;
      }
    }
    state.opts = optsArg !== null && typeof optsArg === 'object' ? (optsArg as ActionOptions) : {};
  });
  return statsCmd;
}

describe('pd principles stats — flag wiring (CLI gate rule 7)', () => {
  it('registers --json flag on the stats subcommand', () => {
    const program = freshProgram();
    const statsCmd = registerPrinciplesCommand(program).commands.find((c) => c.name() === 'stats');
    expect(statsCmd).toBeDefined();
    const opt = statsCmd?.options.find((o) => o.long === '--json');
    expect(opt).toBeDefined();
  });

  it('registers -w shorthand for --workspace', () => {
    const program = freshProgram();
    const statsCmd = registerPrinciplesCommand(program).commands.find((c) => c.name() === 'stats');
    const opt = statsCmd?.options.find((o) => o.short === '-w');
    expect(opt).toBeDefined();
    expect(opt?.long).toBe('--workspace');
  });

  it('registers --days', () => {
    const program = freshProgram();
    const statsCmd = registerPrinciplesCommand(program).commands.find((c) => c.name() === 'stats');
    const opt = statsCmd?.options.find((o) => o.long === '--days');
    expect(opt).toBeDefined();
  });

  it('does NOT register --dry-run or --confirm (read-only command)', () => {
    const program = freshProgram();
    const statsCmd = registerPrinciplesCommand(program).commands.find((c) => c.name() === 'stats');
    expect(statsCmd?.options.find((o) => o.long === '--dry-run')).toBeUndefined();
    expect(statsCmd?.options.find((o) => o.long === '--confirm')).toBeUndefined();
  });

  it('does NOT register --no-json (no accidental negation)', () => {
    const program = freshProgram();
    const statsCmd = registerPrinciplesCommand(program).commands.find((c) => c.name() === 'stats');
    expect(statsCmd?.options.find((o) => o.long === '--no-json')).toBeUndefined();
  });

  // ── Parser-level tests (program.parseAsync) ───────────────────────────────

  it('parses --json as true through the full command path', async () => {
    const program = freshProgram();
    const captured: CapturedAction = { opts: null };
    registerWithCapture(program, captured);

    await program.parseAsync(['node', 'pd', 'principles', 'stats', '--json']);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.json).toBe(true);
  });

  it('parses -w shorthand for --workspace', async () => {
    const program = freshProgram();
    const captured: CapturedAction = { opts: null };
    registerWithCapture(program, captured);

    await program.parseAsync(['node', 'pd', 'principles', 'stats', '-w', '/tmp/ws']);

    expect(captured.opts?.workspace).toBe('/tmp/ws');
  });

  it('parses --days as a number via the parseInt coercer', async () => {
    const program = freshProgram();
    const captured: CapturedAction = { opts: null };
    registerWithCapture(program, captured);

    await program.parseAsync(['node', 'pd', 'principles', 'stats', '--days', '30']);

    expect(captured.opts?.days).toBe(30);
  });

  it('defaults all options to undefined when none passed', async () => {
    const program = freshProgram();
    const captured: CapturedAction = { opts: null };
    registerWithCapture(program, captured);

    await program.parseAsync(['node', 'pd', 'principles', 'stats']);

    expect(captured.opts?.json).toBeUndefined();
    expect(captured.opts?.workspace).toBeUndefined();
    expect(captured.opts?.days).toBeUndefined();
  });
});
