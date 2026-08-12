/**
 * Parser-level tests for `pd rulecode spec|validate|replay` flags (PRI-439 Phase 5).
 *
 * CLI gate rule 7: "Test the real command wiring — when behavior depends on
 * Commander options, add a command-registration or parser test that exercises
 * the actual flags."
 *
 * Tests the real `registerRulecodeCommand` helper (single source of truth
 * shared with `index.ts`). Flag typos in production surface here at
 * parseAsync time, not at handler dispatch.
 *
 * Covers:
 *   - `spec` subcommand: --json, --workspace/-w registered; no --code
 *   - `validate` subcommand: --code required, --code-file, --json, --workspace/-w
 *   - `replay` subcommand: --code required, --code-file, --golden-trace required,
 *     --json, --workspace/-w
 *   - --no-* negations are NOT registered (no accidental negation)
 *   - parseAsync actually dispatches the right opts to the handler
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerRulecodeCommand } from '../rulecode.js';

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

/** Find a subcommand by name, throwing if absent (replaces non-null assertions). */
function requireSubcommand(parent: Command, name: string): Command {
  const cmd = parent.commands.find((c) => c.name() === name);
  if (!cmd) throw new Error(`Expected subcommand "${name}" to be registered`);
  return cmd;
}

describe('pd rulecode — flag wiring (CLI gate rule 7)', () => {
  // ── spec subcommand ───────────────────────────────────────────────────────

  it('registers spec subcommand with --json and --workspace', () => {
    const program = freshProgram();
    const rulecodeCmd = registerRulecodeCommand(program);

    const specCmd = rulecodeCmd.commands.find((c) => c.name() === 'spec');
    expect(specCmd).toBeDefined();

    const jsonOpt = (specCmd as Command).options.find((o) => o.long === '--json');
    expect(jsonOpt).toBeDefined();

    const wsOpt = (specCmd as Command).options.find((o) => o.long === '--workspace');
    expect(wsOpt).toBeDefined();
    expect(wsOpt?.short).toBe('-w');
  });

  it('spec subcommand does NOT register --code', () => {
    const program = freshProgram();
    const rulecodeCmd = registerRulecodeCommand(program);

    const specCmd = rulecodeCmd.commands.find((c) => c.name() === 'spec');
    const codeOpt = (specCmd as Command).options.find((o) => o.long === '--code');
    expect(codeOpt).toBeUndefined();
  });

  // ── validate subcommand ───────────────────────────────────────────────────

  it('registers validate subcommand with --code, --code-file, --json, --workspace', () => {
    const program = freshProgram();
    const rulecodeCmd = registerRulecodeCommand(program);

    const validateCmd = rulecodeCmd.commands.find((c) => c.name() === 'validate');
    expect(validateCmd).toBeDefined();

    const codeOpt = (validateCmd as Command).options.find((o) => o.long === '--code');
    expect(codeOpt).toBeDefined();

    const codeFileOpt = (validateCmd as Command).options.find((o) => o.long === '--code-file');
    expect(codeFileOpt).toBeDefined();

    const jsonOpt = (validateCmd as Command).options.find((o) => o.long === '--json');
    expect(jsonOpt).toBeDefined();

    const wsOpt = (validateCmd as Command).options.find((o) => o.long === '--workspace');
    expect(wsOpt).toBeDefined();
    expect(wsOpt?.short).toBe('-w');
  });

  it('validate --code is NOT required at parser level (can use --code-file instead)', async () => {
    const program = freshProgram();
    const rulecodeCmd = registerRulecodeCommand(program);
    const validateCmd = requireSubcommand(rulecodeCmd, 'validate');
    const captured: CapturedAction = { opts: null };
    attachCapture(validateCmd, captured);

    // parseAsync should NOT reject when --code is missing (handler validates)
    await program.parseAsync(['node', 'pd', 'rulecode', 'validate', '--json']);

    expect(captured.opts).not.toBeNull();
    expect((captured.opts as ActionOptions).code).toBeUndefined();
  });

  // ── replay subcommand ─────────────────────────────────────────────────────

  it('registers replay subcommand with --code, --code-file, --golden-trace, --json, --workspace', () => {
    const program = freshProgram();
    const rulecodeCmd = registerRulecodeCommand(program);

    const replayCmd = rulecodeCmd.commands.find((c) => c.name() === 'replay');
    expect(replayCmd).toBeDefined();

    const codeOpt = (replayCmd as Command).options.find((o) => o.long === '--code');
    expect(codeOpt).toBeDefined();

    const codeFileOpt = (replayCmd as Command).options.find((o) => o.long === '--code-file');
    expect(codeFileOpt).toBeDefined();

    const gtOpt = (replayCmd as Command).options.find((o) => o.long === '--golden-trace');
    expect(gtOpt).toBeDefined();

    const jsonOpt = (replayCmd as Command).options.find((o) => o.long === '--json');
    expect(jsonOpt).toBeDefined();

    const wsOpt = (replayCmd as Command).options.find((o) => o.long === '--workspace');
    expect(wsOpt).toBeDefined();
    expect(wsOpt?.short).toBe('-w');
  });

  it('replay --golden-trace is required', () => {
    const program = freshProgram();
    const rulecodeCmd = registerRulecodeCommand(program);

    const replayCmd = rulecodeCmd.commands.find((c) => c.name() === 'replay');
    const gtOpt = (replayCmd as Command).options.find((o) => o.long === '--golden-trace');
    expect(gtOpt?.required).toBe(true);
  });

  // ── No accidental negations ───────────────────────────────────────────────

  it('does NOT register --no-json on any subcommand', () => {
    const program = freshProgram();
    const rulecodeCmd = registerRulecodeCommand(program);

    for (const sub of rulecodeCmd.commands) {
      const noJson = sub.options.find((o) => o.long === '--no-json');
      expect(noJson).toBeUndefined();
    }
  });

  // ── Parser-level dispatch ─────────────────────────────────────────────────

  it('parseAsync dispatches spec subcommand with json=true', async () => {
    const program = freshProgram();
    const rulecodeCmd = registerRulecodeCommand(program);
    const specCmd = requireSubcommand(rulecodeCmd, 'spec');
    const captured: CapturedAction = { opts: null };
    attachCapture(specCmd, captured);

    await program.parseAsync(['node', 'pd', 'rulecode', 'spec', '--json']);

    expect(captured.opts).not.toBeNull();
    expect((captured.opts as ActionOptions).json).toBe(true);
  });

  it('parseAsync dispatches validate with --code', async () => {
    const program = freshProgram();
    const rulecodeCmd = registerRulecodeCommand(program);
    const validateCmd = requireSubcommand(rulecodeCmd, 'validate');
    const captured: CapturedAction = { opts: null };
    attachCapture(validateCmd, captured);

    await program.parseAsync([
      'node', 'pd', 'rulecode', 'validate',
      '--code', 'function evaluate(input, helpers) { return { decision: "allow", matched: false, reason: "x" }; }',
      '--json',
    ]);

    expect(captured.opts).not.toBeNull();
    expect((captured.opts as ActionOptions).code).toContain('function evaluate');
    expect((captured.opts as ActionOptions).json).toBe(true);
  });

  it('parseAsync dispatches replay with --code and --golden-trace', async () => {
    const program = freshProgram();
    const rulecodeCmd = registerRulecodeCommand(program);
    const replayCmd = requireSubcommand(rulecodeCmd, 'replay');
    const captured: CapturedAction = { opts: null };
    attachCapture(replayCmd, captured);

    await program.parseAsync([
      'node', 'pd', 'rulecode', 'replay',
      '--code', 'function evaluate(input, helpers) { return { decision: "allow", matched: false, reason: "x" }; }',
      '--golden-trace', '/tmp/trace.json',
      '--json',
    ]);

    expect(captured.opts).not.toBeNull();
    expect((captured.opts as ActionOptions).code).toContain('function evaluate');
    expect((captured.opts as ActionOptions).goldenTrace).toBe('/tmp/trace.json');
    expect((captured.opts as ActionOptions).json).toBe(true);
  });

  it('parseAsync rejects replay without --golden-trace (requiredOption)', async () => {
    const program = freshProgram();
    registerRulecodeCommand(program);

    await expect(
      program.parseAsync([
        'node', 'pd', 'rulecode', 'replay',
        '--code', 'function evaluate() {}',
      ]),
    ).rejects.toThrow(/golden-trace/);
  });
});
