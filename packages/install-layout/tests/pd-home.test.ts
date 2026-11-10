import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PD_OPENCLAW_HOME_ENV,
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
