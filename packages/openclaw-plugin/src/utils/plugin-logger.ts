import * as fs from 'fs';
import * as path from 'path';

export interface PluginLogger {
     
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
    debug(message: string, meta?: Record<string, unknown>): void;
     
}

export interface PluginLoggerConfig {
    /** Directory to store log files (typically stateDir) */
    logDir: string;
    /** Plugin identifier for log file naming */
    pluginId: string;
    /** Console logger from OpenClaw API (for dual output) */
    consoleLogger?: PluginLogger;
    /** Whether to also output to console */
    echoToConsole?: boolean;
}

/**
 * Creates a plugin-specific logger that writes to its own log file.
 * 
 * Log file location: {logDir}/logs/{pluginId}.log
 * 
 * Example:
 * ```
 * const logger = createPluginLogger({
 *   logDir: stateDir,  // e.g. ~/.openclaw/
 *   pluginId: 'principles-disciple',
 *   consoleLogger: api.logger,
 *   echoToConsole: true
 * });
 * 
 * logger.info('Evolution task completed', { taskId: 'abc123' });
 * ```
 */
export function createPluginLogger(config: PluginLoggerConfig): PluginLogger {
    const { logDir, pluginId, consoleLogger, echoToConsole = true } = config;
    
    // Ensure logs directory exists
    const logsDir = path.join(logDir, 'logs');
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }
    
    const logFile = path.join(logsDir, `${pluginId}.log`);
    
    const writeLog = (level: string, message: string, meta?: Record<string, unknown>) => {
        const timestamp = new Date().toISOString();
        const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
        const logLine = `${timestamp} [${level.toUpperCase()}] ${message}${metaStr}\n`;
        
        try {
            fs.appendFileSync(logFile, logLine, 'utf-8');
        } catch {
            // Silently fail if log write fails
        }
        
        // Also echo to console if enabled
        if (echoToConsole && consoleLogger) {
            const consoleMessage = `[${pluginId}] ${message}`;
            switch (level) {
                case 'info':
                    consoleLogger.info(consoleMessage, meta);
                    break;
                case 'warn':
                    consoleLogger.warn(consoleMessage, meta);
                    break;
                case 'error':
                    consoleLogger.error(consoleMessage, meta);
                    break;
                case 'debug':
                    consoleLogger.debug(consoleMessage, meta);
                    break;
            }
        }
    };
    
    return {
        info: (message, meta) => writeLog('info', message, meta),
        warn: (message, meta) => writeLog('warn', message, meta),
        error: (message, meta) => writeLog('error', message, meta),
        debug: (message, meta) => writeLog('debug', message, meta),
    };
}

/**
 * Log file path for the plugin.
 * Returns the path where plugin logs are stored.
 */
export function getPluginLogPath(logDir: string, pluginId: string): string {
    return path.join(logDir, 'logs', `${pluginId}.log`);
}
