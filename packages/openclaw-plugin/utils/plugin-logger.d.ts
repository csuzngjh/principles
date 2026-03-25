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
export declare function createPluginLogger(config: PluginLoggerConfig): PluginLogger;
/**
 * Log file path for the plugin.
 * Returns the path where plugin logs are stored.
 */
export declare function getPluginLogPath(logDir: string, pluginId: string): string;
