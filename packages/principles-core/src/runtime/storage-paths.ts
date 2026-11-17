/**
 * Public workspace path entry point.
 *
 * Narrow public subpath for packages that need PD's canonical workspace-relative
 * paths without importing the wide `./runtime` barrel (which also exports
 * Node-only runtime services). The path contract itself performs no I/O.
 */
export {
  PD_DIRS,
  PD_FILES,
  WORKSPACE_STATE_DB_RELATIVE_PATH,
  WORKSPACE_TRAJECTORY_DB_RELATIVE_PATH,
  resolvePdPath,
  resolveStateDbDir,
  resolveStateDbPath,
  resolveTrajectoryDbPath,
} from './store/storage-paths.js';
