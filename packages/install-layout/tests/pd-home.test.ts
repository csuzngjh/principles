import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PD_CODEX_HOME_ENV,
  PD_OPENCLAW_HOME_ENV,
  PD_OPENCLAW_STATE_DIR_ENV,
  PD_WORKBUDDY_CONFIG_DIR_ENV,
  isPathWithinRoot,
  resolvePdHome,
} from '../src/index.js';

/**
 * PRI-872: the isolation contract is FAIL-CLOSED. Each rejection below is a
 * path a real dual-open attempt can take, so each one is a separate test rather
 * than a table-driven afterthought.
 */
const created: string[] = [];

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pd-home-${label}-`));
  created.push(dir);
  return dir;
}

function linkDir(target: string, linkPath: string): void {
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows keeps handles open; the run-level temp lifecycle reclaims it.
    }
  }
});

describe('resolvePdHome — production mode', () => {
  it('derives the historical layout when PD_EXPERIMENT_ROOT is absent', () => {
    const home = tempDir('prod');
    const resolution = resolvePdHome({ env: {}, homeDir: home });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.mode).toBe('production');
    expect(resolution.homeDir).toBe(path.resolve(home));
    expect(resolution.pdHome).toBe(path.join(path.resolve(home), '.pd'));
    expect(resolution.consoleConfigDir).toBe(path.join(path.resolve(home), '.pd-console'));
    expect(resolution.openclawHome).toBe(path.join(path.resolve(home), '.openclaw'));
    expect(resolution.codexHome).toBe(path.join(path.resolve(home), '.codex'));
    expect(resolution.codexWorkspaceDir).toBe(path.join(path.resolve(home), '.codex', 'pd-workspace'));
    expect(resolution.workbuddyConfigDir).toBe(path.join(path.resolve(home), '.workbuddy'));
    expect(resolution.workbuddyWorkspaceDir).toBe(path.join(path.resolve(home), '.workbuddy', 'pd-workspace'));
    expect(resolution.runtimeDir).toBe(path.join(path.resolve(home), '.pd', 'runtime'));
    expect(resolution.pdRuntimeBackupsDir).toBe(path.join(path.resolve(home), '.pd', 'backups'));
    // The legacy OpenClaw-only backups root is NOT part of the resolution
    // contract: the canonical root is <PD_HOME>/.pd/backups and relocating the
    // old root is the installer's explicit migrateLegacyPdBackups operation.
    expect(path.resolve(path.join(resolution.openclawHome, 'pd-backups'))).not.toBe(path.resolve(resolution.pdRuntimeBackupsDir));
    expect(resolution.openclawExtensionDir).toBe(path.join(path.resolve(home), '.openclaw', 'extensions', 'principles-disciple'));
    expect(resolution.experimentRoot).toBeUndefined();
  });

  it('keeps honouring OPENCLAW_HOME', () => {
    const home = tempDir('prod-oc');
    const openclaw = tempDir('prod-oc-home');
    const resolution = resolvePdHome({ env: { [PD_OPENCLAW_HOME_ENV]: openclaw }, homeDir: home });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.openclawHome).toBe(path.resolve(openclaw));
  });

  it('honours OPENCLAW_STATE_DIR when set (PRI-1165)', () => {
    const home = tempDir('prod-state');
    const state = tempDir('prod-state-dir');
    const resolution = resolvePdHome({ env: { [PD_OPENCLAW_STATE_DIR_ENV]: state }, homeDir: home });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.openclawHome).toBe(path.resolve(state));
  });

  it('prefers OPENCLAW_STATE_DIR over OPENCLAW_HOME', () => {
    const home = tempDir('prod-both');
    const state = tempDir('prod-both-state');
    const openclaw = tempDir('prod-both-oc');
    const resolution = resolvePdHome({
      env: { [PD_OPENCLAW_STATE_DIR_ENV]: state, [PD_OPENCLAW_HOME_ENV]: openclaw },
      homeDir: home,
    });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.openclawHome).toBe(path.resolve(state));
  });

  it('honours Codex and WorkBuddy host config overrides without relocating their workspaces', () => {
    const home = tempDir('prod-host-overrides');
    const codexHome = tempDir('prod-codex-home');
    const workbuddyHome = tempDir('prod-workbuddy-home');
    const resolution = resolvePdHome({
      env: { [PD_CODEX_HOME_ENV]: codexHome, [PD_WORKBUDDY_CONFIG_DIR_ENV]: workbuddyHome },
      homeDir: home,
    });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.codexHome).toBe(path.resolve(codexHome));
    expect(resolution.codexWorkspaceDir).toBe(path.join(path.resolve(codexHome), 'pd-workspace'));
    expect(resolution.workbuddyConfigDir).toBe(path.resolve(workbuddyHome));
    expect(resolution.workbuddyWorkspaceDir).toBe(path.join(path.resolve(workbuddyHome), 'pd-workspace'));
  });

  it('refuses a relative OPENCLAW_STATE_DIR (fail-closed)', () => {
    const home = tempDir('prod-state-rel');
    const resolution = resolvePdHome({ env: { [PD_OPENCLAW_STATE_DIR_ENV]: 'state' }, homeDir: home });

    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toBe('openclaw_state_dir_not_absolute');
  });
});

describe('resolvePdHome — experiment mode', () => {
  it('derives every PD-owned directory under the experiment root', () => {
    const home = tempDir('exp-home');
    const root = tempDir('exp-root');

    const resolution = resolvePdHome({ env: { PD_EXPERIMENT_ROOT: root }, homeDir: home });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.mode).toBe('experiment');
    expect(resolution.experimentRoot).toBe(fs.realpathSync.native(root));
    expect(resolution.homeDir).toBe(fs.realpathSync.native(root));
    expect(resolution.pdHome).toBe(path.join(resolution.homeDir, '.pd'));
    expect(resolution.consoleConfigDir).toBe(path.join(resolution.homeDir, '.pd-console'));
    expect(resolution.codexHome).toBe(path.join(resolution.homeDir, '.codex'));
    expect(resolution.codexWorkspaceDir).toBe(path.join(resolution.homeDir, '.codex', 'pd-workspace'));
    expect(resolution.workbuddyConfigDir).toBe(path.join(resolution.homeDir, '.workbuddy'));
    expect(resolution.workbuddyWorkspaceDir).toBe(path.join(resolution.homeDir, '.workbuddy', 'pd-workspace'));
    // The whole point: nothing points at the production home any more.
    expect(resolution.pdHome.startsWith(path.resolve(home))).toBe(false);
    expect(resolution.consoleConfigDir.startsWith(path.resolve(home))).toBe(false);
  });

  it('accepts an OPENCLAW_HOME that lives inside the root', () => {
    const home = tempDir('exp-oc-home');
    const root = tempDir('exp-oc-root');
    const openclaw = path.join(root, 'custom-openclaw');
    fs.mkdirSync(openclaw);

    const resolution = resolvePdHome({
      env: { PD_EXPERIMENT_ROOT: root, [PD_OPENCLAW_HOME_ENV]: openclaw },
      homeDir: home,
    });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.openclawHome).toBe(path.resolve(openclaw));
  });

  it('accepts OPENCLAW_STATE_DIR inside the root (what the launcher passes)', () => {
    const home = tempDir('exp-state-home');
    const root = tempDir('exp-state-root');
    const state = path.join(root, '.openclaw');
    fs.mkdirSync(state);

    const resolution = resolvePdHome({
      env: { PD_EXPERIMENT_ROOT: root, [PD_OPENCLAW_STATE_DIR_ENV]: state },
      homeDir: home,
    });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.openclawHome).toBe(path.resolve(state));
  });

  it('accepts Codex and WorkBuddy host config overrides inside the root', () => {
    const home = tempDir('exp-host-override-home');
    const root = tempDir('exp-host-override-root');
    const codexHome = path.join(root, 'codex-home');
    const workbuddyHome = path.join(root, 'workbuddy-home');
    fs.mkdirSync(codexHome);
    fs.mkdirSync(workbuddyHome);

    const resolution = resolvePdHome({
      env: {
        PD_EXPERIMENT_ROOT: root,
        [PD_CODEX_HOME_ENV]: codexHome,
        [PD_WORKBUDDY_CONFIG_DIR_ENV]: workbuddyHome,
      },
      homeDir: home,
    });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.codexHome).toBe(path.resolve(codexHome));
    expect(resolution.workbuddyConfigDir).toBe(path.resolve(workbuddyHome));
  });

  it('rejects Codex and WorkBuddy host config overrides outside the root', () => {
    const home = tempDir('exp-host-out-home');
    const root = tempDir('exp-host-out-root');
    const outside = tempDir('exp-host-outside');

    const codex = resolvePdHome({
      env: { PD_EXPERIMENT_ROOT: root, [PD_CODEX_HOME_ENV]: outside },
      homeDir: home,
    });
    expect(codex.ok).toBe(false);
    if (!codex.ok) expect(codex.reason).toBe('codex_home_outside_experiment');

    const workbuddy = resolvePdHome({
      env: { PD_EXPERIMENT_ROOT: root, [PD_WORKBUDDY_CONFIG_DIR_ENV]: outside },
      homeDir: home,
    });
    expect(workbuddy.ok).toBe(false);
    if (!workbuddy.ok) expect(workbuddy.reason).toBe('workbuddy_config_dir_outside_experiment');
  });

  it('rejects relative Codex and WorkBuddy host config overrides in experiment mode', () => {
    const home = tempDir('exp-host-rel-home');
    const root = tempDir('exp-host-rel-root');

    const codex = resolvePdHome({
      env: { PD_EXPERIMENT_ROOT: root, [PD_CODEX_HOME_ENV]: 'codex-home' },
      homeDir: home,
    });
    expect(codex.ok).toBe(false);
    if (!codex.ok) expect(codex.reason).toBe('codex_home_not_absolute');

    const workbuddy = resolvePdHome({
      env: { PD_EXPERIMENT_ROOT: root, [PD_WORKBUDDY_CONFIG_DIR_ENV]: 'workbuddy-home' },
      homeDir: home,
    });
    expect(workbuddy.ok).toBe(false);
    if (!workbuddy.ok) expect(workbuddy.reason).toBe('workbuddy_config_dir_not_absolute');
  });

  it('rejects an experiment root that overlaps the production WorkBuddy home', () => {
    const home = tempDir('exp-workbuddy-overlap-home');
    const workbuddy = path.join(home, '.workbuddy');
    fs.mkdirSync(workbuddy);
    const resolution = resolvePdHome({ env: { PD_EXPERIMENT_ROOT: workbuddy }, homeDir: home });

    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.reason).toBe('experiment_root_overlaps_production');
  });

  it('rejects a WorkBuddy workspace junction that escapes the experiment root', () => {
    const home = tempDir('exp-workbuddy-link-home');
    const root = tempDir('exp-workbuddy-link-root');
    const productionWorkspace = path.join(home, '.workbuddy', 'pd-workspace');
    const experimentWorkbuddy = path.join(root, '.workbuddy');
    fs.mkdirSync(productionWorkspace, { recursive: true });
    fs.mkdirSync(experimentWorkbuddy, { recursive: true });
    linkDir(productionWorkspace, path.join(experimentWorkbuddy, 'pd-workspace'));

    const resolution = resolvePdHome({ env: { PD_EXPERIMENT_ROOT: root }, homeDir: home });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.reason).toBe('experiment_path_escapes_root');
  });

  it('rejects OPENCLAW_STATE_DIR outside the root', () => {
    const home = tempDir('exp-state-out-home');
    const root = tempDir('exp-state-out-root');
    const outside = tempDir('exp-state-out');
    const resolution = resolvePdHome({
      env: { PD_EXPERIMENT_ROOT: root, [PD_OPENCLAW_STATE_DIR_ENV]: outside },
      homeDir: home,
    });

    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toBe('openclaw_state_dir_outside_experiment');
  });

  it('rejects a relative OPENCLAW_STATE_DIR in experiment mode', () => {
    const home = tempDir('exp-state-rel-home');
    const root = tempDir('exp-state-rel-root');
    const resolution = resolvePdHome({
      env: { PD_EXPERIMENT_ROOT: root, [PD_OPENCLAW_STATE_DIR_ENV]: 'state' },
      homeDir: home,
    });

    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toBe('openclaw_state_dir_not_absolute');
  });
});

describe('resolvePdHome — refusals (never falls back to the real home)', () => {
  function expectRefusal(env: Record<string, string>, homeDir: string, reason: string): void {
    const resolution = resolvePdHome({ env, homeDir });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toBe(reason);
    expect(resolution.nextAction.length).toBeGreaterThan(0);
  }

  it('rejects an empty value instead of treating it as unset', () => {
    expectRefusal({ PD_EXPERIMENT_ROOT: '   ' }, tempDir('r-empty'), 'experiment_root_empty');
  });

  it('rejects a relative path', () => {
    expectRefusal({ PD_EXPERIMENT_ROOT: 'pd-labs/run-1' }, tempDir('r-rel'), 'experiment_root_not_absolute');
  });

  it('rejects a missing directory', () => {
    const home = tempDir('r-missing');
    expectRefusal(
      { PD_EXPERIMENT_ROOT: path.join(home, 'does-not-exist') },
      home,
      'experiment_root_missing',
    );
  });

  it('rejects a path that is not a directory', () => {
    const home = tempDir('r-file');
    const file = path.join(home, 'not-a-dir.txt');
    fs.writeFileSync(file, 'x');
    expectRefusal({ PD_EXPERIMENT_ROOT: file }, home, 'experiment_root_not_directory');
  });

  it('rejects the production PD home itself', () => {
    const home = tempDir('r-same');
    const pdHome = path.join(home, '.pd');
    fs.mkdirSync(pdHome);
    expectRefusal({ PD_EXPERIMENT_ROOT: pdHome }, home, 'experiment_root_overlaps_production');
  });

  it('rejects an ancestor of the production state (the user home)', () => {
    const home = tempDir('r-ancestor');
    fs.mkdirSync(path.join(home, '.pd'));
    expectRefusal({ PD_EXPERIMENT_ROOT: home }, home, 'experiment_root_overlaps_production');
  });

  it('rejects a derived directory that links into the production install', () => {
    const home = tempDir('r-escape');
    const root = tempDir('r-escape-root');
    const productionPd = path.join(home, '.pd');
    fs.mkdirSync(productionPd);
    // `<root>/.pd` junctioned to the production `~/.pd`: a prefix check on the
    // DECLARED path would pass while every write lands in production.
    linkDir(productionPd, path.join(root, '.pd'));

    expectRefusal({ PD_EXPERIMENT_ROOT: root }, home, 'experiment_path_escapes_root');
  });

  it('rejects OPENCLAW_HOME pointing outside the root', () => {
    const home = tempDir('r-oc');
    const root = tempDir('r-oc-root');
    const outside = tempDir('r-oc-outside');
    expectRefusal(
      { PD_EXPERIMENT_ROOT: root, [PD_OPENCLAW_HOME_ENV]: outside },
      home,
      'openclaw_home_outside_experiment',
    );
  });

  it('rejects a runtime/backups/extension leaf junctioned into the production install', () => {
    const home = tempDir('r-leaf-escape');
    const root = tempDir('r-leaf-escape-root');
    const productionPd = path.join(home, '.pd');
    fs.mkdirSync(productionPd);
    // `<root>/.pd` itself is a NORMAL directory, but its runtime/backups leaves
    // are junctions into production: the first boundary pass only inspects the
    // config roots, so the DERIVED leaves need their own link-aware check
    // (the extension leaf derives from the FINAL openclawHome, finalized
    // after the first pass — same second-pass coverage).
    fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
    const experimentOpenclaw = path.join(root, '.openclaw');
    fs.mkdirSync(path.join(experimentOpenclaw, 'extensions'), { recursive: true });
    fs.mkdirSync(path.join(productionPd, 'backups'), { recursive: true });
    fs.mkdirSync(path.join(productionPd, 'runtime'), { recursive: true });
    const productionExtensions = path.join(home, '.openclaw', 'extensions', 'principles-disciple');
    fs.mkdirSync(productionExtensions, { recursive: true });
    linkDir(path.join(productionPd, 'backups'), path.join(root, '.pd', 'backups'));
    linkDir(path.join(productionPd, 'runtime'), path.join(root, '.pd', 'runtime'));
    linkDir(productionExtensions, path.join(experimentOpenclaw, 'extensions', 'principles-disciple'));

    expectRefusal({ PD_EXPERIMENT_ROOT: root }, home, 'experiment_path_escapes_root');
  });

  it('still accepts a normal experiment layout whose derived leaf dirs already exist', () => {
    const home = tempDir('r-leaf-ok');
    const root = tempDir('r-leaf-ok-root');
    fs.mkdirSync(path.join(root, '.pd', 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(root, '.pd', 'backups'), { recursive: true });
    fs.mkdirSync(path.join(root, '.openclaw', 'extensions', 'principles-disciple'), { recursive: true });

    const resolution = resolvePdHome({ env: { PD_EXPERIMENT_ROOT: root }, homeDir: home });

    expect(resolution.ok).toBe(true);
  });
});

describe('isPathWithinRoot', () => {
  it('accepts equality and descendants, rejects siblings and parents', () => {
    const root = path.resolve('/tmp/pd-labs/run');
    expect(isPathWithinRoot(root, root)).toBe(true);
    expect(isPathWithinRoot(root, path.join(root, '.pd'))).toBe(true);
    expect(isPathWithinRoot(root, path.dirname(root))).toBe(false);
    expect(isPathWithinRoot(root, path.join(root, '..', 'other'))).toBe(false);
  });
});
