/**
 * WorkspaceDir Validation Utilities
 *
 * Provides runtime validation of workspaceDir to catch OpenClaw context bugs early.
 * When a hook receives an invalid workspaceDir, we warn immediately rather than
 * silently writing to the wrong directory.
 */

/* eslint-disable no-unused-vars -- Reason: type definitions require param names that implementations may not use */

import * as os from 'os';
import type { PluginLogger } from '../openclaw-sdk.js';

/**
 * Check if a path looks like a home directory (not a real workspace).
 * Returns the reason if suspicious, or null if it looks valid.
 */
export function validateWorkspaceDir(dir: string | undefined): string | null {
  if (!dir) {
    return 'workspaceDir is undefined/null';
  }
  
  const homeDir = os.homedir();
  
  // Home directory itself is not a valid workspace
  if (dir === homeDir) {
    return `workspaceDir equals home directory (${homeDir}), likely missing context field`;
  }
  
  // Root directory is definitely not a workspace
  if (dir === '/' || dir === '') {
    return `workspaceDir is root or empty: "${dir}"`;
  }
  
  // Check if it looks like a resolved '.' that went wrong
  // Common bad patterns:
  const badPatterns = [
    // Directly under home without a workspace subdirectory
    { pattern: new RegExp(`^${homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), desc: 'is home directory itself' },
    { pattern: new RegExp(`^${homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/$`), desc: 'is home directory with trailing slash' },
  ];
  
  for (const { pattern, desc } of badPatterns) {
    if (pattern.test(dir)) {
      return `workspaceDir ${desc}: "${dir}"`;
    }
  }
  
  return null; // Looks valid
}

/**
 * Try to resolve workspaceDir from agentId.
 * Returns the resolved path if successful and valid, or null.
 */
function tryResolveFromAgentId(
  agentId: string,
  api: {
    runtime: { agent: { resolveAgentWorkspaceDir: (config: unknown, agentId: string) => string } };
    config: unknown;
  },
  onWarning: (msg: string) => void,
): string | null {
  try {
    const resolved = api.runtime.agent.resolveAgentWorkspaceDir(api.config, agentId);
    const issue = validateWorkspaceDir(resolved);
    if (issue) {
      onWarning(`agentId resolution returned invalid: "${resolved}" (${issue})`);
      return null;
    }
    return resolved;
  } catch (err) {
    onWarning(`failed to resolve from agentId: ${String(err)}`);
    return null;
  }
}

/**
 * Validate a fallback workspaceDir and warn if invalid.
 * Returns the path regardless (it's the last resort).
 */
function validateFallback(path: string, onWarning: (msg: string) => void): string {
  const issue = validateWorkspaceDir(path);
  if (issue) {
    onWarning(`FINAL FALLBACK "${path}" is also invalid: ${issue}. Events will be written to wrong location!`);
  }
  return path;
}

/**
 * Resolve workspaceDir with validation and warning.
 *
 * Usage:
 *   const workspaceDir = resolveValidWorkspaceDir(ctx, api, { source: 'after_tool_call' });
 *
 * Fallback chain:
 *   1. ctx.workspaceDir (validated)
 *   2. api.runtime.agent.resolveAgentWorkspaceDir(config, ctx.agentId)
 *   3. api.resolvePath('.') (last resort, warns loudly)
 */
export function resolveValidWorkspaceDir(
  ctx: { workspaceDir?: string; agentId?: string },
  api: {
    runtime: { agent: { resolveAgentWorkspaceDir: (config: unknown, agentId: string) => string } };
    config: unknown;
    resolvePath: (input: string) => string;
    logger: PluginLogger;
  },
  options?: { source?: string; onWarning?: (msg: string) => void },
): string {
  const source = options?.source || 'unknown';
  const onWarning = options?.onWarning || ((msg: string) => api.logger.warn(`[PD:workspaceDir] ${msg}`));

  // 1. Try ctx.workspaceDir
  if (ctx.workspaceDir) {
    const issue = validateWorkspaceDir(ctx.workspaceDir);
    if (issue) {
      onWarning(`${source}: ctx.workspaceDir="${ctx.workspaceDir}" is invalid: ${issue}`);
    } else {
      return ctx.workspaceDir;
    }
  }

  // 2. Try agentId resolution
  if (ctx.agentId) {
    const fromAgent = tryResolveFromAgentId(ctx.agentId, api, onWarning);
    if (fromAgent) return fromAgent;
  }

  // 3. Final fallback
  return validateFallback(api.resolvePath('.'), onWarning);
}

/**
 * Log workspaceDir resolution for debugging.
 * Call this once during plugin startup to verify hook contexts.
 */
export function logWorkspaceDirHealth(ctx: { workspaceDir?: string; agentId?: string }, source: string, api: {
  runtime: { agent: { resolveAgentWorkspaceDir: (config: unknown, agentId: string) => string } };
  config: unknown;
  resolvePath: (input: string) => string;
  logger: PluginLogger;
}): void {
  const resolved = resolveValidWorkspaceDir(ctx, api, { source });
  const issue = validateWorkspaceDir(resolved);
  
  if (issue) {
    api.logger.error(`[PD:health] ${source}: workspaceDir="${resolved}" - ${issue}`);
  } else {
    api.logger.info(`[PD:health] ${source}: workspaceDir="${resolved}" ✓`);
  }
}
