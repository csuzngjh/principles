/**
 * Durable log sink tests: default-on, opt-out, one-file-per-process adoption,
 * rotation, retention and — most importantly — that a broken sink can never
 * throw into the caller.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  combineSinks,
  createMcpFileLog,
  LOG_MAX_FILE_BYTES,
  LOG_RETENTION_MS,
} from '../log-file.js';
import { createLogger } from '../logging.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

function ownFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => /^mcp-.*\.jsonl$/.test(name)).sort();
}

function line(event: string, payload: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts: new Date(0).toISOString(), server: 'pd-mcp-server', version: '0.2.2', level: 'info', event, ...payload });
}

describe('MCP file log', () => {
  it('is enabled by default and writes offset timestamps, runId and seq', () => {
    const dir = tempDir('pd-log-default-');
    const log = createMcpFileLog({ PD_MCP_LOG_DIR: dir });
    expect(log.enabled).toBe(true);
    log.sink(line('startup', { host: 'codex' }));
    log.flushSync();

    const files = ownFiles(dir);
    expect(files).toHaveLength(1);
    const entries = fs.readFileSync(path.join(dir, files[0] as string), 'utf8').trim().split('\n').map((row) => JSON.parse(row) as Record<string, unknown>);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.event).toBe('startup');
    expect(entries[0]?.runId).toMatch(/^[0-9a-f]{8}$/);
    expect(entries[0]?.seq).toBe(1);
    expect(String(entries[0]?.ts)).toMatch(/[+-]\d{2}:\d{2}$/);
    expect(entries[0]?.tzOffsetMinutes).toBeTypeOf('number');
  });

  it('PD_MCP_LOG=0 disables with zero writes', () => {
    const dir = tempDir('pd-log-off-');
    const log = createMcpFileLog({ PD_MCP_LOG: '0', PD_MCP_LOG_DIR: dir });
    expect(log.enabled).toBe(false);
    log.sink(line('startup'));
    log.flushSync();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('appends to the launcher file (same process, same file, seq continues)', () => {
    const dir = tempDir('pd-log-adopt-');
    const launcherFile = 'mcp-codex-42-20261105T000000Z.jsonl';
    fs.writeFileSync(
      path.join(dir, launcherFile),
      `${JSON.stringify({ event: 'launcher_start', seq: 1 })}\n`,
      'utf8'
    );
    const log = createMcpFileLog({
      PD_MCP_LOG_DIR: dir,
      PD_MCP_LOG_FILE: launcherFile,
      PD_MCP_LOG_RUN_ID: 'a1b2c3d4',
      PD_MCP_LOG_SEQ: '1',
    });
    log.sink(line('startup'));
    log.flushSync();

    const rows = fs.readFileSync(path.join(dir, launcherFile), 'utf8').trim().split('\n').map((row) => JSON.parse(row) as Record<string, unknown>);
    expect(rows.map((row) => row.event)).toEqual(['launcher_start', 'startup']);
    expect(rows[1]?.seq).toBe(2);
    expect(rows[1]?.runId).toBe('a1b2c3d4');
  });

  it('rotates at 2 MiB into a bounded number of shards', () => {
    const dir = tempDir('pd-log-rotate-');
    const log = createMcpFileLog({ PD_MCP_LOG_DIR: dir });
    const chunk = 'x'.repeat(900);
    for (let i = 0; i < 3200; i += 1) log.sink(line('tool_call', { toolName: 'pd_recall', padding: chunk }));
    log.flushSync();

    const files = ownFiles(dir);
    expect(files.length).toBeGreaterThan(1);
    expect(files.length).toBeLessThanOrEqual(3);
    for (const file of files) {
      expect(fs.statSync(path.join(dir, file)).size).toBeLessThanOrEqual(LOG_MAX_FILE_BYTES);
    }
  });

  it('deletes files older than the 14-day retention window', () => {
    const dir = tempDir('pd-log-retention-');
    const stale = path.join(dir, 'mcp-codex-1-20200101T000000Z.jsonl');
    fs.writeFileSync(stale, line('startup') + '\n', 'utf8');
    const old = Date.now() - LOG_RETENTION_MS - 60_000;
    fs.utimesSync(stale, new Date(old), new Date(old));

    const log = createMcpFileLog({ PD_MCP_LOG_DIR: dir });
    log.sink(line('startup'));
    log.flushSync();

    expect(fs.existsSync(stale)).toBe(false);
    expect(ownFiles(dir).length).toBe(1);
  });

  it('swallows an unwritable directory and a broken sibling sink', () => {
    const root = tempDir('pd-log-broken-');
    const occupied = path.join(root, 'not-a-dir');
    fs.writeFileSync(occupied, 'x', 'utf8');

    const log = createMcpFileLog({ PD_MCP_LOG_DIR: occupied });
    expect(() => log.sink(line('startup'))).not.toThrow();
    expect(() => log.flushSync()).not.toThrow();

    const combined = combineSinks(
      () => {
        throw new Error('broken sink');
      },
      () => undefined
    );
    expect(() => combined(line('startup'))).not.toThrow();

    const logger = createLogger(combined, { host: 'codex' });
    expect(() => logger('info', 'startup', {})).not.toThrow();
  });

  it('never throws on malformed/unserializable input', () => {
    const dir = tempDir('pd-log-garbage-');
    const log = createMcpFileLog({ PD_MCP_LOG_DIR: dir });
    expect(() => log.sink('not json')).not.toThrow();
    expect(() => log.sink('[1,2,3]')).not.toThrow();
    log.flushSync();
  });
});
