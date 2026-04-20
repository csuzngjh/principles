/**
 * WorkspaceResolver — resolves the active workspace directory.
 *
 * This is a placeholder implementation that uses process.cwd().
 * In openclaw-plugin, this will be replaced with a concrete implementation
 * that respects plugin config, env vars, and workspace files.
 */

import type { WorkspaceResolver } from '../../principles-core/dist/types/workspace-resolver.js';

export function resolveWorkspaceDir(workspaceDir?: string): string {
  if (workspaceDir) return workspaceDir;
  return process.cwd();
}

// WorkspaceResolver interface impl (for future extension)
export const workspaceResolver: WorkspaceResolver = {
  resolve: resolveWorkspaceDir,
};
