import { describe, it, expect, vi } from 'vitest';
import { handleBeforePromptBuild } from '../../src/hooks/prompt';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('fs');

describe('Prompt Context Injection Hook', () => {
  it('should append USER_CONTEXT and CURRENT_FOCUS if they exist', () => {
    const workspaceDir = '/mock/workspace';
    const mockCtx = { workspaceDir };
    const mockEvent = { prompt: 'original prompt', messages: [] };

    const userContextPath = path.join(workspaceDir, 'docs', 'USER_CONTEXT.md');
    const focusPath = path.join(workspaceDir, 'docs', 'okr', 'CURRENT_FOCUS.md');

    vi.mocked(fs.existsSync).mockImplementation((p) => {
      if (p === userContextPath || p === focusPath) return true;
      return false;
    });

    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (p === userContextPath) return 'Mock User Context';
      if (p === focusPath) return 'Mock Current Focus';
      return '';
    });

    const result = handleBeforePromptBuild(mockEvent as any, mockCtx as any);

    expect(result).toBeDefined();
    expect(result?.appendSystemContext).toContain('Mock User Context');
    expect(result?.prependContext).toContain('Mock Current Focus');
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