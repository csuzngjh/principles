/**
 * Unit tests for workspace-dir-validation.ts
 * 
 * Tests the core validation logic and 3-tier fallback strategy
 * for resolving correct workspaceDir in tool hooks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import { validateWorkspaceDir, resolveValidWorkspaceDir, logWorkspaceDirHealth } from '../../src/core/workspace-dir-validation.js';

const homeDir = os.homedir();

describe('validateWorkspaceDir', () => {
  it('should return error for undefined', () => {
    const result = validateWorkspaceDir(undefined);
    expect(result).toBe('workspaceDir is undefined/null');
  });

  it('should return error for null (treated as undefined)', () => {
    const result = validateWorkspaceDir(null as unknown as string);
    expect(result).toBe('workspaceDir is undefined/null');
  });

  it('should return error for empty string (treated as falsy)', () => {
    const result = validateWorkspaceDir('');
    // Empty string is falsy, so it's treated like undefined
    expect(result).toContain('undefined/null');
  });

  it('should return error for root directory', () => {
    const result = validateWorkspaceDir('/');
    expect(result).toContain('root or empty');
  });

  it('should return error for home directory', () => {
    const result = validateWorkspaceDir(homeDir);
    expect(result).toContain('equals home directory');
    expect(result).toContain(homeDir);
  });

  it('should return error for home directory with trailing slash', () => {
    const result = validateWorkspaceDir(`${homeDir}/`);
    expect(result).toContain('home directory');
  });

  it('should return null (valid) for a proper workspace path', () => {
    const result = validateWorkspaceDir('/home/user/projects/my-workspace');
    expect(result).toBeNull();
  });

  it('should return null (valid) for a nested workspace path', () => {
    const result = validateWorkspaceDir('/home/user/.openclaw/workspace-main');
    expect(result).toBeNull();
  });

  it('should return null (valid) for temp directory', () => {
    const result = validateWorkspaceDir('/tmp/test-workspace');
    expect(result).toBeNull();
  });

  it('should return null (valid) for Windows-style path', () => {
    // On Linux, Windows paths are just regular paths
    const result = validateWorkspaceDir('C:\\Users\\test\\workspace');
    expect(result).toBeNull();
  });
});

describe('resolveValidWorkspaceDir', () => {
  const mockLogger = {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };

  const mockApi = {
    runtime: {
      agent: {
        resolveAgentWorkspaceDir: vi.fn(),
      },
    },
    config: {},
    resolvePath: vi.fn(),
    logger: mockLogger,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.resolvePath.mockReturnValue('/default/workspace');
    mockApi.runtime.agent.resolveAgentWorkspaceDir.mockReturnValue('/resolved/from/agent');
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should return ctx.workspaceDir when valid', () => {
    const ctx = { workspaceDir: '/valid/workspace', agentId: 'agent-1' };
    const result = resolveValidWorkspaceDir(ctx, mockApi as any, { source: 'test' });
    
    expect(result).toBe('/valid/workspace');
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('should warn and continue when ctx.workspaceDir is home directory', () => {
    const ctx = { workspaceDir: homeDir, agentId: 'agent-1' };
    const result = resolveValidWorkspaceDir(ctx, mockApi as any, { source: 'test' });
    
    // Should fall back to agentId resolution
    expect(result).toBe('/resolved/from/agent');
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('should try agentId resolution when ctx.workspaceDir is undefined', () => {
    const ctx = { workspaceDir: undefined, agentId: 'agent-1' };
    const result = resolveValidWorkspaceDir(ctx, mockApi as any, { source: 'test' });
    
    expect(mockApi.runtime.agent.resolveAgentWorkspaceDir).toHaveBeenCalledWith(mockApi.config, 'agent-1');
    expect(result).toBe('/resolved/from/agent');
  });

  it('should fallback to resolvePath when agentId is undefined', () => {
    const ctx = { workspaceDir: undefined, agentId: undefined };
    const result = resolveValidWorkspaceDir(ctx, mockApi as any, { source: 'test' });
    
    expect(mockApi.resolvePath).toHaveBeenCalledWith('.');
    expect(result).toBe('/default/workspace');
  });

  it('should fallback to resolvePath when agentId resolution fails', () => {
    mockApi.runtime.agent.resolveAgentWorkspaceDir.mockImplementation(() => {
      throw new Error('Agent not found');
    });
    
    const ctx = { workspaceDir: undefined, agentId: 'unknown-agent' };
    const result = resolveValidWorkspaceDir(ctx, mockApi as any, { source: 'test' });
    
    expect(mockApi.resolvePath).toHaveBeenCalledWith('.');
    expect(result).toBe('/default/workspace');
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('failed to resolve from agentId'));
  });

  it('should fallback to resolvePath when agentId resolution returns home directory', () => {
    mockApi.runtime.agent.resolveAgentWorkspaceDir.mockReturnValue(homeDir);
    
    const ctx = { workspaceDir: undefined, agentId: 'agent-1' };
    const result = resolveValidWorkspaceDir(ctx, mockApi as any, { source: 'test' });
    
    expect(mockApi.resolvePath).toHaveBeenCalledWith('.');
    expect(result).toBe('/default/workspace');
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('invalid'));
  });

  it('should warn when all fallbacks fail', () => {
    mockApi.resolvePath.mockReturnValue(homeDir);
    
    const ctx = { workspaceDir: undefined, agentId: undefined };
    const result = resolveValidWorkspaceDir(ctx, mockApi as any, { source: 'test' });
    
    expect(result).toBe(homeDir);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('FINAL FALLBACK'));
  });

  it('should use custom onWarning callback', () => {
    const customWarning = vi.fn();
    
    const ctx = { workspaceDir: homeDir, agentId: undefined };
    mockApi.resolvePath.mockReturnValue('/valid/fallback');
    
    const result = resolveValidWorkspaceDir(ctx, mockApi as any, { 
      source: 'test',
      onWarning: customWarning,
    });
    
    expect(customWarning).toHaveBeenCalled();
  });

  it('should use default source "unknown" when not provided', () => {
    const ctx = { workspaceDir: homeDir, agentId: undefined };
    mockApi.resolvePath.mockReturnValue('/valid/fallback');
    
    resolveValidWorkspaceDir(ctx, mockApi as any);
    
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('unknown:'));
  });
});

describe('logWorkspaceDirHealth', () => {
  const mockLogger = {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };

  const mockApi = {
    runtime: {
      agent: {
        resolveAgentWorkspaceDir: vi.fn().mockReturnValue('/valid/workspace'),
      },
    },
    config: {},
    resolvePath: vi.fn().mockReturnValue('/valid/workspace'),
    logger: mockLogger,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should log info when workspaceDir is valid', () => {
    const ctx = { workspaceDir: '/valid/workspace' };
    logWorkspaceDirHealth(ctx, 'startup', mockApi as any);
    
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('✓'));
  });

  it('should log error when workspaceDir is invalid', () => {
    mockApi.resolvePath.mockReturnValue(homeDir);
    
    const ctx = { workspaceDir: undefined };
    logWorkspaceDirHealth(ctx, 'startup', mockApi as any);
    
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining(homeDir));
  });
});

describe('Integration: 3-tier fallback chain', () => {
  const mockLogger = {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };

  it('should follow the complete fallback chain: ctx.workspaceDir -> agentId -> resolvePath', () => {
    const mockApi = {
      runtime: {
        agent: {
          resolveAgentWorkspaceDir: vi.fn().mockReturnValue('/workspace/from-agent'),
        },
      },
      config: {},
      resolvePath: vi.fn().mockReturnValue('/workspace/from-resolvePath'),
      logger: mockLogger,
    };

    // Case 1: ctx.workspaceDir is valid - use it directly
    const ctx1 = { workspaceDir: '/workspace/from-ctx', agentId: 'agent-1' };
    const result1 = resolveValidWorkspaceDir(ctx1, mockApi as any, { source: 'test' });
    expect(result1).toBe('/workspace/from-ctx');
    expect(mockApi.runtime.agent.resolveAgentWorkspaceDir).not.toHaveBeenCalled();

    vi.clearAllMocks();

    // Case 2: ctx.workspaceDir is invalid, agentId resolution works
    const ctx2 = { workspaceDir: homeDir, agentId: 'agent-1' };
    const result2 = resolveValidWorkspaceDir(ctx2, mockApi as any, { source: 'test' });
    expect(result2).toBe('/workspace/from-agent');
    expect(mockApi.runtime.agent.resolveAgentWorkspaceDir).toHaveBeenCalled();

    vi.clearAllMocks();

    // Case 3: ctx.workspaceDir is invalid, agentId resolution returns invalid, use resolvePath
    mockApi.runtime.agent.resolveAgentWorkspaceDir.mockReturnValue(homeDir);
    const ctx3 = { workspaceDir: homeDir, agentId: 'agent-1' };
    const result3 = resolveValidWorkspaceDir(ctx3, mockApi as any, { source: 'test' });
    expect(result3).toBe('/workspace/from-resolvePath');
    expect(mockApi.resolvePath).toHaveBeenCalledWith('.');
  });
});
