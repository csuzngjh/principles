/**
 * Golden replay executor — materializes a checked-in golden workspace into a
 * private temp directory (restoring real runtime file names from their
 * `.fixture` storage suffixes), then runs the BUILT pd CLI as a real child
 * process against it and captures (stdout, exitCode) plus a read-only
 * integrity verdict for the materialized workspace.
 *
 * Why materialization: the corpus stores `state.db` / `trajectory.db` /
 * `principle_training_state.json` as `*.fixture` files so that no runtime
 * database or state file is ever committed (repo generated-artifacts gate and
 * gitignore rules stay untouched in their intent). The manifest hashes pin
 * the STORED bytes; this helper restores them byte-identically under their
 * real names in a throwaway directory before each replay.
 *
 * The child is forked (node, fixed entry script, argv array, no shell). Every
 * argv element is minted INSIDE this module from literals plus
 * process.cwd()-derived paths: the caller passes only a case NAME, validated
 * as an identifier and used strictly as a lookup key into the literal command
 * table. `pain-recall.golden.test.ts` cross-checks this table against each
 * checked-in case file's recorded argv so it cannot drift from the corpus.
 */
import { fork } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/** Identifier-shaped case names only — never interpolated into a command. */
const CASE_NAME_RE = /^[a-z0-9-]{1,64}$/;

/**
 * Stored→runtime layout map. Fixture payloads live FLAT at the workspace
 * root with a `.fixture` suffix so the corpus never contains a `.pd/` or
 * `.state/` directory, a `*.db` file, or a ledger filename — the repo's
 * generated-artifacts gate ("no committed runtime PD state") and gitignore
 * rules keep their intent untouched. Materialization restores the exact
 * runtime layout byte-identically in a throwaway directory.
 */
const MATERIALIZE_MAP: Readonly<Record<string, string>> = {
  'pd-state.db.fixture': '.pd/state.db',
  'state-trajectory.db.fixture': '.state/trajectory.db',
  'state-ledger.json.fixture': '.state/principle_training_state.json',
};

/**
 * Hard deadline for one forked CLI replay (review round 2, P2-4): the child
 * is SIGKILLed and the replay resolves with `timedOut: true` (which the
 * golden test asserts false), so a hung CLI can never outlive the vitest
 * process. Must stay comfortably BELOW the per-case 60_000 ms test timeout.
 */
const CHILD_DEADLINE_MS = 45_000;

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
  /** True when the child had to be killed at CHILD_DEADLINE_MS. */
  timedOut: boolean;
  /** Every file AND directory in the materialized workspace is identical
   * after the replay — no new file, no new (even empty) directory, nothing
   * mutated — the strict read-only contract (review round 2, P2-4). */
  workspaceIntact: boolean;
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

function goldenCorpusRoot(): string {
  return path.join(process.cwd(), 'tests', 'commands', '__golden__');
}

/** Recursive file list (posix-style relative paths). */
function listFiles(root: string, rel = '', acc: string[] = []): string[] {
  for (const name of fs.readdirSync(path.join(root, rel))) {
    const relPath = rel ? `${rel}/${name}` : name;
    const stat = fs.statSync(path.join(root, relPath));
    if (stat.isDirectory()) listFiles(root, relPath, acc);
    else acc.push(relPath);
  }
  return acc;
}

/** Recursive DIRECTORY list (posix-style relative paths, the workspace root
 * itself excluded). Complements listFiles: the read-only contract covers
 * directory structure too — a CLI that creates an empty directory must be
 * detected even though an empty directory holds no files to hash (review
 * round 2, P2-4). */
