/**
 * Stderr-only structured logging — SPEC-PD-MCP-GATE4-001 §10.
 *
 * stdout carries MCP protocol messages ONLY; every log line goes to stderr
 * as one JSON object. Redaction is by construction: callers may pass only
 * scalar event/category/duration fields — never Pain text, evidence bodies,
 * env values, raw tool results, absolute workspace/db paths or stack traces.
 * The `errKind` field carries a sanitized exception category (the error's
 * `name`), never `message` or `stack`.
 */
import { SERVER_NAME, SERVER_VERSION } from './version.js';

export type LogField = string | number | boolean;
export type LogFields = Readonly<Record<string, LogField>>;
export type LogLevel = 'info' | 'warn' | 'error';

/** Bound logger: sink fixed at construction, ≤3 params per call. */
export type LogFn = (level: LogLevel, event: string, fields?: LogFields) => void;

function sanitizeErrorKind(err: unknown): string {
  if (err !== null && typeof err === 'object' && Object.hasOwn(err, 'name') && typeof (err as { name: unknown }).name === 'string') {
    const { name } = err as { name: string };
    return name.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) || 'Error';
  }
  return 'Error';
}

/** Default stderr sink. One JSON line per event, nothing else.
 * A closed/broken stderr pipe must never turn into a process-level failure. */
export function stderrSink(line: string): void {
  try {
    process.stderr.write(line + '\n');
  } catch {
    // Logging must never affect the service.
  }
}

export function createLogger(sink: (line: string) => void, baseFields?: LogFields): LogFn {
  return (level, event, fields) => {
    try {
      const entry: Record<string, unknown> = {
        ts: new Date().toISOString(),
        server: SERVER_NAME,
        version: SERVER_VERSION,
        level,
        event,
      };
      const merged: LogFields = { ...baseFields, ...fields };
      for (const [k, v] of Object.entries(merged)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') entry[k] = v;
      }
      sink(JSON.stringify(entry));
    } catch {
      // Logging must never affect the caller (MCP tool calls included).
    }
  };
}

/** Convenience logger bound to stderr (startup/shutdown paths). */
export const stderrLog: LogFn = createLogger(stderrSink);

export { sanitizeErrorKind };
