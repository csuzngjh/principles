/**
 * PD-Lab v0.3 T3b test helper — the ONE subprocess primitive for the T3b
 * wiring tests (scripts/__tests__/pd-lab-t3b-harness-wiring.test.ts).
 *
 * Runs a repository .mjs entry with the literal node binary and an argument
 * array (never a shell, never string-built commands); the working directory
 * is pinned to this repository root so relative resolution inside the
 * entries behaves exactly like `npm run lab:*` invocations. Fixture-specific
 * data (paths) travels on STDIN, never on the command line. execFileSync
 * throws on a non-zero exit; the thrown error carries status/stdout/stderr,
 * which runRepoScript normalizes for exit-code assertions (CF-01/CF-09 …).
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * @param {string} script absolute or repo-relative path to the entry .mjs
 * @param {string[]} args argument vector (no shell interpretation)
 * @param {{ input?: string }} [options] optional stdin payload
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
export function runRepoScript(script, args, options = {}) {
  const scriptPath = path.isAbsolute(script) ? script : path.join(repoRoot, script);
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, ...args], {
      cwd: repoRoot, encoding: 'utf8', timeout: 240_000, maxBuffer: 32 * 1024 * 1024,
      ...(options.input !== undefined ? { input: options.input } : {}),
    });
    return { status: 0, stdout: String(stdout), stderr: '' };
  } catch (err) {
    const e = /** @type {{ status?: number, stdout?: string, stderr?: string, killed?: boolean, signal?: string, message?: string }} */ (err);
    return {
      status: e.status ?? (e.killed ? 124 : -1),
      stdout: e.stdout ?? '',
      stderr: e.stderr && e.stderr !== '' ? String(e.stderr) : String(e.message ?? err),
    };
  }
}
