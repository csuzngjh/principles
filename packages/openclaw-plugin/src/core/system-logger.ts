import * as fs from 'fs';
import * as path from 'path';
import { resolvePdPath } from './paths.js';

/**
 * System Logger for Principles Disciple
 * Writes critical evolutionary events to the project's memory/logs/SYSTEM.log
 * Uses asynchronous writing to avoid blocking the Node.js event loop.
 */
export const SystemLogger = {
    log(workspaceDir: string | undefined, eventType: string, message: string): void {
        if (!workspaceDir) return;
        
        try {
            const logFile = resolvePdPath(workspaceDir, 'SYSTEM_LOG');
            const logDir = path.dirname(logFile);
            
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }
            
            const timestamp = new Date().toISOString();
            
            // Format: [YYYY-MM-DDTHH:mm:ss.sssZ] [EVENT_TYPE] Message
            const logEntry = `[${timestamp}] [${eventType.padEnd(15)}] ${message}\n`;
            
            // Use fire-and-forget async append to prevent blocking
            fs.appendFile(logFile, logEntry, 'utf8', (_err) => { // eslint-disable-line @typescript-eslint/no-unused-vars -- Reason: fire-and-forget, errors silently dropped
                // Silently drop errors (e.g. disk full) to not crash the gateway
            });
        } catch (e) { // eslint-disable-line @typescript-eslint/no-unused-vars -- Reason: intentionally unused - silently fail if we can't setup the log
            // Silently fail if we can't setup the log
        }
    }
};
