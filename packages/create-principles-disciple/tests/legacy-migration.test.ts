import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateLegacyOverlay } from '../src/update/legacy-migration.js';
import { readHistoryEvents } from '../src/update/update-history.js';
import { readActiveRecord } from '../src/update/transaction-journal.js';
import { readInstallConfig, readBootstrapManifest } from '../src/update/install-layout.js';

const temporaryDirectories: string[] = [];

function tempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  temporaryDirectories.push(root);
  return root;
}

function createOverlay(homeRoot: string, pluginVersion = '1.218.0'): string {
  const openclawHome = path.join(homeRoot, '.openclaw');
  const overlayDir = path.join(openclawHome, 'extensions', 'principles-disciple');
  fs.mkdirSync(path.join(overlayDir, 'plugin'), { recursive: true });
  fs.writeFileSync(path.join(overlayDir, 'plugin', 'package.json'), JSON.stringify({
    name: 'principles-disciple',
    version: pluginVersion,
  }));
  fs.writeFileSync(path.join(overlayDir, 'plugin', 'dist-marker.txt'), 'overlay payload');
  return overlayDir;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

describe('official legacy overlay migration (SPEC 15 / 18-9)', () => {
  it('dry-run plans every step without touching disk', () => {
    const home = tempRoot('pd-mig-dry-');
    const overlayDir = createOverlay(home);
    const result = migrateLegacyOverlay({
      homeDir: home,
      openclawHome: path.join(home, '.openclaw'),
      invokedByOfficialInstaller: true,
      dryRun: true,
      bootstrapVersion: '1.0.0',
      transactionId: 'mig-001',
    });
    expect(result.migrated).toBe(true);
    if (!result.migrated) return;
    expect(result.dryRun).toBe(true);
    expect(result.productVersion).toBe('1.218.0');
    expect(result.steps).toHaveLength(5);
    expect(result.overlayDir).toBe(overlayDir);
    expect(fs.existsSync(path.join(home, '.pd', 'active.json'))).toBe(false);
    expect(fs.readFileSync(path.join(overlayDir, 'plugin', 'dist-marker.txt'), 'utf8')).toBe('overlay payload');
  });

  it('migrates under the official installer and preserves the overlay read-only', () => {
    const home = tempRoot('pd-mig-run-');
    const overlayDir = createOverlay(home);
    const before = fs.readFileSync(path.join(overlayDir, 'plugin', 'package.json'), 'utf8');

    const result = migrateLegacyOverlay({
      homeDir: home,
      openclawHome: path.join(home, '.openclaw'),
      invokedByOfficialInstaller: true,
      dryRun: false,
      bootstrapVersion: '1.0.0',
      transactionId: 'mig-002',
    });
    expect(result.migrated).toBe(true);

    const pdHome = path.join(home, '.pd');
    const active = readActiveRecord(path.join(pdHome, 'active.json'));
    expect(active).toMatchObject({ generation: 1, productVersion: '1.218.0' });
    if (result.migrated) {
      expect(active?.releaseId).toBe(result.releaseId);
    }
    expect(readBootstrapManifest({ bootstrapManifestPath: path.join(pdHome, 'bootstrap', 'bootstrap.json') } as never))
      .toMatchObject({ bootstrapVersion: '1.0.0' });
    expect(readInstallConfig({ installConfigPath: path.join(pdHome, 'install.json') } as never))
      .toMatchObject({ channel: 'stable', autoCheck: false });

    // Overlay untouched — read-only diagnostics, zero mutation.
    expect(fs.readFileSync(path.join(overlayDir, 'plugin', 'package.json'), 'utf8')).toBe(before);

    const events = readHistoryEvents(path.join(pdHome, 'logs', 'history.jsonl'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'legacy_migration',
      outcome: 'succeeded',
      productVersion: '1.218.0',
    });
  });

  it('refuses when the overlay is missing, already migrated, or invoked outside the official installer', () => {
    const empty = tempRoot('pd-mig-none-');
    const missing = migrateLegacyOverlay({
      homeDir: empty, openclawHome: path.join(empty, '.openclaw'),
      invokedByOfficialInstaller: true, dryRun: true, bootstrapVersion: '1.0.0', transactionId: 'mig-x',
    });
    expect(missing).toMatchObject({ migrated: false, reason: 'overlay_missing' });

    const home = tempRoot('pd-mig-scope-');
    createOverlay(home);
    const outOfScope = migrateLegacyOverlay({
      homeDir: home, openclawHome: path.join(home, '.openclaw'),
      invokedByOfficialInstaller: false, dryRun: true, bootstrapVersion: '1.0.0', transactionId: 'mig-y',
    });
    expect(outOfScope).toMatchObject({ migrated: false, reason: 'bootstrap_write_out_of_scope' });
    if (!outOfScope.migrated) {
      expect(outOfScope.nextAction).toMatch(/official installer/i);
    }
    expect(fs.existsSync(path.join(home, '.pd'))).toBe(false);

    const migrated = migrateLegacyOverlay({
      homeDir: home, openclawHome: path.join(home, '.openclaw'),
      invokedByOfficialInstaller: true, dryRun: false, bootstrapVersion: '1.0.0', transactionId: 'mig-z',
    });
    expect(migrated.migrated).toBe(true);
    const again = migrateLegacyOverlay({
      homeDir: home, openclawHome: path.join(home, '.openclaw'),
      invokedByOfficialInstaller: true, dryRun: false, bootstrapVersion: '1.0.0', transactionId: 'mig-z2',
    });
    expect(again).toMatchObject({ migrated: false, reason: 'already_migrated' });
  });

  it('refuses an overlay with a malformed plugin manifest loudly', () => {
    const home = tempRoot('pd-mig-bad-');
    const overlayDir = path.join(home, '.openclaw', 'extensions', 'principles-disciple', 'plugin');
    fs.mkdirSync(overlayDir, { recursive: true });
    fs.writeFileSync(path.join(overlayDir, 'package.json'), JSON.stringify({ version: 'not-a-version' }));
    const result = migrateLegacyOverlay({
      homeDir: home, openclawHome: path.join(home, '.openclaw'),
      invokedByOfficialInstaller: true, dryRun: false, bootstrapVersion: '1.0.0', transactionId: 'mig-bad',
    });
    expect(result).toMatchObject({ migrated: false, reason: 'overlay_manifest_invalid' });
  });
});
