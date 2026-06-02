import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import {
  resolveCanonicalWorkspaceDir,
  resolveHookWorkspaceDir,
  resolveToolHookWorkspaceDirSafe,
} from '../../src/utils/workspace-resolver.js';
import type { CanonicalWorkspaceResult, HookWorkspaceResolutionResult } from '../../src/utils/workspace-resolver.js';

const homeDir = os.homedir();
const validWorkspace = path.join(os.tmpdir(), 'pd-test-workspace-hook-resolver');

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const noCanonical: () => null = () => null;

describe('resolveCanonicalWorkspaceDir', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PD_WORKSPACE_DIR;
    delete process.env.OPENCLAW_WORKSPACE;
    ensureDir(validWorkspace);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('resolves from PD_WORKSPACE_DIR env var with highest priority', () => {
    process.env.PD_WORKSPACE_DIR = validWorkspace;
    process.env.OPENCLAW_WORKSPACE = '/some/other/path';
    const result = resolveCanonicalWorkspaceDir();
    expect(result).not.toBeNull();
    expect(result!.source).toBe('pd_env');
    expect(result!.workspaceDir).toBe(path.resolve(validWorkspace));
  });

  it('resolves from OPENCLAW_WORKSPACE env var when PD_WORKSPACE_DIR is not set', () => {
    process.env.OPENCLAW_WORKSPACE = validWorkspace;
    const result = resolveCanonicalWorkspaceDir();
    expect(result).not.toBeNull();
    expect(result!.source).toBe('openclaw_env');
    expect(result!.workspaceDir).toBe(path.resolve(validWorkspace));
  });

  it('prefers PD_WORKSPACE_DIR over OPENCLAW_WORKSPACE', () => {
    const altWorkspace = path.join(os.tmpdir(), 'pd-test-workspace-alt');
    ensureDir(altWorkspace);
    process.env.PD_WORKSPACE_DIR = validWorkspace;
    process.env.OPENCLAW_WORKSPACE = altWorkspace;
    const result = resolveCanonicalWorkspaceDir();
    expect(result).not.toBeNull();
    expect(result!.source).toBe('pd_env');
    expect(result!.workspaceDir).toBe(path.resolve(validWorkspace));
  });

  it('rejects home directory from PD_WORKSPACE_DIR', () => {
    process.env.PD_WORKSPACE_DIR = homeDir;
    const result = resolveCanonicalWorkspaceDir();
    if (result?.source === 'pd_env') {
      expect.fail('Should not resolve home directory from PD_WORKSPACE_DIR');
    }
  });

  it('rejects empty string from PD_WORKSPACE_DIR', () => {
    process.env.PD_WORKSPACE_DIR = '';
    const result = resolveCanonicalWorkspaceDir();
    if (result?.source === 'pd_env') {
      expect.fail('Should not resolve empty PD_WORKSPACE_DIR');
    }
  });

  it('always returns a result when PD_WORKSPACE_DIR points to a valid dir', () => {
    process.env.PD_WORKSPACE_DIR = validWorkspace;
    const result = resolveCanonicalWorkspaceDir();
    expect(result).not.toBeNull();
    expect(result!.workspaceDir).toBe(path.resolve(validWorkspace));
  });
});

