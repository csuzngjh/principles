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

/** Environment variable name for workspace directory. */
export const WORKSPACE_ENV = 'PD_WORKSPACE_DIR';

// ── Internal helpers ────────────────────────────────────────────────────────

/** Normalize path to forward slashes for cross-platform comparison. */
function normalizePath(p: string): string {
  return path.resolve(p).replace(/\\/g, '/');
}

/** Emit workspace warnings to stderr. */
function emitWarning(msg: string): void {
  process.stderr.write(`[PD:workspace] WARNING: ${msg}\n`);
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
    if (configDefault && normalizePath(workspaceDir) !== normalizePath(configDefault)) {
      emitWarning(
        `--workspace "${workspaceDir}" differs from config default "${configDefault}" ` +
        `(source: ${discovered.configPath}). Using explicit flag. ` +
        `Consider updating workspace.default in config.`,
      );
    }
    return workspaceDir;
  }

  // Step 3: Check PD_WORKSPACE_DIR env var
  const envWorkspace = process.env.PD_WORKSPACE_DIR?.trim();
  if (envWorkspace) {
    if (configDefault && normalizePath(envWorkspace) !== normalizePath(configDefault)) {
      emitWarning(
        `PD_WORKSPACE_DIR "${envWorkspace}" differs from config default "${configDefault}" ` +
        `(source: ${discovered.configPath}). Using env var. ` +
        `Consider aligning or updating workspace.default.`,
      );
    }
    return envWorkspace;
  }

  // Step 4: Use discovered config default
  if (configDefault) {
    return configDefault;
  }

  // Step 5: No resolution possible — throw (preserves current behavior)
  throw new Error(
    'No workspace directory configured. Set --workspace <path>, ' +
    'PD_WORKSPACE_DIR environment variable, or add workspace.default to .pd/config.yaml.',
  );
}
