import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleBeforePromptBuild, resolveModelFromConfig, getDiagnosticianModel } from '../../src/hooks/prompt';
import * as sessionTracker from '../../src/core/session-tracker';
import { WorkspaceContext } from '../../src/core/workspace-context';
import fs from 'fs';
import path from 'path';

vi.mock('fs');
vi.mock('../../src/core/session-tracker.js');
vi.mock('../../src/core/workspace-context.js');

// ═══ Test Group: Model Resolution Functions ═══
describe('resolveModelFromConfig', () => {
  it('parses string format "provider/model"', () => {
    expect(resolveModelFromConfig('openai/gpt-4o')).toBe('openai/gpt-4o');
    expect(resolveModelFromConfig('anthropic/claude-opus-4-5')).toBe('anthropic/claude-opus-4-5');
  });

  it('parses object format { primary, fallbacks }', () => {
    expect(resolveModelFromConfig({ primary: 'anthropic/claude-opus-4-5', fallbacks: ['openai/gpt-4o'] }))
      .toBe('anthropic/claude-opus-4-5');
    expect(resolveModelFromConfig({ primary: 'openai/gpt-4o' }))
      .toBe('openai/gpt-4o');
  });

  it('trims whitespace from model string', () => {
    expect(resolveModelFromConfig('  openai/gpt-4o  ')).toBe('openai/gpt-4o');
    expect(resolveModelFromConfig({ primary: '  anthropic/claude-opus-4-5  ' }))
      .toBe('anthropic/claude-opus-4-5');
  });

  it('returns null for invalid input', () => {
    expect(resolveModelFromConfig(null)).toBeNull();
    expect(resolveModelFromConfig(undefined)).toBeNull();
    expect(resolveModelFromConfig('')).toBeNull();
    expect(resolveModelFromConfig('   ')).toBeNull();
    expect(resolveModelFromConfig({})).toBeNull();
    expect(resolveModelFromConfig({ fallbacks: ['openai/gpt-4o'] })).toBeNull();
    expect(resolveModelFromConfig(123)).toBeNull();
  });
});

