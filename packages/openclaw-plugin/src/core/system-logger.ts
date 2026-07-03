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

// PRI-504: per-workspace caches keyed by path.resolve(workspaceDir).
// Previously these were module-level `let` variables, so the first workspace
// to call log() would pin the log file path for ALL subsequent workspaces in
// the same process — causing cross-workspace log leakage (ERR-092).
// Pattern follows evolution-engine.ts:551-577 (Map + path.resolve + dispose).
const cachedLogFiles = new Map<string, string>();
const cachedLogDates = new Map<string, string>();

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

// PRI-504: per-workspace cleanup tracker (was module-level `let`).
// Keyed by path.resolve(workspaceDir) so each workspace runs its own
// daily cleanup independently.
const lastCleanupDates = new Map<string, string>();

export const SystemLogger = {
    log(workspaceDir: string | undefined, eventType: string, message: string): void {
        if (!workspaceDir) return;

        try {
            const resolved = path.resolve(workspaceDir);
            const today = getTodayStr();

            // Check if date changed for THIS workspace - invalidate its cache and run cleanup
            if (cachedLogDates.get(resolved) !== today) {
                cachedLogDates.set(resolved, today);
                cachedLogFiles.delete(resolved);
                // Run cleanup once per day per workspace when date changes
                if (lastCleanupDates.get(resolved) !== today) {
                    lastCleanupDates.set(resolved, today);
                    cleanupOldLogs(workspaceDir);
                }
            }

            // Get or create log file path for this workspace
            let logFile = cachedLogFiles.get(resolved);
            if (!logFile) {
                logFile = getSystemLogPath(workspaceDir, new Date());
                cachedLogFiles.set(resolved, logFile);
                const logDir = path.dirname(logFile);
                if (!fs.existsSync(logDir)) {
                    fs.mkdirSync(logDir, { recursive: true });
                }
            }

            const timestamp = new Date().toISOString();

            // Format: [YYYY-MM-DDTHH:mm:ss.sssZ] [EVENT_TYPE] Message
            const logEntry = `[${timestamp}] [${eventType.padEnd(15)}] ${message}\n`;

            // Use fire-and-forget async append to prevent blocking
            fs.appendFile(logFile, logEntry, 'utf8', (_err) => {
                // Silently drop errors (e.g. disk full) to not crash the gateway
            });
        } catch (e) { // eslint-disable-line @typescript-eslint/no-unused-vars -- Reason: intentionally unused - silently fail if we can't setup the log
            // Silently fail if we can't setup the log
        }
    },

    /**
     * Force refresh of the cached log file path.
     * Call this at midnight or when the date changes to ensure proper rotation.
     *
     * PRI-504: clears log-file and log-date caches for ALL workspaces (preserves
     * the original "force refresh" semantics). Does NOT clear lastCleanupDates
     * to avoid re-triggering cleanup for every workspace on the same day.
     */
    refreshCache(): void {
        cachedLogFiles.clear();
        cachedLogDates.clear();
    }
};

/**
 * PRI-504: dispose the SystemLogger cache for a single workspace.
 * Useful for tests and for workspace teardown in multi-workspace processes.
 * Pattern follows evolution-engine.ts:564-570 (disposeEvolutionEngine).
 */
export function disposeSystemLogger(workspaceDir: string): void {
    const resolved = path.resolve(workspaceDir);
    cachedLogFiles.delete(resolved);
    cachedLogDates.delete(resolved);
    lastCleanupDates.delete(resolved);
}

/**
 * PRI-504: dispose ALL SystemLogger caches. Call this in test afterEach
 * hooks to prevent state leakage between tests. Pattern follows
 * evolution-engine.ts:572-577 (disposeAllEvolutionEngines).
 */
export function disposeAllSystemLoggers(): void {
    cachedLogFiles.clear();
    cachedLogDates.clear();
    lastCleanupDates.clear();
}
