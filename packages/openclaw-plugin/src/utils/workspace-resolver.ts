/**
 * Workspace Directory Resolution Utilities
 *
 * Shared helpers for resolving workspace directories across commands and hooks.
 */

import type { OpenClawPluginApi, PluginCommandContext } from '../openclaw-sdk.js';
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
 * Resolve workspace directory for plugin command execution.
 *
 * Chain: ctx.workspaceDir (canonical) → ctx.config.workspaceDir (dispatcher fallback)
 *
 * CRITICAL: Throws if workspaceDir cannot be resolved. Commands must NEVER silently
 * fall back to process.cwd() as this masks configuration errors and can corrupt
 * the wrong workspace.
 *
 * @param ctx - Plugin command context (has workspaceDir + config properties)
 * @param source - Source label for error messages (e.g. 'evolution-status', 'pain')
 */
export function resolvePluginCommandWorkspaceDir(
  ctx: PluginCommandContext,
  source: string,
): string {
  // 1. Canonical workspaceDir field (set by OpenClaw command dispatcher)
  if (ctx.workspaceDir) {
    const issue = validateWorkspaceDir(ctx.workspaceDir);
    if (!issue) return ctx.workspaceDir;
    throw new Error(`[PD:Command:${source}] ctx.workspaceDir="${ctx.workspaceDir}" is invalid: ${issue}`);
  }

  // 2. Dispatcher may also put workspaceDir in config (legacy/alternative path)
  const configWorkspaceDir = ctx.config?.workspaceDir as string | undefined;
  if (configWorkspaceDir) {
    const issue = validateWorkspaceDir(configWorkspaceDir);
    if (!issue) return configWorkspaceDir;
    throw new Error(`[PD:Command:${source}] ctx.config.workspaceDir="${configWorkspaceDir}" is invalid: ${issue}`);
  }

  // CRITICAL FAILURE: No workspace directory available
  throw new Error(
    `[PD:Command:${source}] CRITICAL: workspaceDir is not set in ctx.workspaceDir or ctx.config.workspaceDir. ` +
    `Commands cannot execute without a valid workspace. Set OPENCLAW_WORKSPACE_DIR env var or ensure the workspace is properly initialized.`,
  );
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
