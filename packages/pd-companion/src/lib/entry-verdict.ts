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
 * A spawn candidate is argv-safe when it is absolute, control-char-free and an
 * existing file. `transient: false` — the value itself is unsafe, so no amount
 * of waiting helps. `transient: true` — only the current filesystem state is
 * wrong, and the update chain is exactly what changes it under us.
 */
export function entryFileVerdict(candidate: string): EntryVerdict {
  if (!path.isAbsolute(candidate)) {
    return { ok: false, detail: `not an absolute path: ${candidate}`, transient: false };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(candidate)) {
    return { ok: false, detail: `path contains control characters: ${JSON.stringify(candidate)}`, transient: false };
  }
  try {
    if (fs.statSync(candidate).isFile()) return { ok: true };
    return { ok: false, detail: `not a regular file: ${candidate}`, transient: true };
  } catch (err) {
    return { ok: false, detail: `stat ${errnoCode(err)}: ${candidate}`, transient: true };
  }
}
