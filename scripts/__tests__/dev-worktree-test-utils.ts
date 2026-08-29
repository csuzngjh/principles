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
  const env = { ...process.env, ...(opts.env ?? {}) };
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [path.join(DEV_SCRIPTS_DIR, scriptName), ...args],
      { cwd: opts.cwd, encoding: 'utf-8', env, maxBuffer: 16 * 1024 * 1024 }
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? '' };
  }
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
  fs.writeFileSync(path.join(seed, '.gitignore'), 'node_modules/\n', 'utf-8');
  await run('git', ['add', '.gitignore'], { cwd: seed });
  await run('git', ['commit', '-m', 'init'], { cwd: seed });
  await run('git', ['remote', 'add', 'origin', origin], { cwd: seed });
  await run('git', ['push', '-u', 'origin', 'main'], { cwd: seed });

  // primary = a clone sharing nothing with seed
  await run('git', ['clone', origin, primary]);
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: primary });
  await run('git', ['config', 'user.name', 'PD Test'], { cwd: primary });
  await run('git', ['config', 'core.autocrlf', 'false'], { cwd: primary });

  fs.rmSync(seed, { recursive: true, force: true });
  return { root, origin, primary };
}

/** Remove a fixture tree (plain directories only — no junctions are created by these fixtures). */
export function removeFixture(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

export async function worktreeList(dir: string): Promise<Array<{ path: string; branch?: string }>> {
  const out = await git(dir, 'worktree', 'list', '--porcelain');
  const list: Array<{ path: string; branch?: string }> = [];
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      list.push({ path: line.slice('worktree '.length).trim() });
    } else if (line.startsWith('branch ') && list.length > 0) {
      list[list.length - 1].branch = line.slice('branch '.length).trim();
    }
  }
  return list;
}
