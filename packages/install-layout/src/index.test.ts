import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getInstallLayoutPaths,
  getConsoleServerEntry,
  getMcpServerEntry,
  getWorkbuddyHostConfigPaths,
  getWorkbuddyWorkspaceDir,
  installManifestHostsForPersist,
  parseInstallManifest,
  resolveInstallLayout,
  resolveOpenClawConfigPath,
  mergeInstallManifestWorkspaces,
  setInstallManifestBackgroundExecution,
  type BackgroundExecutionRecord,
} from './index.js';

// Workspace fixtures MUST be absolute for the platform running the suite:
// `path.isAbsolute('D:/Code/ws-a')` is false on Linux, so a hardcoded drive
// letter makes these tests pass only on Windows and hides the real contract.
// Derive every fixture from os.tmpdir(); win32-specific rules are covered by
// the injected-platform test at the bottom of this file.
const WS_ROOT = path.resolve(os.tmpdir(), 'pd-install-layout-test');
const ws = (name: string): string => path.join(WS_ROOT, name);


describe('resolveOpenClawConfigPath', () => {
  const home = path.join(os.tmpdir(), 'oc-home');

  it('uses OPENCLAW_CONFIG_PATH before OPENCLAW_STATE_DIR before the default home config', () => {
    expect(resolveOpenClawConfigPath({}, home)).toEqual({
      ok: true,
      path: path.join(home, '.openclaw', 'openclaw.json'),
      source: 'default',
    });
    expect(resolveOpenClawConfigPath({ OPENCLAW_STATE_DIR: '/state' }, home)).toEqual({
      ok: true,
      path: path.join('/state', 'openclaw.json'),
      source: 'state_dir',
    });
    expect(resolveOpenClawConfigPath({ OPENCLAW_STATE_DIR: '/state', OPENCLAW_CONFIG_PATH: '/explicit/openclaw.json' }, home)).toEqual({
      ok: true,
      path: path.resolve('/explicit/openclaw.json'),
      source: 'config_path',
    });
  });

  it('resolves relative user-supplied paths with OpenClaw host cwd semantics', () => {
    const cwd = path.join(os.tmpdir(), 'oc-cwd');
    expect(resolveOpenClawConfigPath({ OPENCLAW_STATE_DIR: 'relative-state' }, home, cwd)).toEqual({
      ok: true,
      path: path.join(cwd, 'relative-state', 'openclaw.json'),
      source: 'state_dir',
    });
    expect(resolveOpenClawConfigPath({ OPENCLAW_CONFIG_PATH: 'relative.json' }, home, cwd)).toEqual({
      ok: true,
      path: path.join(cwd, 'relative.json'),
      source: 'config_path',
    });
  });

  it('matches OpenClaw 2026.11.5 HOME, profile, tilde and precedence rules', () => {
    const cwd = path.join(os.tmpdir(), 'oc-cwd');
    const ocHome = path.join(os.tmpdir(), 'oc-openclaw-home');
    expect(resolveOpenClawConfigPath({ OPENCLAW_HOME: ocHome }, home, cwd)).toEqual({
      ok: true,
      path: path.join(ocHome, '.openclaw', 'openclaw.json'),
      source: 'openclaw_home',
    });
    expect(resolveOpenClawConfigPath({ OPENCLAW_HOME: ocHome, OPENCLAW_PROFILE: 'client-a' }, home, cwd)).toEqual({
      ok: true,
      path: path.join(ocHome, '.openclaw-client-a', 'openclaw.json'),
      source: 'profile',
    });
    expect(resolveOpenClawConfigPath({ OPENCLAW_PROFILE: 'default' }, home, cwd).path).toBe(path.join(home, '.openclaw', 'openclaw.json'));
    expect(resolveOpenClawConfigPath({ OPENCLAW_PROFILE: 'not valid!' }, home, cwd).path).toBe(path.join(home, '.openclaw', 'openclaw.json'));
    expect(resolveOpenClawConfigPath({ OPENCLAW_CONFIG_PATH: '~/isolated/openclaw.json' }, home, cwd)).toEqual({
      ok: true,
      path: path.join(home, 'isolated', 'openclaw.json'),
      source: 'config_path',
    });
    expect(resolveOpenClawConfigPath({ OPENCLAW_STATE_DIR: '~/state' }, home, cwd).path).toBe(path.join(home, 'state', 'openclaw.json'));
    expect(resolveOpenClawConfigPath({
      OPENCLAW_CONFIG_PATH: '/explicit/openclaw.json',
      OPENCLAW_STATE_DIR: '/state',
      OPENCLAW_HOME: ocHome,
      OPENCLAW_PROFILE: 'client-a',
    }, home, cwd).path).toBe(path.resolve('/explicit/openclaw.json'));
    expect(resolveOpenClawConfigPath({
      OPENCLAW_STATE_DIR: '/state',
      OPENCLAW_HOME: ocHome,
      OPENCLAW_PROFILE: 'client-a',
    }, home, cwd).path).toBe(path.join('/state', 'openclaw.json'));
  });

  it('falls back to cwd when no home is available, matching OpenClaw resolveRequiredHomeDir', () => {
    const cwd = path.join(os.tmpdir(), 'oc-no-home-cwd');
    expect(resolveOpenClawConfigPath({}, '', cwd)).toEqual({
      ok: true,
      path: path.join(cwd, '.openclaw', 'openclaw.json'),
      source: 'default',
    });
  });

  it('uses host-platform absolute path semantics for explicit paths', () => {
    const explicit = process.platform === 'win32' ? 'C:\\openclaw\\openclaw.json' : '/explicit/openclaw.json';
    expect(resolveOpenClawConfigPath({ OPENCLAW_CONFIG_PATH: explicit }, home).path).toBe(path.resolve(explicit));
  });
});

