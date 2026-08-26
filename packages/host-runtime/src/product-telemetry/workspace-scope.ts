/**
 * Workspace scope resolution — Anonymous Product Telemetry v1
 * (review remediation: measurement unit = workspace).
 *
 * Telemetry bookkeeping (dedup, retry, export lock) is keyed per workspace
 * while consent and the telemetry secret stay machine-scope. The key is a
 * keyed fingerprint of the canonical workspace path:
 *
 *   workspaceScopeId = HMAC(telemetrySecret, "workspace:" + canonicalPath)
 *
 * — opaque, locally stable, and carrying no path information without the
 * secret (a plain path hash would be enumerable; this is not). It exists
 * only in `~/.pd/product-telemetry.json` and lock filenames. The server
 * never sees it.
 *
 * A workspace that is moved or renamed resolves to a new scope and is
 * deliberately treated as a new telemetry workspace — no cross-path
 * identity is created.
 */

import fs from 'node:fs';
import path from 'node:path';
import { deriveWorkspaceScopeId } from '@principles/core/runtime-v2';

/**
 * Canonicalize a workspace directory for scope derivation.
 *
 * Invariants (tested): `D:\Code\PD`, `d:\code\pd\`, and any casing variant
 * on Windows resolve to ONE canonical form, so equivalent spellings never
 * produce two telemetry units. On POSIX (case-sensitive filesystems) case
 * is preserved. realpath collapses symlinks and Windows 8.3 short names;
 * when realpath is unavailable (permissions, vanished dir) the resolved
 * path is used as-is — a degraded key, never a thrown error.
 */
export function canonicalizeWorkspacePath(workspaceDir: string): string {
  let resolved = path.resolve(workspaceDir);
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    // Non-throwing by contract (telemetry must never break PD); the resolved
    // path is still a usable local key.
  }
  let canonical = resolved.split(path.sep).join('/');
  if (process.platform === 'win32') {
    // Windows filesystems are case-insensitive: normalize away casing drift
    // (drive letter included) so D:\Code\PD == d:\code\pd.
    canonical = canonical.toLowerCase();
  }
  if (canonical.length > 1 && canonical.endsWith('/')) {
    canonical = canonical.slice(0, -1);
  }
  return canonical;
}

/** Compute the local workspace scope key (hex16) for one secret + workspace. */
export function workspaceScopeIdFor(telemetrySecretHex: string, workspaceDir: string): string {
  return deriveWorkspaceScopeId(telemetrySecretHex, canonicalizeWorkspacePath(workspaceDir));
}

/**
 * Per-workspace export lock path. The filename embeds ONLY the opaque hex
 * scope key — never the workspace path — so one workspace's in-flight
 * export never blocks another's (review remediation P1-1).
 */
export function workspaceExportLockPath(stateFilePath: string, workspaceScopeId: string): string {
  return `${stateFilePath}.export-lock.${workspaceScopeId}`;
}
