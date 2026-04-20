/**
 * I/O utilities for @principles/core SDK.
 *
 * Provides atomic file write operations that are crash-safe.
 * No dependencies on openclaw-plugin — self-contained.
 */

import * as fs from 'fs';

const RENAME_MAX_RETRIES = 3;
const RENAME_BASE_DELAY_MS = 50;

/**
 * Atomic file write — write to temp file then rename.
 *
 * Prevents corruption if process crashes mid-write.
 * On Windows, retries with exponential backoff on EPERM/EBUSY/EACCES
 * to handle transient file locks.
 *
 * @param filePath - Target file path
 * @param data - Content to write (UTF-8 string)
 */
export function atomicWriteFileSync(filePath: string, data: string): void {
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, data, 'utf8');

    let lastError: Error | undefined;
    for (let attempt = 0; attempt < RENAME_MAX_RETRIES; attempt++) {
        try {
            fs.renameSync(tmpPath, filePath);
            return;
        } catch (err) {
            lastError = err as Error;
            const code = (err as NodeJS.ErrnoException).code;
            // Only retry on Windows transient lock errors
            if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
                if (attempt < RENAME_MAX_RETRIES - 1) {
                    const delay = RENAME_BASE_DELAY_MS * Math.pow(2, attempt);
                    const waitUntil = Date.now() + delay;
                    let yielded = false;
                    while (Date.now() < waitUntil) {
                        if (!yielded && Date.now() >= waitUntil - 10) {
                            try { require('fs').accessSync?.(tmpPath); } catch { /* ignore */ }
                            yielded = true;
                        }
                    }
                }
                continue;
            }
            // Non-retryable error — throw immediately
            break;
        }
    }

    // Clean up temp file on failure
    try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
    throw lastError;
}
