import { describe, it, expect, vi } from 'vitest';
import { handleBeforePromptBuild } from '../../src/hooks/prompt';
import * as fs from 'fs';
import * as path from 'path';

describe('Prompt Context Injection Hook', () => {
  it('should append CURRENT_FOCUS if it exists', () => {
    const workspaceDir = '/mock/workspace';
    const mockCtx = { workspaceDir, trigger: 'user' };
    const mockEvent = { prompt: 'original prompt', messages: [] };

    const focusPath = path.join(workspaceDir, 'docs', 'okr', 'CURRENT_FOCUS.md');
    const thinkingOsPath = path.join(workspaceDir, 'docs', 'THINKING_OS.md');

    vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathOrFileDescriptor) => {
      const pStr = p.toString();
      if (pStr === focusPath) return true;
      if (pStr === thinkingOsPath) return false;
      return false;
    });

    vi.spyOn(fs, 'readFileSync').mockImplementation((p: fs.PathOrFileDescriptor, options?: any) => {
      const pStr = p.toString();
      if (pStr === focusPath) return 'Mock Current Focus';
      return '';
    });

    const result = handleBeforePromptBuild(mockEvent as any, mockCtx as any);

    expect(result).toBeDefined();
    expect(result?.prependContext).toContain('Mock Current Focus');
  });

  it('should prependSystemContext with THINKING_OS.md if it exists', () => {
    const workspaceDir = '/mock/workspace';
    const mockCtx = { workspaceDir, trigger: 'user' };
    const mockEvent = { prompt: 'original prompt', messages: [] };

    const thinkingOsPath = path.join(workspaceDir, 'docs', 'THINKING_OS.md');

    vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathOrFileDescriptor) => {
      const pStr = p.toString();
      if (pStr === thinkingOsPath) return true;
      return false;
    });

    vi.spyOn(fs, 'readFileSync').mockImplementation((p: fs.PathOrFileDescriptor, options?: any) => {
      const pStr = p.toString();
      if (pStr === thinkingOsPath) return 'MOCK THINKING OS CONTENT';
      return '';
    });

    const result = handleBeforePromptBuild(mockEvent as any, mockCtx as any);

    expect(result).toBeDefined();
    expect(result?.prependSystemContext).toContain('MOCK THINKING OS CONTENT');
    expect(result?.prependSystemContext).toContain('<thinking_os>');
  });

  it('should return undefined if workspaceDir is not provided', () => {
    const result = handleBeforePromptBuild({ prompt: '', messages: [] } as any, {} as any);
    expect(result).toBeUndefined();
  });

  it('should return undefined if missing files', () => {
    const workspaceDir = '/mock/workspace';
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const result = handleBeforePromptBuild({ prompt: 'test', messages: [] } as any, { workspaceDir } as any);
    expect(result).toBeUndefined();
  });
});