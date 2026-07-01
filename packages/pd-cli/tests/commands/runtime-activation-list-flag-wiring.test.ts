/**
 * Parser-level tests for `pd activation list` flags (CLI gate rule 7).
 *
 * Mirrors `runtime-activation-promote-flag-wiring.test.ts`. Exercises the real
 * `registerRuntimeActivationListCommand` helper (single source of truth
 * shared with `index.ts`). Flag typos in production surface here at
 * parseAsync time, not at handler dispatch.
 *
 * Covers:
 *   - --json is registered
 *   - --workspace / -w and --channel / -c shorthand flags are registered
 *   - --include-deactivated is registered
 *   - --dry-run / --confirm / --no-json are NOT registered
 *
 * Handler-level behavior (filtering, JSON output shape) is covered by
 * runtime-activation.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';

import { registerRuntimeActivationListCommand } from '../../src/commands/runtime-activation.js';

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

describe('pd activation list — flag wiring (CLI gate rule 7)', () => {
  // ── Option metadata ──────────────────────────────────────────────────────

  it('registers --json flag', () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const listCmd = registerRuntimeActivationListCommand(activationCmd);

    const opt = listCmd.options.find((o) => o.long === '--json');
    expect(opt).toBeDefined();
    expect(opt?.long).toBe('--json');
  });

  it('registers -w shorthand for --workspace', () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const listCmd = registerRuntimeActivationListCommand(activationCmd);

    const opt = listCmd.options.find((o) => o.short === '-w');
    expect(opt).toBeDefined();
    expect(opt?.long).toBe('--workspace');
  });

  it('registers -c shorthand for --channel', () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const listCmd = registerRuntimeActivationListCommand(activationCmd);

    const opt = listCmd.options.find((o) => o.short === '-c');
    expect(opt).toBeDefined();
    expect(opt?.long).toBe('--channel');
  });

  it('registers --include-deactivated', () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const listCmd = registerRuntimeActivationListCommand(activationCmd);

    const opt = listCmd.options.find((o) => o.long === '--include-deactivated');
    expect(opt).toBeDefined();
    expect(opt?.long).toBe('--include-deactivated');
  });

  it('does NOT register --dry-run', () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const listCmd = registerRuntimeActivationListCommand(activationCmd);

    const opt = listCmd.options.find((o) => o.long === '--dry-run');
    expect(opt).toBeUndefined();
  });

  it('does NOT register --confirm', () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const listCmd = registerRuntimeActivationListCommand(activationCmd);

    const opt = listCmd.options.find((o) => o.long === '--confirm');
    expect(opt).toBeUndefined();
  });

  it('does NOT register --no-json (no accidental negation)', () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const listCmd = registerRuntimeActivationListCommand(activationCmd);

    const noForm = listCmd.options.find((o) => o.long === '--no-json');
    expect(noForm).toBeUndefined();
  });

  // ── Parser-level tests (program.parseAsync) ───────────────────────────────

  it('parses --json as true', async () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const listCmd = registerRuntimeActivationListCommand(activationCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(listCmd, captured);

    await program.parseAsync(['node', 'pd', 'activation', 'list', '--json']);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.json).toBe(true);
  });

  it('parses -w shorthand for --workspace', async () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const listCmd = registerRuntimeActivationListCommand(activationCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(listCmd, captured);

    await program.parseAsync(['node', 'pd', 'activation', 'list', '-w', '/tmp/test']);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.workspace).toBe('/tmp/test');
  });

  it('parses -c shorthand for --channel', async () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const listCmd = registerRuntimeActivationListCommand(activationCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(listCmd, captured);

    await program.parseAsync(['node', 'pd', 'activation', 'list', '-c', 'prompt']);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.channel).toBe('prompt');
  });

  it('parses --include-deactivated as true', async () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const listCmd = registerRuntimeActivationListCommand(activationCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(listCmd, captured);

    await program.parseAsync(['node', 'pd', 'activation', 'list', '--include-deactivated']);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.includeDeactivated).toBe(true);
  });

  it('defaults all flags to undefined when none passed', async () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const listCmd = registerRuntimeActivationListCommand(activationCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(listCmd, captured);

    await program.parseAsync(['node', 'pd', 'activation', 'list']);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.json).toBeUndefined();
    expect(captured.opts?.workspace).toBeUndefined();
    expect(captured.opts?.channel).toBeUndefined();
    expect(captured.opts?.includeDeactivated).toBeUndefined();
  });
});
