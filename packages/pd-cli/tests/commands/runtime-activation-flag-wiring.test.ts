/**
 * Parser-level tests for the `pd activation *` flag surface (CLI gate rules 3 and 7).
 *
 * These five commands (approve / deactivate / dispatch / list / promote) used to
 * be five near-identical files that each re-declared the same metadata and
 * parse assertions by hand. They are now ONE table: every row still exercises
 * the REAL registration helper and the REAL commander parser
 * (`program.parseAsync`), so a typo in production still surfaces at parse time,
 * not at handler dispatch.
 *
 * What each row preserves (nothing is weakened by being table-driven):
 *   - every registered long flag, and its shorthand where one exists;
 *   - `required` on the options that are `.requiredOption(...)`;
 *   - the commander rejection when a required option is missing;
 *   - the forbidden flags, especially the `--no-*` negation traps
 *     (cli-3: a `--no-json` registered by accident silently inverts `--json`);
 *   - the parsed option VALUES (camel-cased keys, numbers, defaults, and the
 *     `channel = 'prompt'` default), not just "an option object exists".
 *
 * Handler-level behaviour (mutual exclusivity, refusal paths, JSON output shape)
 * is covered by runtime-activation.test.ts. The two commands that are real
 * end-to-end CLI contracts (journal, link) keep their own files: they assert
 * stdout/stderr separation and exit codes (cli-1 / cli-2 / cli-6), which is a
 * different contract from flag wiring.
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';

import {
  registerRuntimeActivationApproveCommand,
  registerRuntimeActivationDeactivateCommand,
  registerRuntimeActivationDispatchCommand,
  registerRuntimeActivationListCommand,
  registerRuntimeActivationPromoteCommand,
} from '../../src/commands/runtime-activation.js';

type ActionOptions = Record<string, unknown>;

interface CapturedAction {
  opts: ActionOptions | null;
}

interface ParseCase {
  /** Optional label so a failing row names the behaviour, not just the argv. */
  name?: string;
  /** Arguments AFTER `node pd <path>` — the parser is invoked with the full argv. */
  argv: string[];
  expect?: Record<string, unknown>;
  /** Keys that must be `undefined` when the flag was not passed. */
  undefinedKeys?: string[];
}

interface Spec {
  /** e.g. `pd activation list` */
  path: string[];
  /** Mount the leaf command under the real parent chain used by index.ts. */
  mount: (program: Command) => Command;
  /** Long flags that must exist; `short` asserts the shorthand binding. */
  registered: Array<{ long: string; short?: string; required?: boolean }>;
  /** Long flags that must NOT exist (negation traps included). */
  forbidden: string[];
  parses: ParseCase[];
  missingRequired?: { argv: string[]; message: RegExp };
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
    state.opts = optsArg !== null && typeof optsArg === 'object' ? (optsArg as ActionOptions) : {};
  });
}

function freshProgram(): Command {
  const program = new Command();
  program.name('pd').exitOverride();
  return program;
}

function activationParent(program: Command): Command {
  return program.command('activation');
}

