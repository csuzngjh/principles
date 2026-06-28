/**
 * PRI-466: pd intent — parser-level flag wiring tests.
 *
 * Exercises the real Commander command tree via registerIntentCommand,
 * verifying option metadata and parser-level dispatch (CLI Operator Gate
 * rule 7). No handler logic is invoked — actions are captured.
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerIntentCommand } from '../intent.js';

type ActionOptions = Record<string, unknown>;
interface CapturedAction {
  opts: ActionOptions | null;
}

function attachCapture(cmd: Command, state: CapturedAction): void {
  cmd.action(function captureAction(...args: unknown[]): void {
    let optsArg: unknown = null;
    for (let i = args.length - 1; i >= 0; i--) {
      const arg = args[i];
      if (arg !== null && typeof arg === 'object' && !(arg instanceof Command)) {
        optsArg = arg;
        break;
      }
    }
    state.opts = optsArg && typeof optsArg === 'object' ? (optsArg as ActionOptions) : {};
  });
}

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

describe('pd intent — command registration', () => {
  it('registers "intent" command with "init" and "show" subcommands', () => {
    const program = freshProgram();
    registerIntentCommand(program);
    const intentCmd = requireCmd(program.commands.find((c) => c.name() === 'intent'), 'intent');
    const subNames = intentCmd.commands.map((c) => c.name());
    expect(subNames).toContain('init');
    expect(subNames).toContain('show');
  });
});

describe('pd intent init — option metadata', () => {
  it('has --workspace (-w), --force, --dry-run, --confirm, --lang, and --json options', () => {
    const program = freshProgram();
    registerIntentCommand(program);
    const intentCmd = requireCmd(program.commands.find((c) => c.name() === 'intent'), 'intent');
    const initCmd = requireCmd(intentCmd.commands.find((c) => c.name() === 'init'), 'init');

    expect(initCmd.options.find((o) => o.long === '--workspace')).toBeDefined();
    expect(initCmd.options.find((o) => o.long === '--workspace')?.short).toBe('-w');
    expect(initCmd.options.find((o) => o.long === '--force')).toBeDefined();
    expect(initCmd.options.find((o) => o.long === '--dry-run')).toBeDefined();
    expect(initCmd.options.find((o) => o.long === '--confirm')).toBeDefined();
    expect(initCmd.options.find((o) => o.long === '--lang')).toBeDefined();
    expect(initCmd.options.find((o) => o.long === '--json')).toBeDefined();
  });

  it('does not register --no-json or --no-force negations', () => {
    const program = freshProgram();
    registerIntentCommand(program);
    const intentCmd = requireCmd(program.commands.find((c) => c.name() === 'intent'), 'intent');
    const initCmd = requireCmd(intentCmd.commands.find((c) => c.name() === 'init'), 'init');

    const noJson = initCmd.options.find((o) => o.long === '--no-json');
    const noForce = initCmd.options.find((o) => o.long === '--no-force');
    expect(noJson).toBeUndefined();
    expect(noForce).toBeUndefined();
  });
});

describe('pd intent show — option metadata', () => {
  it('has --workspace (-w), --lang, and --json options, no --force', () => {
    const program = freshProgram();
    registerIntentCommand(program);
    const intentCmd = requireCmd(program.commands.find((c) => c.name() === 'intent'), 'intent');
    const showCmd = requireCmd(intentCmd.commands.find((c) => c.name() === 'show'), 'show');

    expect(showCmd.options.find((o) => o.long === '--workspace')).toBeDefined();
    expect(showCmd.options.find((o) => o.long === '--workspace')?.short).toBe('-w');
    expect(showCmd.options.find((o) => o.long === '--lang')).toBeDefined();
    expect(showCmd.options.find((o) => o.long === '--json')).toBeDefined();
    expect(showCmd.options.find((o) => o.long === '--force')).toBeUndefined();
  });
});

describe('pd intent init — parser-level dispatch', () => {
  it('parses --json as true', async () => {
    const program = freshProgram();
    const intentCmd = registerIntentCommand(program);
    const initCmd = requireCmd(intentCmd.commands.find((c) => c.name() === 'init'), 'init');
    const captured: CapturedAction = { opts: null };
    attachCapture(initCmd, captured);

    await program.parseAsync(['node', 'pd', 'intent', 'init', '--json']);
    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.json).toBe(true);
  });

  it('parses --force as true', async () => {
    const program = freshProgram();
    const intentCmd = registerIntentCommand(program);
    const initCmd = requireCmd(intentCmd.commands.find((c) => c.name() === 'init'), 'init');
    const captured: CapturedAction = { opts: null };
    attachCapture(initCmd, captured);

    await program.parseAsync(['node', 'pd', 'intent', 'init', '--force']);
    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.force).toBe(true);
  });

  it('parses -w as --workspace', async () => {
    const program = freshProgram();
    const intentCmd = registerIntentCommand(program);
    const initCmd = requireCmd(intentCmd.commands.find((c) => c.name() === 'init'), 'init');
    const captured: CapturedAction = { opts: null };
    attachCapture(initCmd, captured);

    await program.parseAsync(['node', 'pd', 'intent', 'init', '-w', '/tmp/ws']);
    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.workspace).toBe('/tmp/ws');
  });

  it('defaults json and force to undefined when not passed', async () => {
    const program = freshProgram();
    const intentCmd = registerIntentCommand(program);
    const initCmd = requireCmd(intentCmd.commands.find((c) => c.name() === 'init'), 'init');
    const captured: CapturedAction = { opts: null };
    attachCapture(initCmd, captured);

    await program.parseAsync(['node', 'pd', 'intent', 'init']);
    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.json).toBeUndefined();
    expect(captured.opts?.force).toBeUndefined();
  });

  it('parses --dry-run as true', async () => {
    const program = freshProgram();
    const intentCmd = registerIntentCommand(program);
    const initCmd = requireCmd(intentCmd.commands.find((c) => c.name() === 'init'), 'init');
    const captured: CapturedAction = { opts: null };
    attachCapture(initCmd, captured);

    await program.parseAsync(['node', 'pd', 'intent', 'init', '--dry-run']);
    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.dryRun).toBe(true);
  });

  it('parses --confirm as true', async () => {
    const program = freshProgram();
    const intentCmd = registerIntentCommand(program);
    const initCmd = requireCmd(intentCmd.commands.find((c) => c.name() === 'init'), 'init');
    const captured: CapturedAction = { opts: null };
    attachCapture(initCmd, captured);

    await program.parseAsync(['node', 'pd', 'intent', 'init', '--confirm']);
    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.confirm).toBe(true);
  });
});

describe('pd intent show — parser-level dispatch', () => {
  it('parses --json as true', async () => {
    const program = freshProgram();
    const intentCmd = registerIntentCommand(program);
    const showCmd = requireCmd(intentCmd.commands.find((c) => c.name() === 'show'), 'show');
    const captured: CapturedAction = { opts: null };
    attachCapture(showCmd, captured);

    await program.parseAsync(['node', 'pd', 'intent', 'show', '--json']);
    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.json).toBe(true);
  });

  it('parses -w as --workspace', async () => {
    const program = freshProgram();
    const intentCmd = registerIntentCommand(program);
    const showCmd = requireCmd(intentCmd.commands.find((c) => c.name() === 'show'), 'show');
    const captured: CapturedAction = { opts: null };
    attachCapture(showCmd, captured);

    await program.parseAsync(['node', 'pd', 'intent', 'show', '-w', '/tmp/ws']);
    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.workspace).toBe('/tmp/ws');
  });
});

describe('pd intent --lang — parser-level dispatch (cli-7)', () => {
  it('init: parses --lang zh-CN', async () => {
    const program = freshProgram();
    const intentCmd = registerIntentCommand(program);
    const initCmd = requireCmd(intentCmd.commands.find((c) => c.name() === 'init'), 'init');
    const captured: CapturedAction = { opts: null };
    attachCapture(initCmd, captured);

    await program.parseAsync(['node', 'pd', 'intent', 'init', '--lang', 'zh-CN']);
    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.lang).toBe('zh-CN');
  });

  it('init: parses --lang en', async () => {
    const program = freshProgram();
    const intentCmd = registerIntentCommand(program);
    const initCmd = requireCmd(intentCmd.commands.find((c) => c.name() === 'init'), 'init');
    const captured: CapturedAction = { opts: null };
    attachCapture(initCmd, captured);

    await program.parseAsync(['node', 'pd', 'intent', 'init', '--lang', 'en']);
    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.lang).toBe('en');
  });

  it('init: lang defaults to undefined when not passed', async () => {
    const program = freshProgram();
    const intentCmd = registerIntentCommand(program);
    const initCmd = requireCmd(intentCmd.commands.find((c) => c.name() === 'init'), 'init');
    const captured: CapturedAction = { opts: null };
    attachCapture(initCmd, captured);

    await program.parseAsync(['node', 'pd', 'intent', 'init']);
    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.lang).toBeUndefined();
  });

  it('show: parses --lang en', async () => {
    const program = freshProgram();
    const intentCmd = registerIntentCommand(program);
    const showCmd = requireCmd(intentCmd.commands.find((c) => c.name() === 'show'), 'show');
    const captured: CapturedAction = { opts: null };
    attachCapture(showCmd, captured);

    await program.parseAsync(['node', 'pd', 'intent', 'show', '--lang', 'en']);
    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.lang).toBe('en');
  });

  it('show: lang defaults to undefined when not passed', async () => {
    const program = freshProgram();
    const intentCmd = registerIntentCommand(program);
    const showCmd = requireCmd(intentCmd.commands.find((c) => c.name() === 'show'), 'show');
    const captured: CapturedAction = { opts: null };
    attachCapture(showCmd, captured);

    await program.parseAsync(['node', 'pd', 'intent', 'show']);
    expect(captured.opts).not.toBeNull();
    expect(captured.opts?.lang).toBeUndefined();
  });
});
