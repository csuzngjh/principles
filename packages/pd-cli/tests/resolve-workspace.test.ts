/**
 * resolveWorkspaceDir tests.
 *
 * Tests the 4-step resolution chain by mocking the config loader's
 * discoverWorkspaceDefault function.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

function makeDiscovery(workspaceDefault: string): import('../src/services/pd-config-loader.js').WorkspaceDiscoveryResult {
  return {
    workspaceDefault,
    configPath: `${workspaceDefault}/.pd/config.yaml`,
    source: 'openclaw_default',
  };
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
});
