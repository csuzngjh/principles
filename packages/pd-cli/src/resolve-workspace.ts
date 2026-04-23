/**
 * Resolve the active workspace directory.
 *
 * Requires explicit input — no silent cwd fallback.
 * In openclaw-plugin, this will resolve via plugin config/env vars.
 *
 * @throws Error if no workspace directory can be determined.
 */
export function resolveWorkspaceDir(workspaceDir?: string): string {
  if (workspaceDir) return workspaceDir;
  const envWorkspace = process.env.PD_WORKSPACE_DIR;
  if (envWorkspace) return envWorkspace;
  throw new Error(
    'No workspace directory configured. Set --workspace <path>, ' +
    'PD_WORKSPACE_DIR environment variable, or run from within an initialized workspace.',
  );
}

/** Environment variable name for workspace directory. */
export const WORKSPACE_ENV = 'PD_WORKSPACE_DIR';
