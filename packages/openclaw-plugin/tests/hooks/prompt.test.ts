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

  it('should inject current trust score and stage in runtime_state', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    
    const result = await handleBeforePromptBuild({} as any, { workspaceDir, trigger: 'user' } as any);
    
    expect(result).toBeDefined();
    // trustScore stays in prependContext's <runtime_state>
    expect(result?.prependContext).toContain('<system_override:runtime_constraints>');
    expect(result?.prependContext).toContain('Trust Score: 85/100');
    expect(result?.prependContext).toContain('Stage 4');  });

  // ═══════════════════════════════════════════════════════════════════
  // IMPORTANT: project_context and reflection_log are now in appendSystemContext
  // This fixes WebUI UX issue (Issue #23) and enables Prompt Caching
  // ═══════════════════════════════════════════════════════════════════

  it('should NOT inject project_context by default (projectFocus: off)', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p.toString().includes('CURRENT_FOCUS.md'));
    vi.mocked(fs.readFileSync).mockReturnValue('Focus on testing');

    const result = await handleBeforePromptBuild({} as any, { workspaceDir, trigger: 'user' } as any);

    // Default config: projectFocus = 'off', so CURRENT_FOCUS should NOT be injected
    expect(result?.appendSystemContext).not.toContain('project_context');
  });

  it('should inject project_context in appendSystemContext when config enables it', async () => {
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

    // project_context is now in appendSystemContext (WebUI-hidden, Prompt Cacheable)
    expect(result?.appendSystemContext).toContain('project_context');
    expect(result?.appendSystemContext).toContain('Focus on testing');
    // Should NOT be in prependContext (which WebUI displays)
    expect(result?.prependContext).not.toContain('project_context');
  });

  it('should inject evolution_task if evolution task is in progress', async () => {
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

    // evolutionDirective stays in prependContext (short dynamic directive)
    expect(result?.prependContext).toContain('<evolution_task');
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
    expect(result?.prependContext).toContain('C:\\\\Users\\\\admin');
    expect(result?.prependContext).toContain('\\"quoted text\\"');
    expect(result?.prependContext).toContain('\\nwith newline');
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

    expect(result).toBeDefined();
    expect(result?.prependContext).not.toContain('<evolution_task');
    expect(result?.prependContext).toContain('<system_override:runtime_constraints>');
    expect(result?.prependContext).toContain('Trust Score:');
  });

  it('should appendSystemContext with THINKING_OS.md if it exists and enabled', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p.toString().includes('THINKING_OS.md'));
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p.toString().includes('THINKING_OS.md')) return 'Apply First Principles';
      return '';
    });

    const result = await handleBeforePromptBuild({} as any, { workspaceDir, trigger: 'user' } as any);

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

    expect(result?.appendSystemContext).toContain('<core_principles>');
    expect(result?.appendSystemContext).toContain('# Core Principles');
    expect(result?.appendSystemContext).toContain('Principle A');
  });

  it('should handle missing PRINCIPLES.md gracefully', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = await handleBeforePromptBuild({} as any, { workspaceDir, trigger: 'user' } as any);

    expect(result?.appendSystemContext).not.toContain('<core_principles>');
    // Trust score is now in prependContext's <runtime_state>
    expect(result?.prependContext).toContain('Trust Score:');
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

  it('should inject PRINCIPLES, THINKING_OS, project_context, reflection_log in appendSystemContext', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => 
      p.toString().includes('PRINCIPLES.md') || 
      p.toString().includes('THINKING_OS.md') ||
      p.toString().includes('CURRENT_FOCUS.md') ||
      p.toString().includes('reflection-log.md') ||
      p.toString().includes('PROFILE.json')
    );
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p.toString().includes('PROFILE.json')) {
        return JSON.stringify({ contextInjection: { projectFocus: 'summary', reflectionLog: true } });
      }
      if (p.toString().includes('PRINCIPLES.md')) {
        return '# Core Principles\n\nPrinciple 1';
      }
      if (p.toString().includes('THINKING_OS.md')) {
        return '# Thinking OS\n\nModel 1';
      }
      if (p.toString().includes('CURRENT_FOCUS.md')) {
        return '# Current Focus\n\nTask 1';
      }
      if (p.toString().includes('reflection-log.md')) {
        return '# Reflection Log\n\nDay 1';
      }
      return '';
    });

    const result = await handleBeforePromptBuild({} as any, { workspaceDir, trigger: 'user' } as any);

    // All should be in appendSystemContext (WebUI-hidden, Prompt Cacheable)
    expect(result?.appendSystemContext).toContain('<core_principles>');
    expect(result?.appendSystemContext).toContain('Principle 1');
    expect(result?.appendSystemContext).toContain('<thinking_os>');
    expect(result?.appendSystemContext).toContain('Model 1');
    expect(result?.appendSystemContext).toContain('<project_context>');
    expect(result?.appendSystemContext).toContain('Task 1');
    expect(result?.appendSystemContext).toContain('<reflection_log>');
    expect(result?.appendSystemContext).toContain('Day 1');
    
    // Content order: project_context -> reflection_log -> thinking_os -> principles (recency effect)
    const projectIndex = result?.appendSystemContext?.indexOf('<project_context>') ?? -1;
    const reflectionIndex = result?.appendSystemContext?.indexOf('<reflection_log>') ?? -1;
    const thinkingOsIndex = result?.appendSystemContext?.indexOf('<thinking_os>') ?? -1;
    const principlesIndex = result?.appendSystemContext?.indexOf('<core_principles>') ?? -1;
    
    // Verify order: project_context first, principles last (for recency effect)
    expect(projectIndex).toBeLessThan(reflectionIndex);
    expect(reflectionIndex).toBeLessThan(thinkingOsIndex);
    expect(thinkingOsIndex).toBeLessThan(principlesIndex);
  });

  it('FULL INJECTION: should preserve ALL content with correct separation', async () => {
    // This test catches the "=" vs "+=" bug for ANY future additions
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      const pathStr = p.toString();
      if (pathStr.includes('PROFILE.json')) return JSON.stringify({ contextInjection: { projectFocus: 'summary', reflectionLog: true } });
      if (pathStr.includes('PRINCIPLES.md')) return '[PRINCIPLES_CONTENT]';
      if (pathStr.includes('THINKING_OS.md')) return '[THINKING_OS_CONTENT]';
      if (pathStr.includes('evolution_queue.json')) return '[]';
      if (pathStr.includes('CURRENT_FOCUS.md')) return '[FOCUS_CONTENT]';
      if (pathStr.includes('reflection-log.md')) return '[REFLECTION_CONTENT]';
      return '';
    });

    const result = await handleBeforePromptBuild({} as any, { workspaceDir, trigger: 'user' } as any);

    // prependSystemContext: Agent identity (minimal)
    const identityContext = result?.prependSystemContext ?? '';
    expect(identityContext).toContain('AGENT IDENTITY');
    expect(identityContext).toContain('self-evolving AI agent');
    
    // appendSystemContext: All long context (WebUI-hidden, Prompt Cacheable)
    const rulesContext = result?.appendSystemContext ?? '';
    expect(rulesContext).toContain('<project_context>');
    expect(rulesContext).toContain('[FOCUS_CONTENT]');
    expect(rulesContext).toContain('<reflection_log>');
    expect(rulesContext).toContain('[REFLECTION_CONTENT]');
    expect(rulesContext).toContain('<thinking_os>');
    expect(rulesContext).toContain('[THINKING_OS_CONTENT]');
    expect(rulesContext).toContain('<core_principles>');
    expect(rulesContext).toContain('[PRINCIPLES_CONTENT]');
    expect(rulesContext).toContain('EXECUTION RULES');
    
    // prependContext: Only short dynamic directives
    const dynamicContext = result?.prependContext ?? '';
    expect(dynamicContext).toContain('<system_override:runtime_constraints>');
    expect(dynamicContext).toContain('Trust Score:');
    // project_context and reflection_log should NOT be in prependContext
    expect(dynamicContext).not.toContain('<project_context>');
    expect(dynamicContext).not.toContain('<reflection_log>');
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
      expect(result?.appendSystemContext).not.toContain('<project_context>');
    });

    it('sessionId 含 :subagent: → isMinimalMode = true', async () => {
      const result = await handleBeforePromptBuild({} as any, {
        workspaceDir,
        trigger: 'user',
        sessionId: 'agent:main:subagent:diagnostician-abc123'
      } as any);

      // Minimal mode: should NOT contain project_context
      expect(result?.appendSystemContext).not.toContain('<project_context>');
    });

    it('主会话 sessionId → isMinimalMode = false', async () => {
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

      expect(resultWithFile?.appendSystemContext).toContain('<project_context>');
    });

    it('sessionId undefined → isMinimalMode = false', async () => {
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

      expect(result?.appendSystemContext).toContain('<project_context>');
    });

    it('heartbeat=true, subagent sessionId → isMinimalMode = true', async () => {
      const result = await handleBeforePromptBuild({} as any, {
        workspaceDir,
        trigger: 'heartbeat',
        sessionId: 'agent:main:subagent:diagnostician-xyz'
      } as any);

      expect(result?.appendSystemContext).not.toContain('<project_context>');
    });

    it('main session (no :subagent:) with trigger=user → isMinimalMode = false', async () => {
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

      expect(result?.appendSystemContext).toContain('<project_context>');
      expect(result?.appendSystemContext).toContain('Main session focus');
    });
  });

  // ═══ Test Group 2: Minimal Mode 注入行为 ═══
  describe('Minimal Mode injection behavior', () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
    });

    it('minimal mode: 不含 <project_context> in appendSystemContext', async () => {
      const result = await handleBeforePromptBuild({} as any, { 
        workspaceDir, 
        trigger: 'heartbeat',
        sessionId: 'agent:main:123'
      } as any);

      expect(result?.appendSystemContext).not.toContain('<project_context>');
    });

    it('minimal mode: 仍含 <runtime_state>', async () => {
      const result = await handleBeforePromptBuild({} as any, {
        workspaceDir,
        trigger: 'heartbeat',
        sessionId: 'agent:main:123'
      } as any);

      expect(result?.prependContext).toContain('<system_override:runtime_constraints>');
      expect(result?.prependContext).toContain('Trust Score:');
    });
  });

  // ═══ Test Group 3: Size Guard ═══
  describe('Size Guard', () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
    });

    it('超过 10000 字符 → 触发截断 in appendSystemContext', async () => {
      const largeContent = Array.from({ length: 80 }, (_, i) => 
        `Line ${i + 1}: This is a long line of content with enough data to exceed the 10000 character limit for testing size guard functionality`
      ).join('\n');

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

      // Size guard truncates in appendSystemContext now
      expect(result?.appendSystemContext).toContain('[truncated]');
      expect(result?.appendSystemContext).toContain('...[truncated]');

      consoleSpy.mockRestore();
    });

    it('未超限 → 不截断', async () => {
      const smallContent = 'Small focus content';

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

      expect(result?.appendSystemContext).not.toContain('[truncated]');
      expect(result?.appendSystemContext).toContain('Small focus content');
    });

    it('截断保留前 20 行 + [truncated] in appendSystemContext', async () => {
      const longLines = Array.from({ length: 80 }, (_, i) =>
        `Line ${i + 1}: This is a very long line of content with lots of text to ensure we exceed the 10000 character limit for proper truncation testing - extra padding here`
      ).join('\n');

      const largePrinciples = Array.from({ length: 30 }, (_, i) =>
        `Principle ${i + 1}: This is a very long principle description that adds to the total character count to ensure we exceed the limit for proper truncation testing purposes - additional padding here`
      ).join('\n');

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

      // Size guard truncates <project_context> block in appendSystemContext
      expect(result?.appendSystemContext).toContain('[truncated]');
    });

    it('< 20 行不截断', async () => {
      const fifteenLines = Array.from({ length: 15 }, (_, i) =>
        `Line ${i + 1}: This is content line number ${i + 1} for testing no truncation when under 20 lines`
      ).join('\n');

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

      expect(result?.appendSystemContext).not.toContain('[truncated]');
      expect(result?.appendSystemContext).toContain('Line 15');
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

      expect(result?.prependContext).not.toContain('<runtime_state>');
      expect(result?.prependContext).not.toContain('Trust:');
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

      expect(result?.prependContext).toContain('<system_override:runtime_constraints>');
      expect(result?.prependContext).toContain('Trust Score:');
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

      // reflection_log is now in appendSystemContext
      expect(result?.appendSystemContext).not.toContain('<reflection_log>');
      expect(result?.appendSystemContext).not.toContain('Reflection Log Content');
    });

    it('reflectionLog: true → 注入反思日志 in appendSystemContext', async () => {
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

      // reflection_log is now in appendSystemContext (WebUI-hidden, Prompt Cacheable)
      expect(result?.appendSystemContext).toContain('<reflection_log>');
      expect(result?.appendSystemContext).toContain('Reflection Log Content');
      // Should NOT be in prependContext
      expect(result?.prependContext).not.toContain('<reflection_log>');
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
      expect(result?.prependContext).not.toContain('<runtime_state>');
      expect(result?.appendSystemContext).not.toContain('<reflection_log>');
    });

    it('projectFocus: off → 不注入 project_context', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (p.toString().includes('PROFILE.json')) return true;
        if (p.toString().includes('CURRENT_FOCUS.md')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p.toString().includes('PROFILE.json')) {
          return JSON.stringify({ contextInjection: { projectFocus: 'off' } });
        }
        if (p.toString().includes('CURRENT_FOCUS.md')) {
          return 'Focus Content';
        }
        return '';
      });

      const result = await handleBeforePromptBuild({} as any, {
        workspaceDir,
        trigger: 'user',
        sessionId: 'agent:main:123'
      } as any);

      expect(result?.appendSystemContext).not.toContain('<project_context>');
      expect(result?.appendSystemContext).not.toContain('Focus Content');
    });

    it('projectFocus: summary → 注入智能摘要 project_context in appendSystemContext', async () => {
      // 使用结构化的 CURRENT_FOCUS 内容
      const structuredContent = `# 🎯 CURRENT_FOCUS

> **版本**: v1 | **状态**: EXECUTING | **更新**: 2026-03-16

---

## 📍 状态快照

| 维度 | 值 |
|------|-----|
| 当前阶段 | Phase 2 |
| 信任分数 | 85/100 |

---

## 🔄 当前任务

### P0（阻塞/紧急）
- [ ] 无

### P1（进行中）
- [x] 任务A
- [ ] 任务B ← 当前

---

## ➡️ 下一步

1. 完成任务B
2. 开始任务C

---

## 📎 参考

详细计划: memory/tasks/PLAN.md`;

      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (p.toString().includes('PROFILE.json')) return true;
        if (p.toString().includes('CURRENT_FOCUS.md')) return true;
        if (p.toString().includes('.history')) return false; // 无历史版本
        return false;
      });
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p.toString().includes('PROFILE.json')) {
          return JSON.stringify({ contextInjection: { projectFocus: 'summary' } });
        }
        if (p.toString().includes('CURRENT_FOCUS.md')) {
          return structuredContent;
        }
        return '';
      });

      const result = await handleBeforePromptBuild({} as any, {
        workspaceDir,
        trigger: 'user',
        sessionId: 'agent:main:123'
      } as any);

      // summary mode uses intelligent extraction
      expect(result?.appendSystemContext).toContain('<project_context>');
      // 智能摘要优先提取关键章节
      expect(result?.appendSystemContext).toContain('下一步'); // 关键章节
    });

    it('projectFocus: full → 注入完整 project_context + 历史版本 in appendSystemContext', async () => {
      const currentContent = `# 🎯 CURRENT_FOCUS

> **版本**: v2 | **状态**: EXECUTING | **更新**: 2026-03-16

## 📍 状态快照

| 维度 | 值 |
|------|-----|
| 当前阶段 | Phase 2 |

## ➡️ 下一步

1. 当前任务`;

      const historyContent = `# 🎯 CURRENT_FOCUS

> **版本**: v1 | **状态**: INIT | **更新**: 2026-03-15

## 📍 状态快照

| 维度 | 值 |
|------|-----|
| 当前阶段 | Phase 1 |

## ➡️ 下一步

1. 历史任务`;

      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const pathStr = p.toString();
        if (pathStr.includes('PROFILE.json')) return true;
        if (pathStr.includes('CURRENT_FOCUS.md')) return true;
        if (pathStr.includes('.history')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        const pathStr = p.toString();
        if (pathStr.includes('PROFILE.json')) {
          return JSON.stringify({ contextInjection: { projectFocus: 'full' } });
        }
        if (pathStr.includes('CURRENT_FOCUS.md') && !pathStr.includes('.history')) {
          return currentContent;
        }
        if (pathStr.includes('.history')) {
          return historyContent;
        }
        return '';
      });

      // Mock fs.readdirSync for history
      vi.mocked(fs.readdirSync).mockImplementation((p) => {
        if (p.toString().includes('.history')) {
          return ['CURRENT_FOCUS.v1.2026-03-15.md'] as any;
        }
        return [];
      });

      // Mock fs.statSync for history files
      vi.mocked(fs.statSync).mockImplementation((p) => {
        return { mtime: new Date('2026-03-15') } as any;
      });

      const result = await handleBeforePromptBuild({} as any, {
        workspaceDir,
        trigger: 'user',
        sessionId: 'agent:main:123'
      } as any);

      expect(result?.appendSystemContext).toContain('<project_context>');
      // Full mode includes current version
      expect(result?.appendSystemContext).toContain('当前任务');
    });
  });

  // ═══ Test Group 5: WebUI UX + Prompt Caching ═══
  describe('WebUI UX and Prompt Caching optimization', () => {
    it('prependContext should NOT contain long content (WebUI displays it)', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        const pathStr = p.toString();
        if (pathStr.includes('PROFILE.json')) {
          return JSON.stringify({ contextInjection: { projectFocus: 'full', reflectionLog: true } });
        }
        if (pathStr.includes('PRINCIPLES.md')) return 'P'.repeat(5000);
        if (pathStr.includes('THINKING_OS.md')) return 'T'.repeat(3000);
        if (pathStr.includes('CURRENT_FOCUS.md')) return 'F'.repeat(2000);
        if (pathStr.includes('reflection-log.md')) return 'R'.repeat(1000);
        return '';
      });

      const result = await handleBeforePromptBuild({} as any, {
        workspaceDir,
        trigger: 'user',
        sessionId: 'agent:main:123'
      } as any);

      // prependContext should only contain short dynamic content
      const prependLength = result?.prependContext?.length ?? 0;
      // trustScore is short (< 500 chars), evolutionDirective is also short
      expect(prependLength).toBeLessThan(2000);
      
      // Long content should be in appendSystemContext
      expect(result?.appendSystemContext).toContain('project_context');
      expect(result?.appendSystemContext).toContain('reflection_log');
      expect(result?.appendSystemContext).toContain('thinking_os');
      expect(result?.appendSystemContext).toContain('core_principles');
    });

    it('appendSystemContext contains all long-form context (Prompt Cacheable)', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        const pathStr = p.toString();
        if (pathStr.includes('PROFILE.json')) {
          return JSON.stringify({ contextInjection: { projectFocus: 'full', reflectionLog: true, thinkingOs: true } });
        }
        if (pathStr.includes('PRINCIPLES.md')) return '[PRINCIPLES]';
        if (pathStr.includes('THINKING_OS.md')) return '[THINKING_OS]';
        if (pathStr.includes('CURRENT_FOCUS.md')) return '[CURRENT_FOCUS]';
        if (pathStr.includes('reflection-log.md')) return '[REFLECTION_LOG]';
        return '';
      });

      const result = await handleBeforePromptBuild({} as any, {
        workspaceDir,
        trigger: 'user',
        sessionId: 'agent:main:123'
      } as any);

      // All long content in appendSystemContext (System Prompt level)
      const append = result?.appendSystemContext ?? '';
      expect(append).toContain('[PRINCIPLES]');
      expect(append).toContain('[THINKING_OS]');
      expect(append).toContain('[CURRENT_FOCUS]');
      expect(append).toContain('[REFLECTION_LOG]');
    });
  });
});