/**
 * PDLogger - Unified logging interface for Principles Disciple
 * 
 * This logger provides a single interface that outputs to both:
 * 1. api.logger (Gateway stdout -> journalctl)
 * 2. SystemLogger (persistent file logs)
 * 
 * This solves the problem of logs being scattered across multiple systems
 * and provides structured metadata for better debugging.
 */

import type { PluginLogger } from '../openclaw-sdk.js';
import { SystemLogger } from './system-logger.js';

export interface LogMeta {
  /** Source component (e.g., 'nocturnal', 'evolution-worker', 'pd-reflect') */
  component?: string;
  /** Session ID for context tracking */
  sessionId?: string;
  /** Agent ID for multi-agent scenarios */
  agentId?: string;
  /** Trace ID for request correlation */
  traceId?: string;
  /** Task ID for evolution tracking */
  taskId?: string;
  /** Duration in milliseconds for performance tracking */
  durationMs?: number;
  /** Additional structured data */
  [key: string]: unknown;
}

export interface PDLoggerOptions {
  /** Plugin API logger (Gateway stdout) */
  apiLogger: PluginLogger;
  /** Workspace directory for SystemLogger */
  workspaceDir: string;
  /** Default component name (can be overridden per-call) */
  defaultComponent?: string;
  /** Enable/disable SystemLogger file output */
  enableFileLogging?: boolean;
}

/**
 * Performance timer for measuring operation durations.
 */
class PerformanceTimer {
  private readonly start: number;
  
  constructor() {
    this.start = performance.now();
  }
  
  elapsed(): number {
    return Math.round(performance.now() - this.start);
  }
}

/**
 * Unified logger for Principles Disciple.
 * 
 * Usage:
 * ```typescript
 * const logger = new PDLogger({
 *   apiLogger: api.logger,
 *   workspaceDir: '/path/to/workspace',
 *   defaultComponent: 'nocturnal',
 * });
 * 
 * logger.info('Preflight check completed', {
 *   component: 'nocturnal',
 *   canRun: preflight.canRun,
 *   idle: idle.isIdle,
 * });
 * 
 * // Performance tracking
 * const timer = logger.time();
 * // ... operation ...
 * logger.info('Operation completed', { durationMs: timer.elapsed() });
 * ```
 */
export class PDLogger {
  private readonly apiLogger: PluginLogger;
  private readonly workspaceDir: string;
  private readonly defaultComponent: string;
  private readonly enableFileLogging: boolean;
  
  constructor(options: PDLoggerOptions) {
    this.apiLogger = options.apiLogger;
    this.workspaceDir = options.workspaceDir;
    this.defaultComponent = options.defaultComponent ?? 'pd';
    this.enableFileLogging = options.enableFileLogging ?? true;
  }
  
  /**
   * Log an info message.
   */
  info(message: string, meta?: LogMeta): void {
    const component = meta?.component ?? this.defaultComponent;
    const formattedMeta = this.formatMeta(meta);
    
    // Gateway stdout (journalctl visible)
    this.apiLogger.info(`[PD:${component}] ${message}${formattedMeta}`);
    
    // File log
    if (this.enableFileLogging) {
      SystemLogger.log(this.workspaceDir, 'INFO', `[${component}] ${message}${formattedMeta}`);
    }
  }
  
  /**
   * Log a warning message.
   */
  warn(message: string, meta?: LogMeta): void {
    const component = meta?.component ?? this.defaultComponent;
    const formattedMeta = this.formatMeta(meta);
    
    this.apiLogger.warn(`[PD:${component}] ${message}${formattedMeta}`);
    
    if (this.enableFileLogging) {
      SystemLogger.log(this.workspaceDir, 'WARN', `[${component}] ${message}${formattedMeta}`);
    }
  }
  
  /**
   * Log an error message.
   */
  error(message: string, meta?: LogMeta): void {
    const component = meta?.component ?? this.defaultComponent;
    const formattedMeta = this.formatMeta(meta);
    
    this.apiLogger.error(`[PD:${component}] ${message}${formattedMeta}`);
    
    if (this.enableFileLogging) {
      SystemLogger.log(this.workspaceDir, 'ERROR', `[${component}] ${message}${formattedMeta}`);
    }
  }
  
  /**
   * Log a debug message (only to Gateway, not to file).
   */
  debug(message: string, meta?: LogMeta): void {
    const component = meta?.component ?? this.defaultComponent;
    const formattedMeta = this.formatMeta(meta);
    
    // Debug only goes to Gateway (avoid file spam)
    if (this.apiLogger.debug) {
      this.apiLogger.debug(`[PD:${component}] ${message}${formattedMeta}`);
    } else {
      this.apiLogger.info(`[PD:${component}:DEBUG] ${message}${formattedMeta}`);
    }
  }
  
  /**
   * Start a performance timer.
   */
  time(): PerformanceTimer {
    return new PerformanceTimer();
  }
  
  /**
   * Log an operation with automatic timing.
   */
  async withTiming<T>(
    operation: string,
    fn: () => Promise<T>,
    meta?: Omit<LogMeta, 'durationMs'>,
  ): Promise<T> {
    const timer = this.time();
    try {
      const result = await fn();
      this.info(`${operation} completed`, { ...meta, durationMs: timer.elapsed() });
      return result;
    } catch (err) {
      this.error(`${operation} failed`, { ...meta, durationMs: timer.elapsed(), error: String(err) });
      throw err;
    }
  }
  
  /**
   * Create a child logger with a fixed component.
   */
  child(component: string): PDLogger {
    return new PDLogger({
      apiLogger: this.apiLogger,
      workspaceDir: this.workspaceDir,
      defaultComponent: component,
      enableFileLogging: this.enableFileLogging,
    });
  }
  
  /**
   * Format metadata for log output.
   */
  private formatMeta(meta?: LogMeta): string {
    if (!meta) return '';
    
    const { component: _, ...rest } = meta;
    const entries = Object.entries(rest);
    
    if (entries.length === 0) return '';
    
    // Format key=value pairs, truncating long values
    const formatted = entries.map(([key, value]) => {
      const str = String(value);
      const truncated = str.length > 100 ? str.slice(0, 100) + '...' : str;
      return `${key}=${truncated}`;
    }).join(', ');
    
    return ` | ${formatted}`;
  }
}

/**
 * Create a PDLogger instance.
 */
export function createPDLogger(options: PDLoggerOptions): PDLogger {
  return new PDLogger(options);
}
