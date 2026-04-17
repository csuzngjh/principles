import * as fs from 'fs';
import { resolvePdPath } from './paths.js';

export const PAIN_FLAG_FILENAME = '.pain_flag';

/**
 * Removes the .pain_flag file from the workspace's .state directory.
 * Called when a pain signal task completes (success, timeout, duplicate, or invalid)
 * to prevent stale flags from triggering repeated processing.
 *
 * Optionally verifies the file content before deleting to prevent accidentally removing
 * a concurrent new signal that was written between checkPainFlag reading the file and
 * this deletion call (TOCTOU race).
 *
 * @param workspaceDir - Workspace directory
 * @param expectedPainEventId - If provided, only deletes the file if its pain_event_id matches.
 *                              This prevents deleting a newly written signal during a race window.
 */
export function clearPainFlag(workspaceDir: string, expectedPainEventId?: number | string): void {
    const painFlagPath = resolvePdPath(workspaceDir, 'PAIN_FLAG');
    try {
        // Guard against TOCTOU race: if expectedPainEventId is provided,
        // re-read the file and verify the pain_event_id matches before deleting.
        // This prevents accidentally removing a new signal written between
        // checkPainFlag reading the flag and this deletion.
        if (expectedPainEventId !== undefined) {
            const content = fs.readFileSync(painFlagPath, 'utf8');
            const idMatch = content.includes(`pain_event_id: ${expectedPainEventId}`);
            if (!idMatch) {
                // File was rewritten with a different signal — do not delete.
                return;
            }
        }
        fs.unlinkSync(painFlagPath);
    } catch {
        // Best-effort cleanup — ENOENT means already gone, other errors are ignored.
    }
}
