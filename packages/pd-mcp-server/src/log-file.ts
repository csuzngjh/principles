/**
 * Durable JSONL sink for PD MCP observability (default ON).
 *
 * Every entry the process already emits through `createLogger` is also appended
 * to `~/.pd/logs/mcp/mcp-<host>-<pid>-<stamp>.jsonl`. This module is
 * deliberately defensive: no export ever throws, and a failure to write logs
 * can only lose log lines — it can never change a tool result, the stdio
 * protocol stream, the 32 KiB budget or the 10 s deadline.
 *
 * Privacy: the sink only enriches entries the existing scalar-whitelist logger
 * produced. It never accepts bodies, paths or env values; fields are counts,
 * enums, booleans and fingerprints.
 *
 * Limits: one file per process (the launcher opens the file first and passes
 * its basename through the internal env so the server appends instead of
 * opening a second one), 2 MiB per file, at most 3 shards per process, 64 MiB
 * per directory, 14 days retention. Maintenance runs best-effort at open and
 * rotation time.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

export const LOG_ENV = 'PD_MCP_LOG' as const;
export const LOG_DIR_ENV = 'PD_MCP_LOG_DIR' as const;
/** Internal launcher → server contract (basename only, never a path). */
export const LOG_FILE_ENV = 'PD_MCP_LOG_FILE' as const;
export const LOG_RUN_ID_ENV = 'PD_MCP_LOG_RUN_ID' as const;
export const LOG_SEQ_ENV = 'PD_MCP_LOG_SEQ' as const;

export const LOG_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const LOG_MAX_DIR_BYTES = 64 * 1024 * 1024;
export const LOG_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export const LOG_MAX_SHARDS = 3;

