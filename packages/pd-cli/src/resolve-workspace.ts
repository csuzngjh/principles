/**
 * Resolve the active workspace directory.
 *
 * Resolution chain (highest priority first):
 * 1. Explicit --workspace flag
 * 2. PD_WORKSPACE_DIR environment variable
 * 3. workspace.default from discovered .pd/config.yaml
 * 4. Throw Error (preserve current behavior for unconfigured setups)
 *
 * When the resolved path differs from workspace.default in config,
 * a warning is emitted to stderr.
 *
 * @throws Error if no workspace directory can be determined.
 */

import * as path from 'path';
import { discoverWorkspaceDefault } from './services/pd-config-loader.js';
import { assertSafeDirectoryRoot } from './utils/path-security.js';

/** Environment variable name for workspace directory. */
export const WORKSPACE_ENV = 'PD_WORKSPACE_DIR';

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Normalize a path to forward slashes for cross-platform string comparison.
 *
 * Comparison-only helper: it never resolves against the filesystem and never
 * feeds a filesystem operation, so it intentionally uses `path.normalize`
 * (pure string normalization) instead of `path.resolve`. Callers compare two
 * paths for equality after normalization; the workspace root itself is
 * validated by `assertWorkspaceDirInside` before any IO uses it.
 */
function normalizePath(p: string): string {
  return path.normalize(p).replace(/\\/g, '/');
}

/** Emit workspace warnings to stderr. */
function emitWarning(msg: string): void {
  process.stderr.write(`[PD:workspace] WARNING: ${msg}\n`);
}

/**
 * Validate an operator-supplied workspace root before it is used as an IO
 * root. Delegates to the shared canonical-root validator (empty, parent
 * traversal, filesystem root). Returns nothing; callers keep the original
 * value so downstream resolution semantics are unchanged.
 */
function assertWorkspaceDirInside(p: string, source: string): void {
  assertSafeDirectoryRoot(p, source);
}

/** Emit a warning when an explicit override differs from config default. */
function emitWarningIfDiffers(
  override: string,
  configDefault: string | undefined,
  discovered: { configPath?: string } | null,
): void {
  if (configDefault && normalizePath(override) !== normalizePath(configDefault)) {
    emitWarning(
      `"${override}" differs from config default "${configDefault}" ` +
        `(source: ${discovered?.configPath}). Using explicit override. ` +
        `Consider updating workspace.default in config.`,
    );
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Resolve the active workspace directory.
 *
 * API surface: `(workspaceDir?: string): string`
 * All 13 command files and 20 test mocks rely on this exact signature.
 */
export function resolveWorkspaceDir(workspaceDir?: string): string {
  // Step 1: Discover config-based default (runs always for warning comparison)
  const discovered = discoverWorkspaceDefault();
  const configDefault = discovered?.workspaceDefault;

  // Step 2: Check --workspace flag (highest priority)
  if (workspaceDir) {
    assertWorkspaceDirInside(workspaceDir, '--workspace');
    emitWarningIfDiffers(workspaceDir, configDefault, discovered);
    return workspaceDir;
  }

  // Step 3: Check PD_WORKSPACE_DIR env var
  const envWorkspace = process.env.PD_WORKSPACE_DIR?.trim();
  if (envWorkspace) {
    assertWorkspaceDirInside(envWorkspace, WORKSPACE_ENV);
    emitWarningIfDiffers(envWorkspace, configDefault, discovered);
    return envWorkspace;
  }

  // Step 4: Use discovered config default
  if (configDefault) {
    assertWorkspaceDirInside(configDefault, 'workspace.default');
    return configDefault;
  }
  // Step 5: No resolution possible — throw (preserves current behavior)
  throw new Error(
    'No workspace directory configured. Set --workspace <path>, ' +
    'PD_WORKSPACE_DIR environment variable, or add workspace.default to .pd/config.yaml.',
  );
}
