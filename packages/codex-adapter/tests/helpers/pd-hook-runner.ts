import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export interface HookRunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface RunHookOptions {
  /**
   * Per-invocation subprocess ceiling. Defaults to 15s; the worker harness
   * historically used 20s and preserves it explicitly. Left well under the
   * vitest `testTimeout` (30s) so a hung hook is killed by this fuse — and
   * therefore reported as an abnormal kill — before vitest preempts the test.
   */
  timeoutMs?: number;
}

/**
 * Run the built pd-hook executable in a fresh subprocess. Boundary-validated
 * entry path + argument-vector invocation (no shell), per the repository's
 * subprocess policy shape. This is the single harness shared by the slice-b,
 * owner-loop and worker tests so failure attribution can never diverge across
 * copies again.
 *
 * Failure attribution is deliberate: the hook is fail-open (`process.exitCode`
 * stays 0 on every resolved path), so a subprocess that does NOT return cleanly
 * terminated abnormally. The old per-file `catch` collapsed three distinct
 * causes — harness-timeout kill, external signal (e.g. OOM), and a real non-zero
 * exit — into `status = 1`, so a loaded-runner kill was indistinguishable from a
 * governance regression and surfaced as a misleading `expected 1 to be 0` with no
 * child stderr. Each cause now throws with the captured stderr, so a future red
 * states what actually happened. Note a bare non-zero exit is a REAL bug: it
 * violates the fail-open contract (an escaping rejection at the process entry),
 * not an environmental flake.
 */
export async function runHookExecutable(
  codexHome: string,
  payloadJson: string,
  options: RunHookOptions = {},
): Promise<HookRunResult> {
  const { execFile } = await import('node:child_process');
  const execFileAsync = promisify(execFile);
  const timeout = options.timeoutMs ?? 15_000;
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const entry = path.resolve(packageRoot, 'dist', 'pd-hook.js');
  if (!entry.startsWith(`${packageRoot}${path.sep}`) || !fs.statSync(entry).isFile()) {
    throw new Error(`hook entry not found or outside the package: ${entry}`);
  }
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    const running = execFileAsync(process.execPath, [entry], { encoding: 'utf8', windowsHide: true, timeout });
    // execFile has no `input` option — feed the JSON payload on stdin.
    running.child.stdin?.end(payloadJson);
    const { stdout, stderr } = await running;
    return { status: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number | null; killed?: boolean; signal?: string | null; stdout?: string; stderr?: string; message?: string };
    const stderrDump = (failure.stderr ?? failure.message ?? '').trim().slice(0, 4000);
    const detail = stderrDump ? `\n--- subprocess stderr ---\n${stderrDump}` : '\n--- subprocess stderr --- (empty)';
    if (failure.killed || failure.signal) {
      throw new Error(
        `pd-hook subprocess terminated abnormally (killed=${failure.killed === true}, ` +
          `signal=${failure.signal ?? 'none'}). The hook is fail-open, so an abnormal kill ` +
          `(harness timeout / OOM / external signal) is an environmental failure, NOT a PD ` +
          `governance outcome — re-run before treating it as a regression.${detail}`,
      );
    }
    throw new Error(
      `pd-hook subprocess exited with a non-zero code (${failure.code ?? 'unknown'}) and no ` +
        `signal. This violates the fail-open contract (exitCode must stay 0) — most likely an ` +
        `unhandled rejection at the process entry; see the stderr below. This is a real bug, ` +
        `not an environmental flake.${detail}`,
    );
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
}
