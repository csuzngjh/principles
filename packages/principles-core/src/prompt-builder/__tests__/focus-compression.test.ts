import { describe, it, expect } from 'vitest';
import {
  extractVersion,
  extractDate,
  extractSummary,
  parseWorkingMemorySection,
  workingMemoryToInjection,
  extractMilestones,
  validateCurrentFocus,
  mergeWorkingMemory,
  compressFocusContent,
  DEFAULT_FOCUS_COMPRESSION_OPTIONS,
} from '../focus-compression.js';
import type { WorkingMemorySnapshot } from '../focus-compression.js';

const SAMPLE_FOCUS = `# CURRENT_FOCUS

**版本**: v3
**更新**: 2025-01-15

---

## 📍 状态快照

- 项目阶段: 开发中
- 当前进度: 60%

## 🔄 当前任务

- [x] 完成用户认证模块
- [x] 完成数据库迁移
- [x] 完成API端点设计
- [ ] 实现支付集成
- [ ] 添加错误处理

## ➡️ 下一步

1. 完成支付集成
2. 添加单元测试
3. 代码审查

## 🧠 Working Memory

> Last updated: 2025-01-15T10:00:00Z

### 📁 文件输出记录

| 文件路径 | 操作 | 描述 |
|----------|------|------|
| \`src/auth.ts\` | created | 用户认证模块 |
| \`src/db/migration.ts\` | modified | 数据库迁移 |
| \`src/api/routes.ts\` | modified | API端点 |

### ⚠️ 活动问题

- 支付API返回403 → 需要更新API密钥

### ➡️ 下一步行动

1. 联系支付服务商获取新密钥
2. 更新配置文件

## 📎 参考

- [API文档](https://example.com/api)
`;

