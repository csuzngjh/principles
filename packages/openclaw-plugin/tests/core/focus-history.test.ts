import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getHistoryDir, backupToHistory } from '../../src/core/focus-history.js';
import { extractVersion, extractDate } from '@principles/core/prompt-builder';

/**
 * Principle Context (SPEC v1.1 §8): focus-history shrank to the explicit
 * rollback support (`getHistoryDir` / `backupToHistory`). The former re-export
 * tests for the retired working-memory/compression surface were removed with
 * that surface; the pure display helpers are now asserted against the core
 * module that defines them.
 */

// Mock fs module (includes the P2-3 atomic-writer primitives: constants +
// exclusive openSync/closeSync, so no real file ever appears).
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    constants: actual.constants,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    statSync: vi.fn(),
    unlinkSync: vi.fn(),
    copyFileSync: vi.fn(),
    openSync: vi.fn(() => 7),
    closeSync: vi.fn(),
    promises: {
      readdir: vi.fn(),
      stat: vi.fn(),
      readFile: vi.fn(),
    }
  };
});

describe('focus-history (Principle Context rollback support)', () => {
  const mockFocusPath = '/workspace/memory/okr/CURRENT_FOCUS.md';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('exposes only the rollback support surface (retirement contract)', async () => {
    const module = await import('../../src/core/focus-history.js');
    expect(Object.keys(module).sort()).toEqual(['backupToHistory', 'getHistoryDir']);
  });

  describe('getHistoryDir', () => {
    it('returns the .history directory next to the focus file', () => {
      expect(getHistoryDir(mockFocusPath)).toBe(path.join('/workspace/memory/okr', '.history'));
    });
  });

  describe('backupToHistory', () => {
    it('creates the history directory when missing and writes the backup', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const backupPath = backupToHistory(mockFocusPath, '**版本**: v2\n**更新**: 2026-11-18\ncontent');
      expect(String(backupPath)).toMatch(/CURRENT_FOCUS\.v2\.2026-11-18\.\d+\.md$/);
      expect(fs.mkdirSync).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('returns null when the history directory cannot be created', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.mkdirSync).mockImplementation(() => {
        throw new Error('EACCES');
      });
      expect(backupToHistory(mockFocusPath, 'content')).toBeNull();
    });

    it('returns null when a backup with the same name already exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      expect(backupToHistory(mockFocusPath, 'content')).toBeNull();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe('core display helpers (kept for status/history display)', () => {
    it('extractVersion reads the version label', () => {
      expect(extractVersion('> **版本**: v3 | **状态**: EXECUTING')).toBe('3');
      expect(extractVersion('> **版本**: v1.42 | **状态**: EXECUTING')).toBe('1.42');
      expect(extractVersion('no version')).toBe('1');
    });

    it('extractDate reads the update date', () => {
      expect(extractDate('> **更新**: 2026-11-18')).toBe('2026-11-18');
      expect(extractDate('no date').length).toBe(10);
    });
  });
});