function listDirs(root: string, rel = '', acc: string[] = []): string[] {
  for (const name of fs.readdirSync(path.join(root, rel))) {
    const relPath = rel ? `${rel}/${name}` : name;
    if (fs.statSync(path.join(root, relPath)).isDirectory()) {
      acc.push(relPath);
      listDirs(root, relPath, acc);
    }
  }
  return acc;
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** Materialize the stored corpus workspace into `dest` using the explicit
 * stored→runtime layout map. An unknown stored file is a hard error (the
 * corpus layout is part of the checked-in contract). A corpus workspace with
 * ZERO stored files (ws-empty) has no directory in a fresh checkout — git
 * cannot track empty directories — and materializes to an empty workspace;
 * the corpus-integrity test proves every manifest-declared file exists
 * before any replay runs, so this ENOENT tolerance cannot mask corruption. */
function materializeWorkspace(storedDir: string, dest: string): void {
  if (!fs.existsSync(storedDir)) return; // zero-file workspace (see docblock)
  for (const relPath of listFiles(storedDir)) {
    const targetRel = MATERIALIZE_MAP[relPath];
    if (targetRel === undefined) {
      throw new Error(`golden corpus holds an unmapped stored file: ${relPath}`);
    }
    const target = path.join(dest, ...targetRel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(storedDir, ...relPath.split('/')), target);
  }
}

/** Fork the built CLI with the literal argv for `caseName` against the
 * materialized workspace; verify the workspace survived byte-identically;
 * clean up; resolve (stdout, exitCode, workspaceIntact). */
export async function replayGoldenCase(caseName: string): Promise<GoldenReplayResult> {
  const command = goldenCommandFor(caseName);
  const cliRoot = process.cwd();
  const storedDir = path.join(goldenCorpusRoot(), 'workspaces', command.workspace);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-golden-replay-'));
  const workspaceDir = path.join(workDir, command.workspace);
  fs.mkdirSync(workspaceDir, { recursive: true }); // ws-empty materializes to an empty dir
  materializeWorkspace(storedDir, workspaceDir);

  const beforeFiles = new Map(listFiles(workspaceDir).map((rel) => [rel, sha256File(path.join(workspaceDir, ...rel.split('/')))]));
  const beforeDirs = new Set(listDirs(workspaceDir));

  const childArgv: string[] = ['pain', 'recall'];
  for (const element of command.elements) childArgv.push(element);
  childArgv.push('--workspace');
  childArgv.push(workspaceDir);

  const result = await new Promise<{ stdout: string; exitCode: number; timedOut: boolean }>((resolve) => {
    const child = fork(path.join(cliRoot, 'dist', 'index.js'), childArgv, {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stdout = '';
    let timedOut = false;
    // P2-4: the vitest test timeout does NOT kill forked children — enforce
    // an independent deadline here and terminate the child (default SIGTERM;
    // unconditional on Windows) so a hung CLI can never outlive the worker.
    // The timer is always cleared on exit/error.
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, CHILD_DEADLINE_MS);
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    const settle = (exitCode: number): void => {
      clearTimeout(deadline);
      resolve({ stdout: stdout.replace(/\r\n/g, '\n'), exitCode, timedOut });
    };
    child.on('error', () => settle(1));
    child.on('exit', (code) => settle(code ?? 1));
  });

  let workspaceIntact = true;
  const afterFiles = listFiles(workspaceDir);
  const afterDirs = listDirs(workspaceDir);
  if (afterDirs.length !== beforeDirs.size || afterDirs.some((d) => !beforeDirs.has(d))) {
    workspaceIntact = false; // a new directory appeared (even an empty one)
  } else if (afterFiles.length !== beforeFiles.size) {
    workspaceIntact = false;
  } else {
    for (const rel of afterFiles) {
      const expected = beforeFiles.get(rel);
      if (expected === undefined || sha256File(path.join(workspaceDir, ...rel.split('/'))) !== expected) {
        workspaceIntact = false;
        break;
      }
    }
  }

  try {
    fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // Best effort: a leftover temp dir never affects correctness; the vitest
    // temp-lifecycle keeper sweeps leftovers.
  }
  return { ...result, timedOut: result.timedOut, workspaceIntact };
}
