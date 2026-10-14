/**
 * Resolve the active workspace directory.
 *
 * Resolution chain (highest priority first):
 * 1. Explicit --workspace flag
 * 2. PD_WORKSPACE_DIR environment variable
 * 3. Fail closed when the standing workspace's config exists but cannot be parsed
 * 4. Discovered workspace default — the nearest `.pd/config.yaml` at or above cwd
 *    first, then the OpenClaw default locations (see discoverWorkspaceDefault)
 * 5. Throw Error (preserve current behavior for unconfigured setups)
 *
 * When the resolved path differs from workspace.default in config,
 * a warning is emitted to stderr.
 *
 * This is the single workspace authority for pd-cli: every command — read and
 * write alike — resolves its target here, so the cwd step changes write targets
 * too. Discovery (pd-config-loader) only reports what it found; the statements
 * about which workspace is actually used live here and nowhere else.
 *
 * Step 3 exists because this chain feeds write commands. An unparseable config
 * means the operator's declaration is UNKNOWN, not absent, so the directory they
 * are standing in must not silently become a write target (PRI-957 r3 P1). An
 * explicit override still wins: the operator has then stated the target themselves.
 *
 * @throws Error if no workspace directory can be determined.
 */

import * as path from 'path';
import { discoverWorkspaceDefault } from './services/pd-config-loader.js';
import type { WorkspaceDiscoveryResult } from './services/pd-config-loader.js';
import { assertSafeDirectoryRoot } from './utils/path-security.js';

/** Environment variable name for workspace directory. */
export const WORKSPACE_ENV = 'PD_WORKSPACE_DIR';

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Normalize a path for cross-platform string comparison.
 *
 * Comparison-only helper: it never feeds a filesystem operation. It resolves
 * against cwd (not just `path.normalize`) because an operator-supplied override
 * may be relative (`-w .`) while the discovered default is always absolute, and
 * comparing the two as strings would warn about a difference that does not exist
 * (PRI-957 review P3). The workspace root itself is still validated by
 * `assertWorkspaceDirInside` before any IO uses it.
 */
function normalizePath(p: string): string {
  const resolved = path.resolve(p).replace(/\\/g, '/');
  const stripped = resolved.replace(/\/+$/, '');
  return stripped.length > 0 ? stripped : resolved;
}

/** Emit workspace warnings to stderr. */
function emitWarning(msg: string): void {
  process.stderr.write(`[PD:workspace] WARNING: ${msg}\n`);
}

/**
 * Emit a non-warning statement about the workspace actually used. Only the
 * resolution stage may do this: discovery reports what it found, and two
 * "I used X" lines in one command contradict each other (PRI-957 review P2).
 */
function emitUsedWorkspace(msg: string): void {
  process.stderr.write(`[PD:workspace] ${msg}\n`);
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
  discovered: { configPath?: string; declared?: boolean } | null,
): void {
  if (configDefault && normalizePath(override) !== normalizePath(configDefault)) {
    // A cwd hit may be a bare directory with no workspace.default at all; telling the
    // operator to "update workspace.default in config" would then point at a field
    // nobody declared (PRI-957 review).
    const isDeclaredDefault = discovered?.declared !== false;
    const baseline = isDeclaredDefault ? 'config default' : 'workspace discovered from your current directory';
    emitWarning(
      `"${override}" differs from ${baseline} "${configDefault}" ` +
        `(source: ${discovered?.configPath}). Using explicit override. ` +
        `Consider ${isDeclaredDefault
          ? 'updating workspace.default in config.'
          : 'dropping the override, or adding workspace.default to that config.'}`,
    );
  }
}

/**
 * State the target when an explicit override wins over a config that could not be
 * read. `emitWarningIfDiffers` stays silent in that case (there is no known default
 * to differ from), so without this the operator's only line would be discovery's
 * "workspace.default is unknown" warning — an unstated target (rc-9-no-silent-fallback).
 */
function announceOverrideOverUnreadable(
  override: string,
  source: string,
  discovered: WorkspaceDiscoveryResult | null,
): void {
  if (discovered?.kind !== 'unparseable') return;
  emitUsedWorkspace(
    `using workspace "${override}" from ${source} ` +
      `(${discovered.configPath} could not be parsed, so no declared default was compared)`,
  );
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Resolve the active workspace directory.
 *
 * API surface: `(workspaceDir?: string): string`
 * All 13 command files and 20 test mocks rely on this exact signature.
 */
export function resolveWorkspaceDir(workspaceDir?: string): string {
  // Discovery runs before the chain so an override can be compared against it.
  const discovered = discoverWorkspaceDefault();
  const usable = discovered?.kind === 'resolved' ? discovered : null;
  const configDefault = usable?.workspaceDefault;

  // Chain step 1: --workspace flag (highest priority)
  if (workspaceDir) {
    assertWorkspaceDirInside(workspaceDir, '--workspace');
    emitWarningIfDiffers(workspaceDir, configDefault, usable);
    announceOverrideOverUnreadable(workspaceDir, '--workspace', discovered);
    return workspaceDir;
  }

  // Chain step 2: PD_WORKSPACE_DIR env var
  const envWorkspace = process.env.PD_WORKSPACE_DIR?.trim();
  if (envWorkspace) {
    assertWorkspaceDirInside(envWorkspace, WORKSPACE_ENV);
    emitWarningIfDiffers(envWorkspace, configDefault, usable);
    announceOverrideOverUnreadable(envWorkspace, WORKSPACE_ENV, discovered);
    return envWorkspace;
  }

  // Chain step 3: fail closed on a config that exists but cannot be read. Reaching
  // here means no operator override is in force, so the only remaining "answer" would
  // be the directory the operator happens to be standing in — inferred from a file whose
  // declaration is unknown. This chain feeds write commands (pd pain record), so that
  // guess is not acceptable (PRI-957 review round 3 P1).
  if (discovered?.kind === 'unparseable') {
    throw new Error(
      `Cannot resolve a workspace directory: ${discovered.configPath} could not be parsed ` +
        `(${discovered.reason}), so its workspace.default is unknown. Refusing to fall back to ` +
        `the directory you are standing in, because this command may write to it. ` +
        `Fix that file, or state the target explicitly with --workspace <path> or ` +
        `${WORKSPACE_ENV}=<path>.`,
    );
  }

  // Chain step 4: discovered config default
  if (configDefault && usable) {
    assertWorkspaceDirInside(configDefault, 'workspace.default');
    if (usable.source === 'cwd' && usable.declared === false) {
      // PRI-957 review P1: this resolution chain serves read AND write commands, so a
      // workspace inferred from the current directory also redirects writes. It is the
      // one outcome no operator declared, so name the target instead of leaving it
      // implied (rc-9-no-silent-fallback). Declared defaults need no line: the config
      // the operator wrote already states the target.
      emitUsedWorkspace(
        `using workspace "${configDefault}" — inferred from your current directory ` +
        `(config: ${usable.configPath}; no workspace.default declared)`,
      );
    }
    return configDefault;
  }
  // Chain step 5: no resolution possible — throw (preserves current behavior)
  throw new Error(
    'No workspace directory configured. Set --workspace <path>, ' +
    'PD_WORKSPACE_DIR environment variable, add workspace.default to .pd/config.yaml, ' +
    'or run from inside a directory whose own or parent .pd/config.yaml exists.',
  );
}
