/**
 * Workspace database path contract.
 *
 * Single source of truth for where the two SQLite files of a PD workspace live:
 *
 *   - `<workspaceDir>/.pd/state.db`        — authoritative runtime state
 *   - `<workspaceDir>/.state/trajectory.db` — session / tool event stream
 *
 * Every consumer in packages that depend on `@principles/core` resolves these
 * paths here instead of assembling the `'.pd'` / `'state.db'` literal segments
 * locally. Changing where a database lives is then one edit in this file.
 *
 * Deliberately no filesystem I/O: this module decides *where* a database is,
 * while `SqliteConnection` keeps the leak guard, directory creation, pragma and
 * schema responsibilities. Moving a caller from its own `path.join(...)` to
 * these helpers is path-string-identical (same `path.join` segments, same
 * separators, same result).
 *
 * Not the authority for `openclaw-plugin`: that package has no declared
 * `@principles/core` dependency, so its own `core/paths.ts` (`PD_FILES`)
 * remains the plugin-side authority.
 */
import { join } from 'path';

const STATE_DIR_NAME = '.pd';
const STATE_DB_FILE_NAME = 'state.db';
const TRAJECTORY_DIR_NAME = '.state';
const TRAJECTORY_DB_FILE_NAME = 'trajectory.db';

/** Workspace-relative state database location, POSIX form (`.pd/state.db`). */
export const WORKSPACE_STATE_DB_RELATIVE_PATH = `${STATE_DIR_NAME}/${STATE_DB_FILE_NAME}`;

/** Workspace-relative trajectory database location, POSIX form (`.state/trajectory.db`). */
export const WORKSPACE_TRAJECTORY_DB_RELATIVE_PATH = `${TRAJECTORY_DIR_NAME}/${TRAJECTORY_DB_FILE_NAME}`;

/** `<workspaceDir>/.pd` — the directory that holds the state database. */
export function resolveStateDbDir(workspaceDir: string): string {
  return join(workspaceDir, STATE_DIR_NAME);
}

/** `<workspaceDir>/.pd/state.db` — the authoritative workspace state database. */
export function resolveStateDbPath(workspaceDir: string): string {
  return join(workspaceDir, STATE_DIR_NAME, STATE_DB_FILE_NAME);
}

/** `<workspaceDir>/.state/trajectory.db` — the workspace trajectory event database. */
export function resolveTrajectoryDbPath(workspaceDir: string): string {
  return join(workspaceDir, TRAJECTORY_DIR_NAME, TRAJECTORY_DB_FILE_NAME);
}

/**
 * Inverse of {@link resolveStateDbPath}: derive the workspace root from a state
 * database path. `dbPath` is `<workspaceDir>/.pd/state.db`, so the workspace is
 * two levels up.
 */
export function workspaceDirFromStateDbPath(stateDbPath: string): string {
  return join(stateDbPath, '..', '..');
}
