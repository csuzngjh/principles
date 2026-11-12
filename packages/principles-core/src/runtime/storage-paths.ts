/**
 * Public workspace database path entry point.
 *
 * Narrow public subpath for consumers in other packages (console, CLI) that
 * need to decide *where* a workspace database lives without importing the wide
 * `./runtime` barrel. The authority itself stays in
 * `runtime/store/storage-paths.ts`; this file only selects the two resolvers
 * consumers are allowed to depend on.
 *
 * `workspaceDirFromStateDbPath` is deliberately not re-exported here: deriving a
 * workspace root by joining `..` twice is a known hazard and must not become a
 * public compatibility promise.
 */
export { resolveStateDbPath, resolveTrajectoryDbPath } from './store/storage-paths.js';
