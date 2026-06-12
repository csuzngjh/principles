/**
 * WorkspaceDir Validation Utilities
 *
 * This module only validates candidate workspace directories. Runtime hook
 * resolution policy lives at the I/O boundary in utils/workspace-resolver.ts.
 */

import * as os from 'os';
import * as path from 'path';

export interface WorkspaceResolutionContext {
  workspaceDir?: string;
  agentId?: string;
}

export function validateWorkspaceDir(dir: string | undefined): string | null {
  if (!dir) {
    return 'workspaceDir is undefined/null';
  }

  if (/^[A-Za-z]:\\?$/.test(dir)) {
    return `workspaceDir is a drive root: "${dir}"`;
  }

  const resolved = path.resolve(dir);
  const homeDir = os.homedir();

  if (resolved === homeDir) {
    return `workspaceDir equals home directory (${homeDir}), likely missing context field`;
  }

  if (resolved === '/' || resolved === '') {
    return `workspaceDir is root or empty: "${resolved}"`;
  }

  if (/^[A-Za-z]:\\?$/.test(resolved)) {
    return `workspaceDir is a drive root: "${resolved}"`;
  }

  const escapedHome = homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const badPatterns = [
    { pattern: new RegExp(`^${escapedHome}[\\\\/]?$`), desc: 'is home directory' },
  ];

  for (const { pattern, desc } of badPatterns) {
    if (pattern.test(resolved)) {
      return `workspaceDir ${desc}: "${resolved}"`;
    }
  }

  return null;
}
