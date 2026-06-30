/**
 * Parser-level tests for `pd runtime internalization run-rulehost` flags (PRI-429).
 *
 * CLI gate rule 7: "Test the real command wiring — when behavior depends on
 * Commander options, add a command-registration or parser test that exercises
 * the actual flags."
 *
 * Tests the real `registerRunRuleHostCommand` helper (single source of truth
 * shared with `index.ts`). Flag typos in production surface here at
 * parseAsync time, not at handler dispatch.
 *
 * Covers:
 *   - --dry-run and --confirm are registered
 *   - --dry-run and --confirm can both be parsed
 *   - --json is registered
 *   - --pain-id is required (Commander rejects missing required option)
 *   - --workspace / -w shorthand is registered
 *   - --no-dry-run / --no-confirm are NOT registered (no accidental negation)
 *   - mutual exclusivity is enforced at handler level (not parser level —
 *     Commander doesn't natively support .conflicts() for boolean flags
 *     without explicit registration; the handler validates this)
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerRunRuleHostCommand } from '../runtime-internalization-run-rulehost.js';

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

describe('pd runtime internalization run-rulehost — flag wiring (CLI gate rule 7)', () => {
  // ── Option metadata ──────────────────────────────────────────────────────

  it('registers --dry-run flag', () => {
    const program = freshProgram();
    const intCmd = program.command('internalization');
    const runCmd = registerRunRuleHostCommand(intCmd);

    const opt = runCmd.options.find((o) => o.long === '--dry-run');
    expect(opt).toBeDefined();
    expect(opt?.long).toBe('--dry-run');
  });

  it('registers --confirm flag', () => {
    const program = freshProgram();
    const intCmd = program.command('internalization');
    const runCmd = registerRunRuleHostCommand(intCmd);

    const opt = runCmd.options.find((o) => o.long === '--confirm');
    expect(opt).toBeDefined();
    expect(opt?.long).toBe('--confirm');
  });

  it('registers --json flag', () => {
    const program = freshProgram();
    const intCmd = program.command('internalization');
    const runCmd = registerRunRuleHostCommand(intCmd);

    const opt = runCmd.options.find((o) => o.long === '--json');
    expect(opt).toBeDefined();
    expect(opt?.long).toBe('--json');
  });

  it('parses --behavior-examples as the Owner-labelled evidence file', async () => {
    const program = freshProgram();
    const intCmd = program.command('internalization');
    const runCmd = registerRunRuleHostCommand(intCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(runCmd, captured);

    await program.parseAsync(['node', 'pd', 'internalization', 'run-rulehost', '--pain-id', 'pain-1', '--behavior-examples', 'examples.json']);

    expect(captured.opts?.behaviorExamples).toBe('examples.json');
  });

  it('registers --pain-id as required option', () => {
    const program = freshProgram();
    const intCmd = program.command('internalization');
    const runCmd = registerRunRuleHostCommand(intCmd);

    const opt = runCmd.options.find((o) => o.long === '--pain-id');
    expect(opt).toBeDefined();
    expect(opt?.long).toBe('--pain-id');
    // requiredOption sets .required = true on the Option
    expect(opt?.required).toBe(true);
  });

  it('registers -w shorthand for --workspace', () => {
    const program = freshProgram();
    const intCmd = program.command('internalization');
    const runCmd = registerRunRuleHostCommand(intCmd);

    const opt = runCmd.options.find((o) => o.short === '-w');
    expect(opt).toBeDefined();
    expect(opt?.long).toBe('--workspace');
  });

  it('does NOT register --no-dry-run (no accidental negation)', () => {
    const program = freshProgram();
    const intCmd = program.command('internalization');
    const runCmd = registerRunRuleHostCommand(intCmd);

    const noForm = runCmd.options.find((o) => o.long === '--no-dry-run');
    expect(noForm).toBeUndefined();
  });

  it('does NOT register --no-confirm (no accidental negation)', () => {
    const program = freshProgram();
    const intCmd = program.command('internalization');
    const runCmd = registerRunRuleHostCommand(intCmd);

    const noForm = runCmd.options.find((o) => o.long === '--no-confirm');
    expect(noForm).toBeUndefined();
  });

  // ── Parser-level tests (program.parseAsync) ───────────────────────────────

  it('parses --dry-run as true', async () => {
    const program = freshProgram();
    const intCmd = program.command('internalization');
    const runCmd = registerRunRuleHostCommand(intCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(runCmd, captured);

    await program.parseAsync(['node', 'pd', 'internalization', 'run-rulehost', '--pain-id', 'pain-1', '--dry-run']);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.dryRun).toBe(true);
  });

  it('parses --confirm as true', async () => {
    const program = freshProgram();
    const intCmd = program.command('internalization');
    const runCmd = registerRunRuleHostCommand(intCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(runCmd, captured);

    await program.parseAsync(['node', 'pd', 'internalization', 'run-rulehost', '--pain-id', 'pain-1', '--confirm']);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.confirm).toBe(true);
  });

  it('parses both --dry-run and --confirm (handler enforces mutual exclusivity)', async () => {
    // Commander parses both flags; the handler validates mutual exclusivity.
    // This test proves the parser accepts both — the handler test in
    // rulehost-pipeline-e2e.test.ts proves the handler rejects the combination.
    const program = freshProgram();
    const intCmd = program.command('internalization');
    const runCmd = registerRunRuleHostCommand(intCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(runCmd, captured);

    await program.parseAsync(['node', 'pd', 'internalization', 'run-rulehost', '--pain-id', 'pain-1', '--dry-run', '--confirm']);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.dryRun).toBe(true);
    expect(captured.opts?.confirm).toBe(true);
  });

  it('defaults --dry-run and --confirm to undefined when neither is passed', async () => {
    const program = freshProgram();
    const intCmd = program.command('internalization');
    const runCmd = registerRunRuleHostCommand(intCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(runCmd, captured);

    await program.parseAsync(['node', 'pd', 'internalization', 'run-rulehost', '--pain-id', 'pain-1']);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.dryRun).toBeUndefined();
    expect(captured.opts?.confirm).toBeUndefined();
  });

  it('parses --json as true', async () => {
    const program = freshProgram();
    const intCmd = program.command('internalization');
    const runCmd = registerRunRuleHostCommand(intCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(runCmd, captured);

    await program.parseAsync(['node', 'pd', 'internalization', 'run-rulehost', '--pain-id', 'pain-1', '--json']);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.json).toBe(true);
  });

  it('parses -w shorthand for --workspace', async () => {
    const program = freshProgram();
    const intCmd = program.command('internalization');
    const runCmd = registerRunRuleHostCommand(intCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(runCmd, captured);

    await program.parseAsync(['node', 'pd', 'internalization', 'run-rulehost', '--pain-id', 'pain-1', '-w', '/tmp/test']);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.workspace).toBe('/tmp/test');
  });

  it('rejects missing --pain-id (required option)', async () => {
    const program = freshProgram();
    const intCmd = program.command('internalization');
    registerRunRuleHostCommand(intCmd);

    // Commander should throw on missing required option
    await expect(
      program.parseAsync(['node', 'pd', 'internalization', 'run-rulehost', '--dry-run']),
    ).rejects.toThrow(/pain-id/);
  });

  it('parses --channel with custom value', async () => {
    const program = freshProgram();
    const intCmd = program.command('internalization');
    const runCmd = registerRunRuleHostCommand(intCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(runCmd, captured);

    await program.parseAsync(['node', 'pd', 'internalization', 'run-rulehost', '--pain-id', 'pain-1', '--channel', 'prompt']);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.channel).toBe('prompt');
  });

  it('defaults --channel to code_tool_hook', async () => {
    const program = freshProgram();
    const intCmd = program.command('internalization');
    const runCmd = registerRunRuleHostCommand(intCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(runCmd, captured);

    await program.parseAsync(['node', 'pd', 'internalization', 'run-rulehost', '--pain-id', 'pain-1']);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.channel).toBe('code_tool_hook');
  });

  it('parses --max-rounds as integer', async () => {
    const program = freshProgram();
    const intCmd = program.command('internalization');
    const runCmd = registerRunRuleHostCommand(intCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(runCmd, captured);

    await program.parseAsync(['node', 'pd', 'internalization', 'run-rulehost', '--pain-id', 'pain-1', '--max-rounds', '2']);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.maxRounds).toBe(2);
    expect(typeof captured.opts?.maxRounds).toBe('number');
  });

  it('parses --timeout-ms as integer', async () => {
    const program = freshProgram();
    const intCmd = program.command('internalization');
    const runCmd = registerRunRuleHostCommand(intCmd);
    const captured: CapturedAction = { opts: null };
    attachCapture(runCmd, captured);

    await program.parseAsync(['node', 'pd', 'internalization', 'run-rulehost', '--pain-id', 'pain-1', '--timeout-ms', '600000']);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.timeoutMs).toBe(600000);
    expect(typeof captured.opts?.timeoutMs).toBe('number');
  });
});
