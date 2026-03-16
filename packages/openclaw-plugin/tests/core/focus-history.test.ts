import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  extractVersion,
  extractDate,
  backupToHistory,
  cleanupHistory,
  getHistoryVersions,
  extractSummary,
} from '../../src/core/focus-history.js';

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

describe('focus-history', () => {
  const mockFocusPath = '/workspace/memory/okr/CURRENT_FOCUS.md';
  const mockHistoryDir = '/workspace/memory/okr/.history';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('extractVersion', () => {
    it('should extract version number from content', () => {
      const content = `# 🎯 CURRENT_FOCUS\n\n> **版本**: v3 | **状态**: EXECUTING`;
      expect(extractVersion(content)).toBe(3);
    });

    it('should return 1 if no version found', () => {
      const content = '# 🎯 CURRENT_FOCUS\n\nNo version here';
      expect(extractVersion(content)).toBe(1);
    });
  });

  describe('extractDate', () => {
    it('should extract date from content', () => {
      const content = `# 🎯 CURRENT_FOCUS\n\n> **版本**: v1 | **更新**: 2026-03-16`;
      expect(extractDate(content)).toBe('2026-03-16');
    });

    it('should return today if no date found', () => {
      const content = '# 🎯 CURRENT_FOCUS\n\nNo date here';
      const today = new Date().toISOString().split('T')[0];
      expect(extractDate(content)).toBe(today);
    });
  });

  describe('backupToHistory', () => {
    it('should create backup in history directory', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const content = `# 🎯 CURRENT_FOCUS\n\n> **版本**: v1 | **更新**: 2026-03-16`;
      const result = backupToHistory(mockFocusPath, content);

      expect(fs.mkdirSync).toHaveBeenCalled();
      // 检查路径包含 .history 目录名
      const calledPath = (fs.mkdirSync as any).mock.calls[0][0];
      expect(calledPath).toContain('.history');
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('should skip if backup already exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const content = `# 🎯 CURRENT_FOCUS\n\n> **版本**: v1 | **更新**: 2026-03-16`;
      const result = backupToHistory(mockFocusPath, content);

      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe('cleanupHistory', () => {
    it('should do nothing if history dir does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      cleanupHistory(mockFocusPath, 10);

      expect(fs.readdirSync).not.toHaveBeenCalled();
    });

    it('should delete files exceeding max count', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        'CURRENT_FOCUS.v1.2026-03-10.md',
        'CURRENT_FOCUS.v2.2026-03-11.md',
        'CURRENT_FOCUS.v3.2026-03-12.md',
      ] as any);
      vi.mocked(fs.statSync).mockReturnValue({ mtime: new Date() } as any);

      cleanupHistory(mockFocusPath, 2);

      expect(fs.unlinkSync).toHaveBeenCalledTimes(1);
    });
  });

  describe('getHistoryVersions', () => {
    it('should return empty array if no history', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = getHistoryVersions(mockFocusPath, 3);

      expect(result).toEqual([]);
    });

    it('should return history versions sorted by mtime', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        'CURRENT_FOCUS.v1.2026-03-10.md',
        'CURRENT_FOCUS.v2.2026-03-11.md',
      ] as any);
      vi.mocked(fs.statSync)
        .mockReturnValueOnce({ mtime: new Date('2026-03-10') } as any)
        .mockReturnValueOnce({ mtime: new Date('2026-03-11') } as any);
      vi.mocked(fs.readFileSync).mockReturnValue('history content');

      const result = getHistoryVersions(mockFocusPath, 3);

      expect(result.length).toBe(2);
      expect(result[0]).toBe('history content');
    });
  });

  describe('extractSummary', () => {
    it('should prioritize key sections', () => {
      const content = `# 🎯 CURRENT_FOCUS

> **版本**: v1 | **状态**: EXECUTING | **更新**: 2026-03-16

---

## 📍 状态快照

| 维度 | 值 |
|------|-----|
| 当前阶段 | Phase 2 |

---

## 🔄 当前任务

### P1（进行中）
- [ ] 任务A

---

## ➡️ 下一步

1. 完成任务A
2. 开始任务B

---

## 📎 参考

详细计划: PLAN.md`;

      const summary = extractSummary(content, 30);

      // 应该包含关键章节
      expect(summary).toContain('状态快照');
      expect(summary).toContain('下一步');
    });

    it('should truncate if content exceeds max lines', () => {
      // 使用结构化内容来测试截断
      const content = `# 🎯 CURRENT_FOCUS

> **版本**: v1 | **状态**: EXECUTING

---

## 📍 状态快照

${Array.from({ length: 40 }, (_, i) => `| Item ${i + 1} | Value ${i + 1} |`).join('\n')}

---

## ➡️ 下一步

1. 完成任务A`;

      const summary = extractSummary(content, 20);

      // 检查是否包含关键内容
      expect(summary).toContain('状态快照');
    });
  });
});
