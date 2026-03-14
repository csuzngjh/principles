import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleBeforePromptBuild } from '../../src/hooks/prompt';
import * as sessionTracker from '../../src/core/session-tracker';
import { WorkspaceContext } from '../../src/core/workspace-context';
import fs from 'fs';
import path from 'path';

vi.mock('fs');
vi.mock('../../src/core/session-tracker.js');
vi.mock('../../src/core/workspace-context.js');

describe('Prompt Context Injection Hook', () => {
  const workspaceDir = '/mock/workspace';
  
  const mockTrust = {
    getScorecard: vi.fn().mockReturnValue({ trust_score: 85 }),
    getScore: vi.fn().mockReturnValue(85),
    getStage: vi.fn().mockReturnValue(4),
  };

  const mockHygiene = {
    getStats: vi.fn().mockReturnValue({ writes: 0, streak: 0, lastWrite: null }),
    recordWrite: vi.fn(),
    resetIfNeeded: vi.fn(),
  };

  const mockConfig = {
    get: vi.fn(),
  };

  const mockWctx = {
    workspaceDir,
    stateDir: '/mock/state',
    trust: mockTrust,
    hygiene: mockHygiene,
    config: mockConfig,
    resolve: vi.fn().mockImplementation((key) => {
        if (key === 'CURRENT_FOCUS') return path.join(workspaceDir, 'memory', 'okr', 'CURRENT_FOCUS.md');
        if (key === 'PAIN_FLAG') return path.join(workspaceDir, '.state', '.pain_flag');
        if (key === 'SYSTEM_CAPABILITIES') return path.join(workspaceDir, '.state', 'SYSTEM_CAPABILITIES.json');
        if (key === 'THINKING_OS') return path.join(workspaceDir, '.principles', 'THINKING_OS.md');
        if (key === 'HEARTBEAT') return path.join(workspaceDir, 'HEARTBEAT.md');
        if (key === 'EVOLUTION_QUEUE') return path.join(workspaceDir, '.state', 'evolution_queue.json');
        if (key === 'PRINCIPLES') return path.join(workspaceDir, '.principles', 'PRINCIPLES.md');
        return '';
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sessionTracker.getSession).mockReturnValue(undefined);
    vi.mocked(WorkspaceContext.fromHookContext).mockReturnValue(mockWctx as any);
  });

  it('should return undefined if workspaceDir is not provided', async () => {
    const result = await handleBeforePromptBuild({} as any, { trigger: 'user' } as any);
    expect(result).toBeUndefined();
  });

  it('should inject current trust score and stage in internal_context', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    
    const result = await handleBeforePromptBuild({} as any, { workspaceDir, trigger: 'user' } as any);
    
    expect(result).toBeDefined();
    // Task 1.1: trustScore 移到 prependContext 的 <internal_context> 中
    expect(result?.prependContext).toContain('<pd:internal_context>');
    expect(result?.prependContext).toContain('CURRENT TRUST SCORE: 85/100');
    expect(result?.prependContext).toContain('Stage 4');
  });

  it('should append CURRENT_FOCUS if it exists', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p.toString().includes('CURRENT_FOCUS.md'));
    vi.mocked(fs.readFileSync).mockReturnValue('Focus on testing');

    const result = await handleBeforePromptBuild({} as any, { workspaceDir, trigger: 'user' } as any);

    expect(result?.prependContext).toContain('Strategic Focus');
    expect(result?.prependContext).toContain('Focus on testing');
  });

  it('should inject system override if evolution task is in progress', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p.toString().includes('evolution_queue.json'));
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify([
        { id: 't1', task: 'Fix bug', status: 'in_progress' }
    ]));

    const result = await handleBeforePromptBuild({} as any, { workspaceDir, trigger: 'user' } as any);

    expect(result?.prependContext).toContain('SYSTEM OVERRIDE');
    expect(result?.prependContext).toContain('Fix bug');
  });

  it('should prependSystemContext with THINKING_OS.md if it exists', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p.toString().includes('THINKING_OS.md'));
    vi.mocked(fs.readFileSync).mockReturnValue('Apply First Principles');

    const result = await handleBeforePromptBuild({} as any, { workspaceDir, trigger: 'user' } as any);

    expect(result?.prependSystemContext).toContain('<thinking_os>');
    expect(result?.prependSystemContext).toContain('Apply First Principles');
  });

  it('should prependSystemContext with PRINCIPLES.md as highest priority', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p.toString().includes('PRINCIPLES.md'));
    vi.mocked(fs.readFileSync).mockReturnValue('# Core Principles\n\n1. Principle A\n2. Principle B');

    const result = await handleBeforePromptBuild({} as any, { workspaceDir, trigger: 'user' } as any);

    expect(result?.prependSystemContext).toContain('<core_principles>');
    expect(result?.prependSystemContext).toContain('# Core Principles');
    expect(result?.prependSystemContext).toContain('Principle A');
  });

  it('should handle missing PRINCIPLES.md gracefully', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = await handleBeforePromptBuild({} as any, { workspaceDir, trigger: 'user' } as any);

    expect(result?.prependSystemContext).not.toContain('<core_principles>');
    // Task 1.1: trust score 现在在 prependContext 的 <pd:internal_context> 中
    expect(result?.prependContext).toContain('CURRENT TRUST SCORE');
  });

  it('should handle PRINCIPLES.md read error gracefully', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p.toString().includes('PRINCIPLES.md'));
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('Read error');
    });
    
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await handleBeforePromptBuild({} as any, { workspaceDir, trigger: 'user' } as any);

    expect(result).toBeDefined();
    expect(result?.prependSystemContext).not.toContain('<core_principles>');
    
    consoleSpy.mockRestore();
  });

  it('should inject both PRINCIPLES and THINKING_OS without overwriting', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => 
      p.toString().includes('PRINCIPLES.md') || p.toString().includes('THINKING_OS.md')
    );
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p.toString().includes('PRINCIPLES.md')) {
        return '# Core Principles\n\nPrinciple 1';
      }
      if (p.toString().includes('THINKING_OS.md')) {
        return '# Thinking OS\n\nModel 1';
      }
      return '';
    });

    const result = await handleBeforePromptBuild({} as any, { workspaceDir, trigger: 'user' } as any);

    // Both should be present - THINKING_OS should NOT overwrite PRINCIPLES
    expect(result?.prependSystemContext).toContain('<core_principles>');
    expect(result?.prependSystemContext).toContain('Principle 1');
    expect(result?.prependSystemContext).toContain('<thinking_os>');
    expect(result?.prependSystemContext).toContain('Model 1');
    
    // Verify order: PRINCIPLES should come before THINKING_OS
    const principlesIndex = result?.prependSystemContext?.indexOf('<core_principles>') ?? -1;
    const thinkingOsIndex = result?.prependSystemContext?.indexOf('<thinking_os>') ?? -1;
    expect(principlesIndex).toBeLessThan(thinkingOsIndex);
  });

  it('FULL INJECTION: should preserve ALL content with correct separation', async () => {
    // This test catches the "=" vs "+=" bug for ANY future additions
    // 模拟所有文件都存在的真实场景
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      const pathStr = p.toString();
      if (pathStr.includes('PRINCIPLES.md')) return '[PRINCIPLES_CONTENT]';
      if (pathStr.includes('THINKING_OS.md')) return '[THINKING_OS_CONTENT]';
      if (pathStr.includes('evolution_queue.json')) return '[]';
      if (pathStr.includes('SYSTEM_CAPABILITIES.json')) return '{}';
      return '';
    });

    const result = await handleBeforePromptBuild({} as any, { workspaceDir, trigger: 'user' } as any);

    // Task 1.1: prependSystemContext 只包含静态内容（用于 provider 缓存优化）
    const staticContext = result?.prependSystemContext ?? '';
    expect(staticContext).toContain('<core_principles>');
    expect(staticContext).toContain('[PRINCIPLES_CONTENT]');
    expect(staticContext).toContain('<thinking_os>');
    expect(staticContext).toContain('[THINKING_OS_CONTENT]');
    // 静态上下文不应包含动态内容
    expect(staticContext).not.toContain('CURRENT TRUST SCORE');
    
    // 验证静态内容顺序正确
    const staticOrder = [
      staticContext.indexOf('<core_principles>'),
      staticContext.indexOf('<thinking_os>'),
    ];
    expect(staticOrder).toEqual([...staticOrder].sort((a, b) => a - b));
    
    // Task 1.1: 动态内容在 prependContext 的 <pd:internal_context> 中
    const dynamicContext = result?.prependContext ?? '';
    expect(dynamicContext).toContain('<pd:internal_context>');
    expect(dynamicContext).toContain('CURRENT TRUST SCORE');
    
    // <pd:internal_context> 应该在 prependContext 开头
    expect(dynamicContext.indexOf('<pd:internal_context>')).toBe(1); // 索引 1 因为开头是 \n
  });
});
