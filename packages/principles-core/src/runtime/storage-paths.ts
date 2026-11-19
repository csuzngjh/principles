/**
 * Public workspace path entry point.
 *
 * Narrow public subpath for packages that need PD's canonical workspace-relative
 * paths without importing the wide `./runtime` barrel (which also exports
 * Node-only runtime services). The path contract itself performs no I/O.
 *
 * Only cross-package-needed symbols are exported here (export-surface
 * admission gate): the internal helpers (resolveStateDbDir, the
 * WORKSPACE_*_RELATIVE_PATH constants) stay core-internal — core's own store
 * imports them by relative path, and no other package consumes them.
 */
export {
  PD_DIRS,
  PD_FILES,
  resolvePdPath,
  resolveStateDbPath,
  resolveTrajectoryDbPath,
} from './store/storage-paths.js';