describe('Focus Compression (core)', () => {
  describe('extractVersion', () => {
    it('should extract version from content', () => {
      expect(extractVersion(SAMPLE_FOCUS)).toBe('3');
    });

    it('should return 1 when no version found', () => {
      expect(extractVersion('no version here')).toBe('1');
    });

    it('should handle decimal versions', () => {
      expect(extractVersion('**版本**: v2.3')).toBe('2.3');
    });
  });

  describe('extractDate', () => {
    it('should extract date from content', () => {
      expect(extractDate(SAMPLE_FOCUS)).toBe('2025-01-15');
    });

    it('should return today when no date found', () => {
      const result = extractDate('no date here');
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('extractSummary', () => {
    it('should extract structured summary', () => {
      const summary = extractSummary(SAMPLE_FOCUS, 50);
      expect(summary.length).toBeGreaterThan(0);
      expect(summary).toContain('CURRENT_FOCUS');
    });

    it('should truncate to maxLines', () => {
      const longContent = Array(200).fill('some content line').join('\n');
      const summary = extractSummary(longContent, 30);
      const lines = summary.split('\n');
      expect(lines.length).toBeLessThanOrEqual(32);
    });

    it('should handle unstructured content', () => {
      const unstructured = Array(50).fill('just some text').join('\n');
      const summary = extractSummary(unstructured, 30);
      expect(summary).toContain('just some text');
    });
  });

  describe('parseWorkingMemorySection', () => {
    it('should parse working memory from content', () => {
      const snapshot = parseWorkingMemorySection(SAMPLE_FOCUS);
      expect(snapshot).not.toBeNull();
      expect(snapshot?.artifacts.length).toBe(3);
      expect(snapshot?.activeProblems.length).toBe(1);
      expect(snapshot?.nextActions.length).toBe(2);
    });

    it('should return null when no working memory section', () => {
      const snapshot = parseWorkingMemorySection('no working memory here');
      expect(snapshot).toBeNull();
    });

    it('should parse artifact actions correctly', () => {
      const snapshot = parseWorkingMemorySection(SAMPLE_FOCUS);
      expect(snapshot?.artifacts?.[0]?.action).toBe('created');
      expect(snapshot?.artifacts?.[1]?.action).toBe('modified');
    });
  });

  describe('workingMemoryToInjection', () => {
    it('should generate injection string from snapshot', () => {
      const snapshot = parseWorkingMemorySection(SAMPLE_FOCUS);
      const injection = workingMemoryToInjection(snapshot);
      expect(injection).toContain('<working_memory');
      expect(injection).toContain('</working_memory>');
      expect(injection).toContain('src/auth.ts');
    });

    it('should return empty string for null snapshot', () => {
      expect(workingMemoryToInjection(null)).toBe('');
    });

    it('should return empty string for empty snapshot', () => {
      const emptySnapshot: WorkingMemorySnapshot = {
        lastUpdated: new Date().toISOString(),
        artifacts: [],
        activeProblems: [],
        nextActions: [],
      };
      expect(workingMemoryToInjection(emptySnapshot)).toBe('');
    });
  });

  describe('extractMilestones', () => {
    it('should extract completed tasks and file artifacts', () => {
      const milestones = extractMilestones(SAMPLE_FOCUS);
      expect(milestones.completedTasks.length).toBe(3);
      expect(milestones.fileArtifacts.length).toBeGreaterThan(0);
    });

    it('should return empty arrays for content without milestones', () => {
      const milestones = extractMilestones('no milestones here');
      expect(milestones.completedTasks).toEqual([]);
      expect(milestones.fileArtifacts).toEqual([]);
    });
  });

  describe('validateCurrentFocus', () => {
    it('should validate valid content', () => {
      const result = validateCurrentFocus(SAMPLE_FOCUS);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should reject empty content', () => {
      const result = validateCurrentFocus('');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('文件为空');
    });

    it('should warn about missing next steps', () => {
      const content = '# Focus\nSome content without next steps section';
      const result = validateCurrentFocus(content);
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });

  describe('mergeWorkingMemory', () => {
    it('should append working memory section when missing', () => {
      const content = '# Focus\nSome content';
      const snapshot: WorkingMemorySnapshot = {
        lastUpdated: new Date().toISOString(),
        artifacts: [{ path: 'src/test.ts', action: 'created', description: 'test file' }],
        activeProblems: [],
        nextActions: [],
      };

      const merged = mergeWorkingMemory(content, snapshot);
      expect(merged).toContain('## 🧠 Working Memory');
      expect(merged).toContain('src/test.ts');
    });

    it('should replace existing working memory section', () => {
      const snapshot: WorkingMemorySnapshot = {
        lastUpdated: new Date().toISOString(),
        artifacts: [{ path: 'src/new.ts', action: 'modified', description: 'new file' }],
        activeProblems: [],
        nextActions: [],
      };

      const merged = mergeWorkingMemory(SAMPLE_FOCUS, snapshot);
      expect(merged).toContain('src/new.ts');
    });
  });

  describe('compressFocusContent', () => {
    it('should not compress content below threshold', () => {
      const result = compressFocusContent(SAMPLE_FOCUS, {
        ...DEFAULT_FOCUS_COMPRESSION_OPTIONS,
        lineThreshold: 1000,
        sizeThreshold: 100000,
      });

      expect(result.needsCompression).toBe(false);
      expect(result.compressed).toBe(false);
      expect(result.newContent).toBe(SAMPLE_FOCUS);
    });

    it('should compress content above threshold', () => {
      const longContent = Array(200).fill('some content line with enough text').join('\n');
      const result = compressFocusContent(longContent, {
        ...DEFAULT_FOCUS_COMPRESSION_OPTIONS,
        lineThreshold: 100,
        sizeThreshold: 100,
      });

      expect(result.needsCompression).toBe(true);
      expect(result.compressed).toBe(true);
      expect(result.oldLines).toBe(200);
    });

    it('should increment version on compression', () => {
      const longContent = `**版本**: v3\n` + Array(200).fill('content line').join('\n');
      const result = compressFocusContent(longContent, {
        ...DEFAULT_FOCUS_COMPRESSION_OPTIONS,
        lineThreshold: 100,
        sizeThreshold: 100,
      });

      expect(result.newVersion).toBe('4');
    });

    it('should extract milestones during compression', () => {
      const longContent = SAMPLE_FOCUS + '\n' + Array(200).fill('extra line').join('\n');
      const result = compressFocusContent(longContent, {
        ...DEFAULT_FOCUS_COMPRESSION_OPTIONS,
        lineThreshold: 50,
        sizeThreshold: 100,
      });

      expect(result.milestones.completedTasks.length).toBeGreaterThan(0);
    });
  });
});
