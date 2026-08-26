/**
 * pd telemetry — parser-level flag wiring tests (PRI-597, CLI Operator Gate
 * rule 7 / EP-04).
 *
 * Exercises the real Commander tree via registerTelemetryCommand; actions are
 * captured so no handler logic runs.
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerTelemetryCommand } from '../telemetry.js';

function freshProgram(): Command {
  const program = new Command();
  program.name('pd').exitOverride();
  return program;
}

function requireCmd(cmd: Command | undefined, name: string): Command {
  if (cmd === undefined) {
    throw new Error(`Command '${name}' not found in tree`);
  }
  return cmd;
}

function telemetrySub(name: string): Command {
  const program = freshProgram();
  registerTelemetryCommand(program);
  const telemetry = requireCmd(program.commands.find((c) => c.name() === 'telemetry'), 'telemetry');
  return requireCmd(telemetry.commands.find((c) => c.name() === name), `telemetry ${name}`);
}

describe('pd telemetry — command registration', () => {
  it('registers the telemetry group with all five subcommands', () => {
    const program = freshProgram();
    registerTelemetryCommand(program);
    const telemetry = requireCmd(program.commands.find((c) => c.name() === 'telemetry'), 'telemetry');
    const subNames = telemetry.commands.map((c) => c.name()).sort();
    expect(subNames).toEqual(['disable', 'enable', 'preview', 'reset', 'status']);
  });

  it('status registers --workspace (-w) and --json', () => {
    const status = telemetrySub('status');
    expect(status.options.find((o) => o.long === '--workspace')?.short).toBe('-w');
    expect(status.options.find((o) => o.long === '--json')).toBeDefined();
  });

  it('enable/disable/reset register the dry-run/confirm pair (cli-4) plus --workspace and --json', () => {
    for (const name of ['enable', 'disable', 'reset']) {
      const cmd = telemetrySub(name);
      expect(cmd.options.find((o) => o.long === '--dry-run'), name).toBeDefined();
      expect(cmd.options.find((o) => o.long === '--confirm'), name).toBeDefined();
      expect(cmd.options.find((o) => o.long === '--workspace'), name).toBeDefined();
      expect(cmd.options.find((o) => o.long === '--json'), name).toBeDefined();
    }
  });

  it('preview registers --workspace (-w) and --json', () => {
    const preview = telemetrySub('preview');
    expect(preview.options.find((o) => o.long === '--workspace')?.short).toBe('-w');
    expect(preview.options.find((o) => o.long === '--json')).toBeDefined();
  });

  it('parser dispatches telemetry enable with --confirm as opts.confirm === true', async () => {
    const program = freshProgram();
    registerTelemetryCommand(program);
    const holder: { opts: Record<string, unknown> | null } = { opts: null };
    const telemetry = requireCmd(program.commands.find((c) => c.name() === 'telemetry'), 'telemetry');
    const enable = requireCmd(telemetry.commands.find((c) => c.name() === 'enable'), 'enable');
    enable.action((...args: unknown[]) => {
      for (let i = args.length - 1; i >= 0; i--) {
        const arg = args[i];
        if (arg !== null && typeof arg === 'object' && !(arg instanceof Command)) {
          holder.opts = arg as Record<string, unknown>;
          break;
        }
      }
    });
    await program.parseAsync(['node', 'pd', 'telemetry', 'enable', '--confirm', '--json']);
    expect(holder.opts).not.toBeNull();
    expect(holder.opts?.confirm).toBe(true);
    expect(holder.opts?.json).toBe(true);
  });
});