describe('install layout', () => {
  it('resolves a canonical Codex-only install without OpenClaw', () => {
    const paths = getInstallLayoutPaths('C:/Users/alice');
    const result = resolveInstallLayout({
      homeDir: 'C:/Users/alice',
      manifest: { layoutVersion: 1, mode: 'canonical', hosts: ['codex'] },
      canonicalRuntimeExists: true,
      legacyExtensionExists: false,
    });
    expect(result.mode).toBe('canonical');
    expect(result.manifest?.hosts).toEqual(['codex']);
    expect(paths.openClawExtensionDir).toContain('.openclaw');
    expect(paths.pluginDir).toContain('plugin');
    expect(paths.installLayoutDir).toContain('install-layout');
    expect(getConsoleServerEntry(result.paths, 'canonical')).toContain('.pd');
    // Gate 4 (PRI-1071): one SSoT for the shared MCP server component/entry.
    expect(paths.mcpServerDir).toBe(path.join(paths.runtimeDir, 'pd-mcp-server'));
    expect(getMcpServerEntry(paths)).toBe(path.join(paths.runtimeDir, 'pd-mcp-server', 'dist', 'index.js'));
  });

  it('derives the host installation directory from OPENCLAW_STATE_DIR while keeping PD runtime host-neutral', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-layout-prod-home-'));
    const openclawState = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-layout-openclaw-state-'));
    try {
      const paths = getInstallLayoutPaths(home, { OPENCLAW_STATE_DIR: openclawState });
      expect(paths.homeDir).toBe(path.resolve(home));
      expect(paths.pdDir).toBe(path.join(path.resolve(home), '.pd'));
      expect(paths.runtimeDir).toBe(path.join(path.resolve(home), '.pd', 'runtime'));
      expect(paths.openClawDir).toBe(path.resolve(openclawState));
      expect(paths.openClawExtensionDir).toBe(path.join(path.resolve(openclawState), 'extensions', 'principles-disciple'));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(openclawState, { recursive: true, force: true });
    }
  });

  it('uses PD_EXPERIMENT_ROOT for every shared install path without touching the production home', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-layout-prod-home-'));
    const experimentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-layout-experiment-root-'));
    try {
      const paths = getInstallLayoutPaths(home, { PD_EXPERIMENT_ROOT: experimentRoot });
      expect(paths.homeDir).toBe(fs.realpathSync.native(experimentRoot));
      expect(paths.pdDir).toBe(path.join(fs.realpathSync.native(experimentRoot), '.pd'));
      expect(paths.runtimeDir).toBe(path.join(fs.realpathSync.native(experimentRoot), '.pd', 'runtime'));
      expect(paths.openClawDir).toBe(path.join(fs.realpathSync.native(experimentRoot), '.openclaw'));
      expect(paths.openClawExtensionDir).toBe(path.join(fs.realpathSync.native(experimentRoot), '.openclaw', 'extensions', 'principles-disciple'));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(experimentRoot, { recursive: true, force: true });
    }
  });

  it('falls back to legacy only when the old extension exists', () => {
    const result = resolveInstallLayout({
      homeDir: '/home/alice',
      manifest: undefined,
      canonicalRuntimeExists: false,
      legacyExtensionExists: true,
    });
    expect(result.mode).toBe('legacy');
    expect(result.nextAction).toContain('migrate');
  });

  it('rejects malformed manifests instead of silently treating them as canonical', () => {
    expect(parseInstallManifest({ layoutVersion: 1, mode: 'canonical', hosts: [123] })).toEqual({
      error: 'install_manifest_malformed: hosts must be an array of host name strings',
    });
    expect(parseInstallManifest({ layoutVersion: 1, mode: 'canonical', hosts: [] }).error).toContain('hosts');
    expect(parseInstallManifest({ layoutVersion: 1, mode: 'canonical', hosts: 'codex' }).error).toContain('hosts');
  });

  it('re-reads its own output idempotently (all-unknown-hosts round trip)', () => {
    const first = parseInstallManifest({ layoutVersion: 1, mode: 'canonical', hosts: ['gamma'] });
    expect(first.error).toBeUndefined();
    const second = parseInstallManifest(first.manifest);
    expect(second.error).toBeUndefined();
    expect(second.manifest).toEqual(first.manifest);
    expect(second.warnings).toEqual(first.warnings);
  });

  // ── Forward compatibility (2026-10-16 incident) ─────────────────────────────
  // A manifest written by a NEWER installer must never read as "broken" in an
  // OLDER reader: the pre-WorkBuddy parser rejected the 3-host production
  // manifest as install_manifest_malformed, which resolveInstallLayout turned
  // into a legacy/missing fallback and the Companion surfaced as
  // "未找到已安装�?PD / console_runtime_not_installed" on a healthy install.

  it('accepts the production 3-host manifest (openclaw + codex + workbuddy) without warnings', () => {
    const { manifest, warnings, error } = parseInstallManifest({
      layoutVersion: 1,
      mode: 'canonical',
      hosts: ['openclaw', 'codex', 'workbuddy'],
      workspaces: [ws('codex-pd-workspace'), ws('workbuddy-pd-workspace')],
    });
    expect(error).toBeUndefined();
    expect(warnings).toBeUndefined();
    expect(manifest?.hosts).toEqual(['openclaw', 'codex', 'workbuddy']);
    expect(manifest?.unknownHosts).toBeUndefined();
  });

  it('tolerates an unknown future 4th host as a structured warning �?never "malformed"', () => {
    const { manifest, warnings, error } = parseInstallManifest({
      layoutVersion: 1,
      mode: 'canonical',
      hosts: ['codex', 'openclaw', 'workbuddy', 'gamma'],
      workspaces: [ws('gamma-workspace')],
    });
    expect(error).toBeUndefined();
    expect(manifest?.hosts).toEqual(['codex', 'openclaw', 'workbuddy']);
    expect(manifest?.unknownHosts).toEqual(['gamma']);
    expect(warnings).toEqual([{ code: 'install_manifest_unknown_host', host: 'gamma' }]);
  });

  it('resolves an unknown-host manifest to canonical when the runtime exists �?no legacy fallback (A6)', () => {
    const result = resolveInstallLayout({
      homeDir: 'C:/Users/alice',
      manifest: { layoutVersion: 1, mode: 'canonical', hosts: ['codex', 'gamma'] },
      canonicalRuntimeExists: true,
      legacyExtensionExists: true,
    });
    expect(result.mode).toBe('canonical');
    expect(result.manifest?.unknownHosts).toEqual(['gamma']);
    expect(result.warnings).toEqual([{ code: 'install_manifest_unknown_host', host: 'gamma' }]);
  });

  it('tolerates a manifest whose hosts are ALL unknown to this reader', () => {
    const { manifest, warnings } = parseInstallManifest({
      layoutVersion: 1,
      mode: 'canonical',
      hosts: ['gamma', 'delta'],
    });
    expect(manifest?.hosts).toEqual([]);
    expect(manifest?.unknownHosts).toEqual(['gamma', 'delta']);
    expect(warnings).toHaveLength(2);
    // Still a real canonical install for resolveInstallLayout.
    const resolved = resolveInstallLayout({
      homeDir: 'C:/Users/alice',
      manifest,
      canonicalRuntimeExists: true,
      legacyExtensionExists: false,
    });
    expect(resolved.mode).toBe('canonical');
  });

  it('installManifestHostsForPersist reunites known and unknown hosts for writers �?no registration loss (A5)', () => {
    const { manifest } = parseInstallManifest({
      layoutVersion: 1,
      mode: 'canonical',
      hosts: ['workbuddy', 'codex', 'gamma'],
    });
    expect(installManifestHostsForPersist(manifest)).toEqual(['workbuddy', 'codex', 'gamma']);
    expect(installManifestHostsForPersist(undefined)).toEqual([]);
  });

  it('still fails closed on an incompatible layoutVersion �?compatibility never covers version drift (A2)', () => {
    expect(parseInstallManifest({ layoutVersion: 2, mode: 'canonical', hosts: ['codex'] })).toEqual({
      error: 'install_manifest_unsupported_version: 2',
    });
    expect(parseInstallManifest({ layoutVersion: '1', mode: 'canonical', hosts: ['codex'] })).toEqual({
      error: 'install_manifest_unsupported_version: 1',
    });
  });

  // ── RF-01 (review 2026-10-16): an unreadable manifest must not be bypassed
  // through the legacy path. When the canonical runtime EXISTS, the manifest
  // is the install-state authority; refusing to honor it (newer layoutVersion,
  // structural damage) must refuse the whole resolution instead of silently
  // launching whatever sits in the legacy extension dir.

  it('RF-01: canonical runtime exists + newer layoutVersion + legacy dir present �?refuse, never legacy fallback', () => {
    const result = resolveInstallLayout({
      homeDir: 'C:/Users/alice',
      manifest: { layoutVersion: 2, mode: 'canonical', hosts: ['codex'] },
      canonicalRuntimeExists: true,
      legacyExtensionExists: true,
    });
    expect(result.mode).toBe('missing');
    expect(result.manifest).toBeUndefined();
    expect(result.reason).toBe('install_manifest_unsupported_version: 2');
  });

  it('RF-01: canonical runtime exists + structurally broken manifest + legacy dir present �?refuse, never legacy fallback', () => {
    const result = resolveInstallLayout({
      homeDir: 'C:/Users/alice',
      manifest: { layoutVersion: 1, mode: 'weird', hosts: ['codex'] },
      canonicalRuntimeExists: true,
      legacyExtensionExists: true,
    });
    expect(result.mode).toBe('missing');
    expect(result.reason).toContain('install_manifest_malformed');
  });

  it('RF-01: a genuinely legacy-only install (no manifest at all, no canonical runtime) stays discoverable', () => {
    const result = resolveInstallLayout({
      homeDir: 'C:/Users/alice',
      manifest: undefined,
      canonicalRuntimeExists: false,
      legacyExtensionExists: true,
    });
    expect(result.mode).toBe('legacy');
    expect(result.nextAction).toContain('migrate');
  });

  it('RF-01: canonical runtime ABSENT + incompatible manifest + legacy dir present �?legacy fallback remains available (nothing canonical to bypass)', () => {
    const result = resolveInstallLayout({
      homeDir: 'C:/Users/alice',
      manifest: { layoutVersion: 2, mode: 'canonical', hosts: ['codex'] },
      canonicalRuntimeExists: false,
      legacyExtensionExists: true,
    });
    expect(result.mode).toBe('legacy');
    expect(result.reason).toBe('install_manifest_unsupported_version: 2');
  });

  it('accepts workbuddy as an install host and exposes its runtime adapter dir', () => {
    const paths = getInstallLayoutPaths('C:/Users/alice');
    const result = resolveInstallLayout({
      homeDir: 'C:/Users/alice',
      manifest: { layoutVersion: 1, mode: 'canonical', hosts: ['workbuddy'] },
      canonicalRuntimeExists: true,
      legacyExtensionExists: false,
    });
    expect(result.mode).toBe('canonical');
    expect(result.manifest?.hosts).toEqual(['workbuddy']);
    expect(paths.workbuddyAdapterDir).toBe(path.join(paths.runtimeDir, 'workbuddy-adapter'));
  });

  it('freezes the WorkBuddy governance workspace under the WorkBuddy config root (OD-07)', () => {
    const dir = getWorkbuddyWorkspaceDir('C:/Users/alice');
    expect(dir).toBe(path.join(path.resolve('C:/Users/alice'), '.workbuddy', 'pd-workspace'));
    // Never collides with Codex or OpenClaw state roots.
    expect(dir).not.toContain('.pd');
    expect(dir).not.toContain('.openclaw');
  });

  it('derives the WorkBuddy governance workspace from the experiment PD Home', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-layout-workbuddy-home-'));
    const experimentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-layout-workbuddy-lab-'));
    try {
      expect(getWorkbuddyWorkspaceDir(home, undefined, { PD_EXPERIMENT_ROOT: experimentRoot }))
        .toBe(path.join(fs.realpathSync.native(experimentRoot), '.workbuddy', 'pd-workspace'));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(experimentRoot, { recursive: true, force: true });
    }
  });

  it('keeps WorkBuddy host config and governance workspace aligned under an explicit override', () => {
    const override = path.join(WS_ROOT, 'workbuddy-config');
    const workspace = getWorkbuddyWorkspaceDir(WS_ROOT, override);
    const hostPaths = getWorkbuddyHostConfigPaths(WS_ROOT, override);
    expect(workspace).toBe(path.join(override, 'pd-workspace'));
    expect(hostPaths.configDir).toBe(override);
    expect(hostPaths.settingsPath).toBe(path.join(override, 'settings.json'));
    expect(hostPaths.registryPath).toBe(path.join(override, 'plugins', 'installed_plugins.json'));
  });

  it('accepts a manifest without workspaces (pre-PRI-624 manifests stay valid)', () => {
    const { manifest, error } = parseInstallManifest({ layoutVersion: 1, mode: 'canonical', hosts: ['codex'] });
    expect(error).toBeUndefined();
    expect(manifest?.workspaces).toEqual([]);
  });

  it('parses workspaces as canonical absolute paths, deduped in insertion order', () => {
    const first = ws('ws-a');
    const second = ws('ws b');
    const { manifest, error } = parseInstallManifest({
      layoutVersion: 1,
      mode: 'canonical',
      hosts: ['codex'],
      workspaces: [first, `${first}${path.sep}`, second],
    });
    expect(error).toBeUndefined();
    expect(manifest?.workspaces?.length).toBe(2);
    expect(manifest?.workspaces?.[0]).toBe(path.resolve(first));
    expect(manifest?.workspaces).toContain(path.resolve(second));
  });

  it('rejects malformed workspace entries loudly', () => {
    expect(parseInstallManifest({ layoutVersion: 1, mode: 'canonical', hosts: ['codex'], workspaces: [''] })).toEqual({
      error: 'install_manifest_malformed: workspaces must be non-empty absolute paths',
    });
    expect(parseInstallManifest({ layoutVersion: 1, mode: 'canonical', hosts: ['codex'], workspaces: ['ws-a'] })).toEqual({
      error: 'install_manifest_malformed: workspaces must be non-empty absolute paths',
    });
  });

  it('merges a workspace into an existing manifest without duplicates', () => {
    const first = ws('ws-a');
    const merged = mergeInstallManifestWorkspaces(
      { layoutVersion: 1, mode: 'canonical', hosts: ['codex'], workspaces: [first] },
      `${first}${path.sep}`,
    );
    expect(merged.length).toBe(1);
    expect(merged[0]).toBe(path.resolve(first));
  });

  it('merge accepts unknown current manifests and starts a fresh list', () => {
    const fresh = ws('ws-b');
    const merged = mergeInstallManifestWorkspaces(undefined, fresh);
    expect(merged).toEqual([path.resolve(fresh)]);
  });

  // Injected platform keeps the win32 rule executable on ubuntu CI, where the
  // ambient path module is posix. This is the same seam used by
  // isSameMcpBindingPath in the MCP binding contract.
  it('applies win32 absolute-path rules on every host platform', () => {
    const winA = 'D:/Code/ws-a';
    const winB = 'C:/work/ws b';
    const win = parseInstallManifest(
      {
        layoutVersion: 1,
        mode: 'canonical',
        hosts: ['codex'],
        workspaces: [winA, 'D:\\Code\\ws-a', winB],
      },
      'win32',
    );
    expect(win.error).toBeUndefined();
    expect(win.manifest?.workspaces?.length).toBe(2);
    expect(win.manifest?.workspaces?.[0]).toBe(path.win32.resolve(winA));
    expect(win.manifest?.workspaces).toContain(path.win32.resolve(winB));

    // The same drive-letter path is relative under POSIX rules �?the exact
    // divergence that used to hide because the suite only ran on Windows.
    expect(
      parseInstallManifest(
        { layoutVersion: 1, mode: 'canonical', hosts: ['codex'], workspaces: [winA] },
        'posix',
      ).error,
    ).toBe('install_manifest_malformed: workspaces must be non-empty absolute paths');

    expect(
      mergeInstallManifestWorkspaces(
        { layoutVersion: 1, mode: 'canonical', hosts: ['codex'], workspaces: ['D:/Code/ws-a'] },
        'D:\\Code\\ws-a',
        'win32',
      ),
    ).toEqual([path.win32.resolve('D:/Code/ws-a')]);
  });
});

