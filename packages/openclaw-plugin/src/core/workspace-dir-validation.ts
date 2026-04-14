/**
 * WorkspaceDir Validation Utilities
 *
 * This module only validates candidate workspace directories and delegates
 * actual resolution policy to workspace-dir-service.ts.
 */

import * as os from 'os';

export interface WorkspaceResolutionContext {
  workspaceDir?: string;
  agentId?: string;
}

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
