/**
 * Resolve the active workspace directory.
 *
 * Placeholder: returns cwd if no override passed.
 * In openclaw-plugin, this will resolve via plugin config/env vars.
 */
export function resolveWorkspaceDir(workspaceDir?: string): string {
  if (workspaceDir) return workspaceDir;
  return process.cwd();
}
