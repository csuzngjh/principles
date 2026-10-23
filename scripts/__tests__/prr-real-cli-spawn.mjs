// PRI-1002 — CLI spawn helper for the prr-real authorization reconciliation
// tests. Kept in its own module so the suite itself stays free of
// child_process plumbing.
//
// Safety: execFileSync spawns WITHOUT a shell — every argument is a fixed
// flag or a test-built temp-file path; no string concatenation reaches a
// command interpreter, and `shell: false` is set explicitly.
import { execFileSync, execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dev', 'principle-learning-lab', 'prr', 'run-prr-real.mjs');

/**
 * The current checkout's HEAD — the frozen-commit fixture must pin THIS (the
 * gate refuses a run whose running commit differs from the approved one).
 */
export function gitHead() {
  return execSync('git rev-parse HEAD', { cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'), encoding: 'utf8' }).trim();
}

/**
 * Run the PRR real CLI with the mock transport and the given fixture files.
 * Returns { status, stdout, stderr } — never throws on non-zero exit.
 */
export function runCli({ datasetDir, freezeFile, preregFile, authFile, resolverFile, outDir, transport = 'mock', allowDirty = true }) {
  const args = [
    CLI,
    '--dataset', datasetDir,
    '--freeze', freezeFile,
    '--prereg', preregFile,
    '--authorization', authFile,
    '--transport', transport,
    '--out', outDir,
  ];
  if (resolverFile) args.push('--evidence-resolver', resolverFile);
  if (allowDirty) args.push('--allow-dirty-worktree-for-mock');
  try {
    const stdout = execFileSync(process.execPath, args, { encoding: 'utf8', shell: false });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? '') + String(error.message ?? ''),
    };
  }
}
