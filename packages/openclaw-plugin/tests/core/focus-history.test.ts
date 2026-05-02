import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import {
  extractVersion,
  extractDate,
  backupToHistory,
  cleanupHistory,
  getHistoryVersions,
  extractSummary,
  // 工作记忆相关函数
  extractWorkingMemory,
  parseWorkingMemorySection,
  mergeWorkingMemory,
  workingMemoryToInjection,
  type WorkingMemorySnapshot,
  type FileArtifact,
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
  promises: {
    readdir: vi.fn(),
    stat: vi.fn(),
    readFile: vi.fn(),
  }
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
      expect(extractVersion(content)).toBe('3');
    });

    it('should extract decimal version from content', () => {
      const content = `# 🎯 CURRENT_FOCUS\n\n> **版本**: v1.42 | **状态**: EXECUTING`;
      expect(extractVersion(content)).toBe('1.42');
    });

    it('should return "1" if no version found', () => {
      const content = '# 🎯 CURRENT_FOCUS\n\nNo version here';
      expect(extractVersion(content)).toBe('1');
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
      // 验证文件名包含版本和日期，以及时间戳
      expect(writeCalls[0][0]).toMatch(/CURRENT_FOCUS\.v1\.2026-03-16\.\d+\.md/);
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
    it('should return empty array if no history', async () => {
      const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      vi.mocked(fs.promises.readdir).mockRejectedValue(err);

      const result = await getHistoryVersions(mockFocusPath, 3);

      expect(result).toEqual([]);
    });

    it('should return history versions sorted by mtime', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      // fs.promises.readdir mock
      vi.mocked(fs.promises.readdir).mockResolvedValue([
        'CURRENT_FOCUS.v1.2026-03-10.md',
        'CURRENT_FOCUS.v2.2026-03-11.md',
      ] as any);
      // fs.promises.stat mock
      vi.mocked(fs.promises.stat)
        .mockResolvedValueOnce({ mtime: new Date('2026-03-10') } as any)
        .mockResolvedValueOnce({ mtime: new Date('2026-03-11') } as any);
      // fs.promises.readFile mock
      vi.mocked(fs.promises.readFile).mockResolvedValue('history content');

      const result = await getHistoryVersions(mockFocusPath, 3);

      expect(result.length).toBe(2);
      expect(result[0]).toBe('history content');
    });

    it('should return empty array if readdir throws ENOENT', async () => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      vi.mocked(fs.promises.readdir).mockRejectedValue(err);

      const result = await getHistoryVersions(mockFocusPath, 3);

      expect(result).toEqual([]);
    });

    it('should handle partial stat failures', async () => {
      vi.mocked(fs.promises.readdir).mockResolvedValue([
        'CURRENT_FOCUS.v1.md',
        'CURRENT_FOCUS.v2.md',
      ] as any);

      // First fails, second succeeds
      vi.mocked(fs.promises.stat)
        .mockRejectedValueOnce(new Error('Deleted'))
        .mockResolvedValueOnce({ mtime: new Date() } as any);

      vi.mocked(fs.promises.readFile).mockResolvedValue('content');

      const result = await getHistoryVersions(mockFocusPath, 3);

      expect(result.length).toBe(1);
      expect(result[0]).toBe('content');
    });

    it('should handle partial readFile failures', async () => {
      vi.mocked(fs.promises.readdir).mockResolvedValue([
        'CURRENT_FOCUS.v1.md',
        'CURRENT_FOCUS.v2.md',
      ] as any);

      vi.mocked(fs.promises.stat).mockResolvedValue({ mtime: new Date() } as any);

      // First fails, second succeeds
      vi.mocked(fs.promises.readFile)
        .mockRejectedValueOnce(new Error('Read error'))
        .mockResolvedValueOnce('content v2');

      const result = await getHistoryVersions(mockFocusPath, 3);

      expect(result.length).toBe(1);
      expect(result[0]).toBe('content v2');
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

  // ============================================================================
  // 工作记忆功能测试
  // ============================================================================

  describe('extractWorkingMemory', () => {
    it('should extract file paths from tool_use messages', () => {
      // 模拟包含 tool_use 的消息
      const messages = [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '我来帮你实现这个功能' },
            {
              type: 'tool_use',
              name: 'write_file',
              input: {
                file_path: '/workspace/packages/openclaw-plugin/src/hooks/prompt.ts',
                content: '// new code'
              }
            }
          ]
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'replace',
              input: {
                file_path: '/workspace/packages/openclaw-plugin/src/core/focus-history.ts',
                old_string: 'old',
                new_string: 'new'
              }
            }
          ]
        }
      ];

      const snapshot = extractWorkingMemory(messages, '/workspace');

      // 应该提取出两个文件
      expect(snapshot.artifacts.length).toBe(2);

      // 检查第一个文件（write_file = created）
      expect(snapshot.artifacts[0].path).toMatch(/packages[\\\/]openclaw-plugin[\\\/]src[\\\/]hooks[\\\/]prompt\.ts$/);
      expect(snapshot.artifacts[0].action).toBe('created');

      // 检查第二个文件（replace = modified）
      expect(snapshot.artifacts[1].path).toMatch(/packages[\\\/]openclaw-plugin[\\\/]src[\\\/]core[\\\/]focus-history\.ts$/);
      expect(snapshot.artifacts[1].action).toBe('modified');
    });

    it('should filter out node_modules and config files', () => {
      const messages = [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'write_file',
              input: {
                file_path: '/workspace/node_modules/some-package/index.js'
              }
            },
            {
              type: 'tool_use',
              name: 'write_file',
              input: {
                // .config. 格式的配置文件会被过滤
                file_path: '/workspace/vite.config.js'
              }
            },
            {
              type: 'tool_use',
              name: 'write_file',
              input: {
                file_path: '/workspace/src/valid-file.ts'
              }
            }
          ]
        }
      ];

      const snapshot = extractWorkingMemory(messages, '/workspace');

      // 只应该保留 valid-file.ts（node_modules 和 .config. 被过滤）
      expect(snapshot.artifacts.length).toBe(1);
      expect(snapshot.artifacts[0].path).toMatch(/src[\\\/]valid-file\.ts$/);
    });

    it('should extract problems and solutions from text', () => {
      const messages = [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '问题：压缩后智能体失忆\n解决：用工作记忆保留上下文' }
          ]
        }
      ];

      const snapshot = extractWorkingMemory(messages);

      expect(snapshot.activeProblems.length).toBeGreaterThan(0);
      expect(snapshot.activeProblems[0].problem).toContain('压缩后智能体失忆');
    });

    it('should extract next actions from text', () => {
      const messages = [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '下一步：\n1. 完成测试用例\n2. 提交代码' }
          ]
        }
      ];

      const snapshot = extractWorkingMemory(messages);

      expect(snapshot.nextActions.length).toBeGreaterThan(0);
      expect(snapshot.nextActions.some(a => a.includes('测试用例'))).toBe(true);
    });

    it('should deduplicate file artifacts', () => {
      const messages = [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'write_file',
              input: { file_path: '/workspace/src/same-file.ts' }
            }
          ]
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'replace',
              input: { file_path: '/workspace/src/same-file.ts' }
            }
          ]
        }
      ];

      const snapshot = extractWorkingMemory(messages, '/workspace');

      // 同一文件应该去重
      expect(snapshot.artifacts.length).toBe(1);
    });

    it('should limit artifacts to MAX_ARTIFACTS', () => {
      const messages = [{
        role: 'assistant',
        content: Array.from({ length: 30 }, (_, i) => ({
          type: 'tool_use',
          name: 'write_file',
          input: { file_path: `/workspace/src/file-${i}.ts` }
        }))
      }];

      const snapshot = extractWorkingMemory(messages, '/workspace');

      // 应该被限制在 MAX_ARTIFACTS (20)
      expect(snapshot.artifacts.length).toBeLessThanOrEqual(20);
    });
  });

  describe('mergeWorkingMemory', () => {
    it('should append Working Memory section to content without existing section', () => {
      const content = `# 🎯 CURRENT_FOCUS\n\n> **版本**: v1`;
      const snapshot: WorkingMemorySnapshot = {
        lastUpdated: '2026-03-24T12:00:00Z',
        artifacts: [
          { path: 'src/hooks/prompt.ts', action: 'modified', description: '添加工作记忆注入' }
        ],
        activeProblems: [],
        nextActions: ['测试压缩恢复流程']
      };

      const result = mergeWorkingMemory(content, snapshot);

      expect(result).toContain('## 🧠 Working Memory');
      expect(result).toContain('src/hooks/prompt.ts');
      expect(result).toContain('modified');
      expect(result).toContain('添加工作记忆注入');
      expect(result).toContain('测试压缩恢复流程');
    });

    it('should replace existing Working Memory section', () => {
      const content = `# 🎯 CURRENT_FOCUS\n\n> **版本**: v1\n\n## 🧠 Working Memory\n\n旧的文件记录`;
      const snapshot: WorkingMemorySnapshot = {
        lastUpdated: '2026-03-24T12:00:00Z',
        artifacts: [
          { path: 'src/new-file.ts', action: 'created', description: '新文件' }
        ],
        activeProblems: [],
        nextActions: []
      };

      const result = mergeWorkingMemory(content, snapshot);

      expect(result).toContain('src/new-file.ts');
      expect(result).not.toContain('旧的文件记录');
    });

    it('should generate proper markdown table for artifacts', () => {
      const content = '# 🎯 CURRENT_FOCUS';
      const snapshot: WorkingMemorySnapshot = {
        lastUpdated: '2026-03-24T12:00:00Z',
        artifacts: [
          { path: 'src/a.ts', action: 'created', description: '文件A' },
          { path: 'src/b.ts', action: 'modified', description: '文件B' }
        ],
        activeProblems: [],
        nextActions: []
      };

      const result = mergeWorkingMemory(content, snapshot);

      expect(result).toContain('| 文件路径 | 操作 | 描述 |');
      expect(result).toContain('| `src/a.ts` | created | 文件A |');
      expect(result).toContain('| `src/b.ts` | modified | 文件B |');
    });
  });

  describe('parseWorkingMemorySection', () => {
    it('should return null if no Working Memory section', () => {
      const content = '# 🎯 CURRENT_FOCUS\n\nNo working memory here';
      const result = parseWorkingMemorySection(content);
      expect(result).toBeNull();
    });

    it('should parse artifacts from markdown table', () => {
      const content = `# 🎯 CURRENT_FOCUS

## 🧠 Working Memory
> Last updated: 2026-03-24T12:00:00Z

### 📁 文件输出记录

| 文件路径 | 操作 | 描述 |
|----------|------|------|
| \`src/hooks/prompt.ts\` | modified | 添加工作记忆注入 |
| \`src/core/focus-history.ts\` | created | 新增工作记忆函数 |

### ➡️ 下一步行动
1. 测试压缩恢复
2. 提交代码
`;

      const snapshot = parseWorkingMemorySection(content);

      expect(snapshot).not.toBeNull();
      expect(snapshot!.artifacts.length).toBe(2);
      expect(snapshot!.artifacts[0].path).toBe('src/hooks/prompt.ts');
      expect(snapshot!.artifacts[0].action).toBe('modified');
      expect(snapshot!.artifacts[0].description).toBe('添加工作记忆注入');
      expect(snapshot!.nextActions.length).toBe(2);
    });
  });

  describe('workingMemoryToInjection', () => {
    it('should return empty string for empty snapshot', () => {
      const snapshot: WorkingMemorySnapshot = {
        lastUpdated: '2026-03-24T12:00:00Z',
        artifacts: [],
        activeProblems: [],
        nextActions: []
      };

      const result = workingMemoryToInjection(snapshot);
      expect(result).toBe('');
    });

    it('should generate proper injection string', () => {
      const snapshot: WorkingMemorySnapshot = {
        lastUpdated: '2026-03-24T12:00:00Z',
        artifacts: [
          { path: 'src/hooks/prompt.ts', action: 'modified', description: '添加工作记忆' }
        ],
        activeProblems: [],
        nextActions: ['测试压缩恢复']
      };

      const result = workingMemoryToInjection(snapshot);

      expect(result).toContain('<working_memory preserved="true">');
      expect(result).toContain('已输出的文件');
      expect(result).toContain('[MODIFIED] `src/hooks/prompt.ts`');
      expect(result).toContain('测试压缩恢复');
      expect(result).toContain('</working_memory>');
    });

    it('should include problem with approach', () => {
      const snapshot: WorkingMemorySnapshot = {
        lastUpdated: '2026-03-24T12:00:00Z',
        artifacts: [],
        activeProblems: [
          { problem: '压缩后失忆', approach: '用工作记忆保留' }
        ],
        nextActions: []
      };

      const result = workingMemoryToInjection(snapshot);

      expect(result).toContain('压缩后失忆');
    });
  });

  // ============================================================================
  // 端到端测试：压缩时文件路径落盘
  // ============================================================================

  describe('E2E: File path preservation during compaction', () => {
    it('should preserve file paths from tool_use to CURRENT_FOCUS.md', () => {
      // 模拟会话中的工具调用
      const sessionMessages = [
        {
          role: 'user',
          content: '帮我实现工作记忆功能'
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '好的，我来实现这个功能' },
            {
              type: 'tool_use',
              name: 'write_file',
              input: {
                file_path: '/workspace/packages/openclaw-plugin/src/core/working-memory.ts',
                content: '// WorkingMemoryManager class'
              }
            }
          ]
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '文件已创建，现在修改现有文件' },
            {
              type: 'tool_use',
              name: 'replace',
              input: {
                file_path: '/workspace/packages/openclaw-plugin/src/hooks/lifecycle.ts',
                old_string: '// old',
                new_string: '// new: extract working memory'
              }
            }
          ]
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '下一步：\n1. 添加测试用例\n2. 提交代码' }
          ]
        }
      ];

      // 1. 提取工作记忆
      const snapshot = extractWorkingMemory(sessionMessages, '/workspace');

      // 2. 验证提取结果
      expect(snapshot.artifacts.length).toBe(2);
      expect(snapshot.artifacts[0].action).toBe('created'); // write_file
      expect(snapshot.artifacts[1].action).toBe('modified'); // replace
      expect(snapshot.nextActions.length).toBeGreaterThan(0);

      // 3. 合并到 CURRENT_FOCUS.md
      const originalFocus = `# 🎯 CURRENT_FOCUS

> **版本**: v1 | **状态**: EXECUTING

## 🔄 当前任务

- [ ] 实现工作记忆功能
`;

      const updatedFocus = mergeWorkingMemory(originalFocus, snapshot);

      // 4. 验证文件路径已落盘
      expect(updatedFocus).toContain('## 🧠 Working Memory');
      expect(updatedFocus).toContain('working-memory.ts');
      expect(updatedFocus).toContain('lifecycle.ts');
      expect(updatedFocus).toContain('created');
      expect(updatedFocus).toContain('modified');

      // 5. 验证可以从文件解析回来
      const parsedSnapshot = parseWorkingMemorySection(updatedFocus);
      expect(parsedSnapshot).not.toBeNull();
      expect(parsedSnapshot!.artifacts.length).toBe(2);

      // 6. 验证可以生成注入字符串
      const injection = workingMemoryToInjection(parsedSnapshot!);
      expect(injection).toContain('working-memory.ts');
      expect(injection).toContain('lifecycle.ts');
    });

    it('should handle deleted files', () => {
      const messages = [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'replace',
              input: {
                file_path: '/workspace/src/old-file.ts',
                old_string: 'entire file content',
                new_string: '' // 空字符串表示删除
              }
            }
          ]
        }
      ];

      const snapshot = extractWorkingMemory(messages, '/workspace');

      // 应该能识别文件操作
      expect(snapshot.artifacts.length).toBeGreaterThan(0);
    });
  });
});
