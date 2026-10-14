/**
 * resolveWorkspaceDir tests.
 *
 * Tests the 4-step resolution chain by mocking the config loader's
 * discoverWorkspaceDefault function.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

// ── Mock setup ──────────────────────────────────────────────────────────────

// We must use vi.hoisted() so the mock factory can reference the spy.
const { mockDiscover } = vi.hoisted(() => {
  const mockDiscover = vi.fn<() => import('../src/services/pd-config-loader.js').WorkspaceDiscoveryResult | null>();
  return { mockDiscover };
});

vi.mock('../src/services/pd-config-loader.js', () => ({
  discoverWorkspaceDefault: mockDiscover,
}));

import { resolveWorkspaceDir, WORKSPACE_ENV } from '../src/resolve-workspace.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function captureStderr() {
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return spy;
}

function makeDiscovery(
  workspaceDefault: string,
  opts: { source?: 'cwd' | 'env_var' | 'openclaw_default' | 'openclaw_plugin_config'; declared?: boolean } = {},
): import('../src/services/pd-config-loader.js').WorkspaceDiscoveryResult {
  const { source = 'openclaw_default', declared = true } = opts;
  return {
    kind: 'resolved',
    workspaceDefault,
    configPath: `${workspaceDefault}/.pd/config.yaml`,
    source,
    declared,
  };
}

/**
 * A config that exists but cannot be read. Discovery deliberately carries no path
 * for this case: an unknown declaration must not be expressible as a usable default
 * (PRI-957 review round 3 P1).
 */
function makeUnparseable(
  configPath = '/standing/ws/.pd/config.yaml',
): import('../src/services/pd-config-loader.js').WorkspaceDiscoveryResult {
  return { kind: 'unparseable', configPath, source: 'cwd', reason: 'bad indentation at line 2' };
}

const ORIGINAL_ENV = process.env.PD_WORKSPACE_DIR;

// ── Tests ───────────────────────────────────────────────────────────────────

