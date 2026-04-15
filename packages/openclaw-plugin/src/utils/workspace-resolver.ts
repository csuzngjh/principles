/**
 * Workspace Directory Resolution Utilities
 *
 * Shared helpers for resolving workspace directories across commands and hooks.
 */

import type { OpenClawPluginApi } from '../openclaw-sdk.js';
import { validateWorkspaceDir, type WorkspaceResolutionContext } from '../core/workspace-dir-validation.js';
import { resolveWorkspaceDir } from '../core/workspace-dir-service.js';
import { resolveWorkspaceDirFromApi } from '../core/path-resolver.js';

/**
 * Resolve workspace directory for command execution.
 *
 * Chain: ctx.workspaceDir → resolveWorkspaceDirFromApi (official OpenClaw API + env vars)
 *
 * CRITICAL: Throws if workspaceDir cannot be resolved. Silent failures are dangerous
 * because commands might operate on the wrong directory.
 */
export function resolveCommandWorkspaceDir(
  api: OpenClawPluginApi,
  ctx: { workspaceDir?: string },
): string {
  // 1. Direct from command context (most reliable — set by OpenClaw for current session)
  if (ctx.workspaceDir) {
    const issue = validateWorkspaceDir(ctx.workspaceDir);
    if (!issue) return ctx.workspaceDir;
    api.logger.error(`[PD:Command] ctx.workspaceDir="${ctx.workspaceDir}" is invalid: ${issue}`);
  }

  // 2. Official OpenClaw API → env vars → config file
  const resolved = resolveWorkspaceDirFromApi(api);
  if (resolved) return resolved;

  // CRITICAL FAILURE: Cannot determine workspace directory
  const errorMsg = `[PD:Command] CRITICAL: Cannot resolve workspace directory. ` +
    `ctx.workspaceDir="${ctx.workspaceDir}" is invalid, and all fallbacks failed. ` +
    `Commands will NOT execute to prevent data corruption.`;
  api.logger.error(errorMsg);

  throw new Error(errorMsg);
}

/**
 * Resolve workspace directory for tool hook execution (safe version).
 * Returns undefined instead of throwing if resolution fails.
 */
export function resolveToolHookWorkspaceDirSafe(
  ctx: WorkspaceResolutionContext,
  api: OpenClawPluginApi,
  source: string,
): string | undefined {
  return resolveWorkspaceDir(api, ctx, { source });
}
