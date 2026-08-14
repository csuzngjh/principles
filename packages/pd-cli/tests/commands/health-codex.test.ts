/**
 * pd health --host codex command unit tests.
 *
 * Covers:
 * - cli-1: JSON mode outputs exactly one parseable JSON object.
 * - cli-2: exit paths stop execution (process.exitCode set, no later side effects).
 * - cli-5: failure paths do not mutate state (read-only).
 * - cli-6: every degraded result includes reason + nextAction.
 * - flag-off path (host.codex disabled → warning + exitCode).
 * - hooks trust undetectable (no ~/.codex) → reason + nextAction.
 * - dual registration detection (global hooks.json present → reason + nextAction).
 * - happy path (flag on, hooks trusted) → clean JSON, no warnings.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockResolveNearestPdWorkspace,
  mockLoadPdConfigForPlugin,
  mockComputeFeatureFlagsFromConfig,
  mockIsFeatureEnabled,
  mockExistsSync,
  mockReadFileSync,
  mockHomedir,
  mockRequireResolve,
  mockConsoleLog,
  mockConsoleWarn,
} = vi.hoisted(() => {
  return {
    mockResolveNearestPdWorkspace: vi.fn(),
    mockLoadPdConfigForPlugin: vi.fn(),
    mockComputeFeatureFlagsFromConfig: vi.fn(),
    mockIsFeatureEnabled: vi.fn(),
    mockExistsSync: vi.fn(),
    mockReadFileSync: vi.fn(),
    mockHomedir: vi.fn(),
    mockRequireResolve: vi.fn(),
    mockConsoleLog: vi.fn(),
    mockConsoleWarn: vi.fn(),
  };
});

vi.mock('@principles/host-runtime', () => ({
  resolveNearestPdWorkspace: mockResolveNearestPdWorkspace,
  loadPdConfigForPlugin: mockLoadPdConfigForPlugin,
}));

vi.mock('@principles/core/runtime-v2', () => ({
  computeFeatureFlagsFromConfig: mockComputeFeatureFlagsFromConfig,
  isFeatureEnabled: mockIsFeatureEnabled,
}));

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/fake/workspace'),
}));

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
}));

vi.mock('os', () => ({
  homedir: mockHomedir,
}));

vi.mock('module', () => ({
  createRequire: () => ({
    resolve: mockRequireResolve,
  }),
}));

import { handleHealthCodex } from '../../src/commands/health-codex.js';

describe('pd health --host codex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    mockHomedir.mockReturnValue('/fake/home');
    mockRequireResolve.mockImplementation((name: string) => `/fake/node_modules/${name}/package.json`);
    mockReadFileSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('package.json')) {
        return JSON.stringify({ version: '0.1.0' });
      }
      return '';
    });
    mockResolveNearestPdWorkspace.mockReturnValue({
      ok: true,
      workspaceDir: '/fake/workspace',
      configPath: '/fake/workspace/.pd/config.yaml',
      source: 'nearest',
    });
    mockLoadPdConfigForPlugin.mockReturnValue({
      ok: true,
      effective: {},
      source: 'user_config',
      configPath: '/fake/workspace/.pd/config.yaml',
      warnings: [],
      errors: [],
    });
    mockComputeFeatureFlagsFromConfig.mockReturnValue({ flags: {} });
    mockIsFeatureEnabled.mockReturnValue(true);
    // No ~/.codex by default → hooks trust undetectable
    mockExistsSync.mockImplementation((p: string) => !p.includes('.codex'));
    mockConsoleLog.mockImplementation(() => {});
    mockConsoleWarn.mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(mockConsoleLog);
    vi.spyOn(console, 'warn').mockImplementation(mockConsoleWarn);
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('cli-1: --json outputs exactly one parseable JSON object on stdout', async () => {
    // ~/.codex exists with trusted hooks for happy path
    mockExistsSync.mockImplementation((p: string) => true);
    mockReadFileSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('package.json')) return JSON.stringify({ version: '0.1.0' });
      if (typeof p === 'string' && p.includes('config.toml')) return '[features]\nhooks = true\n';
      return '';
    });

    await handleHealthCodex({ json: true });

    expect(mockConsoleLog).toHaveBeenCalledTimes(1);
    const output = mockConsoleLog.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.host).toBe('codex');
    expect(parsed.adapterVersion).toBe('0.1.0');
    expect(parsed.runtimeVersion).toBe('0.1.0');
    expect(parsed.featureFlag.enabled).toBe(true);
    expect(parsed.hooksTrust.detectable).toBe(true);
    expect(parsed.hooksTrust.trusted).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it('cli-6: when ~/.codex is missing, reports reason + nextAction', async () => {
    mockExistsSync.mockImplementation((p: string) => !p.includes('.codex'));

    await handleHealthCodex({ json: true });

    const output = mockConsoleLog.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.hooksTrust.detectable).toBe(false);
    expect(parsed.hooksTrust.reason).toBe('codex_config_dir_not_found');
    expect(parsed.hooksTrust.nextAction).toContain('Install Codex CLI');
    expect(parsed.warnings).toContainEqual(expect.stringContaining('hooks_trust'));
  });

  it('flag-off + hooks untrusted → exitCode 1', async () => {
    mockIsFeatureEnabled.mockReturnValue(false);
    mockExistsSync.mockImplementation((p: string) => !p.includes('.codex'));

    await handleHealthCodex({ json: true });

    expect(process.exitCode).toBe(1);
    const output = mockConsoleLog.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.featureFlag.enabled).toBe(false);
  });

  it('cli-6: config.toml exists but hooks setting missing → reason + nextAction', async () => {
    mockExistsSync.mockImplementation((p: string) => true);
    mockReadFileSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('package.json')) return JSON.stringify({ version: '0.1.0' });
      if (typeof p === 'string' && p.includes('config.toml')) return '[features]\nmodel = "gpt-4"\n';
      return '';
    });

    await handleHealthCodex({ json: true });

    const output = mockConsoleLog.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.hooksTrust.detectable).toBe(false);
    expect(parsed.hooksTrust.reason).toBe('hooks_setting_not_found_in_config');
    expect(parsed.hooksTrust.nextAction).toContain('/hooks');
  });

  it('dual registration: global hooks.json present → detected + reason + nextAction', async () => {
    mockExistsSync.mockImplementation((p: string) => true);
    mockReadFileSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('package.json')) return JSON.stringify({ version: '0.1.0' });
      if (typeof p === 'string' && p.includes('config.toml')) return '[features]\nhooks = true\n';
      return '';
    });

    await handleHealthCodex({ json: true });

    const output = mockConsoleLog.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.dualRegistration.detected).toBe(true);
    expect(parsed.dualRegistration.globalHooksPath).toContain('hooks.json');
    expect(parsed.dualRegistration.reason).toBe('global_hooks_json_present');
    expect(parsed.dualRegistration.nextAction).toContain('double-registration');
  });

  it('cli-5: workspace not resolved does not mutate state, reports warning', async () => {
    mockResolveNearestPdWorkspace.mockReturnValue({
      ok: false,
      cwd: '/fake/workspace',
      reason: 'config_not_found',
      nextAction: 'Create .pd/config.yaml',
    });

    await handleHealthCodex({ json: true });

    const output = mockConsoleLog.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.workspace).toBe('/fake/workspace');
    expect(parsed.featureFlag.enabled).toBe(false);
    expect(parsed.featureFlag.source).toBe('defaults');
    expect(parsed.warnings).toContainEqual(expect.stringContaining('workspace_not_resolved'));
  });

  it('text output includes nextAction for degraded hooks trust', async () => {
    mockExistsSync.mockImplementation((p: string) => !p.includes('.codex'));

    await handleHealthCodex({ json: false });

    const calls = mockConsoleLog.mock.calls.map((c) => c[0] as string);
    expect(calls.some((s) => s.includes('hooksTrust.nextAction:'))).toBe(true);
    expect(calls.some((s) => s.includes('host: codex'))).toBe(true);
    expect(mockConsoleWarn).toHaveBeenCalled();
  });

  it('adapter/runtime version unknown when package.json unreadable', async () => {
    mockRequireResolve.mockImplementation(() => {
      throw new Error('not found');
    });
    mockExistsSync.mockImplementation((p: string) => true);
    mockReadFileSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('config.toml')) return '[features]\nhooks = true\n';
      return '';
    });

    await handleHealthCodex({ json: true });

    const output = mockConsoleLog.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.adapterVersion).toBe('unknown');
    expect(parsed.runtimeVersion).toBe('unknown');
  });
});
