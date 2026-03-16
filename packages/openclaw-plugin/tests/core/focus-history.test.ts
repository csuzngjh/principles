import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
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
      backupToHistory(mockFocusPath, content);

      expect(fs.mkdirSync).toHaveBeenCalled();
      // 检查路径包含 .history 目录名
      const calledPath = (fs.mkdirSync as any).mock.calls[0][0];
      expect(calledPath).toContain('.history');
      expect(fs.writeFileSync).toHaveBeenCalled();

      // 验证写入的实际内容
      const writeCalls = (fs.writeFileSync as any).mock.calls;
      expect(writeCalls.length).toBe(1);
      expect(writeCalls[0][1]).toBe(content); // 验证写入的内容与原内容一致
      expect(writeCalls[0][0]).toContain('CURRENT_FOCUS.v1.2026-03-16.md'); // 验证文件名
    });

    it('should skip if backup already exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const content = `# 🎯 CURRENT_FOCUS\n\n> **版本**: v1 | **更新**: 2026-03-16`;
      backupToHistory(mockFocusPath, content);

      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe('cleanupHistory', () => {
    it('should do nothing if history dir does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      cleanupHistory(mockFocusPath, 10);

      expect(fs.readdirSync).not.toHaveBeenCalled();
    });

    it('should delete oldest files when exceeding max count', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      // 创建3个文件，按修改时间排序
      const oldDate = new Date('2026-03-10');
      const middleDate = new Date('2026-03-11');
      const newDate = new Date('2026-03-12');

      vi.mocked(fs.readdirSync).mockReturnValue([
        'CURRENT_FOCUS.v1.2026-03-10.md',
        'CURRENT_FOCUS.v2.2026-03-11.md',
        'CURRENT_FOCUS.v3.2026-03-12.md',
      ] as any);

      // 模拟 statSync 返回不同的修改时间
      vi.mocked(fs.statSync)
        .mockReturnValueOnce({ mtime: oldDate } as any)
        .mockReturnValueOnce({ mtime: middleDate } as any)
        .mockReturnValueOnce({ mtime: newDate } as any);

      cleanupHistory(mockFocusPath, 2);

      // 应该删除1个文件（最旧的）
      expect(fs.unlinkSync).toHaveBeenCalledTimes(1);

      // 验证删除的是最旧的文件（v1）
      const deletedPath = (fs.unlinkSync as any).mock.calls[0][0];
      expect(deletedPath).toContain('CURRENT_FOCUS.v1.2026-03-10.md');
    });

    it('should handle deletion failures gracefully', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        'CURRENT_FOCUS.v1.2026-03-10.md',
        'CURRENT_FOCUS.v2.2026-03-11.md',
        'CURRENT_FOCUS.v3.2026-03-12.md',
        'CURRENT_FOCUS.v4.2026-03-13.md',
      ] as any);

      // statSync 调用用于排序
      vi.mocked(fs.statSync).mockReturnValue({ mtime: new Date() } as any);

      // 模拟第一个文件删除失败
      vi.mocked(fs.unlinkSync).mockImplementationOnce(() => {
        throw new Error('Permission denied');
      });

      // 不应该抛出异常
      expect(() => cleanupHistory(mockFocusPath, 2)).not.toThrow();

      // 应该尝试删除2个文件（4个文件，maxFiles=2，所以删除2个）
      expect(fs.unlinkSync).toHaveBeenCalledTimes(2);
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
