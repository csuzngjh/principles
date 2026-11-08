/**
 * Codex Marketplace install contract (2026-11-07).
 *
 * The retired global-hook installer never writes; the Codex end state is
 * reported in three honest states (installed / not_installed / unknown). A
 * pending manual step is NOT an install failure: it must not roll back other
 * hosts (--host all defect) but must surface as an explicit partial
 * completion. Hermetic: only os.homedir is mocked (mutable holder); all file
 * assertions run against a real temp tree.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CodexHostInstaller, detectCodexMarketplaceState } from '../src/installers/codex-host-installer.js';
import { getHostInstallers } from '../src/installers/index.js';
import { partitionHostInstallResults, type InstallResult } from '../src/installer.js';
import { toInstallJsonOutput } from '../src/index.js';
import type { HostInstallContext, HostInstallResult } from '@principles/core/host';

const homeState = vi.hoisted(() => ({ home: '' }));
vi.mock('os', () => ({ homedir: () => homeState.home }));

let home = '';

/** Containment-checked join: every fixture path must resolve inside home. */
function underHome(...segments: string[]): string {
  const target = path.resolve(home, ...segments);
  if (target !== home && !target.startsWith(home + path.sep)) throw new Error('fixture escapes home');
  return target;
}

function writeMarketVersion(version: string): void {
  const dir = underHome('.codex', 'plugins', 'cache', 'principles', 'principles-disciple', version);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'runtime-version.json'), '{}');
}

function codexCtx(): HostInstallContext {
  return { workspaceDir: underHome('project'), pluginDir: underHome('payload'), language: 'en', mode: 'smart' };
}

function newTempHome(prefix: string): void {
  home = fs.mkdtempSync(path.join(process.env.TEMP ?? process.cwd(), prefix));
  homeState.home = home;
}

function dropTempHome(): void {
  if (home.length > 0) fs.rmSync(home, { recursive: true, force: true });
  home = '';
}

/** Every file under home must live inside our known fixture roots. */
function assertNoWritesOutsideFixtures(): void {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else files.push(abs);
    }
  };
  walk(home);
  const allowed = ['plugins', 'cache', 'principles', 'principles-disciple', 'project', 'payload', '.codex'];
  const unexpected = files.filter((f) => {
    const rel = path.relative(home, f);
    return !allowed.some((seg) => rel.split(path.sep).includes(seg)) && !rel.endsWith('hooks.json');
  });
  expect(unexpected).toEqual([]);
}

