/**
 * Parser-level tests for `pd activation promote` flags (CLI gate rule 7).
 *
 * Mirrors `run-rulehost-flag-wiring.test.ts`. Exercises the real
 * `registerRuntimeActivationPromoteCommand` helper (single source of truth
 * shared with `index.ts`). Flag typos in production surface here at
 * parseAsync time, not at handler dispatch.
 *
 * Covers:
 *   - --dry-run and --confirm are registered
 *   - --json is registered
 *   - --activation-id is required (Commander rejects missing required option)
 *   - --workspace / -w shorthand is registered
 *   - --no-dry-run / --no-confirm are NOT registered (no accidental negation)
 *
 * Handler-level behavior (mutual exclusivity enforcement, JSON output shape,
 * refusal reasons) is covered by runtime-activation.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';

import { registerRuntimeActivationPromoteCommand } from '../../src/commands/runtime-activation.js';

type ActionOptions = Record<string, unknown>;

interface CapturedAction {
  opts: ActionOptions | null;
}

function attachCapture(cmd: Command, state: CapturedAction): void {
  cmd.action(function captureAction(...args: unknown[]): void {
    let optsArg: unknown = null;
    for (let i = args.length - 1; i >= 0; i--) {
      const arg: unknown = args[i];
      if (arg !== null && typeof arg === 'object' && !(arg instanceof Command)) {
        optsArg = arg;
        break;
      }
    }
    if (optsArg !== null && typeof optsArg === 'object') {
      state.opts = optsArg as ActionOptions;
    } else {
      state.opts = {};
    }
  });
}

function freshProgram(): Command {
  const program = new Command();
  program.name('pd').exitOverride();
  return program;
}

describe('pd activation promote — flag wiring (CLI gate rule 7)', () => {
  // ── Option metadata ──────────────────────────────────────────────────────

  it('registers --dry-run flag', () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const promoteCmd = registerRuntimeActivationPromoteCommand(activationCmd);

    const opt = promoteCmd.options.find((o) => o.long === '--dry-run');
    expect(opt).toBeDefined();
    expect(opt?.long).toBe('--dry-run');
  });

  it('registers --confirm flag', () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const promoteCmd = registerRuntimeActivationPromoteCommand(activationCmd);

    const opt = promoteCmd.options.find((o) => o.long === '--confirm');
    expect(opt).toBeDefined();
    expect(opt?.long).toBe('--confirm');
  });

  it('registers --json flag', () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const promoteCmd = registerRuntimeActivationPromoteCommand(activationCmd);

    const opt = promoteCmd.options.find((o) => o.long === '--json');
    expect(opt).toBeDefined();
    expect(opt?.long).toBe('--json');
  });

  it('registers --activation-id as required option', () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const promoteCmd = registerRuntimeActivationPromoteCommand(activationCmd);

    const opt = promoteCmd.options.find((o) => o.long === '--activation-id');
    expect(opt).toBeDefined();
    expect(opt?.long).toBe('--activation-id');
    expect(opt?.required).toBe(true);
  });

  it('registers -w shorthand for --workspace', () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const promoteCmd = registerRuntimeActivationPromoteCommand(activationCmd);

    const opt = promoteCmd.options.find((o) => o.short === '-w');
    expect(opt).toBeDefined();
    expect(opt?.long).toBe('--workspace');
  });

  it('does NOT register --no-dry-run (no accidental negation)', () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const promoteCmd = registerRuntimeActivationPromoteCommand(activationCmd);

    const noForm = promoteCmd.options.find((o) => o.long === '--no-dry-run');
    expect(noForm).toBeUndefined();
  });

  it('does NOT register --no-confirm (no accidental negation)', () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const promoteCmd = registerRuntimeActivationPromoteCommand(activationCmd);

    const noForm = promoteCmd.options.find((o) => o.long === '--no-confirm');
    expect(noForm).toBeUndefined();
  });

  // ── Parser-level tests (program.parseAsync) ───────────────────────────────

  it('parses --dry-run as true', async () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const promoteCmd = registerRuntimeActivationPromoteCommand(activationCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(promoteCmd, captured);

    await program.parseAsync(['node', 'pd', 'activation', 'promote', '--activation-id', 'act-1', '--dry-run']);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.dryRun).toBe(true);
  });

  it('parses --confirm as true', async () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const promoteCmd = registerRuntimeActivationPromoteCommand(activationCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(promoteCmd, captured);

    await program.parseAsync(['node', 'pd', 'activation', 'promote', '--activation-id', 'act-1', '--confirm']);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.confirm).toBe(true);
  });

  it('parses both --dry-run and --confirm (handler enforces mutual exclusivity)', async () => {
    // Commander parses both flags; the handler validates mutual exclusivity.
    // This test proves the parser accepts both — the handler test in
    // runtime-activation.test.ts proves the handler rejects the combination.
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const promoteCmd = registerRuntimeActivationPromoteCommand(activationCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(promoteCmd, captured);

    await program.parseAsync(['node', 'pd', 'activation', 'promote', '--activation-id', 'act-1', '--dry-run', '--confirm']);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.dryRun).toBe(true);
    expect(captured.opts?.confirm).toBe(true);
  });

  it('defaults --dry-run and --confirm to undefined when neither is passed', async () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const promoteCmd = registerRuntimeActivationPromoteCommand(activationCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(promoteCmd, captured);

    await program.parseAsync(['node', 'pd', 'activation', 'promote', '--activation-id', 'act-1']);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.dryRun).toBeUndefined();
    expect(captured.opts?.confirm).toBeUndefined();
  });

  it('parses --json as true', async () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const promoteCmd = registerRuntimeActivationPromoteCommand(activationCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(promoteCmd, captured);

    await program.parseAsync(['node', 'pd', 'activation', 'promote', '--activation-id', 'act-1', '--json']);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.json).toBe(true);
  });

  it('parses -w shorthand for --workspace', async () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const promoteCmd = registerRuntimeActivationPromoteCommand(activationCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(promoteCmd, captured);

    await program.parseAsync(['node', 'pd', 'activation', 'promote', '--activation-id', 'act-1', '-w', '/tmp/test']);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.workspace).toBe('/tmp/test');
  });

  it('rejects missing --activation-id (required option)', async () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    registerRuntimeActivationPromoteCommand(activationCmd);

    // Commander should throw on missing required option
    await expect(
      program.parseAsync(['node', 'pd', 'activation', 'promote', '--dry-run']),
    ).rejects.toThrow(/activation-id/);
  });
});
