/**
 * Real-filesystem tests for PD backup placement (installer.ts + mvp-config.ts).
 *
 * Invariant: PD backups must NEVER live inside ~/.openclaw/extensions —
 * OpenClaw plugin discovery scans every extensions/ child directory, so a
 * plugin-shaped backup is re-discovered as a second "principles-disciple"
 * plugin and warns "duplicate plugin id detected" on every gateway startup.
 * Backups belong in ~/.openclaw/pd-backups (getPdBackupsDir).
 *
 * HOME is redirected to a temp dir so these tests never touch the real
 * ~/.openclaw (ERR-083 recurrence PRI-526: verify under a clean home).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getPdBackupsDir, getOpenClawDir } from '../src/mvp-config.js';
import { backupExistingInstall, migrateLegacyPdBackups } from '../src/installer.js';

let tmpHome: string;
let savedHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-backup-loc-test-'));
  savedHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (tmpHome && fs.existsSync(tmpHome)) {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

function extensionsRoot(): string {
  return path.join(getOpenClawDir(), 'extensions');
}

describe('getPdBackupsDir', () => {
  it('is under ~/.openclaw but outside the extensions dir', () => {
    const backupsDir = getPdBackupsDir();
    expect(backupsDir).toBe(path.join(getOpenClawDir(), 'pd-backups'));
    expect(backupsDir.startsWith(extensionsRoot() + path.sep)).toBe(false);
  });
});

describe('backupExistingInstall', () => {
  it('moves the existing plugin dir into pd-backups, not an extensions/ sibling', () => {
    const extDir = path.join(extensionsRoot(), 'principles-disciple');
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, 'marker.txt'), 'install');

    const result = backupExistingInstall();

    expect(result.type).toBe('backed_up');
    expect(result.backupDir).not.toBeNull();
    // Backup lives under pd-backups — never a sibling inside extensions/
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

  it('moves legacy .pd-backup-* and principles-disciple.backup.* dirs out of extensions/', () => {
    const dotBackup = createLegacy('.pd-backup-2026-08-13T14-12-57-972Z', 'console');
    const installerBackup = createLegacy('principles-disciple.backup.1783175678041', 'installer');
    const livePlugin = path.join(extensionsRoot(), 'principles-disciple');
    fs.mkdirSync(livePlugin, { recursive: true });

    migrateLegacyPdBackups();

    expect(fs.existsSync(dotBackup)).toBe(false);
    expect(fs.existsSync(installerBackup)).toBe(false);
    expect(fs.existsSync(livePlugin)).toBe(true);
    expect(fs.readFileSync(path.join(getPdBackupsDir(), '.pd-backup-2026-08-13T14-12-57-972Z', 'marker.txt'), 'utf-8')).toBe('console');
    expect(fs.readFileSync(path.join(getPdBackupsDir(), 'principles-disciple.backup.1783175678041', 'marker.txt'), 'utf-8')).toBe('installer');
  });

  it('leaves other plugins and non-matching dot-dirs untouched', () => {
    const otherPlugin = path.join(extensionsRoot(), 'another-plugin');
    fs.mkdirSync(otherPlugin, { recursive: true });

    migrateLegacyPdBackups();

    expect(fs.existsSync(otherPlugin)).toBe(true);
    expect(fs.existsSync(getPdBackupsDir())).toBe(false);
  });

  it('is a no-op when the extensions dir does not exist', () => {
    expect(() => migrateLegacyPdBackups()).not.toThrow();
  });
});
