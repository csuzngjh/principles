/**
 * Unit tests for PD backup location utilities (pd-backups.ts).
 *
 * Invariants under test:
 * 1. Backups are reserved under <OPENCLAW_HOME>/pd-backups — NEVER inside the
 *    extensions dir that OpenClaw plugin discovery scans (duplicate plugin id
 *    warning, see pd-backups.ts header).
 * 2. Same-millisecond reservations are unique.
 * 3. migrateLegacyExtensionBackups moves legacy ".pd-backup-*" and
 *    "principles-disciple.backup.<ms>" siblings out of extensions/, leaves
 *    everything else untouched, and reports failures with a reason (rc-9).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Partial mock of fs: renameSync is a vi.fn wrapping the real implementation
// so the rename-failure test can override it (same pattern as update.test.ts
// — ESM namespace exports are not configurable, so spyOn is not possible).
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
  };
});

import {
  resolvePdBackupsRoot,
  reservePdBackupDestination,
  migrateLegacyExtensionBackups,
} from '../../../src/server/utils/pd-backups.js';

let tmpHome: string;
let savedOpenclawHome: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-backups-test-'));
  savedOpenclawHome = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = tmpHome;
});

afterEach(async () => {
  // Restore real renameSync in case a test overrode it
  const realFs = await vi.importActual<typeof import('fs')>('fs');
  vi.mocked(fs.renameSync).mockImplementation(realFs.renameSync);
  if (savedOpenclawHome === undefined) delete process.env.OPENCLAW_HOME;
  else process.env.OPENCLAW_HOME = savedOpenclawHome;
  if (tmpHome && fs.existsSync(tmpHome)) {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

describe('resolvePdBackupsRoot', () => {
  it('is outside the extensions dir that OpenClaw scans for plugins', () => {
    const root = resolvePdBackupsRoot();
    expect(root).toBe(path.join(tmpHome, 'pd-backups'));
    expect(path.dirname(root)).toBe(tmpHome);
    expect(root).not.toContain(`${path.sep}extensions${path.sep}`);
  });
});

describe('reservePdBackupDestination', () => {
  it('reserves an existing directory under the backups root', () => {
    const dest = reservePdBackupDestination('principles-disciple');
    expect(path.dirname(dest)).toBe(resolvePdBackupsRoot());
    expect(fs.existsSync(dest)).toBe(true);
    expect(path.basename(dest).startsWith('principles-disciple-')).toBe(true);
  });

  it('returns unique paths for same-millisecond reservations', () => {
    const first = reservePdBackupDestination('principles-disciple');
    const second = reservePdBackupDestination('principles-disciple');
    expect(first).not.toBe(second);
    expect(fs.existsSync(first)).toBe(true);
    expect(fs.existsSync(second)).toBe(true);
  });
});

describe('migrateLegacyExtensionBackups', () => {
  // Fixture helper: only accepts paths that resolve inside the extensions
  // root — the root is the boundary and no fixture may traverse out of it.
  function createLegacy(name: string, marker = 'legacy'): string {
    const extensionsRoot = path.resolve(tmpHome, 'extensions');
    const dir = path.resolve(extensionsRoot, name);
    if (dir !== extensionsRoot && !dir.startsWith(extensionsRoot + path.sep)) {
      throw new Error(`test fixture escapes extensions root: ${name}`);
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'marker.txt'), marker);
    return dir;
  }

  it('moves legacy console-updater and installer backups out of extensions/', () => {
    const dotBackup = createLegacy('.pd-backup-2026-08-13T14-12-57-972Z', 'console');
    const installerBackup = createLegacy('principles-disciple.backup.1783175678041', 'installer');

    const result = migrateLegacyExtensionBackups();

    expect(result.movedFrom.sort()).toEqual([dotBackup, installerBackup].sort());
    expect(result.failed).toEqual([]);
    expect(fs.existsSync(dotBackup)).toBe(false);
    expect(fs.existsSync(installerBackup)).toBe(false);
    // Content preserved at the new location
    const migratedMarker = path.join(resolvePdBackupsRoot(), '.pd-backup-2026-08-13T14-12-57-972Z', 'marker.txt');
    expect(fs.readFileSync(migratedMarker, 'utf-8')).toBe('console');
    const installerMarker = path.join(resolvePdBackupsRoot(), 'principles-disciple.backup.1783175678041', 'marker.txt');
    expect(fs.readFileSync(installerMarker, 'utf-8')).toBe('installer');
  });

  it('leaves the live plugin dir, other plugins, and non-directory entries untouched', () => {
    const pluginDir = path.join(tmpHome, 'extensions', 'principles-disciple');
    fs.mkdirSync(pluginDir, { recursive: true });
    const otherPlugin = path.join(tmpHome, 'extensions', 'some-other-plugin');
    fs.mkdirSync(otherPlugin, { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'extensions', '.pd-backup-not-a-dir.txt'), 'file');

    const result = migrateLegacyExtensionBackups();

    expect(result.movedFrom).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(fs.existsSync(pluginDir)).toBe(true);
    expect(fs.existsSync(otherPlugin)).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, 'extensions', '.pd-backup-not-a-dir.txt'))).toBe(true);
  });

  it('suffixed rename when the destination name already exists in pd-backups', () => {
    createLegacy('.pd-backup-2026-01-01T00-00-00-000Z', 'in-extensions');
    // Pre-existing dir with the same name in the backups root
    const existing = path.join(resolvePdBackupsRoot(), '.pd-backup-2026-01-01T00-00-00-000Z');
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(path.join(existing, 'marker.txt'), 'already-in-backups');

    const result = migrateLegacyExtensionBackups();

    expect(result.movedFrom.length).toBe(1);
    expect(result.failed).toEqual([]);
    // Original in backups root is untouched; the migrated one got a suffix
    expect(fs.readFileSync(path.join(existing, 'marker.txt'), 'utf-8')).toBe('already-in-backups');
    const suffixed = path.join(resolvePdBackupsRoot(), '.pd-backup-2026-01-01T00-00-00-000Z-1', 'marker.txt');
    expect(fs.existsSync(suffixed)).toBe(true);
  });

  it('reports a structured failure when rename fails (rc-9), still migrates others', async () => {
    createLegacy('.pd-backup-A', 'a');
    createLegacy('.pd-backup-B', 'b');
    const realFs = await vi.importActual<typeof import('fs')>('fs');
    vi.mocked(fs.renameSync).mockImplementation((from: fs.PathLike, to: fs.PathLike) => {
      if (from.toString().endsWith('.pd-backup-A')) {
        throw new Error('EPERM: rename locked');
      }
      return realFs.renameSync(from, to);
    });

    const result = migrateLegacyExtensionBackups();

    expect(result.movedFrom.length).toBe(1);
    expect(result.movedFrom[0]).toContain('.pd-backup-B');
    expect(result.failed.length).toBe(1);
    expect(result.failed[0]?.name).toBe('.pd-backup-A');
    expect(result.failed[0]?.reason).toContain('EPERM');
    expect(fs.existsSync(path.join(tmpHome, 'extensions', '.pd-backup-A'))).toBe(true);
  });

  it('returns empty result when the extensions dir does not exist', () => {
    const result = migrateLegacyExtensionBackups();
    expect(result.movedFrom).toEqual([]);
    expect(result.failed).toEqual([]);
  });
});
