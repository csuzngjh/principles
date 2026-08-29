/**
 * Codex home resolution (G1 probe report §7, source-pinned from
 * codex-rs/utils/home-dir/src/lib.rs find_codex_home).
 *
 * Rules: CODEX_HOME, when set and non-empty, MUST already exist and be a
 * directory and is canonicalized; a missing path or a file path is an error.
 * When unset, the home comes from the OS home directory plus `.codex`, and
 * existence is NOT verified. There is one OS-generic implementation.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type CodexHomeResolution =
  | { ok: true; home: string }
  | { ok: false; reason: string; nextAction: string };

/**
 * Canonicalize a Windows path to its final long form. Node's JS realpath
 * preserves 8.3 short-name segments (ADMINI~1), while hook payloads carry
 * the long form — containment comparisons must use one canonical form, so
 * prefer the native realpath (GetFinalPathNameByHandle) and fall back to
 * the JS implementation where native is unavailable.
 */
export function canonicalizePath(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return fs.realpathSync(target);
  }
}

export function resolveCodexHome(env: { CODEX_HOME?: string | undefined } = process.env): CodexHomeResolution {
  const configured = env.CODEX_HOME;
  if (configured !== undefined && configured.trim() !== '') {
    try {
      const stats = fs.statSync(configured);
      if (!stats.isDirectory()) {
        return { ok: false, reason: 'codex_home_not_directory', nextAction: 'CODEX_HOME must point at an existing directory (Codex fatal-error contract).' };
      }
      return { ok: true, home: canonicalizePath(configured) };
    } catch {
      return { ok: false, reason: 'codex_home_unavailable', nextAction: 'CODEX_HOME is set but does not exist; unset it or create the directory.' };
    }
  }
  return { ok: true, home: path.join(os.homedir(), '.codex') };
}