const SPECS: Spec[] = [
  {
    path: ['activation', 'approve'],
    mount: activationParent,
    registered: [
      { long: '--approval-id', short: '-a', required: true },
      { long: '--decided-by' },
      { long: '--note' },
      { long: '--json' },
      { long: '--workspace', short: '-w' },
      { long: '--target-host' },
    ],
    forbidden: ['--dry-run', '--confirm', '--no-json'],
    parses: [
      { argv: ['--approval-id', 'ap-1', '--json'], expect: { approvalId: 'ap-1', json: true } },
      { name: '-a shorthand', argv: ['-a', 'ap-2'], expect: { approvalId: 'ap-2' } },
      { argv: ['--approval-id', 'ap-3', '--decided-by', 'owner'], expect: { decidedBy: 'owner' } },
      { argv: ['--approval-id', 'ap-4', '--note', 'reviewed'], expect: { note: 'reviewed' } },
      { name: '-w shorthand', argv: ['--approval-id', 'ap-5', '-w', '/tmp/ws'], expect: { workspace: '/tmp/ws' } },
      { argv: ['--approval-id', 'ap-6', '--target-host', 'codex'], expect: { targetHost: 'codex' } },
      { name: 'defaults', argv: ['--approval-id', 'ap-7'], undefinedKeys: ['json'] },
    ],
    missingRequired: { argv: [], message: /approval-id/ },
  },
  {
    path: ['activation', 'deactivate'],
    mount: activationParent,
    registered: [
      { long: '--activation-id', required: true },
      { long: '--json' },
      { long: '--workspace', short: '-w' },
      // SPEC R4/P1: the recovery-probe path is non-destructive and never writes.
      { long: '--dry-run' },
    ],
    forbidden: ['--confirm', '--no-json'],
    parses: [
      { argv: ['--activation-id', 'act-1', '--json'], expect: { activationId: 'act-1', json: true } },
      { name: '-w shorthand', argv: ['--activation-id', 'act-2', '-w', '/tmp/ws'], expect: { workspace: '/tmp/ws' } },
      { name: 'defaults', argv: ['--activation-id', 'act-3'], undefinedKeys: ['json'] },
    ],
    missingRequired: { argv: [], message: /activation-id/ },
  },
  {
    path: ['runtime', 'activation', 'dispatch'],
    mount: (program) => program.command('runtime').command('activation', { hidden: true }),
    registered: [
      { long: '--dry-run' },
      { long: '--confirm' },
      { long: '--json' },
      { long: '--artifact-id', short: '-a' },
      { long: '--workspace', short: '-w' },
      { long: '--channel', short: '-c' },
    ],
    forbidden: ['--no-dry-run', '--no-confirm'],
    parses: [
      { argv: ['--dry-run'], expect: { dryRun: true } },
      { argv: ['--confirm'], expect: { confirm: true } },
      // Both are parsed; the HANDLER enforces mutual exclusivity (cli-4).
      { argv: ['--dry-run', '--confirm'], expect: { dryRun: true, confirm: true } },
      { argv: [], undefinedKeys: ['dryRun', 'confirm'] },
      { argv: ['--json'], expect: { json: true } },
      { name: '-a shorthand', argv: ['-a', 'art-1'], expect: { artifactId: 'art-1' } },
      { name: '-w shorthand', argv: ['-w', '/tmp/ws'], expect: { workspace: '/tmp/ws' } },
      { name: 'channel default', argv: [], expect: { channel: 'prompt' } },
    ],
  },
  {
    path: ['activation', 'list'],
    mount: activationParent,
    registered: [
      { long: '--json' },
      { long: '--workspace', short: '-w' },
      { long: '--channel', short: '-c' },
      { long: '--include-deactivated' },
    ],
    forbidden: ['--dry-run', '--confirm', '--no-json'],
    parses: [
      { argv: ['--json'], expect: { json: true } },
      { name: '-w shorthand', argv: ['-w', '/tmp/ws'], expect: { workspace: '/tmp/ws' } },
      { name: '-c shorthand', argv: ['-c', 'prompt'], expect: { channel: 'prompt' } },
      { argv: ['--include-deactivated'], expect: { includeDeactivated: true } },
      { name: 'defaults', argv: [], undefinedKeys: ['json', 'workspace', 'channel', 'includeDeactivated'] },
    ],
  },
  {
    path: ['activation', 'promote'],
    mount: activationParent,
    registered: [
      { long: '--dry-run' },
      { long: '--confirm' },
      { long: '--json' },
      { long: '--activation-id', required: true },
      { long: '--workspace', short: '-w' },
      // Owner authority binding: every value the handler forwards is parsed here.
      { long: '--artifact-id' },
      { long: '--artifact-digest' },
      { long: '--control-version' },
      { long: '--idempotency-key' },
      { long: '--reason' },
      { long: '--note' },
    ],
    forbidden: ['--no-dry-run', '--no-confirm'],
    parses: [
      { argv: ['--activation-id', 'act-1', '--dry-run'], expect: { dryRun: true } },
      { argv: ['--activation-id', 'act-2', '--confirm'], expect: { confirm: true } },
      { argv: ['--activation-id', 'act-3', '--dry-run', '--confirm'], expect: { dryRun: true, confirm: true } },
      { argv: ['--activation-id', 'act-4'], undefinedKeys: ['dryRun', 'confirm'] },
      { argv: ['--activation-id', 'act-5', '--json'], expect: { json: true } },
      { name: '-w shorthand', argv: ['--activation-id', 'act-6', '-w', '/tmp/ws'], expect: { workspace: '/tmp/ws' } },
      {
        name: 'all Owner authority binding values',
        argv: [
          '--activation-id', 'act-7',
          '--artifact-id', 'art-1', '--artifact-digest', 'sha256:one', '--control-version', '7',
          '--idempotency-key', 'idem-1', '--reason', 'owner_review', '--note', 'reviewed', '--confirm',
        ],
        expect: {
          artifactId: 'art-1', artifactDigest: 'sha256:one', controlVersion: 7,
          idempotencyKey: 'idem-1', reason: 'owner_review', note: 'reviewed', confirm: true,
        },
      },
    ],
    missingRequired: { argv: ['--dry-run'], message: /activation-id/ },
  },
];