describe('detectCodexMarketplaceState — three states (read-only)', () => {
  beforeAll(() => newTempHome('pd-codex-mkt-'));
  afterAll(dropTempHome);

  it('reports not_installed when the marketplace cache root is absent', () => {
    expect(detectCodexMarketplaceState(underHome('.codex'))).toEqual({ state: 'not_installed' });
  });

  it('reports installed with the highest semver dir carrying runtime-version.json', () => {
    writeMarketVersion('1.2.3');
    writeMarketVersion('1.10.0');
    fs.mkdirSync(underHome('.codex', 'plugins', 'cache', 'principles', 'principles-disciple', 'not-a-version'), { recursive: true });
    fs.mkdirSync(underHome('.codex', 'plugins', 'cache', 'principles', 'principles-disciple', '2.0.0'), { recursive: true });
    const state = detectCodexMarketplaceState(underHome('.codex'));
    expect(state.state).toBe('installed');
    if (state.state === 'installed') expect(state.version).toBe('1.10.0');
  });

  it('reports unknown when the cache root exists but cannot be read', () => {
    // A FILE at the cache-root path: readdirSync fails (ENOTDIR) — a real
    // unreadable-cache shape that must stay unknown, never guessed.
    const fileRoot = underHome('.codex2', 'plugins', 'cache', 'principles', 'principles-disciple');
    fs.mkdirSync(path.dirname(fileRoot), { recursive: true });
    fs.writeFileSync(fileRoot, 'not a directory');
    const state = detectCodexMarketplaceState(underHome('.codex2'));
    expect(state.state).toBe('unknown');
  });

  it('does not mistake a default-home plugin for the active relative CODEX_HOME', () => {
    // The old mirror rejected a relative override and silently fell back to
    // ~/.codex, returning false installed-success for the wrong instance.
    writeMarketVersion('9.9.9');
    const previous = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = 'relative-codex-home-not-installed';
      expect(detectCodexMarketplaceState().state).toBe('not_installed');
      process.env.CODEX_HOME = home + path.sep + 'nested' + path.sep + '..' + path.sep + 'custom-codex';
      expect(detectCodexMarketplaceState().state).toBe('not_installed');
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });

  it('returns UNKNOWN rather than NOT_INSTALLED when a semver version has an unreadable pin', () => {
    const codexHome = underHome('.codex-corrupt');
    const versionDir = path.join(codexHome, 'plugins', 'cache', 'principles', 'principles-disciple', '1.2.3');
    fs.mkdirSync(versionDir, { recursive: true });
    fs.writeFileSync(path.join(versionDir, 'runtime-version.json'), '{invalid-json');
    const state = detectCodexMarketplaceState(codexHome);
    expect(state.state).toBe('unknown');
    if (state.state === 'unknown') expect(state.reason).toContain('runtime pin cannot be verified');
  });

  it('parity: agrees with pd-cli selectMarketplaceCacheVersionDir on a fixture matrix (ERR-126)', async () => {
    // The installer's read-only classifier mirrors pd-cli's health authority
    // because the npx package must not depend on pd-cli. This parity test
    // pins the two shapes together the same way the legacy-registration
    // parser parity test does (EP-06/ERR-126: a live mirror is a pinned
    // twin, not an independent truth).
    const { selectMarketplaceCacheVersionDir } = await import('../../pd-cli/src/services/codex-plugin-install.js');

    const scenario = (layout: Record<string, boolean>): string => {
      const codexHome = underHome('.parity', Object.keys(layout).join('-') || 'empty');
      const cache = path.join(codexHome, 'plugins', 'cache', 'principles', 'principles-disciple');
      for (const [dirName, withPin] of Object.entries(layout)) {
        fs.mkdirSync(path.join(cache, dirName), { recursive: true });
        if (withPin) fs.writeFileSync(path.join(cache, dirName, 'runtime-version.json'), '{}');
        if (!withPin) fs.writeFileSync(path.join(cache, dirName, 'runtime-version.json'), 'not-json');
      }
      return codexHome;
    };

    const matrix: Record<string, Record<string, boolean>> = {
      'absent-cache': {},
      'single-version': { '1.2.3': true },
      'highest-wins': { '1.2.3': true, '1.10.0': true },
      'corrupt-pin-ignored': { '1.2.3': true, '2.0.0': false },
      'non-semver-ignored': { '1.2.3': true, 'main': true },
    };
    for (const [name, layout] of Object.entries(matrix)) {
      const codexHome = scenario(layout);
      const authority = selectMarketplaceCacheVersionDir(codexHome);
      const mirror = detectCodexMarketplaceState(codexHome);
      expect(mirror.state, name).toBe(authority === null ? 'not_installed' : 'installed');
      if (authority !== null && mirror.state === 'installed') {
        expect(mirror.version, name).toBe(authority.dirName);
      }
    }
  });
});

describe('CodexHostInstaller.install — Marketplace contract (real temp home)', () => {
  beforeAll(() => newTempHome('pd-codex-install-'));
  afterAll(dropTempHome);

  it('manual action required when the Marketplace plugin is not installed (A4 #1, #5)', async () => {
    const result = await new CodexHostInstaller().install(codexCtx());
    expect(result.success).toBe(false);
    expect(result.manualActionRequired).toBe(true);
    expect(result.reason).toContain('not installed');
    expect(result.nextAction).toContain('codex plugin add principles-disciple@principles');
    assertNoWritesOutsideFixtures();
  });

  it('already-installed marketplace is a preserved success, idempotent re-run (A4 #2, #8)', async () => {
    writeMarketVersion('1.2.3');
    const installer = new CodexHostInstaller();
    const first = await installer.install(codexCtx());
    expect(first.success).toBe(true);
    expect(first.configAction).toBe('preserved');
    expect(first.manualActionRequired).toBeUndefined();
    expect(first.reason).toContain('1.2.3');
    const second = await installer.install(codexCtx());
    expect(second.success).toBe(true);
    expect(second.configAction).toBe('preserved');
    expect(second.reason).toBe(first.reason);
    assertNoWritesOutsideFixtures();
  });

  it('legacy hook registration routes to the explicit migration (manual action)', async () => {
    const hooksDir = underHome('.codex');
    fs.mkdirSync(hooksDir, { recursive: true });
    const legacyGroup = {
      matcher: '.*',
      hooks: [{ type: 'command', command: 'node pd-hook.cjs', timeout: 5, async: true }],
      __pd_marker: 'pd-owned',
    };
    fs.writeFileSync(path.join(hooksDir, 'hooks.json'), JSON.stringify({ PostToolUse: [legacyGroup] }));
    const result = await new CodexHostInstaller().install(codexCtx());
    expect(result.success).toBe(false);
    expect(result.manualActionRequired).toBe(true);
    expect(result.nextAction).toContain('uninstall --host codex');
    expect(result.nextAction).toContain('codex plugin add principles-disciple@principles');
  });

  it('unverifiable marketplace state stays a manual action, never guessed success', async () => {
    // A FILE at the cache-root path (ENOTDIR on read) → the detector reports
    // unknown; install() must keep the honest manual-action verdict. The
    // legacy hooks.json from the previous test is removed first — the legacy
    // detection would otherwise win before the marketplace check runs.
    fs.rmSync(underHome('.codex', 'hooks.json'), { force: true });
    const fileRoot = underHome('.codexu', 'plugins', 'cache', 'principles', 'principles-disciple');
    fs.mkdirSync(path.dirname(fileRoot), { recursive: true });
    fs.writeFileSync(fileRoot, 'not a directory');
    process.env.CODEX_HOME = underHome('.codexu');
    try {
      const result = await new CodexHostInstaller().install(codexCtx());
      expect(result.success).toBe(false);
      expect(result.manualActionRequired).toBe(true);
      expect(result.reason).toContain('could not be verified');
    } finally {
      delete process.env.CODEX_HOME;
    }
  });
});