describe('resolveWorkspaceDir', () => {
  beforeEach(() => {
    mockDiscover.mockReset();
    delete process.env.PD_WORKSPACE_DIR;
  });

  afterEach(() => {
    if (ORIGINAL_ENV !== undefined) {
      process.env.PD_WORKSPACE_DIR = ORIGINAL_ENV;
    } else {
      delete process.env.PD_WORKSPACE_DIR;
    }
  });

  // 1. Returns explicit --workspace flag
  it('returns explicit --workspace flag', () => {
    mockDiscover.mockReturnValue(null);
    const result = resolveWorkspaceDir('/explicit/path');
    expect(result).toBe('/explicit/path');
  });

  // 2. Returns PD_WORKSPACE_DIR env var when no flag
  it('returns PD_WORKSPACE_DIR env var when no flag', () => {
    mockDiscover.mockReturnValue(null);
    process.env.PD_WORKSPACE_DIR = '/env/workspace';
    const result = resolveWorkspaceDir();
    expect(result).toBe('/env/workspace');
  });

  // 3. Returns config default when no flag and no env var
  it('returns config default when no flag and no env var', () => {
    mockDiscover.mockReturnValue(makeDiscovery('/config/workspace'));
    const result = resolveWorkspaceDir();
    expect(result).toBe('/config/workspace');
  });

  // 4. Throws when no flag, no env var, and no config found
  it('throws when no flag, no env var, and no config found', () => {
    mockDiscover.mockReturnValue(null);
    expect(() => resolveWorkspaceDir()).toThrow('No workspace directory configured');
  });

  // 5. Emits warning when --workspace differs from config default
  it('emits warning when --workspace differs from config default', () => {
    mockDiscover.mockReturnValue(makeDiscovery('/config/default'));
    const stderrSpy = captureStderr();

    const result = resolveWorkspaceDir('/different/path');

    expect(result).toBe('/different/path');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('[PD:workspace] WARNING'),
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('differs from config default'),
    );

    stderrSpy.mockRestore();
  });

  // 6. Does NOT warn when --workspace matches config default (normalized)
  it('does NOT warn when --workspace matches config default', () => {
    mockDiscover.mockReturnValue(makeDiscovery('/same/path'));
    const stderrSpy = captureStderr();

    const result = resolveWorkspaceDir('/same/path');

    expect(result).toBe('/same/path');
    // No warning should be emitted since paths match
    const warningCalls = stderrSpy.mock.calls.filter(
      call => typeof call[0] === 'string' && call[0].includes('WARNING'),
    );
    expect(warningCalls).toHaveLength(0);

    stderrSpy.mockRestore();
  });

  // 7. Emits warning when env var differs from config default
  it('emits warning when env var differs from config default', () => {
    mockDiscover.mockReturnValue(makeDiscovery('/config/default'));
    process.env.PD_WORKSPACE_DIR = '/different/env/path';
    const stderrSpy = captureStderr();

    const result = resolveWorkspaceDir();

    expect(result).toBe('/different/env/path');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('[PD:workspace] WARNING'),
    );

    stderrSpy.mockRestore();
  });

  // 8. Does NOT warn when env var matches config default
  it('does NOT warn when env var matches config default', () => {
    mockDiscover.mockReturnValue(makeDiscovery('/same/path'));
    process.env.PD_WORKSPACE_DIR = '/same/path';
    const stderrSpy = captureStderr();

    const result = resolveWorkspaceDir();

    expect(result).toBe('/same/path');
    const warningCalls = stderrSpy.mock.calls.filter(
      call => typeof call[0] === 'string' && call[0].includes('WARNING'),
    );
    expect(warningCalls).toHaveLength(0);

    stderrSpy.mockRestore();
  });

  // 9. Does NOT warn when --workspace provided and no config found
  it('does NOT warn when --workspace provided and no config found', () => {
    mockDiscover.mockReturnValue(null);
    const stderrSpy = captureStderr();

    const result = resolveWorkspaceDir('/some/path');

    expect(result).toBe('/some/path');
    expect(stderrSpy).not.toHaveBeenCalled();

    stderrSpy.mockRestore();
  });

  // 10. Exports correct WORKSPACE_ENV constant
  it('exports correct WORKSPACE_ENV constant', () => {
    expect(WORKSPACE_ENV).toBe('PD_WORKSPACE_DIR');
  });

  // 11. Error message mentions workspace.default option
  it('error message mentions workspace.default option', () => {
    mockDiscover.mockReturnValue(null);
    expect(() => resolveWorkspaceDir()).toThrow('workspace.default');
  });

  // 12. CWE-22 boundary guard: parent traversal is rejected
  it('rejects parent-traversal workspace paths', () => {
    mockDiscover.mockReturnValue(null);
    expect(() => resolveWorkspaceDir('../evil')).toThrow('parent traversal');
    expect(() => resolveWorkspaceDir('a/../../b')).toThrow('parent traversal');
  });

  // 13. CWE-22 boundary guard: filesystem root is rejected
  it('rejects filesystem-root workspace paths', () => {
    mockDiscover.mockReturnValue(null);
    expect(() => resolveWorkspaceDir('/')).toThrow('filesystem root');
  });

  // 14. Platform-agnostic: a Windows-style path is accepted everywhere.
  // On POSIX runners "Z:\\work" is not absolute; the boundary guard must
  // NOT treat that as invalid (regression for CI failure on Linux).
  it('accepts Windows-style workspace paths (platform-agnostic)', () => {
    mockDiscover.mockReturnValue(null);
    expect(resolveWorkspaceDir('Z:\\pd-nonexistent-workspace-12345')).toBe('Z:\\pd-nonexistent-workspace-12345');
  });

  // 15. PRI-957: when the discovered default is a bare cwd hit (nothing declared),
  // the override warning must not advise editing a field that does not exist.
  // Discriminating against cases 5/7, which use a declared default and keep the
  // "config default" wording.
  it('names the discovered workspace and offers the right fix when nothing was declared', () => {
    mockDiscover.mockReturnValue(
      makeDiscovery('/standing/in/codex-workspace', { source: 'cwd', declared: false }),
    );
    const stderrSpy = captureStderr();

    const result = resolveWorkspaceDir('/explicit/path');

    expect(result).toBe('/explicit/path');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('differs from workspace discovered from your current directory'),
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('dropping the override, or adding workspace.default'),
    );

    stderrSpy.mockRestore();
  });

  // 16. PRI-957: a declared config default keeps the original wording.
  it('keeps the config-default wording when the discovered default was declared', () => {
    mockDiscover.mockReturnValue(
      makeDiscovery('/declared/default', { source: 'cwd', declared: true }),
    );
    const stderrSpy = captureStderr();

    resolveWorkspaceDir('/explicit/path');

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('differs from config default "/declared/default"'),
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Consider updating workspace.default in config.'),
    );

    stderrSpy.mockRestore();
  });

  // 17. PRI-957 review P3: `-w .` inside the discovered workspace is the SAME
  // directory, so warning about a difference would mislead the operator about
  // which library gets used. Relative overrides must be compared as resolved.
  it('does NOT warn for a relative override that resolves to the discovered workspace', () => {
    mockDiscover.mockReturnValue(makeDiscovery(path.resolve('.')));
    const stderrSpy = captureStderr();

    expect(resolveWorkspaceDir('.')).toBe('.');
    expect(stderrSpy.mock.calls.map((call) => String(call[0])).join('')).toBe('');

    stderrSpy.mockRestore();
  });

  it('does NOT warn when the only difference is a trailing separator', () => {
    mockDiscover.mockReturnValue(makeDiscovery(path.resolve('.')));
    const stderrSpy = captureStderr();

    resolveWorkspaceDir(`${path.resolve('.')}/`);

    expect(stderrSpy.mock.calls.map((call) => String(call[0])).join('')).toBe('');
    stderrSpy.mockRestore();
  });

  it('still warns for a relative override that resolves elsewhere', () => {
    mockDiscover.mockReturnValue(makeDiscovery(path.resolve('..', 'other-workspace')));
    const stderrSpy = captureStderr();

    resolveWorkspaceDir('.');

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('differs from'));
    stderrSpy.mockRestore();
  });

  // 18. PRI-957 review P1: this chain is also what routes WRITE commands, so the
  // one outcome nobody declared — the inferred cwd workspace — must be stated by
  // the resolution stage, which is the sole place that declares the used target.
  it('announces the workspace when it is inferred from the current directory', () => {
    mockDiscover.mockReturnValue(
      makeDiscovery('/inferred/cwd/workspace', { source: 'cwd', declared: false }),
    );
    const stderrSpy = captureStderr();

    expect(resolveWorkspaceDir()).toBe('/inferred/cwd/workspace');

    const text = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(text).toContain('using workspace "/inferred/cwd/workspace"');
    expect(text).toContain('inferred from your current directory');
    expect(text).toContain('no workspace.default declared');
    stderrSpy.mockRestore();
  });

  it('does not announce a target the operator declared', () => {
    mockDiscover.mockReturnValue(
      makeDiscovery('/declared/default', { source: 'cwd', declared: true }),
    );
    const stderrSpy = captureStderr();

    expect(resolveWorkspaceDir()).toBe('/declared/default');
    expect(stderrSpy.mock.calls.map((call) => String(call[0])).join('')).toBe('');

    stderrSpy.mockRestore();
  });

  it('does not announce a target from the pre-existing default locations', () => {
    mockDiscover.mockReturnValue(makeDiscovery('/openclaw/workspace', { source: 'openclaw_default' }));
    const stderrSpy = captureStderr();

    expect(resolveWorkspaceDir()).toBe('/openclaw/workspace');
    expect(stderrSpy.mock.calls.map((call) => String(call[0])).join('')).toBe('');

    stderrSpy.mockRestore();
  });

  // 19. PRI-957 review round 3 P1: an unparseable config is an UNKNOWN declaration,
  // not an absent one. Without an override the chain must fail closed instead of
  // handing the standing directory to a write command.
  it('fails closed when the standing config cannot be parsed and nothing overrides it', () => {
    mockDiscover.mockReturnValue(makeUnparseable());
    expect(() => resolveWorkspaceDir()).toThrow(/Cannot resolve a workspace directory/);
  });

  // 20. The failure must name the file, the reason, and both escape hatches
  // (cli-6-output-next-action) — a bare refusal is not actionable.
  it('names the unparseable config and the explicit escape hatches when failing closed', () => {
    mockDiscover.mockReturnValue(makeUnparseable('/standing/ws/.pd/config.yaml'));
    let message = '';
    try {
      resolveWorkspaceDir();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('/standing/ws/.pd/config.yaml');
    expect(message).toContain('bad indentation at line 2');
    expect(message).toContain('--workspace');
    expect(WORKSPACE_ENV).toBe('PD_WORKSPACE_DIR');
    expect(message).toContain('PD_WORKSPACE_DIR');
  });

  // 21. Reverse test required by the review: broken config + explicit -w B must use
  // B, and the only target statement must come from the resolution stage.
  it('lets an explicit --workspace win over an unparseable config and states that target', () => {
    mockDiscover.mockReturnValue(makeUnparseable());
    const stderrSpy = captureStderr();

    const result = resolveWorkspaceDir('/explicit/b');

    expect(result).toBe('/explicit/b');
    const text = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(text).toContain('using workspace "/explicit/b" from --workspace');
    expect(text).toContain('could not be parsed');
    // No known default exists, so no "differs from" claim may appear.
    expect(text).not.toContain('differs from');

    stderrSpy.mockRestore();
  });

  // 22. Same precedence for the environment override.
  it('lets PD_WORKSPACE_DIR win over an unparseable config and states that target', () => {
    mockDiscover.mockReturnValue(makeUnparseable());
    process.env.PD_WORKSPACE_DIR = '/env/b';
    const stderrSpy = captureStderr();

    const result = resolveWorkspaceDir();

    expect(result).toBe('/env/b');
    const text = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(text).toContain('using workspace "/env/b" from PD_WORKSPACE_DIR');
    expect(text).not.toContain('differs from');

    stderrSpy.mockRestore();
  });
});
