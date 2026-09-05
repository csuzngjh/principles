import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import {
  resolveCanonicalWorkspaceDir,
  resolveHookWorkspaceDir,
  resolveToolHookWorkspaceDirSafe,
  resolveCommandWorkspaceDir,
  resolvePluginCommandWorkspaceDir,
  resolveWorkspaceDirForRuntimeV2,
  WorkspaceResolutionError,
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

  it('falls back to OpenClaw context when no PD explicit config exists', () => {
    const result = resolveHookWorkspaceDir(
      { workspaceDir: validWorkspace },
      api as any,
      'test',
      { canonicalResolver: noCanonical, explicitPdResolver: noCanonical },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('openclaw_context');
      expect(result.workspaceDir).toBe(validWorkspace);
    }
  });

  it('falls back to OpenClaw API when context is also missing', () => {
    api.runtime.agent.resolveAgentWorkspaceDir.mockReturnValue(validWorkspace);
    const result = resolveHookWorkspaceDir(
      {},
      api as any,
      'test',
      { canonicalResolver: noCanonical, explicitPdResolver: noCanonical },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('openclaw_api');
      expect(result.workspaceDir).toBe(validWorkspace);
    }
  });

  it('returns structured failure with reason and nextAction when all sources fail', () => {
    api.runtime.agent.resolveAgentWorkspaceDir.mockReturnValue(homeDir);
    const result = resolveHookWorkspaceDir(
      {},
      api as any,
      'test_hook',
      { canonicalResolver: noCanonical, explicitPdResolver: noCanonical },
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
      { canonicalResolver: noCanonical, explicitPdResolver: noCanonical },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('openclaw_api');
      expect(result.workspaceDir).toBe(validWorkspace);
    }
  });

  it('ctx.workspaceDir takes priority over pd_default when no explicit PD source exists', () => {
    // canonicalResolver returns pd_default, but ctx.workspaceDir is a real workspace
    const pdDefaultResolver = (): CanonicalWorkspaceResult => ({
      workspaceDir: path.join(homeDir, '.openclaw', 'workspace'),
      source: 'pd_default',
    });
    const result = resolveHookWorkspaceDir(
      { workspaceDir: validWorkspace },
      api as any,
      'test',
      { canonicalResolver: pdDefaultResolver, explicitPdResolver: noCanonical },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('openclaw_context');
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
      { canonicalResolver: noCanonical, explicitPdResolver: noCanonical },
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

  it('returns pd_default when only default fallback is available', () => {
    // When no explicit PD source, no ctx.workspaceDir, and no API resolution,
    // resolveToolHookWorkspaceDirSafe falls back to pd_default
    api.runtime.agent.resolveAgentWorkspaceDir.mockReturnValue(homeDir);
    const result = resolveToolHookWorkspaceDirSafe(
      {},
      api as any,
      'test',
    );
    // pd_default (~/.openclaw/workspace) is used as last resort
    expect(result).toBeDefined();
    expect(result).toContain('.openclaw');
  });

  it('returns undefined and logs when all sources including pd_default fail', () => {
    api.runtime.agent.resolveAgentWorkspaceDir.mockImplementation(() => {
      throw new Error('no workspace');
    });
    const result = resolveToolHookWorkspaceDirSafe(
      {},
      api as any,
      'test_hook',
      { canonicalResolver: noCanonical, explicitPdResolver: noCanonical },
    );
    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
    const warnCalls = logger.warn.mock.calls.map((c: unknown[]) => String(c[0]));
    const fullWarn = warnCalls.join('\n');
    expect(fullWarn).toContain('Cannot resolve workspace directory');
    expect(fullWarn).toContain('PD_WORKSPACE_DIR');
    expect(fullWarn).toContain('principles-disciple.json');
  });
});

describe('resolveCommandWorkspaceDir — Command Resolution', () => {
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

  // PRI-686: isolate from the host machine's real ~/.openclaw/principles-disciple.json
  // (present on dev machines with a live PD install) so "no explicit sources"
  // scenarios actually exercise the ctx/fallback chain.
  const noExplicit = () => ({ explicitPdResolver: () => null });

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

  it('returns ctx.workspaceDir when valid and no PD explicit source', () => {
    const result = resolveCommandWorkspaceDir(api as any, { workspaceDir: validWorkspace }, noExplicit());
    expect(result).toBe(validWorkspace);
  });

  it('throws when ctx.workspaceDir is home directory', () => {
    expect(() => resolveCommandWorkspaceDir(api as any, { workspaceDir: homeDir }, noExplicit()))
      .toThrow(/is invalid/);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('is invalid'));
  });

  it('throws when ctx.workspaceDir is empty string', () => {
    expect(() => resolveCommandWorkspaceDir(api as any, { workspaceDir: '' }, noExplicit()))
      .toThrow(/Cannot resolve workspace directory/);
  });

  it('falls back to API resolution when ctx.workspaceDir is undefined', () => {
    api.runtime.agent.resolveAgentWorkspaceDir.mockReturnValue(validWorkspace);
    process.env.OPENCLAW_WORKSPACE = validWorkspace;
    const result = resolveCommandWorkspaceDir(api as any, {}, noExplicit());
    expect(result).toBe(path.resolve(validWorkspace));
  });

  it('falls back to PathResolver default when API throws', () => {
    api.runtime.agent.resolveAgentWorkspaceDir.mockImplementation(() => {
      throw new Error('API unavailable');
    });
    // PathResolver provides default ~/.openclaw/workspace fallback
    const result = resolveCommandWorkspaceDir(api as any, {}, noExplicit());
    expect(result).toBeDefined();
    expect(result).toContain('.openclaw');
  });

  // ── PRI-686: PD explicit sources take priority over session context ──

  it('returns PD explicit workspace over diverging ctx.workspaceDir and warns (env source)', () => {
    process.env.PD_WORKSPACE_DIR = validWorkspace;
    const agentSub = path.join(os.tmpdir(), 'pd-test-workspace-agent-sub');
    ensureDir(agentSub);
    const result = resolveCommandWorkspaceDir(api as any, { workspaceDir: agentSub });
    expect(result).toBe(path.resolve(validWorkspace));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('differs from OpenClaw context'));
  });

  it('does not warn when PD explicit workspace matches ctx.workspaceDir', () => {
    process.env.PD_WORKSPACE_DIR = validWorkspace;
    const result = resolveCommandWorkspaceDir(api as any, { workspaceDir: validWorkspace });
    expect(result).toBe(path.resolve(validWorkspace));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('hooks and commands converge on the same PD canonical workspace (split regression)', () => {
    // The live 2026-09-05 incident: hook side wrote root (PD canonical from
    // principles-disciple.json), command side read <root>/main (ctx.workspaceDir).
    // After PRI-686 both must resolve identically.
    process.env.PD_WORKSPACE_DIR = validWorkspace;
    const agentSub = path.join(validWorkspace, 'main');
    ensureDir(agentSub);

    const hookResult = resolveHookWorkspaceDir({ workspaceDir: agentSub }, api as any, 'test');
    const cmdResult = resolveCommandWorkspaceDir(api as any, { workspaceDir: agentSub });

    expect(hookResult.ok).toBe(true);
    if (hookResult.ok) {
      expect(path.resolve(hookResult.workspaceDir)).toBe(path.resolve(cmdResult));
    }
  });
});

describe('resolvePluginCommandWorkspaceDir — Plugin Command Resolution', () => {
  // PRI-686: isolate from host machine's real PD canonical config (see above).
  const noExplicit = () => ({ explicitPdResolver: () => null });
  const warnLogger = { warn: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    ensureDir(validWorkspace);
  });

  it('returns ctx.workspaceDir when valid and no PD explicit source', () => {
    const ctx = { workspaceDir: validWorkspace, config: {} };
    const result = resolvePluginCommandWorkspaceDir(ctx as any, 'test-source', undefined, noExplicit());
    expect(result).toBe(validWorkspace);
  });

  it('throws when ctx.workspaceDir is home directory', () => {
    const ctx = { workspaceDir: homeDir, config: {} };
    expect(() => resolvePluginCommandWorkspaceDir(ctx as any, 'test-source', undefined, noExplicit()))
      .toThrow(/is invalid/);
  });

  it('falls back to ctx.config.workspaceDir when ctx.workspaceDir is undefined', () => {
    const ctx = { workspaceDir: undefined, config: { workspaceDir: validWorkspace } };
    const result = resolvePluginCommandWorkspaceDir(ctx as any, 'test-source', undefined, noExplicit());
    expect(result).toBe(validWorkspace);
  });

  it('throws when both ctx.workspaceDir and ctx.config.workspaceDir are invalid', () => {
    const ctx = { workspaceDir: homeDir, config: { workspaceDir: homeDir } };
    expect(() => resolvePluginCommandWorkspaceDir(ctx as any, 'test-source', undefined, noExplicit()))
      .toThrow(/is invalid/);
  });

  it('throws critical error when no workspaceDir available', () => {
    const ctx = { workspaceDir: undefined, config: {} };
    expect(() => resolvePluginCommandWorkspaceDir(ctx as any, 'test-source', undefined, noExplicit()))
      .toThrow(/CRITICAL: workspaceDir is not set/);
  });

  // ── PRI-686: PD explicit sources take priority over session context ──

  it('returns PD explicit workspace over diverging ctx.workspaceDir and warns via logger', () => {
    process.env.PD_WORKSPACE_DIR = validWorkspace;
    const agentSub = path.join(os.tmpdir(), 'pd-test-workspace-agent-sub-2');
    ensureDir(agentSub);
    const ctx = { workspaceDir: agentSub, config: {} };
    const result = resolvePluginCommandWorkspaceDir(ctx as any, 'pain', warnLogger);
    expect(result).toBe(path.resolve(validWorkspace));
    expect(warnLogger.warn).toHaveBeenCalledWith(expect.stringContaining('differs from OpenClaw context'));
    delete process.env.PD_WORKSPACE_DIR;
  });
});

describe('resolveWorkspaceDirForRuntimeV2 — Runtime V2 Resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureDir(validWorkspace);
  });

  it('returns normalized workspaceDir when valid', () => {
    const result = resolveWorkspaceDirForRuntimeV2(
      { workspaceDir: validWorkspace },
      undefined,
      'runtime-v2-test',
    );
    expect(result).toBe(path.resolve(validWorkspace));
  });

  it('throws WorkspaceResolutionError when workspaceDir is empty', () => {
    expect(() => resolveWorkspaceDirForRuntimeV2({ workspaceDir: '' }, undefined, 'test'))
      .toThrow(WorkspaceResolutionError);
    
    try {
      resolveWorkspaceDirForRuntimeV2({ workspaceDir: '' }, undefined, 'test');
    } catch (e) {
      expect((e as WorkspaceResolutionError).reason).toBe('workspace_dir_missing');
      expect((e as WorkspaceResolutionError).nextAction).toContain('PD_WORKSPACE_DIR');
    }
  });

  it('throws WorkspaceResolutionError when workspaceDir is undefined', () => {
    expect(() => resolveWorkspaceDirForRuntimeV2({}, undefined, 'test'))
      .toThrow(WorkspaceResolutionError);
  });

  it('throws WorkspaceResolutionError when workspaceDir is home directory', () => {
    expect(() => resolveWorkspaceDirForRuntimeV2({ workspaceDir: homeDir }, undefined, 'test'))
      .toThrow(WorkspaceResolutionError);
    
    try {
      resolveWorkspaceDirForRuntimeV2({ workspaceDir: homeDir }, undefined, 'test');
    } catch (e) {
      expect((e as WorkspaceResolutionError).reason).toBe('workspace_dir_invalid');
    }
  });
});

describe('WorkspaceResolutionError — Error Structure', () => {
  it('has correct name and properties', () => {
    const error = new WorkspaceResolutionError(
      'Test message',
      'test_reason',
      'Test next action',
    );
    expect(error.name).toBe('WorkspaceResolutionError');
    expect(error.message).toBe('Test message');
    expect(error.reason).toBe('test_reason');
    expect(error.nextAction).toBe('Test next action');
  });

  it('toJSON returns structured failure object', () => {
    const error = new WorkspaceResolutionError(
      'Test message',
      'test_reason',
      'Test next action',
    );
    const json = error.toJSON();
    expect(json.ok).toBe(false);
    expect(json.reason).toBe('test_reason');
    expect(json.message).toBe('Test message');
    expect(json.nextAction).toBe('Test next action');
  });
});
