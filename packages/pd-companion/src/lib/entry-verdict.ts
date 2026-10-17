/**
 * Verdict on a pd-cli entry candidate at spawn time (PRI-1012).
 *
 * The update chain flips the installed version marker BEFORE it lays
 * `~/.pd/runtime/pd-cli/dist/index.js`, so "not on disk yet" and "this value
 * can never be spawned" are different failures that need opposite responses:
 * wait out the first, fail fast on the second. Conflating them degraded a
 * mid-update install to a dead tray icon until a manual restart.
 *
 * `locate.ts` stays fs-free by design; this is the existence-check half that
 * belongs one layer above it.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';

export type EntryVerdict = { ok: true } | { ok: false; detail: string; transient: boolean };

/** Error code for structured failure detail (rc-9 — never a bare message). */
export function errnoCode(err: unknown): string {
  if (err !== null && typeof err === 'object' && Object.hasOwn(err, 'code')) {
    const { code } = err as { code?: unknown };
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return 'unknown';
}

/**
 * Bounded path for logs and pages. Callers reach it only after the control-char
 * screen, so the text is display-safe; the cap is what keeps an unexpected
 * multi-kilobyte candidate from becoming an unbounded log line (rc-8).
 */
function brief(value: string): string {
  return value.length > 160 ? `${value.slice(0, 160)}…` : value;
}

/**
 * A spawn candidate is argv-safe when it is absolute, control-char-free and an
 * existing file. `transient: false` — the value itself is unsafe, so no amount
 * of waiting helps. `transient: true` — only the current filesystem state is
 * wrong, and the update chain is exactly what changes it under us.
 */
export function entryFileVerdict(candidate: string): EntryVerdict {
  // Order matters: the control-character screen runs first so no unbounded,
  // control-bearing text can reach a log line or the degraded page, which
  // echoes `detail` (rc-8 — bounded output for unknown values).
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(candidate)) {
    return { ok: false, detail: `path contains control characters: ${brief(candidate)}`, transient: false };
  }
  if (!path.isAbsolute(candidate)) {
    return { ok: false, detail: `not an absolute path: ${brief(candidate)}`, transient: false };
  }
  try {
    if (fs.statSync(candidate).isFile()) return { ok: true };
    return { ok: false, detail: `not a regular file: ${brief(candidate)}`, transient: true };
  } catch (err) {
    return { ok: false, detail: `stat ${errnoCode(err)}: ${brief(candidate)}`, transient: true };
  }
}
