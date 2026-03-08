import * as fs from 'fs';
import * as path from 'path';

/**
 * System Logger for Principles Disciple
 * Writes critical evolutionary events to workspaceDir/docs/SYSTEM.log
 * Uses asynchronous writing to avoid blocking the Node.js event loop.
 */
export const SystemLogger = {
    log(workspaceDir: string | undefined, eventType: string, message: string): void {
        if (!workspaceDir) return;
        
        try {
            const docsDir = path.join(workspaceDir, 'docs');
            if (!fs.existsSync(docsDir)) {
                fs.mkdirSync(docsDir, { recursive: true });
            }
            
            const logFile = path.join(docsDir, 'SYSTEM.log');
            const timestamp = new Date().toISOString();
            
            // Format: [YYYY-MM-DDTHH:mm:ss.sssZ] [EVENT_TYPE] Message
            const logEntry = `[${timestamp}] [${eventType.padEnd(15)}] ${message}\n`;
            
            // Use fire-and-forget async append to prevent blocking
            fs.appendFile(logFile, logEntry, 'utf8', (err) => {
                // Silently drop errors (e.g. disk full) to not crash the gateway
            });
        } catch (e) {
            // Silently fail if we can't setup the log
        }
    }
};
