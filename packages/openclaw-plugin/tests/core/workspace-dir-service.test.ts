import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import { resolveRequiredWorkspaceDir, resolveWorkspaceDir } from '../../src/core/workspace-dir-service.js';

const homeDir = os.homedir();

describe('workspace-dir-service', () => {
  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };

  const api = {
    runtime: {
      agent: {
        resolveAgentWorkspaceDir: vi.fn(),
      },
    },
    config: {},
    logger,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    api.runtime.agent.resolveAgentWorkspaceDir.mockReturnValue('/resolved/workspace');
  });

  it('accepts valid ctx.workspaceDir directly', () => {
    const resolved = resolveRequiredWorkspaceDir(api as any, { workspaceDir: '/active/workspace', agentId: 'main' }, { source: 'test' });
    expect(resolved).toBe('/active/workspace');
    expect(api.runtime.agent.resolveAgentWorkspaceDir).not.toHaveBeenCalled();
  });

  it('rejects home directory and resolves from agent id when available', () => {
    const resolved = resolveWorkspaceDir(api as any, { workspaceDir: homeDir, agentId: 'worker-1' }, { source: 'test' });
    expect(resolved).toBe('/resolved/workspace');
    expect(api.runtime.agent.resolveAgentWorkspaceDir).toHaveBeenCalledWith(api.config, 'worker-1');
  });

  it('throws in required mode when no valid workspace can be resolved', () => {
    api.runtime.agent.resolveAgentWorkspaceDir.mockImplementation(() => {
      throw new Error('no agent workspace');
    });

    expect(() => resolveRequiredWorkspaceDir(api as any, { workspaceDir: homeDir }, { source: 'command' })).toThrow(
      /unable to resolve a valid workspace directory/i,
    );
    expect(logger.error).toHaveBeenCalled();
  });

  it('returns undefined in optional mode when no valid workspace can be resolved', () => {
    api.runtime.agent.resolveAgentWorkspaceDir.mockImplementation(() => {
      throw new Error('no agent workspace');
    });

    const resolved = resolveWorkspaceDir(api as any, { workspaceDir: homeDir }, { source: 'hook' });
    expect(resolved).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('uses explicit fallbackAgentId when caller provides one', () => {
    const resolved = resolveRequiredWorkspaceDir(api as any, {}, { source: 'startup', fallbackAgentId: 'main' });
    expect(resolved).toBe('/resolved/workspace');
    expect(api.runtime.agent.resolveAgentWorkspaceDir).toHaveBeenCalledWith(api.config, 'main');
  });
});
