/**
 * WorkspaceResolver Interface
 *
 * Framework-agnostic contract for resolving the active workspace directory.
 * Concrete implementation is provided by the openclaw-plugin extension mechanism.
 *
 * D-01: Interface in @principles/core, implementation in openclaw-plugin
 */

/**
 * Interface for resolving the active workspace directory.
 *
 * Concrete implementation lives in openclaw-plugin via extension/override pattern.
 * CLI commands depend on the interface only — no plugin internals.
 */
export interface WorkspaceResolver {
  /**
   * Resolve the active workspace directory.
   *
   * @param workspaceDir - Optional override. If not provided, resolves using
   *                       platform-specific defaults (env vars, config file, cwd).
   * @returns The resolved workspace directory path.
   */
  resolve(workspaceDir?: string): string;
}
