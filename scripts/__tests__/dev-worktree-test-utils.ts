// Shared fixture helpers for the task-worktree dev tool tests.
// Every test builds a REAL temporary git repository (with a local bare
// "origin") and drives the real script CLIs — no internal-helper-only tests,
// no mocks of git itself.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SCRIPTS_DIR = path.resolve(HERE, '..');
export const DEV_SCRIPTS_DIR = path.join(SCRIPTS_DIR, 'dev');

export type RunResult = { code: number; stdout: string; stderr: string };

export async function run(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: opts.cwd,
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? '' };
  }
}

/** Run one of the scripts/dev/*.mjs tools with the real node binary. */
export async function runDevScript(
  scriptName: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {}
): Promise<RunResult> {
  return runNode([path.join(DEV_SCRIPTS_DIR, scriptName), ...args], opts);
}

/**
 * Run an arbitrary node entry point (a fixture helper, a repo script) as a real
 * child process. PRI-796 tests need this for concurrency cases: the repo
 * mutation mutex is a CROSS-PROCESS guarantee, so holding it in-process would
 * test nothing.
 */
export async function runNode(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {}
): Promise<RunResult> {
  const env = { ...process.env, ...(opts.env ?? {}) } as Record<string, string>;
  // Drop keys explicitly set to undefined so a test can hide them.
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    if (value === undefined) delete env[key];
  }
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      cwd: opts.cwd,
      encoding: 'utf-8',
      env,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? '' };
  }
}

/**
 * Create a directory junction (Windows) / symlink (POSIX) at `link` -> `target`.
 *
 * The junction case is the one that matters here: a worktree whose
 * `node_modules/@principles/*` points back at the primary is the silent
 * false-verification hazard (`PRIMARY_LEAKAGE`), and the residue deleter must
 * detach such a link instead of following it.
 */
export function makeJunction(link: string, target: string): void {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

/** The pool root the tools derive for a given primary checkout. */
export function poolRootFor(primary: string): string {
  return path.join(path.dirname(primary), '_worktrees', path.basename(primary));
}

export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function git(dir: string, ...args: string[]): Promise<string> {
  const r = await run('git', args, { cwd: dir });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed in ${dir}\n${r.stderr}`);
  return r.stdout;
}

export async function initRepo(dir: string, opts: { defaultBranch?: string } = {}): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const branch = opts.defaultBranch ?? 'main';
  const steps: Array<[string[], string]> = [
    [['init', '-b', branch], 'git init'],
    [['config', 'user.email', 'test@example.com'], 'config email'],
    [['config', 'user.name', 'PD Test'], 'config name'],
    [['config', 'core.autocrlf', 'false'], 'config autocrlf'],
  ];
  for (const [args, label] of steps) {
    const r = await run('git', args, { cwd: dir });
    if (r.code !== 0) throw new Error('fixture ' + label + ' failed in ' + dir + '\n' + r.stderr);
  }
}

export async function commitFile(dir: string, name: string, content = 'x\n', message?: string): Promise<void> {
  fs.writeFileSync(path.join(dir, name), content, 'utf-8');
  await run('git', ['add', '--', name], { cwd: dir });
  const r = await run('git', ['commit', '-m', message ?? ('add ' + name)], { cwd: dir });
  if (r.code !== 0) throw new Error('commit failed in ' + dir + '\n' + r.stderr);
}

/**
 * Full fixture: a bare "origin" + a primary clone whose main is pushed.
 * Mirrors the real PD topology (primary checkout + origin on GitHub) with
 * plain local paths so everything runs offline.
 */
export async function setupOriginFixture(prefix: string): Promise<{ root: string; origin: string; primary: string }> {
  const root = makeTempDir(prefix);
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const primary = path.join(root, 'primary');

  await run('git', ['init', '--bare', '-b', 'main', origin]);
  await initRepo(seed);
  // PRI-712: pin eol handling. Without this, a clone made under
  // autocrlf=true materializes CRLF files while the per-clone
  // autocrlf=false set below makes later `git status` calls
  // NONDETERMINISTICALLY report ` M` on content-identical files (racy-clean
  // stat flips) — which the prune safety guard must then treat as dirt.
  fs.writeFileSync(path.join(seed, '.gitattributes'), '* -text\n', 'utf-8');
  fs.writeFileSync(path.join(seed, '.gitignore'), 'node_modules/\n', 'utf-8');
  await run('git', ['add', '.gitattributes', '.gitignore'], { cwd: seed });
  await run('git', ['commit', '-m', 'init'], { cwd: seed });
  await run('git', ['remote', 'add', 'origin', origin], { cwd: seed });
  await run('git', ['push', '-u', 'origin', 'main'], { cwd: seed });

  // primary = a clone sharing nothing with seed
  await run('git', ['clone', origin, primary]);
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: primary });
  await run('git', ['config', 'user.name', 'PD Test'], { cwd: primary });
  await run('git', ['config', 'core.autocrlf', 'false'], { cwd: primary });
  // The eol pin only works if it reaches the clones: the file must be part
  // of the committed tree, not just the seed's working directory.
  if (!fs.existsSync(path.join(primary, '.gitattributes'))) {
    throw new Error('fixture bug: .gitattributes was not committed into the seed repository');
  }

  fs.rmSync(seed, { recursive: true, force: true });
  return { root, origin, primary };
}

/** Remove a fixture tree (plain directories only — no junctions are created by these fixtures). */
export function removeFixture(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

export async function worktreeList(
  dir: string
): Promise<Array<{ path: string; branch?: string; locked?: boolean; lockReason?: string }>> {
  const out = await git(dir, 'worktree', 'list', '--porcelain');
  const list: Array<{ path: string; branch?: string; locked?: boolean; lockReason?: string }> = [];
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      list.push({ path: line.slice('worktree '.length).trim() });
    } else if (list.length === 0) {
      continue;
    } else if (line.startsWith('branch ')) {
      list[list.length - 1].branch = line.slice('branch '.length).trim();
    } else if (line === 'locked') {
      list[list.length - 1].locked = true;
    } else if (line.startsWith('locked ')) {
      list[list.length - 1].locked = true;
      list[list.length - 1].lockReason = line.slice('locked '.length).trim();
    }
  }
  return list;
}

/**
 * The live entry for one worktree, matched through git's own path normalization.
 *
 * Matching on the raw string is a trap: the CLI reports a native path
 * (`D:\...\slot`) while `git worktree list --porcelain` reports a forward-slash
 * path (`D:/.../slot`), so `indexOf` silently misses and a substring assertion
 * over the whole list then "passes" against some OTHER worktree's lock.
 */
export async function worktreeEntry(
  dir: string,
  worktreePath: string
): Promise<{ path: string; branch?: string; locked?: boolean; lockReason?: string } | undefined> {
  const list = await worktreeList(dir);
  const normalize = (p: string): string => {
    let resolved = path.resolve(p);
    try {
      resolved = fs.realpathSync.native(resolved);
    } catch {
      /* keep lexical */
    }
    return (process.platform === 'win32' ? resolved.toLowerCase() : resolved).replaceAll('\\', '/');
  };
  const wanted = normalize(worktreePath);
  return list.find((w) => normalize(w.path) === wanted);
}
