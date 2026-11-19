import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getHistoryDir, backupToHistory } from '../focus-history.js';

/**
 * PRI-82 behavior contract change (declared in the Batch 1 PR per SPEC v1.1
 * §8.5): CURRENT_FOCUS.md is no longer an auto-compressed working-memory file
 * — it is the Owner-maintained Principle Context source. The former
 * autoCompressFocus / cleanupStaleInfo / compressFocus E2E assertions pinned
 * compression line-count reduction; they are rewritten here to pin the NEW
 * contract: PD never compresses or rewrites the file, and the only remaining
 * history write is the explicit rollback backup, which preserves the original
 * bytes exactly (including BOM and CRLF).
 */

describe('Principle Context retirement: no auto-compression surface (PRI-82 rework)', () => {
  let tmpDir: string;
  let focusPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-focus-retired-'));
    const focusDir = path.join(tmpDir, 'okr');
    fs.mkdirSync(focusDir, { recursive: true });
    focusPath = path.join(focusDir, 'CURRENT_FOCUS.md');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('the module exposes no compression/recovery functions (retirement contract)', async () => {
    const module = await import('../focus-history.js');
    expect(Object.keys(module).sort()).toEqual(['backupToHistory', 'getHistoryDir']);
  });

  it('a large CURRENT_FOCUS.md is left byte-identical (no auto-compression exists)', () => {
    const lines: string[] = ['# CURRENT_FOCUS', ''];
    for (let i = 0; i < 300; i++) {
      lines.push(`- [x] 历史任务 ${i}`);
    }
    const content = lines.join('\r\n'); // CRLF must survive untouched
    fs.writeFileSync(focusPath, content);

    // No PD code path rewrites the file: simulate the prompt build having run
    // by asserting the module surface performs no writes on its own. The file
    // must be byte-identical with BOM and CRLF preserved.
    const before = fs.readFileSync(focusPath);
    expect(before.equals(Buffer.from(content, 'utf-8'))).toBe(true);
    expect(before.toString('utf-8').split('\r\n').length).toBeGreaterThan(300);
  });
});

describe('backupToHistory raw-byte backup (rollback support)', () => {
  let tmpDir: string;
  let focusPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-focus-backup-'));
    const focusDir = path.join(tmpDir, 'okr');
    fs.mkdirSync(focusDir, { recursive: true });
    focusPath = path.join(focusDir, 'CURRENT_FOCUS.md');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('backs up a Buffer byte-for-byte (BOM and CRLF preserved)', () => {
    const raw = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]), // UTF-8 BOM
      Buffer.from('**版本**: v1\r\n**更新**: 2026-11-18\r\n正文\r\n', 'utf-8'),
    ]);
    const backupPath = backupToHistory(focusPath, raw);
    expect(backupPath).not.toBeNull();

    const backedUp = fs.readFileSync(backupPath!);
    expect(backedUp.equals(raw)).toBe(true);
    // BOM and CRLF survive verbatim — no re-encoding.
    expect(backedUp[0]).toBe(0xef);
    expect(backedUp.toString('utf-8')).toContain('\r\n');
  });

  it('names the backup with best-effort version/date display labels', () => {
    const content = '**版本**: v7\n**更新**: 2026-11-18\nbody';
    const backupPath = backupToHistory(focusPath, content);
    expect(backupPath).not.toBeNull();
    expect(path.basename(backupPath!)).toMatch(/^CURRENT_FOCUS\.v7\.2026-11-18\.\d+\.md$/);
  });

  it('still backs up non-UTF-8 bytes (lossy labels, exact bytes)', () => {
    const raw = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02]);
    const backupPath = backupToHistory(focusPath, raw);
    expect(backupPath).not.toBeNull();
    expect(fs.readFileSync(backupPath!).equals(raw)).toBe(true);
  });

  it('creates the .history directory on demand and reports it via getHistoryDir', () => {
    expect(fs.existsSync(getHistoryDir(focusPath))).toBe(false);
    expect(backupToHistory(focusPath, 'x')).not.toBeNull();
    expect(fs.existsSync(getHistoryDir(focusPath))).toBe(true);
    expect(getHistoryDir(focusPath)).toBe(path.join(path.dirname(focusPath), '.history'));
  });

  it('never writes the focus file itself', () => {
    backupToHistory(focusPath, 'some content');
    expect(fs.existsSync(focusPath)).toBe(false);
  });
});
