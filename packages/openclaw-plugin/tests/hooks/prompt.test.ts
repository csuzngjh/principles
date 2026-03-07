import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleBeforePromptBuild } from '../../src/hooks/prompt';
import fs from 'fs';
import path from 'path';

vi.mock('fs');

describe('Prompt Context Injection Hook', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should append CURRENT_FOCUS if it exists', () => {
    const workspaceDir = '/mock/workspace';
    const mockCtx = { workspaceDir, trigger: 'user' };
    const mockEvent = { prompt: 'original prompt', messages: [] };

    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
      return p.toString().includes('CURRENT_FOCUS.md');
    });

    vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor, options?: any) => {
      if (p.toString().includes('CURRENT_FOCUS.md')) return 'Mock Current Focus';
      return '' as any;
    });

    const result = handleBeforePromptBuild(mockEvent as any, mockCtx as any);

    expect(result).toBeDefined();
    expect(result?.prependContext).toContain('Mock Current Focus');
  });

  it('should prependSystemContext with THINKING_OS.md if it exists', () => {
    const workspaceDir = '/mock/workspace';
    const mockCtx = { workspaceDir, trigger: 'user' };
    const mockEvent = { prompt: 'original prompt', messages: [] };

    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
      return p.toString().includes('THINKING_OS.md');
    });

    vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor, options?: any) => {
      if (p.toString().includes('THINKING_OS.md')) return 'MOCK THINKING OS CONTENT';
      return '' as any;
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
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = handleBeforePromptBuild({ prompt: 'test', messages: [] } as any, { workspaceDir } as any);
    expect(result).toBeUndefined();
  });
});