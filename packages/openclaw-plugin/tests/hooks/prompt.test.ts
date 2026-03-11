import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleBeforePromptBuild } from '../../src/hooks/prompt';
import * as sessionTracker from '../../src/core/session-tracker';
import * as trustEngine from '../../src/core/trust-engine.js';
import fs from 'fs';
import path from 'path';

vi.mock('fs');
vi.mock('../../src/core/session-tracker');
vi.mock('../../src/core/trust-engine.js');

describe('Prompt Context Injection Hook', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(sessionTracker.getSession).mockReturnValue(undefined);
    vi.mocked(trustEngine.getAgentScorecard).mockReturnValue({ trust_score: 50 });
  });

  it('should inject current trust score and stage', async () => {
    const workspaceDir = '/mock/workspace';
    const mockCtx = { workspaceDir, trigger: 'user' };
    const mockEvent = { prompt: 'original prompt', messages: [] };

    vi.mocked(trustEngine.getAgentScorecard).mockReturnValue({ trust_score: 75 });

    const result = await handleBeforePromptBuild(mockEvent as any, mockCtx as any);

    expect(result).toBeDefined();
    expect(result?.prependContext).toContain('[CURRENT TRUST SCORE: 75/100 (Stage 3)]');
  });

  it('should append CURRENT_FOCUS if it exists', async () => {
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

    const result = await handleBeforePromptBuild(mockEvent as any, mockCtx as any);

    expect(result).toBeDefined();
    expect(result?.prependContext).toContain('Mock Current Focus');
  });

  it('should inject system override if GFI exceeds threshold', async () => {
    const workspaceDir = '/mock/workspace';
    const sessionId = 's1';
    const mockCtx = { workspaceDir, sessionId, trigger: 'user' };
    const mockEvent = { prompt: 'original prompt', messages: [] };

    vi.mocked(sessionTracker.getSession).mockReturnValue({
        currentGfi: 120,
        consecutiveErrors: 3
    } as any);

    const result = await handleBeforePromptBuild(mockEvent as any, mockCtx as any);

    expect(result).toBeDefined();
    expect(result?.prependContext).toContain('[🚨 CRITICAL SYSTEM OVERRIDE 🚨]');
    expect(result?.prependContext).toContain('Friction Index');
    expect(sessionTracker.resetFriction).toHaveBeenCalledWith(sessionId);
  });

  it('should prependSystemContext with THINKING_OS.md if it exists', async () => {
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

    const result = await handleBeforePromptBuild(mockEvent as any, mockCtx as any);

    expect(result).toBeDefined();
    expect(result?.prependSystemContext).toContain('MOCK THINKING OS CONTENT');
    expect(result?.prependSystemContext).toContain('<thinking_os>');
  });

  it('should return undefined if workspaceDir is not provided', async () => {
    const result = await handleBeforePromptBuild({ prompt: '', messages: [] } as any, {} as any);
    expect(result).toBeUndefined();
  });
});
