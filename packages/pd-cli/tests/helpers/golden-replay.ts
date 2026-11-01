/**
 * Golden replay executor — runs the BUILT pd CLI as a real child process for
 * the golden equivalence tests (`pain-recall.golden.test.ts`).
 *
 * The child is forked (node, fixed entry script, argv array, no shell). Every
 * argv element is minted INSIDE this module from literals plus
 * process.cwd()-derived paths: the caller passes only a case NAME, validated
 * as an identifier and used strictly as a lookup key into the literal command
 * table. `pain-recall.golden.test.ts` cross-checks this table against each
 * checked-in case file's recorded argv so it cannot drift from the corpus.
 */
import { fork } from 'node:child_process';
import * as path from 'node:path';

/** Identifier-shaped case names only — never interpolated into a command. */
const CASE_NAME_RE = /^[a-z0-9-]{1,64}$/;

const P_OK = '11111111-1111-4111-8111-111111111111';
const P_EMPTY = '33333333-3333-4333-8333-333333333333';
const P_TRUNC = '44444444-4444-4444-8444-444444444444';
const P_PART = '55555555-5555-4555-8555-555555555555';
const P_UNKNOWN = '99999999-9999-4999-8999-999999999999';
const PAIN_ORPHAN = 'pain-golden-orphan-004';

export interface GoldenCommand {
  readonly workspace: string;
  /** Literal argv elements after `pain recall` and before `--workspace`. */
  readonly elements: readonly string[];
}

const GOLDEN_COMMANDS: Readonly<Record<string, GoldenCommand>> = {
  'ok-full': { workspace: 'ws-ok', elements: ['--principle-id', P_OK, '--json'] },
  'default-limit-truncation': { workspace: 'ws-trunc', elements: ['--principle-id', P_TRUNC, '--json'] },
  'no-matches': { workspace: 'ws-ok', elements: ['--principle-id', P_EMPTY, '--json'] },
  'partial': { workspace: 'ws-partial', elements: ['--principle-id', P_PART, '--json'] },
  'principle-not-found': { workspace: 'ws-ok', elements: ['--principle-id', P_UNKNOWN, '--json'] },
  'pain-not-found': { workspace: 'ws-ok', elements: ['--principle-id', P_OK, '--pain-id', PAIN_ORPHAN, '--json'] },
  'param-error-missing-principle-id': { workspace: 'ws-ok', elements: ['--json'] },
  'source-missing': { workspace: 'ws-empty', elements: ['--principle-id', P_OK, '--json'] },
};

export interface GoldenReplayResult {
  stdout: string;
  exitCode: number;
}

export function listGoldenCaseNames(): string[] {
  return Object.keys(GOLDEN_COMMANDS);
}

/** The literal command table entry for a case (for corpus cross-checks). */
export function goldenCommandFor(caseName: string): GoldenCommand {
  if (!CASE_NAME_RE.test(caseName)) {
    throw new Error(`golden case name rejected: ${JSON.stringify(caseName.slice(0, 40))}`);
  }
  const command = GOLDEN_COMMANDS[caseName];
  if (command === undefined) {
    throw new Error(`unknown golden case: ${caseName}`);
  }
  return command;
}

/** Fork the built CLI with the literal argv for `caseName` and capture
 * (stdout, exitCode) — stdout is LF-normalized for cross-platform goldens. */
export function replayGoldenCase(caseName: string): Promise<GoldenReplayResult> {
  const command = goldenCommandFor(caseName);
  const cliRoot = process.cwd();
  const childArgv: string[] = ['pain', 'recall'];
  for (const element of command.elements) childArgv.push(element);
  childArgv.push('--workspace');
  childArgv.push(path.join(cliRoot, 'tests', 'commands', '__golden__', 'workspaces', command.workspace));
  return new Promise((resolve) => {
    const child = fork(path.join(cliRoot, 'dist', 'index.js'), childArgv, {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stdout = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.on('error', () => resolve({ stdout: stdout.replace(/\r\n/g, '\n'), exitCode: 1 }));
    child.on('exit', (code) => resolve({ stdout: stdout.replace(/\r\n/g, '\n'), exitCode: code ?? 1 }));
  });
}