describe('resolveHookWorkspaceDir — PD canonical primary', () => {
  const originalEnv = { ...process.env };
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
    process.env = { ...originalEnv };
    delete process.env.PD_WORKSPACE_DIR;
    delete process.env.OPENCLAW_WORKSPACE;
    vi.clearAllMocks();
    ensureDir(validWorkspace);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('uses PD_WORKSPACE_DIR as primary source regardless of OpenClaw context', () => {
    process.env.PD_WORKSPACE_DIR = validWorkspace;
    const result = resolveHookWorkspaceDir(
      { workspaceDir: '/some/openclaw/path', agentId: 'main' },
      api as any,
      'test',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('pd_env');
      expect(result.workspaceDir).toBe(path.resolve(validWorkspace));
    }
  });

  it('emits consistency warning when PD canonical differs from OpenClaw context', () => {
    const altWorkspace = path.join(os.tmpdir(), 'pd-test-workspace-alt-2');
    ensureDir(altWorkspace);
    process.env.PD_WORKSPACE_DIR = validWorkspace;
    const result = resolveHookWorkspaceDir(
      { workspaceDir: altWorkspace },
      api as any,
      'test',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('pd_env');
      expect(result.workspaceDir).toBe(path.resolve(validWorkspace));
      expect(result.consistencyWarning).toContain('differs from OpenClaw context');
    }
  });

  it('does not emit consistency warning when PD canonical matches OpenClaw context', () => {
    process.env.PD_WORKSPACE_DIR = validWorkspace;
    const result = resolveHookWorkspaceDir(
      { workspaceDir: validWorkspace },
      api as any,
      'test',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.consistencyWarning).toBeUndefined();
    }
  });

  it('falls back to OpenClaw context when no PD canonical config exists', () => {
    const result = resolveHookWorkspaceDir(
      { workspaceDir: validWorkspace },
      api as any,
      'test',
      { canonicalResolver: noCanonical },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('openclaw_context');
      expect(result.workspaceDir).toBe(validWorkspace);
      expect(result.consistencyWarning).toContain('PD canonical config not found');
    }
  });

  it('falls back to OpenClaw API when context is also missing', () => {
    api.runtime.agent.resolveAgentWorkspaceDir.mockReturnValue(validWorkspace);
    const result = resolveHookWorkspaceDir(
      {},
      api as any,
      'test',
      { canonicalResolver: noCanonical },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('openclaw_api');
      expect(result.workspaceDir).toBe(validWorkspace);
      expect(result.consistencyWarning).toContain('PD canonical config not found');
    }
  });

  it('returns structured failure with reason and nextAction when all sources fail', () => {
    api.runtime.agent.resolveAgentWorkspaceDir.mockReturnValue(homeDir);
    const result = resolveHookWorkspaceDir(
      {},
      api as any,
      'test_hook',
      { canonicalResolver: noCanonical },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('workspace_dir_unresolvable');
      expect(result.nextAction).toContain('PD_WORKSPACE_DIR');
      expect(result.nextAction).toContain('principles-disciple.json');
      expect(result.message).toContain('test_hook');
    }
  });

  it('rejects home directory from OpenClaw context and falls back to API', () => {
    api.runtime.agent.resolveAgentWorkspaceDir.mockReturnValue(validWorkspace);
    const result = resolveHookWorkspaceDir(
      { workspaceDir: homeDir, agentId: 'main' },
      api as any,
      'test',
      { canonicalResolver: noCanonical },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('openclaw_api');
      expect(result.workspaceDir).toBe(validWorkspace);
    }
  });

  it('returns failure when API throws and no other source works', () => {
    api.runtime.agent.resolveAgentWorkspaceDir.mockImplementation(() => {
      throw new Error('API unavailable');
    });
    const result = resolveHookWorkspaceDir(
      {},
      api as any,
      'test_hook',
      { canonicalResolver: noCanonical },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('workspace_dir_unresolvable');
      expect(result.nextAction).toContain('PD_WORKSPACE_DIR');
    }
  });
});

describe('resolveToolHookWorkspaceDirSafe (backward compat)', () => {
  const originalEnv = { ...process.env };
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
    process.env = { ...originalEnv };
    delete process.env.PD_WORKSPACE_DIR;
    delete process.env.OPENCLAW_WORKSPACE;
    vi.clearAllMocks();
    ensureDir(validWorkspace);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns string when PD_WORKSPACE_DIR resolves', () => {
    process.env.PD_WORKSPACE_DIR = validWorkspace;
    const result = resolveToolHookWorkspaceDirSafe({}, api as any, 'test');
    expect(result).toBe(path.resolve(validWorkspace));
  });

  it('logs consistency warning when PD canonical differs from context', () => {
    const altWorkspace = path.join(os.tmpdir(), 'pd-test-workspace-alt-3');
    ensureDir(altWorkspace);
    process.env.PD_WORKSPACE_DIR = validWorkspace;
    const result = resolveToolHookWorkspaceDirSafe(
      { workspaceDir: altWorkspace },
      api as any,
      'test',
    );
    expect(result).toBe(path.resolve(validWorkspace));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('differs from OpenClaw context'),
    );
  });

  it('returns undefined and logs when all sources fail', () => {
    api.runtime.agent.resolveAgentWorkspaceDir.mockReturnValue(homeDir);
    const result = resolveHookWorkspaceDir(
      {},
      api as any,
      'test',
      { canonicalResolver: noCanonical },
    );
    expect(result.ok).toBe(false);
  });

  it('no silent skip — failure includes workspace_dir_unresolvable reason', () => {
    api.runtime.agent.resolveAgentWorkspaceDir.mockImplementation(() => {
      throw new Error('no workspace');
    });
    const result = resolveHookWorkspaceDir(
      {},
      api as any,
      'test_hook',
      { canonicalResolver: noCanonical },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('workspace_dir_unresolvable');
      expect(result.message).toContain('test_hook');
    }
  });
});