describe('--host all host set — WorkBuddy stays opt-in (A4 #6)', () => {
  it('all resolves to exactly openclaw + codex', () => {
    expect(getHostInstallers('all').map((installer) => installer.hostId)).toEqual(['openclaw', 'codex']);
  });
});

describe('partitionHostInstallResults — manual actions are not failures (A4 #3, #4)', () => {
  const manual: HostInstallResult = {
    success: false, hostId: 'codex', configAction: 'skipped',
    manualActionRequired: true, reason: 'not installed', nextAction: 'codex plugin add',
  };
  const ok: HostInstallResult = { success: true, hostId: 'openclaw', configAction: 'updated', nextAction: 'none' };
  const broken: HostInstallResult = {
    success: false, hostId: 'openclaw', configAction: 'skipped',
    reason: 'config write failed', nextAction: 'fix permissions',
  };

  it('openclaw success + codex manual → zero failures, no rollback signal (A4 #3)', () => {
    const { failures, manualActions } = partitionHostInstallResults([ok, manual]);
    expect(failures).toEqual([]);
    expect(manualActions.map((r) => r.hostId)).toEqual(['codex']);
  });

  it('a real failure still partitions as a failure (A4 #4)', () => {
    const { failures, manualActions } = partitionHostInstallResults([broken, manual]);
    expect(failures.map((r) => r.hostId)).toEqual(['openclaw']);
    expect(manualActions.map((r) => r.hostId)).toEqual(['codex']);
  });

  it('success results land in neither bucket', () => {
    const { failures, manualActions } = partitionHostInstallResults([ok]);
    expect(failures).toEqual([]);
    expect(manualActions).toEqual([]);
  });
});

describe('toInstallJsonOutput — partial completion is machine-readable (A4 #7)', () => {
  const manual: HostInstallResult = {
    success: false, hostId: 'codex', configAction: 'skipped',
    manualActionRequired: true, reason: 'not installed', nextAction: 'codex plugin add',
  };

  function baseResult(overrides: Partial<InstallResult>): InstallResult {
    return {
      success: false,
      workspaceDir: 'W',
      configYamlPath: 'C',
      templatesCount: 0,
      components: { plugin: 'verified', cli: 'verified', console: 'configured' } as InstallResult['components'],
      verification: { features: 'passed', storyA: 'passed' } as InstallResult['verification'],
      enabledChannels: [],
      nextAction: 'N',
      ...overrides,
    };
  }

  it('exposes manualActions + non-success when a manual step is pending', () => {
    const result = baseResult({
      manualActions: [manual],
      hostResults: [manual],
      reason: 'Partial completion: host "codex" requires a manual step (not installed)',
    });
    const output = toInstallJsonOutput(result);
    expect(output.success).toBe(false);
    const actions = output.manualActions as Array<{ hostId: string; reason?: string; nextAction: string }>;
    expect(actions).toHaveLength(1);
    expect(actions[0]?.hostId).toBe('codex');
    expect(actions[0]?.nextAction).toContain('codex plugin add');
    expect(output.reason).toContain('Partial completion');
  });

  it('omits manualActions on fully successful runs', () => {
    const output = toInstallJsonOutput(baseResult({ success: true }));
    expect(output.success).toBe(true);
    expect(Object.hasOwn(output, 'manualActions')).toBe(false);
  });
});
