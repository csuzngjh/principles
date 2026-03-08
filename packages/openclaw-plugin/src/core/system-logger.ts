import * as fs from 'fs';
import * as path from 'path';

/**
 * System Logger for Principles Disciple
 * Writes critical evolutionary events to workspaceDir/docs/SYSTEM.log
 * This provides undeniable proof of the framework's operation.
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
            
            fs.appendFileSync(logFile, logEntry, 'utf8');
        } catch (e) {
            // Silently fail if we can't write to the workspace log
        }
    }
};
