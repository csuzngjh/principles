/**
 * Parser-level tests for `pd activation approve` flags (CLI gate rule 7).
 *
 * Mirrors `runtime-activation-promote-flag-wiring.test.ts`. Exercises the real
 * `registerRuntimeActivationApproveCommand` helper (single source of truth
 * shared with `index.ts`). Flag typos in production surface here at
 * parseAsync time, not at handler dispatch.
 *
 * Covers:
 *   - --approval-id / -a is required (Commander rejects missing required option)
 *   - --decided-by, --note, --json are registered
 *   - --workspace / -w shorthand is registered
 *   - --dry-run / --confirm / --no-json are NOT registered
 *
 * Handler-level behavior (approval dispatch, JSON output shape) is covered by
 * runtime-activation.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';

import { registerRuntimeActivationApproveCommand } from '../../src/commands/runtime-activation.js';

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

describe('pd activation approve — flag wiring (CLI gate rule 7)', () => {
  // ── Option metadata ──────────────────────────────────────────────────────

  it('registers -a, --approval-id as required option', () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const approveCmd = registerRuntimeActivationApproveCommand(activationCmd);

    const opt = approveCmd.options.find((o) => o.long === '--approval-id');
    expect(opt).toBeDefined();
    expect(opt?.long).toBe('--approval-id');
    expect(opt?.short).toBe('-a');
    expect(opt?.required).toBe(true);
  });

  it('registers --decided-by flag', () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const approveCmd = registerRuntimeActivationApproveCommand(activationCmd);

    const opt = approveCmd.options.find((o) => o.long === '--decided-by');
    expect(opt).toBeDefined();
    expect(opt?.long).toBe('--decided-by');
  });

  it('registers --note flag', () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const approveCmd = registerRuntimeActivationApproveCommand(activationCmd);

    const opt = approveCmd.options.find((o) => o.long === '--note');
    expect(opt).toBeDefined();
    expect(opt?.long).toBe('--note');
  });

  it('registers --json flag', () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const approveCmd = registerRuntimeActivationApproveCommand(activationCmd);

    const opt = approveCmd.options.find((o) => o.long === '--json');
    expect(opt).toBeDefined();
    expect(opt?.long).toBe('--json');
  });

  it('registers -w shorthand for --workspace', () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const approveCmd = registerRuntimeActivationApproveCommand(activationCmd);

    const opt = approveCmd.options.find((o) => o.short === '-w');
    expect(opt).toBeDefined();
    expect(opt?.long).toBe('--workspace');
  });

  it('does NOT register --dry-run', () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const approveCmd = registerRuntimeActivationApproveCommand(activationCmd);

    const opt = approveCmd.options.find((o) => o.long === '--dry-run');
    expect(opt).toBeUndefined();
  });

  it('does NOT register --confirm', () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const approveCmd = registerRuntimeActivationApproveCommand(activationCmd);

    const opt = approveCmd.options.find((o) => o.long === '--confirm');
    expect(opt).toBeUndefined();
  });

  it('does NOT register --no-json (no accidental negation)', () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const approveCmd = registerRuntimeActivationApproveCommand(activationCmd);

    const noForm = approveCmd.options.find((o) => o.long === '--no-json');
    expect(noForm).toBeUndefined();
  });

  // ── Parser-level tests (program.parseAsync) ───────────────────────────────

  it('parses --approval-id and --json', async () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const approveCmd = registerRuntimeActivationApproveCommand(activationCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(approveCmd, captured);

    await program.parseAsync(['node', 'pd', 'activation', 'approve', '--approval-id', 'apr-1', '--json']);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.approvalId).toBe('apr-1');
    expect(captured.opts?.json).toBe(true);
  });

  it('parses -a shorthand for --approval-id', async () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const approveCmd = registerRuntimeActivationApproveCommand(activationCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(approveCmd, captured);

    await program.parseAsync(['node', 'pd', 'activation', 'approve', '-a', 'apr-1']);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.approvalId).toBe('apr-1');
  });

  it('parses --decided-by with value', async () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const approveCmd = registerRuntimeActivationApproveCommand(activationCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(approveCmd, captured);

    await program.parseAsync(['node', 'pd', 'activation', 'approve', '--approval-id', 'apr-1', '--decided-by', 'alice']);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.decidedBy).toBe('alice');
  });

  it('parses --note with value', async () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const approveCmd = registerRuntimeActivationApproveCommand(activationCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(approveCmd, captured);

    await program.parseAsync(['node', 'pd', 'activation', 'approve', '--approval-id', 'apr-1', '--note', 'looks good']);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.note).toBe('looks good');
  });

  it('parses -w shorthand for --workspace', async () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const approveCmd = registerRuntimeActivationApproveCommand(activationCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(approveCmd, captured);

    await program.parseAsync(['node', 'pd', 'activation', 'approve', '--approval-id', 'apr-1', '-w', '/tmp/test']);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.workspace).toBe('/tmp/test');
  });

  it('rejects missing --approval-id (required option)', async () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    registerRuntimeActivationApproveCommand(activationCmd);

    // Commander should throw on missing required option
    await expect(
      program.parseAsync(['node', 'pd', 'activation', 'approve', '--json']),
    ).rejects.toThrow(/approval-id/);
  });

  it('defaults --json to undefined when not passed', async () => {
    const program = freshProgram();
    const activationCmd = program.command('activation');
    const approveCmd = registerRuntimeActivationApproveCommand(activationCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(approveCmd, captured);

    await program.parseAsync(['node', 'pd', 'activation', 'approve', '--approval-id', 'apr-1']);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.json).toBeUndefined();
  });
});
