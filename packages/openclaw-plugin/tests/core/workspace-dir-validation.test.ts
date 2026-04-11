import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import { validateWorkspaceDir, resolveValidWorkspaceDir, logWorkspaceDirHealth } from '../../src/core/workspace-dir-validation.js';

const homeDir = os.homedir();

describe('validateWorkspaceDir', () => {
  it('rejects undefined or null values', () => {
    expect(validateWorkspaceDir(undefined)).toBe('workspaceDir is undefined/null');
    expect(validateWorkspaceDir(null as unknown as string)).toBe('workspaceDir is undefined/null');
  });

  it('rejects home directory and root-like paths', () => {
    expect(validateWorkspaceDir(homeDir)).toContain('home directory');
    expect(validateWorkspaceDir(`${homeDir}/`)).toContain('home directory');
    expect(validateWorkspaceDir('/')).toContain('root or empty');
    expect(validateWorkspaceDir('')).toContain('undefined/null');
  });

  it('accepts normal workspace paths', () => {
    expect(validateWorkspaceDir('/home/user/projects/workspace-main')).toBeNull();
    expect(validateWorkspaceDir('/tmp/test-workspace')).toBeNull();
    expect(validateWorkspaceDir('C:\\Users\\test\\workspace')).toBeNull();
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
    logger: mockLogger,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.runtime.agent.resolveAgentWorkspaceDir.mockReturnValue('/resolved/from/agent');
  });

  it('returns ctx.workspaceDir when valid', () => {
    const result = resolveValidWorkspaceDir(
      { workspaceDir: '/valid/workspace', agentId: 'main' },
      mockApi as any,
      { source: 'test' },
    );

    expect(result).toBe('/valid/workspace');
    expect(mockApi.runtime.agent.resolveAgentWorkspaceDir).not.toHaveBeenCalled();
  });

  it('falls back to agent resolution when ctx.workspaceDir is invalid', () => {
    const result = resolveValidWorkspaceDir(
      { workspaceDir: homeDir, agentId: 'main' },
      mockApi as any,
      { source: 'test' },
    );

    expect(result).toBe('/resolved/from/agent');
    expect(mockApi.runtime.agent.resolveAgentWorkspaceDir).toHaveBeenCalledWith(mockApi.config, 'main');
  });

  it('returns undefined when no valid workspace can be resolved', () => {
    mockApi.runtime.agent.resolveAgentWorkspaceDir.mockReturnValue(homeDir);

    const result = resolveValidWorkspaceDir(
      { workspaceDir: undefined, agentId: 'main' },
      mockApi as any,
      { source: 'test' },
    );

    expect(result).toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('unable to resolve a valid workspace directory'));
  });

  it('supports explicit fallbackAgentId', () => {
    mockApi.runtime.agent.resolveAgentWorkspaceDir
      .mockImplementationOnce(() => {
        throw new Error('agent missing');
      })
      .mockReturnValueOnce('/resolved/from/fallback');

    const result = resolveValidWorkspaceDir(
      { workspaceDir: undefined, agentId: 'worker-1' },
      mockApi as any,
      { source: 'test', fallbackAgentId: 'main' },
    );

    expect(result).toBe('/resolved/from/fallback');
    expect(mockApi.runtime.agent.resolveAgentWorkspaceDir).toHaveBeenNthCalledWith(1, mockApi.config, 'worker-1');
    expect(mockApi.runtime.agent.resolveAgentWorkspaceDir).toHaveBeenNthCalledWith(2, mockApi.config, 'main');
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
    logger: mockLogger,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs info when workspace is valid', () => {
    logWorkspaceDirHealth({ workspaceDir: '/valid/workspace' }, 'startup', mockApi as any);
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('workspaceDir="/valid/workspace" OK'));
  });

  it('logs error when workspace remains unresolved', () => {
    mockApi.runtime.agent.resolveAgentWorkspaceDir.mockReturnValue(homeDir);
    logWorkspaceDirHealth({ workspaceDir: undefined }, 'startup', mockApi as any);
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('workspaceDir="undefined"'));
  });
});
