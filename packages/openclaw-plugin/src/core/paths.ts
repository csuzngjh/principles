/**
 * Compatibility entry point for the OpenClaw adapter.
 *
 * The canonical PD workspace-relative path contract lives in
 * @principles/core/runtime/storage-paths. Keep this module as a stable import
 * path for existing plugin consumers; do not add path definitions here.
 */
export { PD_DIRS, PD_FILES, resolvePdPath } from '@principles/core/runtime/storage-paths';
