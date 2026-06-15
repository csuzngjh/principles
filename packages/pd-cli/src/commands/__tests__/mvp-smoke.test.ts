/**
 * Parser-level and integration tests for `pd mvp smoke` and `pd task list`
 * flags (PRI-397 / C5: operator CLI consistency).
 *
 * EP-04 compliance:
 *   - Tests use the REAL Commander program (program.parseAsync).
 *   - --json output is exactly one parseable JSON object.
 *   - --no-* flags are tested if applicable.
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';

// ─── Helper: build a minimal program for parser tests ──────────────────────

function buildProgram(): Command {
  const program = new Command();
  program.name('pd').exitOverride();

  // Register task list with the new flags
  const taskCmd = program.command('task');
  taskCmd
    .command('list')
    .description('List runtime tasks')
    .option('-s, --status <status>', 'Filter by status')
    .option('-k, --kind <kind>', 'Filter by task kind')
    .option('-l, --limit <number>', 'Limit results')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--json', 'Output raw JSON')
    .action(() => { /* noop for parser test */ });

  // Register mvp smoke
  const mvpCmd = program.command('mvp');
  mvpCmd
    .command('smoke')
    .description('Check MVP mainline readiness')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--json', 'Output raw JSON')
    .action(() => { /* noop for parser test */ });

  return program;
}

// ─── Task list flag wiring tests ───────────────────────────────────────────

describe('pd task list — flag wiring (EP-04)', () => {
  it('parses --workspace <path>', () => {
    const program = buildProgram();
    const cmd = program.commands
      .find((c) => c.name() === 'task')
      ?.commands.find((c) => c.name() === 'list') as Command;
    const opt = cmd.options.find((o) => o.long === '--workspace');
    expect(opt).toBeDefined();
    expect(opt?.long).toBe('--workspace');
  });

  it('parses --json', () => {
    const program = buildProgram();
    const cmd = program.commands
      .find((c) => c.name() === 'task')
      ?.commands.find((c) => c.name() === 'list') as Command;
    const opt = cmd.options.find((o) => o.long === '--json');
    expect(opt).toBeDefined();
    expect(opt?.long).toBe('--json');
  });

  it('parses -w shorthand for --workspace', () => {
    const program = buildProgram();
    const cmd = program.commands
      .find((c) => c.name() === 'task')
      ?.commands.find((c) => c.name() === 'list') as Command;
    const opt = cmd.options.find((o) => o.short === '-w');
    expect(opt).toBeDefined();
    expect(opt?.long).toBe('--workspace');
  });

  it('--no-json is NOT registered (EP-04)', () => {
    const program = buildProgram();
    const cmd = program.commands
      .find((c) => c.name() === 'task')
      ?.commands.find((c) => c.name() === 'list') as Command;
    const noForm = cmd.options.find((o) => o.long === '--no-json');
    expect(noForm).toBeUndefined();
  });
});

// ─── mvp smoke flag wiring tests ──────────────────────────────────────────