const REGISTER: Record<string, (parent: Command) => Command> = {
  'activation approve': registerRuntimeActivationApproveCommand,
  'activation deactivate': registerRuntimeActivationDeactivateCommand,
  'runtime activation dispatch': registerRuntimeActivationDispatchCommand,
  'activation list': registerRuntimeActivationListCommand,
  'activation promote': registerRuntimeActivationPromoteCommand,
};

for (const spec of SPECS) {
  const key = spec.path.join(' ');
  const register = REGISTER[key];
  if (!register) throw new Error('no registration helper mapped for ' + key);
  const label = 'pd ' + key;

  describe(`${label} — flag wiring (CLI gate rules 3 and 7)`, () => {
    function leaf(): { program: Command; cmd: Command } {
      const program = freshProgram();
      return { program, cmd: register(spec.mount(program)) };
    }

    for (const option of spec.registered) {
      it(`registers ${option.long}${option.short ? ' (' + option.short + ')' : ''}${option.required ? ' as required' : ''}`, () => {
        const { cmd } = leaf();
        const opt = cmd.options.find((o) => o.long === option.long);
        expect(opt, option.long + ' is not registered').toBeDefined();
        if (option.short) {
          const short = cmd.options.find((o) => o.short === option.short);
          expect(short?.long, option.short + ' does not bind ' + option.long).toBe(option.long);
        }
        if (option.required) expect(opt?.required).toBe(true);
      });
    }

    for (const flag of spec.forbidden) {
      it(`does NOT register ${flag}`, () => {
        const { cmd } = leaf();
        expect(cmd.options.find((o) => o.long === flag)).toBeUndefined();
      });
    }

    for (const parseCase of spec.parses) {
      const label2 = parseCase.name ? 'parses ' + parseCase.name : 'parses ' + (parseCase.argv.join(' ') || '(no flags)');
      it(label2, async () => {
        const { program, cmd } = leaf();
        const captured: CapturedAction = { opts: null };
        attachCapture(cmd, captured);

        await program.parseAsync(['node', 'pd', ...spec.path, ...parseCase.argv]);

        expect(captured.opts).not.toBeNull();
        if (parseCase.expect) expect(captured.opts).toMatchObject(parseCase.expect);
        for (const key2 of parseCase.undefinedKeys ?? []) {
          expect(captured.opts?.[key2]).toBeUndefined();
        }
      });
    }

    if (spec.missingRequired) {
      it(`rejects a missing required option (${spec.missingRequired.message.source})`, async () => {
        const { program } = leaf();
        await expect(
          program.parseAsync(['node', 'pd', ...spec.path, ...spec.missingRequired!.argv]),
        ).rejects.toThrow(spec.missingRequired!.message);
      });
    }
  });
}