const MAX_BUFFER_LINES = 200;
const MAX_BUFFER_BYTES = 256 * 1024;
const DISABLED_VALUES = ['0', 'false', 'off'];
const ADOPTED_FILE = /^mcp-[^\\/:*?"<>|\s]{1,120}\.jsonl$/;
const RUN_ID = /^[0-9a-f]{8}$/;

export interface McpFileLog {
  /** False when `PD_MCP_LOG=0` or the log directory cannot be resolved. */
  readonly enabled: boolean;
  readonly sink: (line: string) => void;
  /** Flush pending lines synchronously; used on startup failure/shutdown. */
  flushSync(): void;
  readonly dir: string | null;
  readonly file: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function envString(env: Record<string, unknown>, key: string): string | undefined {
  const value = env[key];
  return typeof value === 'string' ? value : undefined;
}

function isEnabled(env: Record<string, unknown>): boolean {
  const value = envString(env, LOG_ENV);
  if (value === undefined) return true;
  return !DISABLED_VALUES.includes(value.trim().toLowerCase());
}

function resolveDir(env: Record<string, unknown>): string | null {
  const override = envString(env, LOG_DIR_ENV);
  if (override !== undefined && override.trim().length > 0) return path.resolve(override);
  try {
    return path.join(os.homedir(), '.pd', 'logs', 'mcp');
  } catch {
    return null;
  }
}

function resolveAdoptedFile(env: Record<string, unknown>): string | null {
  const name = envString(env, LOG_FILE_ENV);
  return name !== undefined && ADOPTED_FILE.test(name) ? name : null;
}

function resolveRunId(env: Record<string, unknown>): string {
  const given = envString(env, LOG_RUN_ID_ENV);
  if (given !== undefined && RUN_ID.test(given)) return given;
  return randomBytes(4).toString('hex');
}

function resolveSeq(env: Record<string, unknown>): number {
  const raw = envString(env, LOG_SEQ_ENV);
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed < 1_000_000 ? parsed : 0;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** RFC3339 with a numeric local offset, plus the offset in minutes. */
function localTimestamp(date: Date): { ts: string; tzOffsetMinutes: number } {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const ts =
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return { ts, tzOffsetMinutes: offsetMinutes };
}

function utcStamp(date: Date): string {
  return (
    `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

interface LogFileInfo {
  readonly fullPath: string;
  readonly size: number;
  readonly mtimeMs: number;
}

function listOwnLogFiles(dir: string): LogFileInfo[] {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const out: LogFileInfo[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^mcp-.*\.jsonl$/.test(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        out.push({ fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // Concurrent cleanup removed it — ignore.
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Best-effort retention + directory cap. Never throws, never deletes non-PD files. */
function maintainDirectory(dir: string, nowMs: number, keepPath: string | null): void {
  try {
    const files = listOwnLogFiles(dir);
    const survivors: LogFileInfo[] = [];
    for (const file of files) {
      if (nowMs - file.mtimeMs > LOG_RETENTION_MS) {
        if (file.fullPath === keepPath) {
          survivors.push(file);
          continue;
        }
        try {
          fs.unlinkSync(file.fullPath);
        } catch {
          survivors.push(file);
        }
      } else {
        survivors.push(file);
      }
    }
    let total = survivors.reduce((sum, file) => sum + file.size, 0);
    if (total <= LOG_MAX_DIR_BYTES) return;
    const removable = survivors
      .filter((file) => file.fullPath !== keepPath)
      .sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const file of removable) {
      if (total <= LOG_MAX_DIR_BYTES) break;
      try {
        fs.unlinkSync(file.fullPath);
        total -= file.size;
      } catch {
        // Another process owns it or it vanished — leave it.
      }
    }
  } catch {
    // Maintenance is advisory only.
  }
}

function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  return cleaned.length > 0 ? cleaned : 'unknown';
}

const NOOP_LOG: McpFileLog = {
  enabled: false,
  sink: () => undefined,
  flushSync: () => undefined,
  dir: null,
  file: null,
};

/**
 * Create the process log sink. Never throws: an unusable directory degrades to
 * a running-but-silent sink (stderr logging stays untouched).
 */
export function createMcpFileLog(
  env: Record<string, unknown> = process.env,
  clock: () => Date = () => new Date()
): McpFileLog {
  try {
    if (!isEnabled(env)) return NOOP_LOG;
    const dir = resolveDir(env);
    if (dir === null) return NOOP_LOG;

    const openedAt = clock();
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!fs.statSync(dir).isDirectory()) return { ...NOOP_LOG, enabled: true, dir };
    } catch {
      // Directory unavailable (e.g. a file occupies the path): stay silent.
      return { ...NOOP_LOG, enabled: true, dir };
    }

    maintainDirectory(dir, openedAt.getTime(), null);

    const host = sanitizeSegment(envString(env, 'PD_MCP_HOST') ?? 'unknown');
    const adopted = resolveAdoptedFile(env);
    const baseName = adopted ?? `mcp-${host}-${process.pid}-${utcStamp(openedAt)}.jsonl`;
    const runId = resolveRunId(env);
    let seq = resolveSeq(env);
    let shard = 1;
    let currentPath = shard === 1 ? path.join(dir, baseName) : path.join(dir, baseName.replace(/\.jsonl$/, `-${shard}.jsonl`));
    let currentBytes = 0;
    try {
      currentBytes = fs.statSync(currentPath).size;
    } catch {
      currentBytes = 0;
    }
    if (currentBytes >= LOG_MAX_FILE_BYTES) {
      shard = 2;
      currentPath = path.join(dir, baseName.replace(/\.jsonl$/, `-${shard}.jsonl`));
      currentBytes = 0;
    }

    let buffer: string[] = [];
    let bufferBytes = 0;
    let scheduled = false;
    let exhausted = shard > LOG_MAX_SHARDS;

    function rotate(): void {
      if (shard >= LOG_MAX_SHARDS) {
        exhausted = true;
        return;
      }
      shard += 1;
      currentPath = path.join(dir as string, baseName.replace(/\.jsonl$/, `-${shard}.jsonl`));
      currentBytes = 0;
      maintainDirectory(dir as string, clock().getTime(), currentPath);
    }

    function flush(): void {
      scheduled = false;
      if (buffer.length === 0) return;
      const batch = buffer.join('');
      buffer = [];
      bufferBytes = 0;
      try {
        const bytes = Buffer.byteLength(batch, 'utf8');
        if (currentBytes + bytes > LOG_MAX_FILE_BYTES) rotate();
        if (exhausted || currentBytes + bytes > LOG_MAX_FILE_BYTES) return;
        fs.appendFileSync(currentPath, batch, { mode: 0o600 });
        currentBytes += bytes;
      } catch {
        // Drop the batch. Logging must never affect the caller.
      }
    }

    function flushSync(): void {
      try {
        flush();
      } catch {
        // Swallow even a synchronous flush defect.
      }
    }

    function sink(line: string): void {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!isRecord(parsed)) return;
        const stamp = localTimestamp(clock());
        parsed.ts = stamp.ts;
        parsed.tzOffsetMinutes = stamp.tzOffsetMinutes;
        parsed.runId = runId;
        parsed.seq = (seq += 1);
        const enriched = JSON.stringify(parsed);
        buffer.push(enriched + '\n');
        bufferBytes += Buffer.byteLength(enriched, 'utf8');
        if (buffer.length >= MAX_BUFFER_LINES || bufferBytes >= MAX_BUFFER_BYTES) flushSync();
        else if (!scheduled) {
          scheduled = true;
          setImmediate(() => {
            try {
              flush();
            } catch {
              // Swallow.
            }
          });
        }
      } catch {
        // Swallow: enrichment/serialization errors must not reach the server.
      }
    }

    return {
      enabled: true,
      sink,
      flushSync,
      dir,
      get file() {
        return currentPath;
      },
    };
  } catch {
    return { ...NOOP_LOG, enabled: true };
  }
}

/** Compose sinks; a broken sink never prevents the others from running. */
export function combineSinks(...sinks: readonly ((line: string) => void)[]): (line: string) => void {
  return (line) => {
    for (const sink of sinks) {
      try {
        sink(line);
      } catch {
        // Isolate sinks from each other.
      }
    }
  };
}
