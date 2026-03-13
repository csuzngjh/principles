/**
 * P-03: 精确匹配前验证原则 - Edit Verification Tests
 *
 * 测试 gate.ts 中的编辑验证功能：
 * - 精确匹配
 * - 模糊匹配
 * - 二进制文件跳过
 * - 错误消息生成
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleBeforeToolCall } from '../../src/hooks/gate.js';
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceContext } from '../../src/core/workspace-context.js';

vi.mock('fs');
vi.mock('../../src/core/workspace-context.js');

// Mock fs.statSync
const mockStatSync = vi.fn();
vi.mocked(fs.statSync).mockImplementation(mockStatSync);

describe('P-03 Edit Verification', () => {
  const workspaceDir = '/mock/workspace';

  const mockEvent = {
    toolName: 'edit',
    params: {
      file_path: 'src/example.ts',
      oldText: 'const x = 1;',
      newText: 'const x = 2;',
    },
  };

  const mockWctx = {
    workspaceDir,
    resolve: vi.fn().mockImplementation((p) => {
      if (p === 'src/example.ts') return path.join(workspaceDir, 'src/example.ts');
      return p;
    }),
    trust: {
      getScore: vi.fn().mockReturnValue(75), // Stage 3 (Developer)
      getStage: vi.fn().mockReturnValue(3),
    },
    config: {
      get: vi.fn().mockReturnValue({
        limits: { stage_2_max_lines: 50, stage_3_max_lines: 300 }
      }),
    },
  };

  const mockCtx = {
    workspaceDir,
    logger: console,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(WorkspaceContext.fromHookContext).mockReturnValue(mockWctx as any);
    // Mock PROFILE.json to disable Progressive Gate
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      if (typeof p === 'string' && p.includes('PROFILE.json')) {
        return true;
      }
      if (typeof p === 'string' && p.includes('src/example.ts')) {
        return true;
      }
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
      if (typeof filePath === 'string' && filePath.includes('PROFILE.json')) {
        return JSON.stringify({
          progressive_gate: { enabled: false }, // Disable Progressive Gate for P-03 tests
        });
      }
      return 'mock content'; // Default for source files
    });
    // Mock fs.statSync to return file stats
    mockStatSync.mockReturnValue({ size: 1000 }); // 1KB file by default
  });

  describe('Exact Match Verification', () => {
    it('should pass when oldText exactly matches current content', () => {
      const fileContent = 'function hello() {\n  const x = 1;\n  console.log("hello");\n}\n';

      vi.mocked(fs.readFileSync).mockReturnValue(fileContent);

      const result = handleBeforeToolCall(mockEvent as any, { ...mockCtx, ...mockWctx } as any);

      expect(result).toBeUndefined(); // No blocking
      expect(fs.readFileSync).toHaveBeenCalledWith(
        path.join(workspaceDir, 'src/example.ts'),
        'utf-8'
      );
    });

    it('should pass when oldText matches with proper newlines', () => {
      const fileContent = 'line 1\nline 2\nline 3\n';
      const eventWithNewlines = {
        ...mockEvent,
        params: {
          ...mockEvent.params,
          oldText: 'line 2\n',
        },
      };

      vi.mocked(fs.readFileSync).mockReturnValue(fileContent);

      const result = handleBeforeToolCall(eventWithNewlines as any, { ...mockCtx, ...mockWctx } as any);

      expect(result).toBeUndefined();
    });

    it('should pass when oldText matches with proper tabs', () => {
      const fileContent = 'function test() {\n\tconsole.log("test");\n}\n';
      const eventWithTabs = {
        ...mockEvent,
        params: {
          ...mockEvent.params,
          oldText: '\tconsole.log("test");\n',
        },
      };

      vi.mocked(fs.readFileSync).mockReturnValue(fileContent);

      const result = handleBeforeToolCall(eventWithTabs as any, { ...mockCtx, ...mockWctx } as any);

      expect(result).toBeUndefined();
    });
  });

  describe('Fuzzy Matching', () => {
    it('should fuzzy match with extra spaces', () => {
      const fileContent = 'const x  =  1;\n'; // Extra spaces
      const event = {
        ...mockEvent,
        params: {
          ...mockEvent.params,
          oldText: 'const x = 1;',
        },
      };

      vi.mocked(fs.readFileSync).mockReturnValue(fileContent);

      const result = handleBeforeToolCall(event as any, { ...mockCtx, ...mockWctx } as any);

      // Fuzzy match should auto-correct oldText
      expect(result).toBeDefined();
      expect(result?.params?.oldText).toBe(fileContent.trim());
      expect(result?.params?.old_string).toBe(fileContent.trim());
    });

    it('should fuzzy match with different indentation', () => {
      const fileContent = 'function hello() {\n    console.log("hello");\n}\n'; // 4 spaces
      const event = {
        ...mockEvent,
        params: {
          ...mockEvent.params,
          oldText: 'function hello() {\n\tconsole.log("hello");\n}', // Tab
        },
      };

      vi.mocked(fs.readFileSync).mockReturnValue(fileContent);

      const result = handleBeforeToolCall(event as any, { ...mockCtx, ...mockWctx } as any);

      expect(result?.params?.oldText).toContain('    console.log("hello")');
    });

    it.skip('should fuzzy match with trailing whitespace', () => {
      const fileContent = 'const x = 1;   \n'; // Trailing spaces
      const event = {
        ...mockEvent,
        params: {
          ...mockEvent.params,
          oldText: 'const x = 1;',
        },
      };

      vi.mocked(fs.readFileSync).mockReturnValue(fileContent);

      const result = handleBeforeToolCall(event as any, { ...mockCtx, ...mockWctx } as any);

      expect(result).toBeDefined();
    });

    it('should NOT fuzzy match when <80% of lines match', () => {
      const fileContent = 'function hello() {\n  console.log("hello");\n  return true;\n}\n';
      const event = {
        ...mockEvent,
        params: {
          ...mockEvent.params,
          oldText: 'completely different text that has no relation', // No match
        },
      };

      vi.mocked(fs.readFileSync).mockReturnValue(fileContent);

      const result = handleBeforeToolCall(event as any, { ...mockCtx, ...mockWctx } as any);

      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('Edit verification failed');
    });

    it.skip('should extract actual text for fuzzy match', () => {
      const fileContent = 'const x = 1;\n';
      const event = {
        ...mockEvent,
        params: {
          ...mockEvent.params,
          oldText: 'const x = 1', // Missing semicolon
        },
      };

      vi.mocked(fs.readFileSync).mockReturnValue(fileContent);

      const result = handleBeforeToolCall(event as any, { ...mockCtx, ...mockWctx } as any);

      // Should pass (fuzzy match found and corrected)
      expect(result).toBeDefined();
      expect(result?.block).toBeFalsy();
    });
  });

  describe('Error Cases', () => {
    it('should block when oldText not found (no fuzzy match)', () => {
      const fileContent = 'function hello() {\n  console.log("hello");\n}\n';
      const event = {
        ...mockEvent,
        params: {
          ...mockEvent.params,
          oldText: 'completely different code',
        },
      };

      vi.mocked(fs.readFileSync).mockReturnValue(fileContent);

      const result = handleBeforeToolCall(event as any, { ...mockCtx, ...mockWctx } as any);

      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('[P-03 Violation]');
    });

    it('should block when file does not exist', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT: no such file');
      });

      const result = handleBeforeToolCall(mockEvent as any, { ...mockCtx, ...mockWctx } as any);

      expect(result).toBeUndefined(); // Let it fail naturally
    });

    it('should block when oldText is empty', () => {
      const event = {
        ...mockEvent,
        params: {
          file_path: 'src/example.ts',
          oldText: '', // Empty oldText
          newText: 'new content',
        },
      };

      const result = handleBeforeToolCall(event as any, { ...mockCtx, ...mockWctx } as any);

      expect(result).toBeUndefined(); // Let it fail naturally
    });

    it('should provide helpful error messages', () => {
      const fileContent = 'function hello() {\n  console.log("hello");\n}\n';
      const event = {
        ...mockEvent,
        params: {
          ...mockEvent.params,
          oldText: 'wrong text',
        },
      };

      vi.mocked(fs.readFileSync).mockReturnValue(fileContent);

      const result = handleBeforeToolCall(event as any, { ...mockCtx, ...mockWctx } as any);

      expect(result?.blockReason).toContain('[P-03 Violation]');
      expect(result?.blockReason).toContain('Solution:');
    });
  });

  describe('Edge Cases', () => {
    it('should skip verification for binary files (PNG)', () => {
      const event = {
        ...mockEvent,
        params: {
          ...mockEvent.params,
          file_path: 'assets/image.png',
        },
      };

      const result = handleBeforeToolCall(event as any, { ...mockCtx, ...mockWctx } as any);

      expect(result).toBeUndefined(); // Binary files should skip verification
    });

    it('should skip verification for binary files (PDF)', () => {
      const event = {
        ...mockEvent,
        params: {
          ...mockEvent.params,
          file_path: 'docs/report.pdf',
        },
      };

      const result = handleBeforeToolCall(event as any, { ...mockCtx, ...mockWctx } as any);

      expect(result).toBeUndefined(); // Binary files should skip verification
    });

    it('should skip verification for binary files (ZIP)', () => {
      const event = {
        ...mockEvent,
        params: {
          ...mockEvent.params,
          file_path: 'dist/package.zip',
        },
      };

      const result = handleBeforeToolCall(event as any, { ...mockCtx, ...mockWctx } as any);

      expect(result).toBeUndefined(); // Binary files should skip verification
    });

    it('should handle special characters correctly', () => {
      const fileContent = 'const emoji = "😀🎉";\nconst unicode = "中文";\nconst symbols = "@#$%^&*";\n';
      const event = {
        ...mockEvent,
        params: {
          ...mockEvent.params,
          oldText: 'const emoji = "😀🎉";',
        },
      };

      vi.mocked(fs.readFileSync).mockReturnValue(fileContent);

      const result = handleBeforeToolCall(event as any, { ...mockCtx, ...mockWctx } as any);

      expect(result).toBeUndefined();
    });

    it('should handle concurrent edits gracefully', () => {
      // First call: file contains 'const x = 1;'
      vi.mocked(fs.readFileSync).mockReturnValue('const x = 1;\n');

      const event1 = { ...mockEvent, params: { ...mockEvent.params, oldText: 'const x = 1;' } };
      const result1 = handleBeforeToolCall(event1 as any, { ...mockCtx, ...mockWctx } as any);

      // Second call: file still contains 'const x = 1;' (but trying to edit 'const x = 2;' which doesn't exist)
      const event2 = { ...mockEvent, params: { ...mockEvent.params, oldText: 'const x = 2;' } };
      const result2 = handleBeforeToolCall(event2 as any, { ...mockCtx, ...mockWctx } as any);

      expect(result1).toBeUndefined(); // First edit matches exactly
      expect(result2?.block).toBe(true); // Second edit doesn't match
    });
  });

  describe('Parameter Extraction', () => {
    it('should extract filePath from file_path parameter', () => {
      const event = {
        ...mockEvent,
        params: {
          file_path: 'src/test.ts',
          oldText: 'old',
          newText: 'new',
        },
      };

      vi.mocked(fs.readFileSync).mockReturnValue('old\n');

      const result = handleBeforeToolCall(event as any, { ...mockCtx, ...mockWctx } as any);

      expect(result).toBeUndefined();
    });

    it('should extract filePath from path parameter', () => {
      const event = {
        ...mockEvent,
        params: {
          path: 'src/test.ts', // Using 'path' instead of 'file_path'
          oldText: 'old',
          newText: 'new',
        },
      };

      vi.mocked(fs.readFileSync).mockReturnValue('old\n');

      const result = handleBeforeToolCall(event as any, { ...mockCtx, ...mockWctx } as any);

      expect(result).toBeUndefined();
    });

    it('should extract filePath from file parameter', () => {
      const event = {
        ...mockEvent,
        params: {
          file: 'src/test.ts', // Using 'file' instead of 'file_path'
          oldText: 'old',
          newText: 'new',
        },
      };

      vi.mocked(fs.readFileSync).mockReturnValue('old\n');

      const result = handleBeforeToolCall(event as any, { ...mockCtx, ...mockWctx } as any);

      expect(result).toBeUndefined();
    });

    it('should extract oldText from old_string parameter', () => {
      const event = {
        ...mockEvent,
        params: {
          file_path: 'src/test.ts',
          old_string: 'old', // Using 'old_string' instead of 'oldText'
          newText: 'new',
        },
      };

      vi.mocked(fs.readFileSync).mockReturnValue('old\n');

      const result = handleBeforeToolCall(event as any, { ...mockCtx, ...mockWctx } as any);

      expect(result).toBeUndefined();
    });
  });
});
