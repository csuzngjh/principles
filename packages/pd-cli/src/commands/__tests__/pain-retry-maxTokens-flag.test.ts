/**
 * CLI flag-wiring tests for `pd pain retry --maxTokens` (PRI-509 follow-up).
 *
 * Covers:
 *   - `--maxTokens <n>` parses to a number and is passed to the handler
 *   - `--maxTokens` falls back to undefined when the flag is omitted
 *
 * Mirrors the flag-wiring test pattern from run-rulehost-flag-wiring.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerPainRetryCommand } from '../pain-retry.js';

function freshProgram(): Command {
  return new Command();
}

function attachCapture(cmd: Command, captured: { opts: Record<string, unknown> | null }) {
  const origAction = cmd.action.bind(cmd);
  cmd.action = ((handler: (opts: Record<string, unknown>) => void) => {
    return origAction((opts: Record<string, unknown>) => {
      captured.opts = opts;
      return handler(opts);
    });
  }) as typeof cmd.action;
}

function register(painCmd: Command, captured: { opts: Record<string, unknown> | null }) {
  const cmd = registerPainRetryCommand(painCmd, async (opts) => {
    captured.opts = opts as unknown as Record<string, unknown>;
  });
  attachCapture(cmd, captured);
}

describe('pd pain retry --maxTokens flag wiring', () => {
  let captured: { opts: Record<string, unknown> | null };

  beforeEach(() => {
    captured = { opts: null };
  });

  it('parses --maxTokens to a number and passes it to the handler', async () => {
    const program = freshProgram();
    const painCmd = program.command('pain');
    register(painCmd, captured);

    await program.parseAsync(['node', 'pd', 'pain', 'retry', '--pain-id', 'pain-1', '--runtime', 'pi-ai', '--maxTokens', '16000']);

    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.maxTokens).toBe(16000);
    expect(typeof captured.opts?.maxTokens).toBe('number');
  });

  it('parses --maxTokens with a numeric string (parseInt path)', async () => {
    const program = freshProgram();
    const painCmd = program.command('pain');
    register(painCmd, captured);

    await program.parseAsync(['node', 'pd', 'pain', 'retry', '--pain-id', 'pain-1', '--runtime', 'pi-ai', '--maxTokens', '32000']);

    expect(captured.opts?.maxTokens).toBe(32000);
  });

  it('keeps maxTokens undefined when flag is omitted (falls back to config)', async () => {
    const program = freshProgram();
    const painCmd = program.command('pain');
    register(painCmd, captured);

    await program.parseAsync(['node', 'pd', 'pain', 'retry', '--pain-id', 'pain-1', '--runtime', 'pi-ai']);

    expect(captured.opts?.maxTokens).toBeUndefined();
  });
});