describe('per-Workspace backgroundExecutions ownership records (SPEC-PD-SERVICE-HOST-001 §8.4)', () => {
  const wsA = path.posix.resolve('/ws/a');
  const wsB = path.posix.resolve('/ws/b');
  const base = {
    layoutVersion: 1 as const, mode: 'canonical' as const, hosts: ['codex' as const],
    workspaces: [wsA, wsB],
  };
  const handover: BackgroundExecutionRecord = {
    state: 'handover_preparing', effectiveOwner: 'legacy', generation: 3,
    operationId: 'op-42', previousOwner: 'legacy', targetOwner: 'service_host',
    updatedAt: '2026-11-20T00:00:00.000Z',
  };
  const shOwned: BackgroundExecutionRecord = {
    state: 'service_host_owned', effectiveOwner: 'service_host', generation: 9,
    operationId: null, previousOwner: null, targetOwner: null,
    updatedAt: '2026-11-20T00:00:00.000Z',
  };
  const legacyOwned: BackgroundExecutionRecord = {
    state: 'legacy_owned', effectiveOwner: 'legacy', generation: 0,
    operationId: null, previousOwner: null, targetOwner: null,
    updatedAt: '2026-11-20T00:00:00.000Z',
  };

  it('absent map parses (legacy default per Workspace); multiple records round-trip', () => {
    expect(parseInstallManifest(base).manifest?.backgroundExecutions).toBeUndefined();
    const parsed = parseInstallManifest({
      ...base,
      backgroundExecutions: {[wsA]: handover, [wsB]: shOwned},
    });
    expect(parsed.error).toBeUndefined();
    expect(parsed.manifest?.backgroundExecutions).toEqual({[wsA]: handover, [wsB]: shOwned});
  });

  it('multiple Workspaces hold DIFFERENT owner states at once', () => {
    const parsed = parseInstallManifest({
      ...base,
      backgroundExecutions: {[wsA]: legacyOwned, [wsB]: shOwned},
    });
    expect(parsed.manifest?.backgroundExecutions?.[wsA]?.effectiveOwner).toBe('legacy');
    expect(parsed.manifest?.backgroundExecutions?.[wsB]?.effectiveOwner).toBe('service_host');
  });

  it('illegal state combinations are refused — semantic validation, not just types', () => {
    const combination = /illegal effectiveOwner\/previousOwner\/targetOwner\/operationId\/generation combination/;
    for (const bad of [
      {...shOwned, effectiveOwner: 'legacy'},                       // SERVICE_HOST_OWNED with legacy effectiveOwner
      {...handover, effectiveOwner: 'service_host'},               // preparing: old consumer must still own
      {...handover, previousOwner: null},                          // preparing must name the source
      {...handover, targetOwner: 'legacy'},                        // preparing must name the SH target
      {...handover, operationId: null},                            // in-flight transition needs an operation identity
      {...handover, generation: 0},                                // a transition implies >=1 accepted transition
      {...shOwned, generation: 0},
      {state: 'rollback_pending', effectiveOwner: 'service_host', generation: 4,
        operationId: 'op-9', previousOwner: 'service_host', targetOwner: 'service_host',
        updatedAt: '2026-11-20T00:00:00.000Z'},                    // prev==target is not a transition
      {...legacyOwned, operationId: 'op-1'},                       // steady state carries no operation
      {...legacyOwned, previousOwner: 'service_host'},
    ]) {
      expect(parseInstallManifest({...base, backgroundExecutions: {[wsA]: bad}}).error).toMatch(combination);
    }
  });

  it('a legal rollback_pending transition record parses', () => {
    const rollback = {
      state: 'rollback_pending', effectiveOwner: 'service_host', generation: 10,
      operationId: 'op-99', previousOwner: 'service_host', targetOwner: 'legacy',
      updatedAt: '2026-11-20T00:00:00.000Z',
    };
    const parsed = parseInstallManifest({...base, backgroundExecutions: {[wsA]: rollback}});
    expect(parsed.error).toBeUndefined();
    expect(parsed.manifest?.backgroundExecutions?.[wsA]).toEqual(rollback);
  });

  it('keys must be canonical paths of DECLARED workspaces — identity conflicts fail closed', () => {
    const mapMalformed =
      'install_manifest_malformed: backgroundExecutions must be keyed by canonical paths of declared workspaces';
    for (const key of [
      '/ws/undeclared',        // not in workspaces list
      'ws/a',                  // not absolute
      '/ws/./a',               // not canonical (resolve differs)
      '/ws/a/',                // trailing separator resolves to a different identity
    ]) {
      expect(
        parseInstallManifest({...base, backgroundExecutions: {[key]: legacyOwned}}).error,
      ).toBe(mapMalformed);
    }
    expect(
      parseInstallManifest({...base, backgroundExecutions: ['not-a-map']}).error,
    ).toBe(mapMalformed);
  });

  it('legacy single backgroundExecution migrates only to a unique workspace identity', () => {
    const oneWs = {...base, workspaces: [wsA]};
    const migrated = parseInstallManifest({...oneWs, backgroundExecution: handover});
    expect(migrated.error).toBeUndefined();
    expect(migrated.manifest?.backgroundExecutions).toEqual({[wsA]: handover});
    const ambiguous =
      'install_manifest_malformed: legacy backgroundExecution cannot be attributed to a unique workspace';
    expect(parseInstallManifest({...base, backgroundExecution: handover}).error).toBe(ambiguous);
    expect(
      parseInstallManifest({...base, workspaces: [], backgroundExecution: handover}).error,
    ).toBe(ambiguous);
    expect(
      parseInstallManifest({
        ...oneWs, backgroundExecution: handover, backgroundExecutions: {[wsA]: legacyOwned},
      }).error,
    ).toBe('install_manifest_malformed: backgroundExecution conflicts with backgroundExecutions');
  });

  it('malformed records fail closed — an untrusted ownership fact is never honored', () => {
    const malformed = 'install_manifest_malformed: backgroundExecution must be a complete ownership record';
    for (const bad of [
      'handover',
      {...handover, state: 'bogus'},
      {...handover, effectiveOwner: 'root'},
      {...handover, generation: 1.5},
      {...handover, generation: -1},
      {...handover, generation: '3'},
      {...handover, operationId: 42},
      {...handover, previousOwner: 'nobody'},
      {...handover, targetOwner: 'nobody'},
      {...handover, updatedAt: ''},
    ]) {
      expect(parseInstallManifest({...base, backgroundExecutions: {[wsA]: bad}}).error).toBe(malformed);
    }
  });

  it('setInstallManifestBackgroundExecution writes one Workspace without touching the others', () => {
    const {manifest} = parseInstallManifest({
      ...base, backgroundExecutions: {[wsA]: handover, [wsB]: legacyOwned},
    });
    expect(manifest).toBeDefined();
    const next = setInstallManifestBackgroundExecution(manifest, {workspaceDir: wsA}, shOwned);
    expect(next[wsA]).toEqual(shOwned);
    expect(next[wsB]).toEqual(legacyOwned);
    const cleared = setInstallManifestBackgroundExecution(manifest, {workspaceDir: wsA}, undefined);
    expect(cleared[wsA]).toBeUndefined();
    expect(cleared[wsB]).toEqual(legacyOwned);
    expect(manifest?.backgroundExecutions?.[wsA]).toEqual(handover);
  });
});
