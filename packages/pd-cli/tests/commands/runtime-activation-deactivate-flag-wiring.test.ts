/**
 * Parser-level tests for `pd activation deactivate` flags (CLI gate rule 7).
 *
 * Mirrors `runtime-activation-promote-flag-wiring.test.ts`. Exercises the real
 * `registerRuntimeActivationDeactivateCommand` helper (single source of truth
 * shared with `index.ts`). Flag typos in production surface here at
 * parseAsync time, not at handler dispatch.
 *
 * Covers:
 *   - --activation-id is required (Commander rejects missing required option)
 *   - --json is registered
 *   - --workspace / -w shorthand is registered
 *   - --dry-run / --confirm / --no-json are NOT registered
 *
 * Handler-level behavior (deactivation idempotency, JSON output shape,
 * refusal reasons) is covered by runtime-activation.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';

import { registerRuntimeActivationDeactivateCommand } from '../../src/commands/runtime-activation.js';

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

describe('pd activation deactivate — flag wiring (CLI gate rule 7)', () => {
  // ── Option metadata ──────────────────────────────────────────────────────

  it('registers --activation-id as required option', () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const deactivateCmd = registerRuntimeActivationDeactivateCommand(activationCmd);

    const opt = deactivateCmd.options.find((o) => o.long === '--activation-id');
    expect(opt).toBeDefined();
    expect(opt?.long).toBe('--activation-id');
    expect(opt?.required).toBe(true);
  });

  it('registers --json flag', () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const deactivateCmd = registerRuntimeActivationDeactivateCommand(activationCmd);

    const opt = deactivateCmd.options.find((o) => o.long === '--json');
    expect(opt).toBeDefined();
    expect(opt?.long).toBe('--json');
  });

  it('registers -w shorthand for --workspace', () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const deactivateCmd = registerRuntimeActivationDeactivateCommand(activationCmd);

    const opt = deactivateCmd.options.find((o) => o.short === '-w');
    expect(opt).toBeDefined();
    expect(opt?.long).toBe('--workspace');
  });

  it('does NOT register --dry-run', () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const deactivateCmd = registerRuntimeActivationDeactivateCommand(activationCmd);

    const opt = deactivateCmd.options.find((o) => o.long === '--dry-run');
    expect(opt).toBeUndefined();
  });

  it('does NOT register --confirm', () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const deactivateCmd = registerRuntimeActivationDeactivateCommand(activationCmd);

    const opt = deactivateCmd.options.find((o) => o.long === '--confirm');
    expect(opt).toBeUndefined();
  });

  it('does NOT register --no-json (no accidental negation)', () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const deactivateCmd = registerRuntimeActivationDeactivateCommand(activationCmd);

    const noForm = deactivateCmd.options.find((o) => o.long === '--no-json');
    expect(noForm).toBeUndefined();
  });

  // ── Parser-level tests (program.parseAsync) ───────────────────────────────

  it('parses --activation-id and --json', async () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const deactivateCmd = registerRuntimeActivationDeactivateCommand(activationCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(deactivateCmd, captured);

    await program.parseAsync(['node', 'pd', 'activation', 'deactivate', '--activation-id', 'act-1', '--json']);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.activationId).toBe('act-1');
    expect(captured.opts?.json).toBe(true);
  });

  it('parses -w shorthand for --workspace', async () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const deactivateCmd = registerRuntimeActivationDeactivateCommand(activationCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(deactivateCmd, captured);

    await program.parseAsync(['node', 'pd', 'activation', 'deactivate', '--activation-id', 'act-1', '-w', '/tmp/test']);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.workspace).toBe('/tmp/test');
  });

  it('rejects missing --activation-id (required option)', async () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    registerRuntimeActivationDeactivateCommand(activationCmd);

    // Commander should throw on missing required option
    await expect(
      program.parseAsync(['node', 'pd', 'activation', 'deactivate', '--json']),
    ).rejects.toThrow(/activation-id/);
  });

  it('defaults --json to undefined when not passed', async () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const deactivateCmd = registerRuntimeActivationDeactivateCommand(activationCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(deactivateCmd, captured);

    await program.parseAsync(['node', 'pd', 'activation', 'deactivate', '--activation-id', 'act-1']);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.json).toBeUndefined();
  });
});
