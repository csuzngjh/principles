import * as fs from 'fs';
import { resolvePdPath } from './paths.js';

export const PAIN_FLAG_FILENAME = '.pain_flag';

/**
 * Removes the .pain_flag file from the workspace's .state directory.
 * Called when a pain signal task completes (success, timeout, duplicate, or invalid)
 * to prevent stale flags from triggering repeated processing.
 */
export function clearPainFlag(workspaceDir: string): void {
    const painFlagPath = resolvePdPath(workspaceDir, 'PAIN_FLAG');
    try {
        fs.unlinkSync(painFlagPath);
    } catch {
        // Best-effort cleanup — ENOENT means already gone, other errors are ignored.
    }
}