describe('getDiagnosticianModel', () => {
  const mockLogger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prefers subagents.model over primary model', () => {
    const api = {
      config: {
        agents: {
          defaults: {
            model: 'openai/gpt-4o',
            subagents: { model: 'anthropic/claude-opus-4-5' }
          }
        }
      }
    };
    
    const result = getDiagnosticianModel(api, mockLogger as any);
    
    expect(result).toBe('anthropic/claude-opus-4-5');
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('subagents.model for diagnostician')
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('anthropic/claude-opus-4-5')
    );
  });

  it('falls back to primary model when subagents.model not set', () => {
    const api = {
      config: {
        agents: {
          defaults: {
            model: 'openai/gpt-4o'
          }
        }
      }
    };
    
    const result = getDiagnosticianModel(api, mockLogger as any);
    
    expect(result).toBe('openai/gpt-4o');
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('primary model for diagnostician')
    );
  });

  it('supports object format for model config', () => {
    const api = {
      config: {
        agents: {
          defaults: {
            model: { primary: 'openai/gpt-4o', fallbacks: ['openai/gpt-4o-mini'] }
          }
        }
      }
    };
    
    const result = getDiagnosticianModel(api, mockLogger as any);
    
    expect(result).toBe('openai/gpt-4o');
  });

  it('throws error when no model configured', () => {
    const api = { config: {} };
    
    expect(() => getDiagnosticianModel(api, mockLogger as any))
      .toThrow('No model configured for diagnostician subagent');
    
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('ERROR: No model configured')
    );
  });

  it('throws error when api is null', () => {
    expect(() => getDiagnosticianModel(null, mockLogger as any))
      .toThrow('No model configured for diagnostician subagent');
    
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('throws error when agents.defaults is empty', () => {
    const api = {
      config: {
        agents: {
          defaults: {}
        }
      }
    };
    
    expect(() => getDiagnosticianModel(api, mockLogger as any))
      .toThrow('No model configured for diagnostician subagent');
  });
});

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
        if (key === 'REFLECTION_LOG') return path.join(workspaceDir, 'memory', 'reflection-log.md');
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

  it('should NOT append CURRENT_FOCUS by default (projectFocus: off)', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p.toString().includes('CURRENT_FOCUS.md'));
    vi.mocked(fs.readFileSync).mockReturnValue('Focus on testing');

    const result = await handleBeforePromptBuild({} as any, { workspaceDir, trigger: 'user' } as any);

    // Default config: projectFocus = 'off', so CURRENT_FOCUS should NOT be injected
    expect(result?.prependContext).not.toContain('project_context');
  });

  it('should append CURRENT_FOCUS when config enables it', async () => {
    // Mock PROFILE.json with projectFocus enabled
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      if (p.toString().includes('PROFILE.json')) return true;
      if (p.toString().includes('CURRENT_FOCUS.md')) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p.toString().includes('PROFILE.json')) {
        return JSON.stringify({ contextInjection: { projectFocus: 'summary' } });
      }
      if (p.toString().includes('CURRENT_FOCUS.md')) {
        return 'Focus on testing';
      }
      return '';
    });

    const result = await handleBeforePromptBuild({} as any, { workspaceDir, trigger: 'user' } as any);

    expect(result?.prependContext).toContain('project_context');
    expect(result?.prependContext).toContain('Focus on testing');
  });

  it('should inject system override if evolution task is in progress', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p.toString().includes('evolution_queue.json'));
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify([
        { id: 't1', task: 'Fix bug', status: 'in_progress' }
    ]));

    const mockApi = {
      config: {
        agents: {
          defaults: {
            model: 'openai/gpt-4o'
          }
        }
      },
      logger: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      }
    };

    const result = await handleBeforePromptBuild({} as any, { 
      workspaceDir, 
      trigger: 'user',
      api: mockApi
    } as any);

    expect(result?.prependContext).toContain('SYSTEM OVERRIDE');
    expect(result?.prependContext).toContain('Fix bug');
    expect(result?.prependContext).toContain('model="openai/gpt-4o"');
    expect(result?.prependContext).toContain('sessions_spawn target="diagnostician"');
  });

  it('should properly escape special characters in task string', async () => {
    // 任务包含特殊字符：反斜杠、双引号、换行符
    const taskWithSpecialChars = 'Fix path C:\\Users\\admin and "quoted text"\nwith newline';
    
    vi.mocked(fs.existsSync).mockImplementation((p) => p.toString().includes('evolution_queue.json'));
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify([
        { id: 't1', task: taskWithSpecialChars, status: 'in_progress' }
    ]));

    const mockApi = {
      config: {
        agents: {
          defaults: {
            model: 'openai/gpt-4o'
          }
        }
      },
      logger: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      }
    };

    const result = await handleBeforePromptBuild({} as any, { 
      workspaceDir, 
      trigger: 'user',
      api: mockApi
    } as any);

    // 验证转义后的字符串
    // 原始: Fix path C:\Users\admin and "quoted text"\nwith newline
    // 转义后: Fix path C:\\Users\\admin and \"quoted text\"\nwith newline
    // 在 prependContext 中会再次转义显示
    expect(result?.prependContext).toContain('C:\\\\Users\\\\admin');  // 反斜杠被转义为双反斜杠
    expect(result?.prependContext).toContain('\\\"quoted text\\\"');   // 双引号被转义
    expect(result?.prependContext).toContain('\\nwith newline');      // 换行符被转义为字面 \n
  });

  it('should NOT inject system override if model config is missing', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p.toString().includes('evolution_queue.json'));
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify([
        { id: 't1', task: 'Fix bug', status: 'in_progress' }
    ]));

    const mockApi = {
      config: {},
      logger: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      }
    };

    const result = await handleBeforePromptBuild({} as any, { 
      workspaceDir, 
      trigger: 'user',
      api: mockApi
    } as any);

    // 修复问题2后：不再 return undefined，而是继续注入其他上下文
    // 但不包含 SYSTEM OVERRIDE
    expect(result).toBeDefined();
    expect(result?.prependContext).not.toContain('SYSTEM OVERRIDE');
    // 仍应包含内部上下文
    expect(result?.prependContext).toContain('<pd:internal_context>');
    expect(result?.prependContext).toContain('CURRENT TRUST SCORE');
    // 错误日志被 console.error 记录
    const consoleSpy = vi.spyOn(console, 'error');
    // 注意：错误是通过 console.error 记录的，不是 mockApi.logger.error
  });

  it('should appendSystemContext with THINKING_OS.md if it exists and enabled', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p.toString().includes('THINKING_OS.md'));
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p.toString().includes('THINKING_OS.md')) return 'Apply First Principles';
      return '';
    });

    const result = await handleBeforePromptBuild({} as any, { workspaceDir, trigger: 'user' } as any);

    // THINKING_OS is now in appendSystemContext (not prependSystemContext)
    expect(result?.appendSystemContext).toContain('<thinking_os>');
    expect(result?.appendSystemContext).toContain('Apply First Principles');
  });

  it('should appendSystemContext with PRINCIPLES.md as highest priority', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p.toString().includes('PRINCIPLES.md'));
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p.toString().includes('PRINCIPLES.md')) return '# Core Principles\n\n1. Principle A\n2. Principle B';
      return '';
    });

    const result = await handleBeforePromptBuild({} as any, { workspaceDir, trigger: 'user' } as any);

    // PRINCIPLES is now in appendSystemContext (not prependSystemContext)
    expect(result?.appendSystemContext).toContain('<core_principles>');
    expect(result?.appendSystemContext).toContain('# Core Principles');
    expect(result?.appendSystemContext).toContain('Principle A');
  });

  it('should handle missing PRINCIPLES.md gracefully', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = await handleBeforePromptBuild({} as any, { workspaceDir, trigger: 'user' } as any);

    expect(result?.appendSystemContext).not.toContain('<core_principles>');
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
    expect(result?.appendSystemContext).not.toContain('<core_principles>');
    
    consoleSpy.mockRestore();
  });

  it('should inject both PRINCIPLES and THINKING_OS in appendSystemContext', async () => {
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

    // Both should be present in appendSystemContext (recency effect)
    expect(result?.appendSystemContext).toContain('<core_principles>');
    expect(result?.appendSystemContext).toContain('Principle 1');
    expect(result?.appendSystemContext).toContain('<thinking_os>');
    expect(result?.appendSystemContext).toContain('Model 1');
    
    // Verify order: PRINCIPLES should come before THINKING_OS
    const principlesIndex = result?.appendSystemContext?.indexOf('<core_principles>') ?? -1;
    const thinkingOsIndex = result?.appendSystemContext?.indexOf('<thinking_os>') ?? -1;
    expect(principlesIndex).toBeLessThan(thinkingOsIndex);
  });

  it('FULL INJECTION: should preserve ALL content with correct separation', async () => {
    // This test catches the "=" vs "+=" bug for ANY future additions
    // 模拟所有文件都存在的真实场景
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      const pathStr = p.toString();
      if (pathStr.includes('PROFILE.json')) return JSON.stringify({ contextInjection: { projectFocus: 'summary' } });
      if (pathStr.includes('PRINCIPLES.md')) return '[PRINCIPLES_CONTENT]';
      if (pathStr.includes('THINKING_OS.md')) return '[THINKING_OS_CONTENT]';
      if (pathStr.includes('evolution_queue.json')) return '[]';
      if (pathStr.includes('CURRENT_FOCUS.md')) return '[FOCUS_CONTENT]';
      return '';
    });

    const result = await handleBeforePromptBuild({} as any, { workspaceDir, trigger: 'user' } as any);

    // prependSystemContext: Agent identity (minimal)
    const identityContext = result?.prependSystemContext ?? '';
    expect(identityContext).toContain('AGENT IDENTITY');
    expect(identityContext).toContain('self-evolving AI agent');
    
    // appendSystemContext: Principles + Thinking OS (recency effect)
    const rulesContext = result?.appendSystemContext ?? '';
    expect(rulesContext).toContain('<core_principles>');
    expect(rulesContext).toContain('[PRINCIPLES_CONTENT]');
    expect(rulesContext).toContain('<thinking_os>');
    expect(rulesContext).toContain('[THINKING_OS_CONTENT]');
    expect(rulesContext).toContain('THESE RULES OVERRIDE');
    
    // prependContext: Dynamic content
    const dynamicContext = result?.prependContext ?? '';
    expect(dynamicContext).toContain('<pd:internal_context>');
    expect(dynamicContext).toContain('CURRENT TRUST SCORE');
    expect(dynamicContext).toContain('project_context');
    expect(dynamicContext).toContain('[FOCUS_CONTENT]');
  });

  // ═══ Test Group 1: isMinimalMode ═══
  describe('isMinimalMode detection', () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
    });

    it('heartbeat trigger → isMinimalMode = true', async () => {
      const result = await handleBeforePromptBuild({} as any, {
        workspaceDir,
        trigger: 'heartbeat',
        sessionId: 'agent:main:123'
      } as any);

      // Minimal mode: should NOT contain project_context
      expect(result?.prependContext).not.toContain('<project_context>');
    });

    it('sessionId 含 :subagent: → isMinimalMode = true', async () => {
      const result = await handleBeforePromptBuild({} as any, {
        workspaceDir,
        trigger: 'user',
        sessionId: 'agent:main:subagent:diagnostician-abc123'
      } as any);

      // Minimal mode: should NOT contain project_context
      expect(result?.prependContext).not.toContain('<project_context>');
    });

    it('主会话 sessionId → isMinimalMode = false', async () => {
      // Enable projectFocus via PROFILE.json
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (p.toString().includes('PROFILE.json')) return true;
        if (p.toString().includes('CURRENT_FOCUS.md')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p.toString().includes('PROFILE.json')) {
          return JSON.stringify({ contextInjection: { projectFocus: 'summary' } });
        }
        if (p.toString().includes('CURRENT_FOCUS.md')) return 'Test focus';
        return '';
      });

      const resultWithFile = await handleBeforePromptBuild({} as any, {
        workspaceDir,
        trigger: 'user',
        sessionId: 'agent:main:12345'
      } as any);

      expect(resultWithFile?.prependContext).toContain('<project_context>');
    });

    it('sessionId undefined → isMinimalMode = false', async () => {
      // Enable projectFocus via PROFILE.json
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (p.toString().includes('PROFILE.json')) return true;
        if (p.toString().includes('CURRENT_FOCUS.md')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p.toString().includes('PROFILE.json')) {
          return JSON.stringify({ contextInjection: { projectFocus: 'summary' } });
        }
        if (p.toString().includes('CURRENT_FOCUS.md')) return 'Test focus';
        return '';
      });

      const result = await handleBeforePromptBuild({} as any, {
        workspaceDir,
        trigger: 'user',
        sessionId: undefined
      } as any);

      // Normal mode: should contain project_context
      expect(result?.prependContext).toContain('<project_context>');
    });

    // Task: Additional isMinimalMode test cases
    it('heartbeat=true, subagent sessionId → isMinimalMode = true', async () => {
      const result = await handleBeforePromptBuild({} as any, {
        workspaceDir,
        trigger: 'heartbeat',
        sessionId: 'agent:main:subagent:diagnostician-xyz'
      } as any);

      // Minimal mode: should NOT contain project_context
      expect(result?.prependContext).not.toContain('<project_context>');
    });

    it('main session (no :subagent:) with trigger=user → isMinimalMode = false', async () => {
      // Enable projectFocus via PROFILE.json
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (p.toString().includes('PROFILE.json')) return true;
        if (p.toString().includes('CURRENT_FOCUS.md')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p.toString().includes('PROFILE.json')) {
          return JSON.stringify({ contextInjection: { projectFocus: 'summary' } });
        }
        if (p.toString().includes('CURRENT_FOCUS.md')) return 'Main session focus';
        return '';
      });

      const result = await handleBeforePromptBuild({} as any, {
        workspaceDir,
        trigger: 'user',
        sessionId: 'agent:main:session-001'
      } as any);

      // Normal mode: should contain project_context
      expect(result?.prependContext).toContain('<project_context>');
      expect(result?.prependContext).toContain('Main session focus');
    });
  });

  // ═══ Test Group 2: Minimal Mode 注入行为 ═══
  describe('Minimal Mode injection behavior', () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
    });

    it('minimal mode: 不含 <project_context>', async () => {
      // Trigger minimal mode via heartbeat
      const result = await handleBeforePromptBuild({} as any, { 
        workspaceDir, 
        trigger: 'heartbeat',
        sessionId: 'agent:main:123'
      } as any);

      expect(result?.prependContext).not.toContain('<project_context>');
    });

    it('minimal mode: 仍含 <pd:internal_context>', async () => {
      // Minimal mode should still include internal context with trust info
      const result = await handleBeforePromptBuild({} as any, { 
        workspaceDir, 
        trigger: 'heartbeat',
        sessionId: 'agent:main:123'
      } as any);

      expect(result?.prependContext).toContain('<pd:internal_context>');
      expect(result?.prependContext).toContain('CURRENT TRUST SCORE');
    });
  });

  // ═══ Test Group 3: Size Guard ═══
  describe('Size Guard', () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
    });

    it('超过 10000 字符 → 触发截断', async () => {
      // Create content large enough to exceed 10000 chars total
      // Each line ~150 chars * 80 lines = ~12000 chars to exceed MAX_SIZE
      const largeContent = Array.from({ length: 80 }, (_, i) => 
        `Line ${i + 1}: This is a long line of content with enough data to exceed the 10000 character limit for testing size guard functionality`
      ).join('\n');

      // Enable projectFocus and mock CURRENT_FOCUS.md
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (p.toString().includes('PROFILE.json')) return true;
        if (p.toString().includes('CURRENT_FOCUS.md')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p.toString().includes('PROFILE.json')) {
          return JSON.stringify({ contextInjection: { projectFocus: 'full' } });
        }
        if (p.toString().includes('CURRENT_FOCUS.md')) {
          return largeContent;
        }
        return '';
      });

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await handleBeforePromptBuild({} as any, { 
        workspaceDir, 
        trigger: 'user',
        sessionId: 'agent:main:123'
      } as any);

      // Should contain truncation marker
      expect(result?.prependContext).toContain('[truncated]');
      expect(result?.prependContext).toContain('...[truncated]');

      consoleSpy.mockRestore();
    });

    it('未超限 → 不截断', async () => {
      // Small content that won't trigger truncation
      const smallContent = 'Small focus content';

      // Enable projectFocus and mock CURRENT_FOCUS.md
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (p.toString().includes('PROFILE.json')) return true;
        if (p.toString().includes('CURRENT_FOCUS.md')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p.toString().includes('PROFILE.json')) {
          return JSON.stringify({ contextInjection: { projectFocus: 'summary' } });
        }
        if (p.toString().includes('CURRENT_FOCUS.md')) {
          return smallContent;
        }
        return '';
      });

      const result = await handleBeforePromptBuild({} as any, { 
        workspaceDir, 
        trigger: 'user',
        sessionId: 'agent:main:123'
      } as any);

      // Should NOT contain truncation marker
      expect(result?.prependContext).not.toContain('[truncated]');
      expect(result?.prependContext).toContain('Small focus content');
    });

    it('截断保留前 20 行 + [truncated]', async () => {
      // Create 80 lines with ~200 chars each for project_context
      const longLines = Array.from({ length: 80 }, (_, i) =>
        `Line ${i + 1}: This is a very long line of content with lots of text to ensure we exceed the 10000 character limit for proper truncation testing - extra padding here`
      ).join('\n');

      // Create large PRINCIPLES content to help exceed MAX_SIZE
      const largePrinciples = Array.from({ length: 30 }, (_, i) =>
        `Principle ${i + 1}: This is a very long principle description that adds to the total character count to ensure we exceed the limit for proper truncation testing purposes - additional padding here`
      ).join('\n');

      // Enable projectFocus in FULL mode (not summary) so size guard can truncate
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (p.toString().includes('PROFILE.json')) return true;
        if (p.toString().includes('CURRENT_FOCUS.md')) return true;
        if (p.toString().includes('PRINCIPLES.md')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p.toString().includes('PROFILE.json')) {
          return JSON.stringify({ contextInjection: { projectFocus: 'full' } });
        }
        if (p.toString().includes('CURRENT_FOCUS.md')) {
          return longLines;
        }
        if (p.toString().includes('PRINCIPLES.md')) {
          return largePrinciples;
        }
        return '';
      });

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await handleBeforePromptBuild({} as any, {
        workspaceDir,
        trigger: 'user',
        sessionId: 'agent:main:123'
      } as any);

      consoleSpy.mockRestore();

      // Size guard truncates <project_context> block to 20 lines when total exceeds MAX_SIZE
      expect(result?.prependContext).toContain('[truncated]');
    });

    it('< 20 行不截断', async () => {
      // Create 15 lines of content - should NOT trigger truncation
      const fifteenLines = Array.from({ length: 15 }, (_, i) =>
        `Line ${i + 1}: This is content line number ${i + 1} for testing no truncation when under 20 lines`
      ).join('\n');

      // Enable projectFocus and mock CURRENT_FOCUS.md
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (p.toString().includes('PROFILE.json')) return true;
        if (p.toString().includes('CURRENT_FOCUS.md')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p.toString().includes('PROFILE.json')) {
          return JSON.stringify({ contextInjection: { projectFocus: 'summary' } });
        }
        if (p.toString().includes('CURRENT_FOCUS.md')) {
          return fifteenLines;
        }
        return '';
      });

      const result = await handleBeforePromptBuild({} as any, {
        workspaceDir,
        trigger: 'user',
        sessionId: 'agent:main:123'
      } as any);

      // Should NOT contain truncation marker
      expect(result?.prependContext).not.toContain('[truncated]');
      // Should contain all lines including line 15
      expect(result?.prependContext).toContain('Line 15');
    });
  });

  // ═══ Test Group 4: ContextInjectionConfig 配置测试 ═══
  describe('ContextInjectionConfig settings', () => {
    it('thinkingOs: false → 不注入 THINKING_OS', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (p.toString().includes('PROFILE.json')) return true;
        if (p.toString().includes('THINKING_OS.md')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p.toString().includes('PROFILE.json')) {
          return JSON.stringify({ contextInjection: { thinkingOs: false } });
        }
        if (p.toString().includes('THINKING_OS.md')) {
          return 'Thinking OS Content';
        }
        return '';
      });

      const result = await handleBeforePromptBuild({} as any, {
        workspaceDir,
        trigger: 'user',
        sessionId: 'agent:main:123'
      } as any);

      // thinkingOs: false, so THINKING_OS should NOT be injected
      expect(result?.appendSystemContext).not.toContain('<thinking_os>');
      expect(result?.appendSystemContext).not.toContain('Thinking OS Content');
    });

    it('thinkingOs: true → 注入 THINKING_OS', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (p.toString().includes('PROFILE.json')) return true;
        if (p.toString().includes('THINKING_OS.md')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p.toString().includes('PROFILE.json')) {
          return JSON.stringify({ contextInjection: { thinkingOs: true } });
        }
        if (p.toString().includes('THINKING_OS.md')) {
          return 'Thinking OS Content';
        }
        return '';
      });

      const result = await handleBeforePromptBuild({} as any, {
        workspaceDir,
        trigger: 'user',
        sessionId: 'agent:main:123'
      } as any);

      // thinkingOs: true, so THINKING_OS should be injected
      expect(result?.appendSystemContext).toContain('<thinking_os>');
      expect(result?.appendSystemContext).toContain('Thinking OS Content');
    });

    it('trustScore: false → 不注入信任分数', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (p.toString().includes('PROFILE.json')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p.toString().includes('PROFILE.json')) {
          return JSON.stringify({ contextInjection: { trustScore: false } });
        }
        return '';
      });

      const result = await handleBeforePromptBuild({} as any, {
        workspaceDir,
        trigger: 'user',
        sessionId: 'agent:main:123'
      } as any);

      // trustScore: false, so internal_context should NOT be injected
      expect(result?.prependContext).not.toContain('<pd:internal_context>');
      expect(result?.prependContext).not.toContain('CURRENT TRUST SCORE');
    });

    it('trustScore: true → 注入信任分数', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (p.toString().includes('PROFILE.json')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p.toString().includes('PROFILE.json')) {
          return JSON.stringify({ contextInjection: { trustScore: true } });
        }
        return '';
      });

      const result = await handleBeforePromptBuild({} as any, {
        workspaceDir,
        trigger: 'user',
        sessionId: 'agent:main:123'
      } as any);

      // trustScore: true, so internal_context should be injected
      expect(result?.prependContext).toContain('<pd:internal_context>');
      expect(result?.prependContext).toContain('CURRENT TRUST SCORE');
    });

    it('reflectionLog: false → 不注入反思日志', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (p.toString().includes('PROFILE.json')) return true;
        if (p.toString().includes('reflection-log.md')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p.toString().includes('PROFILE.json')) {
          return JSON.stringify({ contextInjection: { reflectionLog: false } });
        }
        if (p.toString().includes('reflection-log.md')) {
          return 'Reflection Log Content';
        }
        return '';
      });

      const result = await handleBeforePromptBuild({} as any, {
        workspaceDir,
        trigger: 'user',
        sessionId: 'agent:main:123'
      } as any);

      // reflectionLog: false, so reflection_log should NOT be injected
      expect(result?.prependContext).not.toContain('<reflection_log>');
      expect(result?.prependContext).not.toContain('Reflection Log Content');
    });

    it('reflectionLog: true → 注入反思日志', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (p.toString().includes('PROFILE.json')) return true;
        if (p.toString().includes('reflection-log.md')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p.toString().includes('PROFILE.json')) {
          return JSON.stringify({ contextInjection: { reflectionLog: true } });
        }
        if (p.toString().includes('reflection-log.md')) {
          return 'Reflection Log Content';
        }
        return '';
      });

      const result = await handleBeforePromptBuild({} as any, {
        workspaceDir,
        trigger: 'user',
        sessionId: 'agent:main:123'
      } as any);

      // reflectionLog: true, so reflection_log should be injected
      expect(result?.prependContext).toContain('<reflection_log>');
      expect(result?.prependContext).toContain('Reflection Log Content');
    });

    it('多项配置同时生效: thinkingOs=false, trustScore=false, reflectionLog=false', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (p.toString().includes('PROFILE.json')) return true;
        if (p.toString().includes('THINKING_OS.md')) return true;
        if (p.toString().includes('reflection-log.md')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p.toString().includes('PROFILE.json')) {
          return JSON.stringify({ 
            contextInjection: { 
              thinkingOs: false, 
              trustScore: false, 
              reflectionLog: false 
            } 
          });
        }
        if (p.toString().includes('THINKING_OS.md')) return 'Thinking OS';
        if (p.toString().includes('reflection-log.md')) return 'Reflection';
        return '';
      });

      const result = await handleBeforePromptBuild({} as any, {
        workspaceDir,
        trigger: 'user',
        sessionId: 'agent:main:123'
      } as any);

      // All disabled
      expect(result?.appendSystemContext).not.toContain('<thinking_os>');
      expect(result?.prependContext).not.toContain('<pd:internal_context>');
      expect(result?.prependContext).not.toContain('<reflection_log>');
    });
  });
});
