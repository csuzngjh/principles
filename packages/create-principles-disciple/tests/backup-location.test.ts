/**
 * Real-filesystem tests for PD backup placement (installer.ts + mvp-config.ts).
 *
 * Invariants under test:
 * 1. PD backups live in the host-neutral <PD_HOME>/.pd/backups root — never
 *    inside the extensions dir OpenClaw plugin discovery scans (a plugin-shaped
 *    backup is re-discovered as a second "principles-disciple" plugin and warns
 *    "duplicate plugin id detected" on every gateway startup), and never in the
 *    legacy OpenClaw-only <openclawHome>/pd-backups root.
 * 2. migrateLegacyPdBackups relocates BOTH legacy locations (the old
 *    <openclawHome>/pd-backups root and the extensions/ siblings) into the
 *    canonical root: names preserved, collisions suffixed, originals kept on
 *    failure, the old root only removed when provably empty (explicit installer
 *    operation — never an implicit Console move).
 *
 * Isolation: every path authority is redirected with PD_EXPERIMENT_ROOT (the
 * same fail-closed experiment isolation production uses). HOME redirection is
 * NOT sufficient — getHomeDir() now follows os.homedir(), which on Windows
 * reads USERPROFILE, so a HOME-only sandbox would touch the real production
 * ~/.openclaw (ERR-083 recurrence PRI-526: verify under a clean home).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Partial mock of fs: renameSync is a vi.fn wrapping the real implementation so
// the rename-failure test can override it (ESM namespace exports are not
// configurable, so spyOn is not possible — same pattern as pd-console
// update.test.ts / pd-backups.test.ts).
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
  };
});

import { getPdBackupsDir, getOpenClawDir, getPdDir } from '../src/mvp-config.js';
import { backupExistingInstall, migrateLegacyPdBackups } from '../src/installer.js';

let tmpRoot: string;
const savedEnv: Record<string, string | undefined> = {};
const ISOLATED_ENV_KEYS = [
  'PD_EXPERIMENT_ROOT',
  'OPENCLAW_STATE_DIR',
  'OPENCLAW_HOME',
  'CODEX_HOME',
  'WORKBUDDY_CONFIG_DIR',
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ISOLATED_ENV_KEYS) savedEnv[key] = process.env[key];
  tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-backup-loc-test-')));
  process.env.PD_EXPERIMENT_ROOT = tmpRoot;
  delete process.env.OPENCLAW_STATE_DIR;
  delete process.env.OPENCLAW_HOME;
  delete process.env.CODEX_HOME;
  delete process.env.WORKBUDDY_CONFIG_DIR;
});

afterEach(async () => {
  // Restore real renameSync in case a test overrode it
  const realFs = await vi.importActual<typeof import('fs')>('fs');
  vi.mocked(fs.renameSync).mockImplementation(realFs.renameSync);
  for (const key of ISOLATED_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

function extensionsRoot(): string {
  return path.join(getOpenClawDir(), 'extensions');
}

describe('getPdBackupsDir', () => {
  it('is the canonical <PD_HOME>/.pd/backups root, outside every host discovery tree', () => {
    const backupsDir = getPdBackupsDir();
    expect(backupsDir).toBe(path.join(getPdDir(), 'backups'));
    expect(backupsDir.startsWith(extensionsRoot() + path.sep)).toBe(false);
    // The legacy OpenClaw-only root is NOT the canonical root anymore.
    expect(backupsDir).not.toBe(path.join(getOpenClawDir(), 'pd-backups'));
  });
});

describe('backupExistingInstall', () => {
  it('moves the existing plugin dir into the canonical backups root, not an extensions/ sibling', () => {
    const extDir = path.join(extensionsRoot(), 'principles-disciple');
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, 'marker.txt'), 'install');

    const result = backupExistingInstall();

    expect(result.type).toBe('backed_up');
    expect(result.backupDir).not.toBeNull();
    // Backup lives under <PD_HOME>/.pd/backups — never a sibling inside extensions/
    expect(result.backupDir!.startsWith(getPdBackupsDir() + path.sep)).toBe(true);
    expect(fs.existsSync(result.backupDir!)).toBe(true);
    expect(fs.readFileSync(path.join(result.backupDir!, 'marker.txt'), 'utf-8')).toBe('install');
    // The live extension dir was renamed away (ready for fresh install)
    expect(fs.existsSync(extDir)).toBe(false);
    // extensions/ holds no backup siblings
    const siblings = fs.readdirSync(extensionsRoot());
    expect(siblings).toEqual([]);
  });

  it('returns no_existing when the plugin dir is absent', () => {
    expect(backupExistingInstall()).toEqual({ type: 'no_existing', backupDir: null });
  });

  it('does not move an OpenClaw plugin during a Codex-only install', () => {
    const extDir = path.join(extensionsRoot(), 'principles-disciple');
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, 'marker.txt'), 'openclaw-install');

    expect(backupExistingInstall('codex')).toEqual({ type: 'no_existing', backupDir: null });
    expect(fs.readFileSync(path.join(extDir, 'marker.txt'), 'utf8')).toBe('openclaw-install');
  });
});

describe('migrateLegacyPdBackups', () => {
  function createLegacy(name: string, marker: string): string {
    const root = path.resolve(extensionsRoot());
    const dir = path.resolve(root, name);
    if (!dir.startsWith(root + path.sep)) {
      throw new Error(`test fixture escapes extensions root: ${name}`);
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'marker.txt'), marker);
    return dir;
  }

  it('relocates the legacy <openclawHome>/pd-backups root (including unknown user files) into the canonical root', () => {
    const legacyRoot = path.join(getOpenClawDir(), 'pd-backups');
    const legacyBackup = path.join(legacyRoot, 'principles-disciple.backup.1700000000000');
    fs.mkdirSync(legacyBackup, { recursive: true });
    fs.writeFileSync(path.join(legacyBackup, 'marker.txt'), 'legacy-openclaw-backup');
    // Unknown user file directly under the old root — Owner data, moved verbatim.
    fs.writeFileSync(path.join(legacyRoot, 'notes.txt'), 'owner-notes');

    const result = migrateLegacyPdBackups();

    expect(result.failed).toEqual([]);
    expect(result.movedFrom).toContain(legacyBackup);
    expect(fs.readFileSync(path.join(getPdBackupsDir(), 'principles-disciple.backup.1700000000000', 'marker.txt'), 'utf-8'))
      .toBe('legacy-openclaw-backup');
    expect(fs.readFileSync(path.join(getPdBackupsDir(), 'notes.txt'), 'utf-8')).toBe('owner-notes');
    // The old root is removed only after its contents were relocated.
    expect(fs.existsSync(legacyRoot)).toBe(false);
  });

  it('keeps the old pd-backups root when a move fails (original data preserved)', async () => {
    const legacyRoot = path.join(getOpenClawDir(), 'pd-backups');
    const locked = path.join(legacyRoot, 'principles-disciple.backup.1');
    const movable = path.join(legacyRoot, 'principles-disciple.backup.2');
    fs.mkdirSync(locked, { recursive: true });
    fs.mkdirSync(movable, { recursive: true });
    fs.writeFileSync(path.join(locked, 'marker.txt'), 'locked');
    fs.writeFileSync(path.join(movable, 'marker.txt'), 'movable');
    const realFs = await vi.importActual<typeof import('fs')>('fs');
    vi.mocked(fs.renameSync).mockImplementation((from: fs.PathLike, to: fs.PathLike) => {
      if (String(from) === movable) {
        throw new Error('EPERM: rename locked');
      }
      return realFs.renameSync(from, to);
    });

    const result = migrateLegacyPdBackups();

    expect(result.failed).toEqual([{ name: 'principles-disciple.backup.2', reason: expect.stringContaining('EPERM') }]);
    // The entry whose rename succeeded moved to the canonical root...
    expect(fs.readFileSync(path.join(getPdBackupsDir(), 'principles-disciple.backup.1', 'marker.txt'), 'utf-8')).toBe('locked');
    expect(fs.existsSync(locked)).toBe(false);
    // ...while the failed entry stays at the old location, byte-identical.
    expect(fs.readFileSync(path.join(movable, 'marker.txt'), 'utf-8')).toBe('movable');
    // A non-empty legacy root is NEVER deleted.
    expect(fs.existsSync(legacyRoot)).toBe(true);
  });

  it('suffixed rename when the destination name already exists in the canonical root (old entry untouched)', () => {
    const legacyRoot = path.join(getOpenClawDir(), 'pd-backups');
    fs.mkdirSync(path.join(legacyRoot, 'old-backup'), { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, 'old-backup', 'marker.txt'), 'legacy');
    const existing = path.join(getPdBackupsDir(), 'old-backup');
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(path.join(existing, 'marker.txt'), 'already-migrated');

    const result = migrateLegacyPdBackups();

    expect(result.failed).toEqual([]);
    expect(result.movedFrom.length).toBe(1);
    expect(fs.readFileSync(path.join(existing, 'marker.txt'), 'utf-8')).toBe('already-migrated');
    expect(fs.readFileSync(path.join(getPdBackupsDir(), 'old-backup-1', 'marker.txt'), 'utf-8')).toBe('legacy');
  });

  it('moves legacy .pd-backup-* and principles-disciple.backup.* dirs out of extensions/', () => {
    const dotBackup = createLegacy('.pd-backup-2026-08-13T14-12-57-972Z', 'console');
    const installerBackup = createLegacy('principles-disciple.backup.1783175678041', 'installer');
    const livePlugin = path.join(extensionsRoot(), 'principles-disciple');
    fs.mkdirSync(livePlugin, { recursive: true });

    const result = migrateLegacyPdBackups();

    expect(result.failed).toEqual([]);
    expect(fs.existsSync(dotBackup)).toBe(false);
    expect(fs.existsSync(installerBackup)).toBe(false);
    expect(fs.existsSync(livePlugin)).toBe(true);
    expect(fs.readFileSync(path.join(getPdBackupsDir(), '.pd-backup-2026-08-13T14-12-57-972Z', 'marker.txt'), 'utf-8')).toBe('console');
    expect(fs.readFileSync(path.join(getPdBackupsDir(), 'principles-disciple.backup.1783175678041', 'marker.txt'), 'utf-8')).toBe('installer');
  });

  it('leaves other plugins and non-matching dot-dirs untouched', () => {
    const otherPlugin = path.join(extensionsRoot(), 'another-plugin');
    fs.mkdirSync(otherPlugin, { recursive: true });

    const result = migrateLegacyPdBackups();

    expect(result.movedFrom).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(fs.existsSync(otherPlugin)).toBe(true);
    expect(fs.existsSync(getPdBackupsDir())).toBe(false);
  });

  it('is a no-op when neither legacy location exists', () => {
    expect(() => migrateLegacyPdBackups()).not.toThrow();
  });
});