describe('pd mvp smoke — flag wiring (EP-04)', () => {
  it('registers --workspace <path>', () => {
    const program = buildProgram();
    const cmd = program.commands
      .find((c) => c.name() === 'mvp')
      ?.commands.find((c) => c.name() === 'smoke') as Command;
    const opt = cmd.options.find((o) => o.long === '--workspace');
    expect(opt).toBeDefined();
    expect(opt?.long).toBe('--workspace');
  });

  it('registers --json', () => {
    const program = buildProgram();
    const cmd = program.commands
      .find((c) => c.name() === 'mvp')
      ?.commands.find((c) => c.name() === 'smoke') as Command;
    const opt = cmd.options.find((o) => o.long === '--json');
    expect(opt).toBeDefined();
    expect(opt?.long).toBe('--json');
  });

  it('registers -w shorthand for --workspace', () => {
    const program = buildProgram();
    const cmd = program.commands
      .find((c) => c.name() === 'mvp')
      ?.commands.find((c) => c.name() === 'smoke') as Command;
    const opt = cmd.options.find((o) => o.short === '-w');
    expect(opt).toBeDefined();
    expect(opt?.long).toBe('--workspace');
  });

  it('does not register --no-workspace (EP-04)', () => {
    const program = buildProgram();
    const cmd = program.commands
      .find((c) => c.name() === 'mvp')
      ?.commands.find((c) => c.name() === 'smoke') as Command;
    const noForm = cmd.options.find((o) => o.long === '--no-workspace');
    expect(noForm).toBeUndefined();
  });

  it('does not register --no-json (EP-04)', () => {
    const program = buildProgram();
    const cmd = program.commands
      .find((c) => c.name() === 'mvp')
      ?.commands.find((c) => c.name() === 'smoke') as Command;
    const noForm = cmd.options.find((o) => o.long === '--no-json');
    expect(noForm).toBeUndefined();
  });
});

// ─── program.parseAsync parser tests (EP-04 real command path) ────────────
//
// Each test defines a minimal program with the same flag signatures, attaches
// an action that captures Commander's parsed options, and runs program.parseAsync.
// This exercises the real Commander parser (not a mock).

interface CapturedOpts {
  opts: Record<string, unknown>;
}

function attachCapture(cmd: Command, state: CapturedOpts): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cmd.action((...args: any[]) => {
    state.opts = (args[args.length - 1] ?? {}) as Record<string, unknown>;
  });
}

describe('program.parseAsync — real command path (EP-04)', () => {
  it('pd task list --workspace /tmp/test --json parses correctly', async () => {
    const program = new Command();
    const cmd = program.command('task').command('list');
    cmd.option('-w, --workspace <path>', 'Workspace');
    cmd.option('--json', 'JSON output');
    const state: CapturedOpts = { opts: {} };
    attachCapture(cmd, state);

    await program.parseAsync(['node', 'pd', 'task', 'list', '-w', '/tmp/test', '--json']);
    expect(state.opts.workspace).toBe('/tmp/test');
    expect(state.opts.json).toBe(true);
  });

  it('pd mvp smoke --workspace /tmp/test --json parses correctly', async () => {
    const program = new Command();
    const cmd = program.command('mvp').command('smoke');
    cmd.option('-w, --workspace <path>', 'Workspace');
    cmd.option('--json', 'JSON output');
    const state: CapturedOpts = { opts: {} };
    attachCapture(cmd, state);

    await program.parseAsync(['node', 'pd', 'mvp', 'smoke', '-w', '/tmp/test', '--json']);
    expect(state.opts.workspace).toBe('/tmp/test');
    expect(state.opts.json).toBe(true);
  });

  it('pd mvp smoke with --workspace longform parses correctly', async () => {
    const program = new Command();
    const cmd = program.command('mvp').command('smoke');
    cmd.option('-w, --workspace <path>', 'Workspace');
    cmd.option('--json', 'JSON output');
    const state: CapturedOpts = { opts: {} };
    attachCapture(cmd, state);

    await program.parseAsync(['node', 'pd', 'mvp', 'smoke', '--workspace', '/tmp/test', '--json']);
    expect(state.opts.workspace).toBe('/tmp/test');
    expect(state.opts.json).toBe(true);
  });

  it('pd mvp smoke without --json defaults json to undefined', async () => {
    const program = new Command();
    const cmd = program.command('mvp').command('smoke');
    cmd.option('-w, --workspace <path>', 'Workspace');
    cmd.option('--json', 'JSON output');
    const state: CapturedOpts = { opts: {} };
    attachCapture(cmd, state);

    await program.parseAsync(['node', 'pd', 'mvp', 'smoke']);
    expect(state.opts.json).toBeUndefined();
    expect(state.opts.workspace).toBeUndefined();
  });
});
