import * as fs from 'fs';
import * as path from 'path';
import { resolvePdPath, PD_FILES } from './paths.js';

/**
 * System Logger for Principles Disciple
 *
 * Writes critical evolutionary events to date-stamped log files:
 *   memory/logs/SYSTEM_YYYY-MM-DD.log
 *
 * Uses asynchronous writing to avoid blocking the Node.js event loop.
 * Automatically rotates to a new file at midnight.
 * Old log files are automatically cleaned up based on retention policy.
 */

// Cache for current log file path, invalidated when date changes
let cachedLogFile: string | undefined;
let cachedLogDate: string | undefined;

/**
 * Log retention: delete SYSTEM logs older than this many days.
 * Set to 0 to disable cleanup.
 */
const LOG_RETENTION_DAYS = 7;

/**
 * Get the system log file path for a given date.
 * Format: memory/logs/SYSTEM_YYYY-MM-DD.log
 */
function getSystemLogPath(workspaceDir: string, date: Date): string {
    const dateStr = date.toISOString().slice(0, 10); // YYYY-MM-DD
    const logDir = path.dirname(resolvePdPath(workspaceDir, 'SYSTEM_LOG'));
    const baseName = path.basename(PD_FILES.SYSTEM_LOG, '.log');
    return path.join(logDir, `${baseName}_${dateStr}.log`);
}

/**
 * Get today's date string (YYYY-MM-DD).
 */
function getTodayStr(): string {
    return new Date().toISOString().slice(0, 10);
}

/**
 * Clean up old SYSTEM log files, keeping only LOG_RETENTION_DAYS.
 * Called automatically on first log write of each day.
 */
function cleanupOldLogs(workspaceDir: string): void {
    if (LOG_RETENTION_DAYS <= 0) return;

    try {
        const logDir = path.dirname(resolvePdPath(workspaceDir, 'SYSTEM_LOG'));
        const baseName = path.basename(PD_FILES.SYSTEM_LOG, '.log');
        const prefix = `${baseName}_`;

        if (!fs.existsSync(logDir)) return;

        const cutoffMs = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
        const files = fs.readdirSync(logDir);

        for (const file of files) {
            if (!file.startsWith(prefix) || !file.endsWith('.log')) continue;

            const filePath = path.join(logDir, file);
            const stat = fs.statSync(filePath);
            if (stat.mtimeMs < cutoffMs) {
                fs.unlinkSync(filePath);
            }
        }
    } catch {
        // Silently fail cleanup - don't crash logging for cleanup failures
    }
}

// Track if cleanup has run today
let lastCleanupDate: string | undefined;

export const SystemLogger = {
    log(workspaceDir: string | undefined, eventType: string, message: string): void {
        if (!workspaceDir) return;

        try {
            const today = getTodayStr();

            // Check if date changed - invalidate cache and run cleanup
            if (cachedLogDate !== today) {
                cachedLogDate = today;
                cachedLogFile = undefined;
                // Run cleanup once per day when date changes
                if (lastCleanupDate !== today) {
                    lastCleanupDate = today;
                    cleanupOldLogs(workspaceDir);
                }
            }

            // Get or create log file path
            if (!cachedLogFile) {
                cachedLogFile = getSystemLogPath(workspaceDir, new Date());
                const logDir = path.dirname(cachedLogFile);
                if (!fs.existsSync(logDir)) {
                    fs.mkdirSync(logDir, { recursive: true });
                }
            }

            const timestamp = new Date().toISOString();

            // Format: [YYYY-MM-DDTHH:mm:ss.sssZ] [EVENT_TYPE] Message
            const logEntry = `[${timestamp}] [${eventType.padEnd(15)}] ${message}\n`;

            // Use fire-and-forget async append to prevent blocking
            fs.appendFile(cachedLogFile, logEntry, 'utf8', (_err) => {
                // Silently drop errors (e.g. disk full) to not crash the gateway
            });
        } catch (e) { // eslint-disable-line @typescript-eslint/no-unused-vars -- Reason: intentionally unused - silently fail if we can't setup the log
            // Silently fail if we can't setup the log
        }
    },

    /**
     * Force refresh of the cached log file path.
     * Call this at midnight or when the date changes to ensure proper rotation.
     */
    refreshCache(): void {
        cachedLogDate = undefined;
        cachedLogFile = undefined;
    }
};
