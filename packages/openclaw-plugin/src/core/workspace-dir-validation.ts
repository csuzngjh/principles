/**
 * WorkspaceDir Validation Utilities
 *
 * This module only validates candidate workspace directories and delegates
 * actual resolution policy to workspace-dir-service.ts.
 */

import * as os from 'os';
import type { PluginLogger } from '../openclaw-sdk.js';
import { resolveWorkspaceDir, type WorkspaceResolutionContext } from './workspace-dir-service.js';

export function validateWorkspaceDir(dir: string | undefined): string | null {
  if (!dir) {
    return 'workspaceDir is undefined/null';
  }

  const homeDir = os.homedir();

  if (dir === homeDir) {
    return `workspaceDir equals home directory (${homeDir}), likely missing context field`;
  }

  if (dir === '/' || dir === '') {
    return `workspaceDir is root or empty: "${dir}"`;
  }

  const escapedHome = homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const badPatterns = [
    { pattern: new RegExp(`^${escapedHome}$`), desc: 'is home directory itself' },
    { pattern: new RegExp(`^${escapedHome}/$`), desc: 'is home directory with trailing slash' },
  ];

  for (const { pattern, desc } of badPatterns) {
    if (pattern.test(dir)) {
      return `workspaceDir ${desc}: "${dir}"`;
    }
  }

  return null;
}

export function resolveValidWorkspaceDir(
  ctx: WorkspaceResolutionContext,
  api: {
    runtime: { agent: { resolveAgentWorkspaceDir: (config: unknown, agentId: string) => string } };
    config: unknown;
    logger: PluginLogger;
  },
  options?: { source?: string; fallbackAgentId?: string },
): string | undefined {
  return resolveWorkspaceDir(api as never, ctx, {
    source: options?.source,
    fallbackAgentId: options?.fallbackAgentId,
    logger: api.logger,
  });
}

export function logWorkspaceDirHealth(
  ctx: WorkspaceResolutionContext,
  source: string,
  api: {
    runtime: { agent: { resolveAgentWorkspaceDir: (config: unknown, agentId: string) => string } };
    config: unknown;
    logger: PluginLogger;
  },
): void {
  const resolved = resolveValidWorkspaceDir(ctx, api, { source, fallbackAgentId: 'main' });
  const issue = validateWorkspaceDir(resolved);

  if (issue) {
    api.logger.error(`[PD:health] ${source}: workspaceDir="${resolved}" - ${issue}`);
  } else {
    api.logger.info(`[PD:health] ${source}: workspaceDir="${resolved}" OK`);
  }
}
