/**
 * `pd mcp logs export` contract: window filtering, bounded archive, raw JSONL
 * preserved, README + manifest included, and no absolute paths in the bundle.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { handleMcpLogsExport } from '../mcp-logs-export.js';

const cleanup: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PD_MCP_LOG_DIR;
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

function zipEntries(archive: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 30 <= archive.length && archive.readUInt32LE(offset) === 0x04034b50) {
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const nameStart = offset + 30;
    const name = archive.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const dataStart = nameStart + nameLength + extraLength;
    entries.set(name, inflateRawSync(archive.subarray(dataStart, dataStart + compressedSize)));
    offset = dataStart + compressedSize;
  }
  return entries;
}

describe('pd mcp logs export', () => {
  it('bundles only the requested window, preserving raw JSONL', async () => {
    const logDir = tempDir('pd-export-logs-');
    const recent = '{"event":"startup","seq":1}\n{"event":"tool_call","status":"ok"}\n';
    fs.writeFileSync(path.join(logDir, 'mcp-codex-1-recent.jsonl'), recent, 'utf8');
    const old = path.join(logDir, 'mcp-codex-2-old.jsonl');
    fs.writeFileSync(old, '{"event":"startup","seq":1}\n', 'utf8');
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(old, thirtyDaysAgo, thirtyDaysAgo);

    process.env.PD_MCP_LOG_DIR = logDir;
    const out = path.join(tempDir('pd-export-out-'), 'bundle.zip');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await handleMcpLogsExport({ days: 7, out, json: true });

    const archive = fs.readFileSync(out);
    expect(archive.length).toBeLessThanOrEqual(20 * 1024 * 1024);
    const entries = zipEntries(archive);
    expect([...entries.keys()]).toContain('README.md');
    expect([...entries.keys()]).toContain('manifest.json');
    expect([...entries.keys()]).toContain('mcp-codex-1-recent.jsonl');
    expect([...entries.keys()]).not.toContain('mcp-codex-2-old.jsonl');

    // Raw lines are byte-identical (the archive never rewrites evidence).
    expect(entries.get('mcp-codex-1-recent.jsonl')?.toString('utf8')).toBe(recent);
    for (const data of entries.values()) {
      expect(data.toString('utf8')).not.toContain(logDir);
      expect(data.toString('utf8')).not.toContain(os.homedir());
    }
    expect(entries.get('README.md')?.toString('utf8')).toContain('nextAction');
  });

  it('creates a valid bundle even when no log file matches', async () => {
    const logDir = tempDir('pd-export-empty-');
    process.env.PD_MCP_LOG_DIR = logDir;
    const out = path.join(tempDir('pd-export-empty-out-'), 'empty.zip');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await handleMcpLogsExport({ days: 7, out });

    const archive = fs.readFileSync(out);
    expect([...zipEntries(archive).keys()]).toEqual(['README.md', 'manifest.json']);
    expect(archive.length).toBeLessThanOrEqual(20 * 1024 * 1024);
  });
});
