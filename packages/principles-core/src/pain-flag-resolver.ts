/**
 * PainFlagPathResolver — Pure function for resolving pain flag file paths.
 *
 * D-04: resolvePainFlagPath(workspaceDir: string): string
 *
 * Usage:
 *   import { resolvePainFlagPath } from '@principles/core';
 *   const flagPath = resolvePainFlagPath('/path/to/workspace');
 *   // => '/path/to/workspace/.state/.pain_flag'
 */

import * as path from 'path';

/**
 * Resolve the absolute path to the .pain_flag file for a given workspace.
 *
 * @param workspaceDir - Absolute path to the workspace directory
 * @returns The absolute path to the .pain_flag file
 */
export function resolvePainFlagPath(workspaceDir: string): string {
  return path.join(workspaceDir, '.state', '.pain_flag');
}
