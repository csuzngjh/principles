import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrateLegacyOverlay } from '../src/update/legacy-migration.js';
import { readHistoryEvents } from '../src/update/update-history.js';
import { readActiveRecord, readTransactionJournalForRecovery } from '../src/update/transaction-journal.js';
import { readInstallConfig, readBootstrapManifest } from '../src/update/install-layout.js';

// Crash-injection seam: node:fs's ESM namespace cannot be spied directly, so
// the write path is wrapped through vi.mock with a hoisted control slot.
// Empty target = pure delegation (all other tests see the real fs).
const crashInjection = vi.hoisted(() => ({ target: '' }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: ((target: unknown, data: unknown, options: unknown) => {
      if (typeof target === 'string' && crashInjection.target !== ''
        && target.includes(crashInjection.target) && target.includes('.pd')) {
        throw new Error(`INJECTED_CRASH:${crashInjection.target}`);
      }
      return actual.writeFileSync(target as never, data as never, options as never);
    }) as typeof actual.writeFileSync,
  };
});

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

  it('returns the structured overlay refusal when package.json is invalid JSON', () => {
    const home = tempRoot('pd-mig-json-');
    const overlayDir = path.join(home, '.openclaw', 'extensions', 'principles-disciple', 'plugin');
    fs.mkdirSync(overlayDir, { recursive: true });
    fs.writeFileSync(path.join(overlayDir, 'package.json'), '{');
    const result = migrateLegacyOverlay({
      homeDir: home, openclawHome: path.join(home, '.openclaw'),
      invokedByOfficialInstaller: true, dryRun: false, bootstrapVersion: '1.0.0', transactionId: 'mig-json',
    });
    expect(result).toMatchObject({ migrated: false, reason: 'overlay_manifest_invalid' });
  });

  // Journal-first crash injection (SPEC §8): EVERY transition must already be
  // persisted when its side effect is attempted. Crashing exactly at each
  // side effect leaves a journal that never understates reality — the
  // recovery rules can then decide old/new/refusal without guessing.
  it('appends each journal transition BEFORE its side effect (crash injected at every write)', () => {
    const cases: readonly { crashOn: string; expectedLastTransition: string }[] = [
      { crashOn: 'bootstrap.json', expectedLastTransition: 'staged' },
      { crashOn: 'releases', expectedLastTransition: 'probed' },
      { crashOn: 'install.json', expectedLastTransition: 'confirmed' },
    ];
    for (const testCase of cases) {
      const home = tempRoot('pd-mig-crash-');
      createOverlay(home);
      crashInjection.target = testCase.crashOn;
      try {
        const crashed = migrateLegacyOverlay({
          homeDir: home,
          openclawHome: path.join(home, '.openclaw'),
          invokedByOfficialInstaller: true,
          dryRun: false,
          bootstrapVersion: '1.0.0',
          transactionId: 'mig-crash',
        });
        expect(crashed.migrated).toBe(true); // must NOT reach here
        throw new Error(`crash injection on ${testCase.crashOn} never fired`);
      } catch (error) {
        expect(String(error)).toMatch(new RegExp(`INJECTED_CRASH:${testCase.crashOn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      } finally {
        crashInjection.target = '';
      }

      const journalPath = path.join(home, '.pd', 'transactions', 'mig-crash.jsonl');
      const journalRead = readTransactionJournalForRecovery(journalPath);
      expect(journalRead.tornTailDetected).toBe(false);
      const last = journalRead.transitions[journalRead.transitions.length - 1];
      expect(last?.to).toBe(testCase.expectedLastTransition);
      // The side effect that crashed did not land.
      if (testCase.crashOn === 'bootstrap.json') {
        expect(fs.existsSync(path.join(home, '.pd', 'bootstrap', 'bootstrap.json'))).toBe(false);
        expect(fs.existsSync(path.join(home, '.pd', 'active.json'))).toBe(false);
      }
      if (testCase.crashOn === 'install.json') {
        expect(fs.existsSync(path.join(home, '.pd', 'install.json'))).toBe(false);
      }
    }
  });
});
