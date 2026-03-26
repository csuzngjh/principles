/**
 * Edit Verification Module Tests
 *
 * Testing extracted edit verification functions:
 * - normalizeLine()
 * - findFuzzyMatch()
 * - tryFuzzyMatch()
 * - generateEditError()
 * - handleEditVerification()
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  normalizeLine,
  findFuzzyMatch,
  tryFuzzyMatch,
  generateEditError,
  handleEditVerification
} from '../../src/hooks/edit-verification.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('fs');
vi.mock('../../src/core/workspace-context.js');

describe('edit-verification - normalizeLine', () => {
  it('should collapse multiple spaces into single space', () => {
    const result = normalizeLine('const   x  =   1;');
    expect(result).toBe('const x = 1;');
  });

  it('should collapse tabs into spaces', () => {
    const result = normalizeLine('\tconst\tx\t=\t1;');
    expect(result).toBe('const x = 1;');
  });

  it('should trim leading/trailing whitespace', () => {
    const result = normalizeLine('   const x = 1;   ');
    expect(result).toBe('const x = 1;');
  });

  it('should handle mixed tabs and spaces', () => {
    const result = normalizeLine(' \t const \t x \t = \t 1; \t ');
    expect(result).toBe('const x = 1;');
  });

  it('should handle empty string', () => {
    const result = normalizeLine('');
    expect(result).toBe('');
  });

  it('should handle whitespace-only string', () => {
    const result = normalizeLine('   \t   ');
    expect(result).toBe('');
  });
});

describe('edit-verification - findFuzzyMatch', () => {
  it('should return -1 for empty oldLines', () => {
    const lines = ['const x = 1;', 'const y = 2;'];
    const oldLines: string[] = [];
    const result = findFuzzyMatch(lines, oldLines, 0.8);
    expect(result).toBe(-1);
  });

  it('should find exact match at position 0', () => {
    const lines = ['const x = 1;', 'const y = 2;', 'const z = 3;'];
    const oldLines = ['const x = 1;', 'const y = 2;'];
    const result = findFuzzyMatch(lines, oldLines, 0.8);
    expect(result).toBe(0);
  });

  it('should find exact match at later position', () => {
    const lines = ['const a = 1;', 'const x = 1;', 'const y = 2;'];
    const oldLines = ['const x = 1;', 'const y = 2;'];
    const result = findFuzzyMatch(lines, oldLines, 0.8);
    expect(result).toBe(1);
  });

  it('should match with different whitespace (fuzzy)', () => {
    const lines = ['const   x = 1;', 'const  y = 2;'];
    const oldLines = ['const x = 1;', 'const y = 2;'];
    const result = findFuzzyMatch(lines, oldLines, 0.8);
    expect(result).toBe(0);
  });

  it('should respect threshold (0.8)', () => {
    const lines = ['const x = 1;', 'WRONG LINE', 'const y = 2;'];
    const oldLines = ['const x = 1;', 'const y = 2;'];
    const result = findFuzzyMatch(lines, oldLines, 0.8);
    // 1/2 = 50% < 80%, should not match
    expect(result).toBe(-1);
  });

  it('should use custom threshold (0.6)', () => {
    const lines = ['const x = 1;', 'WRONG LINE', 'const y = 2;'];
    const oldLines = ['const x = 1;', 'const y = 2;'];
    const result = findFuzzyMatch(lines, oldLines, 0.6);
    // 1/2 = 50% < 60%, should not match
    expect(result).toBe(-1);
  });

  it('should match when 2/3 lines match with 0.6 threshold', () => {
    const lines = ['const x = 1;', 'const y = 2;', 'const z = 3;'];
    const oldLines = ['const x = 1;', 'const y = 2;'];
    const result = findFuzzyMatch(lines, oldLines, 0.6);
    // 2/2 = 100% > 60%, should match
    expect(result).toBe(0);
  });

  it('should return -1 when no match found', () => {
    const lines = ['const a = 1;', 'const b = 2;', 'const c = 3;'];
    const oldLines = ['const x = 1;', 'const y = 2;'];
    const result = findFuzzyMatch(lines, oldLines, 0.8);
    expect(result).toBe(-1);
  });
});

describe('edit-verification - tryFuzzyMatch', () => {
  it('should return found: false when no match', () => {
    const currentContent = 'const a = 1;\nconst b = 2;';
    const oldText = 'const x = 1;';
    const result = tryFuzzyMatch(currentContent, oldText, 0.8);
    expect(result).toEqual({ found: false });
  });

  it('should return found: true with correctedText when match found', () => {
    const currentContent = 'const   x = 1;';
    const oldText = 'const x = 1;';
    const result = tryFuzzyMatch(currentContent, oldText, 0.8);
    expect(result.found).toBe(true);
    expect(result.correctedText).toBe('const   x = 1;');
  });

  it('should extract actual text with extra spaces', () => {
    const currentContent = 'const  x  =  1;';
    const oldText = 'const x = 1;';
    const result = tryFuzzyMatch(currentContent, oldText, 0.8);
    expect(result.found).toBe(true);
    expect(result.correctedText).toBe('const  x  =  1;');
  });

  it('should extract multi-line match with different whitespace', () => {
    const currentContent = 'const x = 1;\nconst y = 2;';
    const oldText = 'const  x  =  1;\nconst  y  =  2;';
    const result = tryFuzzyMatch(currentContent, oldText, 0.8);
    expect(result.found).toBe(true);
    expect(result.correctedText).toBe('const x = 1;\nconst y = 2;');
  });
});

describe('edit-verification - generateEditError', () => {
  it('should generate error message with file path', () => {
    const oldText = 'const x = 1;';
    const currentContent = 'const y = 2;';
    const result = generateEditError('/path/to/file.ts', oldText, currentContent);
    expect(result).toContain('File: /path/to/file.ts');
    expect(result).toContain('[P-03 Violation]');
  });

  it('should include expected text snippet', () => {
    const oldText = 'const x = 1;';
    const currentContent = 'different content';
    const result = generateEditError('/path/to/file.ts', oldText, currentContent);
    expect(result).toContain('Expected to find:');
    expect(result).toContain('const x = 1;');
  });

  it('should include actual text snippet', () => {
    const oldText = 'const x = 1;';
    const currentContent = 'different content here';
    const result = generateEditError('/path/to/file.ts', oldText, currentContent);
    expect(result).toContain('Actual file contains:');
    expect(result).toContain('different content here');
  });

  it('should truncate long oldText to 200 characters', () => {
    const longText = 'a'.repeat(300);
    const currentContent = 'b'.repeat(300);
    const result = generateEditError('/path/to/file.ts', longText, currentContent);
    // Should have 200 'a's plus '...'
    expect(result).toContain('a'.repeat(200));
    expect(result).toContain('...');
  });

  it('should truncate long currentContent to 200 characters', () => {
    const oldText = 'a'.repeat(300);
    const currentContent = 'b'.repeat(300);
    const result = generateEditError('/path/to/file.ts', oldText, currentContent);
    // Should have 200 'b's plus '...'
    expect(result).toContain('b'.repeat(200));
    expect(result).toContain('...');
  });

  it('should include possible reasons', () => {
    const oldText = 'const x = 1;';
    const currentContent = 'const y = 2;';
    const result = generateEditError('/path/to/file.ts', oldText, currentContent);
    expect(result).toContain('Possible reasons:');
    expect(result).toContain('- File has been modified by another process');
    expect(result).toContain('- Whitespace characters do not match');
    expect(result).toContain('- Context compression caused outdated information');
  });

  it('should include solution steps', () => {
    const oldText = 'const x = 1;';
    const currentContent = 'const y = 2;';
    const result = generateEditError('/path/to/file.ts', oldText, currentContent);
    expect(result).toContain('Solution:');
    expect(result).toContain("1. Use 'read' tool to get current file content");
    expect(result).toContain('2. Update your edit command with exact text from file');
    expect(result).toContain('3. Retry edit operation');
  });

  it('should mention P-03 principle', () => {
    const oldText = 'const x = 1;';
    const currentContent = 'const y = 2;';
    const result = generateEditError('/path/to/file.ts', oldText, currentContent);
    expect(result).toContain('P-03');
    expect(result).toContain('精确匹配前验证原则');
  });
});

describe('edit-verification - handleEditVerification', () => {
  const mockEvent = {
    toolName: 'edit',
    params: {
      file_path: 'src/example.ts',
      oldText: 'const x = 1;',
      newText: 'const x = 2;',
    },
  };

  const mockWctx = {
    resolve: vi.fn().mockImplementation((p) => `/mock/workspace/${p}`),
  };

  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('exact match scenarios', () => {
    it('should allow edit when oldText matches exactly', () => {
      const fileContent = 'const x = 1;';
      vi.mocked(fs.readFileSync).mockReturnValue(fileContent);
      vi.mocked(fs.statSync).mockReturnValue({ size: 1024 } as fs.Stats);

      const result = handleEditVerification(
        mockEvent as any,
        mockWctx as any,
        { logger: mockLogger },
        { enabled: true }
      );

      expect(result).toBeUndefined();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Verified edit')
      );
    });

    it('should skip verification when enabled = false', () => {
      const result = handleEditVerification(
        mockEvent as any,
        mockWctx as any,
        { logger: mockLogger },
        { enabled: false }
      );

      expect(result).toBeUndefined();
      expect(mockLogger.info).not.toHaveBeenCalled();
    });
  });

  describe('missing parameters', () => {
    it('should allow edit when file_path is missing', () => {
      const event = {
        ...mockEvent,
        params: {
          oldText: 'const x = 1;',
          newText: 'const x = 2;',
        },
      };

      const result = handleEditVerification(
        event as any,
        mockWctx as any,
        { logger: mockLogger },
        { enabled: true }
      );

      expect(result).toBeUndefined();
    });

    it('should allow edit when oldText is missing', () => {
      const event = {
        ...mockEvent,
        params: {
          file_path: 'src/example.ts',
          newText: 'const x = 2;',
        },
      };

      const result = handleEditVerification(
        event as any,
        mockWctx as any,
        { logger: mockLogger },
        { enabled: true }
      );

      expect(result).toBeUndefined();
    });
  });

  describe('binary file handling', () => {
    const binaryExtensions = [
      '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg',
      '.pdf', '.zip', '.tar', '.gz', '.7z', '.rar',
      '.exe', '.dll', '.so', '.dylib', '.bin',
      '.mp3', '.mp4', '.avi', '.mov', '.wav',
      '.ttf', '.otf', '.woff', '.woff2',
      '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'
    ];

    binaryExtensions.forEach(ext => {
      it(`should skip verification for ${ext} files`, () => {
        const event = {
          ...mockEvent,
          params: {
            ...mockEvent.params,
            file_path: `image${ext}`,
          },
        };

        const result = handleEditVerification(
          event as any,
          mockWctx as any,
          { logger: mockLogger },
          { enabled: true }
        );

        expect(result).toBeUndefined();
        expect(mockLogger.info).toHaveBeenCalledWith(
          expect.stringContaining('Skipping verification for binary file')
        );
      });
    });
  });

  describe('file size check', () => {
    it('should block files exceeding max_file_size_bytes when skip_large_file_action = block', () => {
      const largeFileSize = 11 * 1024 * 1024; // 11MB

      vi.mocked(fs.statSync).mockReturnValue({ size: largeFileSize } as fs.Stats);

      const result = handleEditVerification(
        mockEvent as any,
        mockWctx as any,
        { logger: mockLogger },
        {
          enabled: true,
          max_file_size_bytes: 10 * 1024 * 1024,
          skip_large_file_action: 'block',
        }
      );

      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('File is too large');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('BLOCKED')
      );
    });

    it('should skip verification (warn) for files exceeding max_file_size_bytes by default', () => {
      const largeFileSize = 11 * 1024 * 1024; // 11MB

      vi.mocked(fs.statSync).mockReturnValue({ size: largeFileSize } as fs.Stats);

      const result = handleEditVerification(
        mockEvent as any,
        mockWctx as any,
        { logger: mockLogger },
        { enabled: true, max_file_size_bytes: 10 * 1024 * 1024 }
      );

      expect(result).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('SKIPPING verification')
      );
    });

    it('should pass verification for files under max_file_size_bytes', () => {
      const smallFileSize = 1024; // 1KB
      const fileContent = 'const x = 1;';

      vi.mocked(fs.statSync).mockReturnValue({ size: smallFileSize } as fs.Stats);
      vi.mocked(fs.readFileSync).mockReturnValue(fileContent);

      const result = handleEditVerification(
        mockEvent as any,
        mockWctx as any,
        { logger: mockLogger },
        { enabled: true }
      );

      expect(result).toBeUndefined();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('File size check passed')
      );
    });
  });

  describe('permission error handling', () => {
    it('should block when stat() fails with EACCES', () => {
      vi.mocked(fs.statSync).mockImplementation(() => {
        const error = new Error('Permission denied') as any;
        error.code = 'EACCES';
        throw error;
      });

      const result = handleEditVerification(
        mockEvent as any,
        mockWctx as any,
        { logger: mockLogger },
        { enabled: true }
      );

      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('Permission denied');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Permission denied')
      );
    });

    it('should block when readFileSync() fails with EACCES', () => {
      vi.mocked(fs.statSync).mockReturnValue({ size: 1024 } as fs.Stats);
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        const error = new Error('Permission denied') as any;
        error.code = 'EACCES';
        throw error;
      });

      const result = handleEditVerification(
        mockEvent as any,
        mockWctx as any,
        { logger: mockLogger },
        { enabled: true }
      );

      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('Permission denied');
      expect(result?.blockReason).toContain('Cannot read file');
    });

    it('should allow edit when file does not exist (ENOENT)', () => {
      vi.mocked(fs.statSync).mockImplementation(() => {
        const error = new Error('No such file') as any;
        error.code = 'ENOENT';
        throw error;
      });

      const result = handleEditVerification(
        mockEvent as any,
        mockWctx as any,
        { logger: mockLogger },
        { enabled: true }
      );

      expect(result).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('File not found')
      );
    });
  });

  describe('encoding error handling', () => {
    it('should block on encoding errors', () => {
      vi.mocked(fs.statSync).mockReturnValue({ size: 1024 } as fs.Stats);
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        const error = new Error('Invalid UTF-8 sequence') as any;
        error.code = 'ERR_ENCODING';
        throw error;
      });

      const result = handleEditVerification(
        mockEvent as any,
        mockWctx as any,
        { logger: mockLogger },
        { enabled: true }
      );

      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('Encoding error');
      expect(result?.blockReason).toContain('UTF-8');
    });
  });

  describe('fuzzy matching', () => {
    it('should auto-correct with fuzzy match when enabled', () => {
      const fileContent = 'const  x  =  1;';
      vi.mocked(fs.statSync).mockReturnValue({ size: 1024 } as fs.Stats);
      vi.mocked(fs.readFileSync).mockReturnValue(fileContent);

      const result = handleEditVerification(
        mockEvent as any,
        mockWctx as any,
        { logger: mockLogger },
        {
          enabled: true,
          fuzzy_match_enabled: true,
          fuzzy_match_threshold: 0.8,
        }
      );

      expect(result).toBeDefined();
      expect(result?.params?.oldText).toBe('const  x  =  1;');
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Fuzzy match found')
      );
    });

    it('should disable fuzzy match when fuzzy_match_enabled = false', () => {
      const fileContent = 'const  x  =  1;';
      vi.mocked(fs.statSync).mockReturnValue({ size: 1024 } as fs.Stats);
      vi.mocked(fs.readFileSync).mockReturnValue(fileContent);

      const result = handleEditVerification(
        mockEvent as any,
        mockWctx as any,
        { logger: mockLogger },
        {
          enabled: true,
          fuzzy_match_enabled: false,
        }
      );

      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('[P-03 Violation]');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Block edit')
      );
    });

    it('should respect custom fuzzy_match_threshold', () => {
      const fileContent = 'const x = 1;\nconst y = 2;\nconst z = 3;';
      const event = {
        ...mockEvent,
        params: {
          ...mockEvent.params,
          oldText: 'const x = 1;\nconst y = 2;',
        },
      };

      vi.mocked(fs.statSync).mockReturnValue({ size: 1024 } as fs.Stats);
      vi.mocked(fs.readFileSync).mockReturnValue(fileContent);

      const result = handleEditVerification(
        event as any,
        mockWctx as any,
        { logger: mockLogger },
        {
          enabled: true,
          fuzzy_match_enabled: true,
          fuzzy_match_threshold: 0.6,
        }
      );

      // 2/3 = 66.7% > 60%, should pass with fuzzy match
      expect(result?.params?.oldText).toBeTruthy();
    });
  });

  describe('block on no match', () => {
    it('should block when oldText not found and fuzzy match fails', () => {
      const fileContent = 'different content';
      vi.mocked(fs.statSync).mockReturnValue({ size: 1024 } as fs.Stats);
      vi.mocked(fs.readFileSync).mockReturnValue(fileContent);

      const result = handleEditVerification(
        mockEvent as any,
        mockWctx as any,
        { logger: mockLogger },
        { enabled: true }
      );

      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('[P-03 Violation]');
      expect(result?.blockReason).toContain('Expected to find:');
      expect(result?.blockReason).toContain('Actual file contains:');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Block edit')
      );
    });
  });

  describe('parameter name conventions', () => {
    it('should handle old_string parameter name', () => {
      const event = {
        ...mockEvent,
        params: {
          file_path: 'src/example.ts',
          old_string: 'const x = 1;',
          newText: 'const x = 2;',
        },
      };

      const fileContent = 'const x = 1;';
      vi.mocked(fs.statSync).mockReturnValue({ size: 1024 } as fs.Stats);
      vi.mocked(fs.readFileSync).mockReturnValue(fileContent);

      const result = handleEditVerification(
        event as any,
        mockWctx as any,
        { logger: mockLogger },
        { enabled: true }
      );

      expect(result).toBeUndefined();
    });

    it('should handle path parameter name', () => {
      const event = {
        ...mockEvent,
        params: {
          path: 'src/example.ts',
          oldText: 'const x = 1;',
          newText: 'const x = 2;',
        },
      };

      const fileContent = 'const x = 1;';
      vi.mocked(fs.statSync).mockReturnValue({ size: 1024 } as fs.Stats);
      vi.mocked(fs.readFileSync).mockReturnValue(fileContent);

      const result = handleEditVerification(
        event as any,
        mockWctx as any,
        { logger: mockLogger },
        { enabled: true }
      );

      expect(result).toBeUndefined();
    });

    it('should handle file parameter name', () => {
      const event = {
        ...mockEvent,
        params: {
          file: 'src/example.ts',
          oldText: 'const x = 1;',
          newText: 'const x = 2;',
        },
      };

      const fileContent = 'const x = 1;';
      vi.mocked(fs.statSync).mockReturnValue({ size: 1024 } as fs.Stats);
      vi.mocked(fs.readFileSync).mockReturnValue(fileContent);

      const result = handleEditVerification(
        event as any,
        mockWctx as any,
        { logger: mockLogger },
        { enabled: true }
      );

      expect(result).toBeUndefined();
    });
  });
});
