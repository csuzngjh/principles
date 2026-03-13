/**
 * P-03 Edit Verification - P1 Improvements Tests
 *
 * Testing P1 improvements to edit verification:
 * - Configuration system (PROFILE.json integration)
 * - File size check (>10MB threshold)
 * - Permission error handling
 * - File not found error handling
 * - Encoding error handling
 * - Configurable fuzzy match threshold
 * - Configurable skip_large_file_action
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleBeforeToolCall } from '../../src/hooks/gate.js';
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceContext } from '../../src/core/workspace-context.js';

vi.mock('fs');
vi.mock('../../src/core/workspace-context.js');

describe('P-03 Edit Verification - P1 Improvements', () => {
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
      if (p === 'large-file.ts') return path.join(workspaceDir, 'large-file.ts');
      if (p === 'PROFILE') return path.join(workspaceDir, 'PROFILE.json');
      return p;
    }),
    trust: {
      getScore: vi.fn().mockReturnValue(75),
      getStage: vi.fn().mockReturnValue(3),
    },
    config: {
      get: vi.fn().mockReturnValue({
        limits: { stage_2_max_lines: 50, stage_3_max_lines: 300 }
      }),
    },
  };

  // Console spies
  let consoleInfoSpy: any;
  let consoleWarnSpy: any;
  let consoleErrorSpy: any;

  const mockCtx = {
    workspaceDir,
    logger: console,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(WorkspaceContext.fromHookContext).mockReturnValue(mockWctx as any);

    // Setup console spies
    consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      if (typeof p === 'string' && p.includes('PROFILE.json')) {
        return true;
      }
      if (typeof p === 'string' && p.endsWith('.ts')) {
        return true;
      }
      return false;
    });
    // Default: return empty profile (enables edit verification)
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
      if (typeof filePath === 'string' && filePath.includes('PROFILE.json')) {
        return JSON.stringify({
          progressive_gate: { enabled: false },
        });
      }
      return 'mock content';
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    consoleInfoSpy?.mockRestore();
    consoleWarnSpy?.mockRestore();
    consoleErrorSpy?.mockRestore();
  });

  describe('Configuration System - PROFILE.json', () => {
    it('should use default config when edit_verification not specified', () => {
      const fileContent = 'const x = 1;';
      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
        if (typeof filePath === 'string' && filePath.includes('PROFILE.json')) {
          return JSON.stringify({
            progressive_gate: { enabled: false },
          });
        }
        return fileContent;
      });
      vi.mocked(fs.statSync).mockReturnValue({ size: 1024 } as fs.Stats);

      const result = handleBeforeToolCall(mockEvent as any, { ...mockCtx, ...mockWctx } as any);

      expect(result).toBeUndefined(); // Should allow edit with default config
    });

    it('should disable verification when edit_verification.enabled = false', () => {
      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
        if (typeof filePath === 'string' && filePath.includes('PROFILE.json')) {
          return JSON.stringify({
            progressive_gate: { enabled: false },
            edit_verification: { enabled: false },
          });
        }
        return 'any content'; // Content doesn't match, but verification is disabled
      });

      const event = {
        ...mockEvent,
        params: {
          ...mockEvent.params,
          oldText: 'this does not match', // Mismatched text
        },
      };

      const result = handleBeforeToolCall(event as any, { ...mockCtx, ...mockWctx } as any);

      expect(result).toBeUndefined(); // Should allow edit even with mismatch (verification disabled)
    });

    it('should use custom max_file_size_bytes from config', () => {
      const customMaxSize = 5 * 1024 * 1024; // 5MB
      const fileSize = 6 * 1024 * 1024; // 6MB (over custom limit)

      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
        if (typeof filePath === 'string' && filePath.includes('PROFILE.json')) {
          return JSON.stringify({
            progressive_gate: { enabled: false },
            edit_verification: {
              enabled: true,
              max_file_size_bytes: customMaxSize,
              skip_large_file_action: 'warn',
            },
          });
        }
        return 'const x = 1;';
      });

      vi.mocked(fs.statSync).mockReturnValue({ size: fileSize } as fs.Stats);

      const result = handleBeforeToolCall(mockEvent as any, { ...mockCtx, ...mockWctx } as any);

      expect(result).toBeUndefined(); // Should skip but not block
    });

    it('should use custom fuzzy_match_threshold from config', () => {
      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
        if (typeof filePath === 'string' && filePath.includes('PROFILE.json')) {
          return JSON.stringify({
            progressive_gate: { enabled: false },
            edit_verification: {
              enabled: true,
              fuzzy_match_enabled: true,
              fuzzy_match_threshold: 0.9, // Higher threshold (90%)
            },
          });
        }
        // File has "const  x  =  1;" (extra spaces) - needs >90% match
        return 'const  x  =  1;';
      });

      const event = {
        ...mockEvent,
        params: {
          ...mockEvent.params,
          oldText: 'const x = 1;',
        },
      };

      const result = handleBeforeToolCall(event as any, { ...mockCtx, ...mockWctx } as any);

      // With 90% threshold, single line with different spacing should still match (1/1 = 100%)
      // Fuzzy match should succeed and return corrected params
      expect(result).toBeDefined();
      expect(result?.params?.oldText).toBe('const  x  =  1;');
    });

    it('should respect skip_large_file_action = block', () => {
      const largeFileSize = 11 * 1024 * 1024; // 11MB

      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
        if (typeof filePath === 'string' && filePath.includes('PROFILE.json')) {
          return JSON.stringify({
            progressive_gate: { enabled: false },
            edit_verification: {
              enabled: true,
              max_file_size_bytes: 10 * 1024 * 1024,
              skip_large_file_action: 'block',
            },
          });
        }
        return 'const x = 1;';
      });

      vi.mocked(fs.statSync).mockReturnValue({ size: largeFileSize } as fs.Stats);

      const result = handleBeforeToolCall(mockEvent as any, { ...mockCtx, ...mockWctx } as any);

      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('File is too large');
    });

    it('should respect skip_large_file_action = warn', () => {
      const largeFileSize = 11 * 1024 * 1024; // 11MB

      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
        if (typeof filePath === 'string' && filePath.includes('PROFILE.json')) {
          return JSON.stringify({
            progressive_gate: { enabled: false },
            edit_verification: {
              enabled: true,
              max_file_size_bytes: 10 * 1024 * 1024,
              skip_large_file_action: 'warn',
            },
          });
        }
        return 'const x = 1;';
      });

      vi.mocked(fs.statSync).mockReturnValue({ size: largeFileSize } as fs.Stats);

      const result = handleBeforeToolCall(mockEvent as any, { ...mockCtx, ...mockWctx } as any);

      expect(result).toBeUndefined(); // Should allow with warning
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('SKIPPING verification')
      );
    });
  });

  describe('File Size Check', () => {
    it('should pass verification for small files (<10MB)', () => {
      const smallFileSize = 1024; // 1KB
      const fileContent = 'const x = 1;';

      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
        if (typeof filePath === 'string' && filePath.includes('PROFILE.json')) {
          return JSON.stringify({ progressive_gate: { enabled: false } });
        }
        return fileContent;
      });
      vi.mocked(fs.statSync).mockReturnValue({ size: smallFileSize } as fs.Stats);

      const result = handleBeforeToolCall(mockEvent as any, { ...mockCtx, ...mockWctx } as any);

      expect(result).toBeUndefined();
      expect(consoleInfoSpy).toHaveBeenCalledWith(
        expect.stringContaining('File size check passed')
      );
    });

    it('should pass verification for files exactly at 10MB threshold', () => {
      const exactThreshold = 10 * 1024 * 1024; // Exactly 10MB
      const fileContent = 'const x = 1;';

      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
        if (typeof filePath === 'string' && filePath.includes('PROFILE.json')) {
          return JSON.stringify({ progressive_gate: { enabled: false } });
        }
        return fileContent;
      });
      vi.mocked(fs.statSync).mockReturnValue({ size: exactThreshold } as fs.Stats);

      const result = handleBeforeToolCall(mockEvent as any, { ...mockCtx, ...mockWctx } as any);

      expect(result).toBeUndefined();
    });

    it('should skip verification (warn) for files >10MB with default config', () => {
      const largeFileSize = 11 * 1024 * 1024; // 11MB
      const fileContent = 'const x = 1;';

      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
        if (typeof filePath === 'string' && filePath.includes('PROFILE.json')) {
          return JSON.stringify({ progressive_gate: { enabled: false } });
        }
        return fileContent;
      });
      vi.mocked(fs.statSync).mockReturnValue({ size: largeFileSize } as fs.Stats);

      const event = {
        ...mockEvent,
        params: {
          ...mockEvent.params,
          oldText: 'this does not match', // Mismatched text
        },
      };

      const result = handleBeforeToolCall(event as any, { ...mockCtx, ...mockWctx } as any);

      expect(result).toBeUndefined(); // Should allow (skip verification)
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('SKIPPING verification')
      );
    });

    it('should block for files >10MB when skip_large_file_action = block', () => {
      const largeFileSize = 11 * 1024 * 1024; // 11MB
      const fileContent = 'const x = 1;';

      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
        if (typeof filePath === 'string' && filePath.includes('PROFILE.json')) {
          return JSON.stringify({
            progressive_gate: { enabled: false },
            edit_verification: {
              skip_large_file_action: 'block',
            },
          });
        }
        return fileContent;
      });
      vi.mocked(fs.statSync).mockReturnValue({ size: largeFileSize } as fs.Stats);

      const event = {
        ...mockEvent,
        params: {
          ...mockEvent.params,
          oldText: 'this does not match',
        },
      };

      const result = handleBeforeToolCall(event as any, { ...mockCtx, ...mockWctx } as any);

      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('File is too large');
      expect(result?.blockReason).toContain('11.00MB');
    });
  });

  describe('Permission Error Handling', () => {
    it('should block with helpful message when stat() fails with EACCES', () => {
      vi.mocked(fs.statSync).mockImplementation(() => {
        const error = new Error('Permission denied') as any;
        error.code = 'EACCES';
        throw error;
      });

      const result = handleBeforeToolCall(mockEvent as any, { ...mockCtx, ...mockWctx } as any);

      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('Permission denied');
      expect(result?.blockReason).toContain('Check file permissions');
    });

    it('should block with helpful message when stat() fails with EPERM', () => {
      vi.mocked(fs.statSync).mockImplementation(() => {
        const error = new Error('Operation not permitted') as any;
        error.code = 'EPERM';
        throw error;
      });

      const result = handleBeforeToolCall(mockEvent as any, { ...mockCtx, ...mockWctx } as any);

      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('Permission denied');
    });

    it('should block with helpful message when readFileSync() fails with EACCES', () => {
      vi.mocked(fs.statSync).mockReturnValue({ size: 1024 } as fs.Stats);
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        const error = new Error('Permission denied') as any;
        error.code = 'EACCES';
        throw error;
      });

      const result = handleBeforeToolCall(mockEvent as any, { ...mockCtx, ...mockWctx } as any);

      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('Permission denied');
      expect(result?.blockReason).toContain('Cannot read file');
    });

    it('should block with helpful message when readFileSync() fails with EPERM', () => {
      vi.mocked(fs.statSync).mockReturnValue({ size: 1024 } as fs.Stats);
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        const error = new Error('Operation not permitted') as any;
        error.code = 'EPERM';
        throw error;
      });

      const result = handleBeforeToolCall(mockEvent as any, { ...mockCtx, ...mockWctx } as any);

      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('Permission denied');
    });
  });

  describe('File Not Found Error Handling', () => {
    it('should allow edit when file does not exist (stat ENOENT)', () => {
      vi.mocked(fs.statSync).mockImplementation(() => {
        const error = new Error('No such file') as any;
        error.code = 'ENOENT';
        throw error;
      });

      const result = handleBeforeToolCall(mockEvent as any, { ...mockCtx, ...mockWctx } as any);

      expect(result).toBeUndefined(); // Allow edit (file will be created)
    });

    it('should allow edit when file does not exist (read ENOENT)', () => {
      vi.mocked(fs.statSync).mockReturnValue({ size: 1024 } as fs.Stats);
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        const error = new Error('No such file') as any;
        error.code = 'ENOENT';
        throw error;
      });

      const result = handleBeforeToolCall(mockEvent as any, { ...mockCtx, ...mockWctx } as any);

      expect(result).toBeUndefined(); // Allow edit (file will be created)
    });

    it('should log warning when file not found', () => {
      vi.mocked(fs.statSync).mockImplementation(() => {
        const error = new Error('No such file') as any;
        error.code = 'ENOENT';
        throw error;
      });

      const result = handleBeforeToolCall(mockEvent as any, { ...mockCtx, ...mockWctx } as any);

      expect(result).toBeUndefined();
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('File not found')
      );
    });
  });

  describe('Encoding Error Handling', () => {
    it('should block with helpful message for encoding errors', () => {
      vi.mocked(fs.statSync).mockReturnValue({ size: 1024 } as fs.Stats);
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        const error = new Error('Invalid UTF-8 sequence') as any;
        error.code = 'ERR_ENCODING';
        throw error;
      });

      const result = handleBeforeToolCall(mockEvent as any, { ...mockCtx, ...mockWctx } as any);

      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('Encoding error');
      expect(result?.blockReason).toContain('UTF-8');
    });

    it('should provide actionable solution for encoding errors', () => {
      vi.mocked(fs.statSync).mockReturnValue({ size: 1024 } as fs.Stats);
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        const error = new Error('UTF-8 decode error') as any;
        error.code = 'ERR_UTF8_DECODE';
        throw error;
      });

      const result = handleBeforeToolCall(mockEvent as any, { ...mockCtx, ...mockWctx } as any);

      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('Solution:');
      expect(result?.blockReason).toContain('UTF-8 encoded');
    });
  });

  describe('Fuzzy Match Threshold Configuration', () => {
    it('should use 0.8 threshold by default', () => {
      // File has different whitespace than oldText - need fuzzy match
      // oldText has 2 lines, file has "line  one" with extra space (2/2 = 100% fuzzy match)
      // Since 100% > 80%, fuzzy match should succeed
      const fileContent = 'line  one\nline  two\n'; // Extra space - no exact match
      const event = {
        ...mockEvent,
        params: {
          ...mockEvent.params,
          oldText: 'line one\nline two\n', // Different whitespace
        },
      };

      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
        if (typeof filePath === 'string' && filePath.includes('PROFILE.json')) {
          return JSON.stringify({ progressive_gate: { enabled: false } });
        }
        return fileContent;
      });
      vi.mocked(fs.statSync).mockReturnValue({ size: 1024 } as fs.Stats);

      const result = handleBeforeToolCall(event as any, { ...mockCtx, ...mockWctx } as any);

      // With 80% threshold and 100% match (2/2 lines), should auto-correct
      expect(result?.block).toBeUndefined();
      expect(result?.params?.oldText).toBeTruthy();
    });

    it('should use custom threshold from config', () => {
      // oldText doesn't match exactly, fuzzy match needed
      const fileContent = 'line a\nline b\nline c\n';
      const event = {
        ...mockEvent,
        params: {
          ...mockEvent.params,
          oldText: 'line a\nline b\n', // Won't match exactly
        },
      };

      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
        if (typeof filePath === 'string' && filePath.includes('PROFILE.json')) {
          return JSON.stringify({
            progressive_gate: { enabled: false },
            edit_verification: {
              fuzzy_match_threshold: 0.6, // Lower threshold (60%)
            },
          });
        }
        return fileContent;
      });
      vi.mocked(fs.statSync).mockReturnValue({ size: 1024 } as fs.Stats);

      const result = handleBeforeToolCall(event as any, { ...mockCtx, ...mockWctx } as any);

      // 2/3 = 66.7% > 60%, should pass with fuzzy match
      expect(result?.block).toBeUndefined();
    });

    it('should disable fuzzy match when fuzzy_match_enabled = false', () => {
      const fileContent = 'const  x  =  1;'; // Extra spaces
      const event = {
        ...mockEvent,
        params: {
          ...mockEvent.params,
          oldText: 'const x = 1;',
        },
      };

      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
        if (typeof filePath === 'string' && filePath.includes('PROFILE.json')) {
          return JSON.stringify({
            progressive_gate: { enabled: false },
            edit_verification: {
              fuzzy_match_enabled: false,
            },
          });
        }
        return fileContent;
      });
      vi.mocked(fs.statSync).mockReturnValue({ size: 1024 } as fs.Stats);

      const result = handleBeforeToolCall(event as any, { ...mockCtx, ...mockWctx } as any);

      // Fuzzy match disabled, should block with detailed error
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('[P-03 Violation]');
      expect(result?.blockReason).toContain('Whitespace characters');
    });
  });

  describe('Integration Tests', () => {
    it('should handle all checks together: size, permissions, fuzzy match', () => {
      const fileContent = 'function hello() {\n  const x = 1;\n}\n';

      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
        if (typeof filePath === 'string' && filePath.includes('PROFILE.json')) {
          return JSON.stringify({
            progressive_gate: { enabled: false },
            edit_verification: {
              max_file_size_bytes: 10 * 1024 * 1024,
              fuzzy_match_threshold: 0.8,
              fuzzy_match_enabled: true,
            },
          });
        }
        return fileContent;
      });
      vi.mocked(fs.statSync).mockReturnValue({ size: 1024 } as fs.Stats);

      const event = {
        ...mockEvent,
        params: {
          ...mockEvent.params,
          oldText: 'function hello() {\n  const x = 1;\n}',
        },
      };

      const result = handleBeforeToolCall(event as any, { ...mockCtx, ...mockWctx } as any);

      expect(result).toBeUndefined(); // All checks pass
    });

    it('should provide complete error stack for failed edit', () => {
      const fileContent = 'function hello() {\n  const x = 1;\n}\n';
      const event = {
        ...mockEvent,
        params: {
          ...mockEvent.params,
          oldText: 'completely wrong text',
        },
      };

      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
        if (typeof filePath === 'string' && filePath.includes('PROFILE.json')) {
          return JSON.stringify({ progressive_gate: { enabled: false } });
        }
        return fileContent;
      });
      vi.mocked(fs.statSync).mockReturnValue({ size: 1024 } as fs.Stats);

      const result = handleBeforeToolCall(event as any, { ...mockCtx, ...mockWctx } as any);

      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('Expected to find:');
      expect(result?.blockReason).toContain('Actual file contains:');
      expect(result?.blockReason).toContain('Solution:');
    });
  });
});
