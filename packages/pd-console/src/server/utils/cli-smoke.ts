/**
 * PRI-711: post-apply CLI smoke for the full-update pipeline.
 *
 * The full update swaps component dists without running npm install, and
 * resolution gaps of one class have now shipped three times — each discovered
 * only as a bricked CLI at the next console launch (PRI-561 host-runtime
 * links, the 2026-08-29 install-layout component gap, PRI-711 codex-adapter).
 * Spawning the pd CLI once with `--version` loads its entire eager import
 * graph (health-codex → @principles/codex-adapter →
 * @principles/host-runtime → @principles/core) and exits without touching
 * workspace state, so a gap anywhere in that graph surfaces before the update
 * is recorded as a success.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type CliSmokeResult = { ok: true; version: string } | { ok: false; error: string };

/**
 * Spawn the pd CLI entry and require exit 0.
 *
 * Resolves `node` from PATH — the same resolution the installed bin/pd.cmd
 * shim already depends on, so any environment that can run `pd` at all can
 * run this probe. The entry path is boundary-checked to stay inside the
 * pd-cli component dir (same guard shape as the legacy-rule preflight's
 * subprocess target), and the subprocess is invoked with an argv array —
 * never a shell string (ERR-045). Bounded stderr extract on failure (rc-8);
 * never throws.
 */
export function runPostUpdateCliSmoke(pdCliDir: string): CliSmokeResult {
  const resolvedRoot = path.resolve(pdCliDir);
  const pdCliEntry = path.join(resolvedRoot, 'dist', 'index.js');
  if (!pdCliEntry.startsWith(resolvedRoot + path.sep)) {
    return { ok: false, error: `pd CLI entry ${pdCliEntry} is outside the pd-cli component dir ${resolvedRoot}` };
  }
  if (!fs.existsSync(pdCliEntry)) {
    return { ok: false, error: `pd CLI entry not found at ${pdCliEntry}` };
  }
  try {
    const stdout = execFileSync('node', [pdCliEntry, '--version'], {
      timeout: 60_000,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const version = (stdout.trim().split(/\r?\n/, 1)[0] ?? '').trim();
    return { ok: true, version };
  } catch (error) {
    // rc-1/rc-2: the child failure shape is unknown — guard every read.
    // Node prints the error MESSAGE first and stack frames after, so the
    // operator-facing extract is the bounded HEAD of stderr (a tail would
    // carry only stack noise — observed in the PRI-711 test fixture).
    let reason = error instanceof Error ? error.message : String(error);
    if (typeof error === 'object' && error !== null && Object.hasOwn(error, 'stderr')) {
      const { stderr } = error as { stderr?: unknown };
      if (typeof stderr === 'string' && stderr.trim().length > 0) reason = stderr;
    }
    return { ok: false, error: reason.trim().slice(0, 400) };
  }
}
