/**
 * P0-3 / P0-4 (PRI-1069/1070, G1, SPEC v1.2 §17): real-filesystem tests for
 * the rename-aside restore and the partial-backup compensation.
 *
 * Invariants under test:
 *   - a restore NEVER recursively deletes the live tree first (the PRI-1070
 *     delete-then-rename defect); the live tree is moved aside and, on any
 *     failure, moved back or PRESERVED — never destroyed;
 *   - per-tree outcomes are reported individually (extension vs runtime);
 *   - `restored: true` only when every tree genuinely landed;
 *   - restore is idempotent (a re-run after success is a no-op);
 *   - backupExistingInstall compensates a partial backup (extension moved,
 *     runtime move failed) by moving the extension back; if even that fails,
 *     BackupIntegrityError carries the preserved paths.
 *
 * EPERM mid-operation is injected by counting real fs rename operations and
 * failing the Nth one — the failure MODE is identical to the field report (a
 * locked native module), the physical tree layout is real. The installer's
 * fs imports go through this file's vi.mock('fs'), so the injection lands on
 * the production code path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getPluginExtDir, getPdBackupsDir } from '../src/mvp-config.js';

// Shared injection state (vi.mock factories are hoisted; vi.hoisted keeps
// the handle usable from tests). failAt = 1-based renameSync call number to
// fail once; failFrom = fail every call >= N; -1 disables each.
const renameInjection = vi.hoisted(() => ({ calls: 0, failAt: -1, failFrom: -1, code: 'EPERM' }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    renameSync(from: fs.PathLike, to: fs.PathLike) {
      renameInjection.calls += 1;
      const shouldFail = renameInjection.calls === renameInjection.failAt
        || (renameInjection.failFrom > 0 && renameInjection.calls >= renameInjection.failFrom);
      if (shouldFail) {
        throw Object.assign(new Error(`${renameInjection.code}: operation not permitted, rename ${String(from)}`), { code: renameInjection.code });
      }
      return actual.renameSync(from, to);
    },
  };
});

let tmpHome: string;
let savedHome: string | undefined;
let savedUserProfile: string | undefined;

beforeEach(() => {
  renameInjection.calls = 0;
  renameInjection.failAt = -1;
  renameInjection.failFrom = -1;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-restore-partial-'));
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  renameInjection.calls = 0;
  renameInjection.failAt = -1;
  renameInjection.failFrom = -1;
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
  if (tmpHome && fs.existsSync(tmpHome)) fs.rmSync(tmpHome, { recursive: true, force: true });
});

/** Import the module under test AFTER env pinning (installer resolves dirs lazily). */
async function importInstaller(): Promise<typeof import('../src/installer.js')> {
  return import('../src/installer.js');
}

function layoutOldInstall(): { extDir: string; runtimeDir: string; extBackup: string; runtimeBackup: string } {
  const extDir = getPluginExtDir();
  const runtimeDir = path.join(tmpHome, '.pd', 'runtime');
  fs.mkdirSync(path.join(extDir, 'plugin'), { recursive: true });
  fs.writeFileSync(path.join(extDir, 'plugin', 'bundle.js'), 'OLD-EXT');
  fs.mkdirSync(path.join(runtimeDir, 'console'), { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'console', 'marker.txt'), 'OLD-RUNTIME');
  // backups as backupExistingInstall would have created them
  const extBackup = path.join(getPdBackupsDir(), 'principles-disciple.backup.1700000000000');
  const runtimeBackup = path.join(tmpHome, '.pd', 'backups', 'runtime.backup.1700000000000');
  fs.mkdirSync(path.join(extBackup, 'plugin'), { recursive: true });
  fs.writeFileSync(path.join(extBackup, 'plugin', 'bundle.js'), 'BACKUP-EXT');
  fs.mkdirSync(path.join(runtimeBackup, 'console'), { recursive: true });
  fs.writeFileSync(path.join(runtimeBackup, 'console', 'marker.txt'), 'BACKUP-RUNTIME');
  return { extDir, runtimeDir, extBackup, runtimeBackup };
}

describe('restoreBackup — rename-aside semantics (P0-3)', () => {
  it('restores both trees when both backups exist; idempotent on re-run', { timeout: 60_000 }, async () => {
    const { restoreBackup } = await importInstaller();
    const { extDir, runtimeDir, extBackup, runtimeBackup } = layoutOldInstall();
    const result = restoreBackup(extBackup, runtimeBackup);
    expect(result.restored).toBe(true);
    expect(result.partial).toBe(false);
    expect(result.extension?.status).toBe('restored');
    expect(result.runtime?.status).toBe('restored');
    expect(fs.readFileSync(path.join(extDir, 'plugin', 'bundle.js'), 'utf8')).toBe('BACKUP-EXT');
    expect(fs.readFileSync(path.join(runtimeDir, 'console', 'marker.txt'), 'utf8')).toBe('BACKUP-RUNTIME');
    expect(fs.existsSync(extBackup)).toBe(false);
    expect(fs.existsSync(runtimeBackup)).toBe(false);
    // no quarantine residue from the healthy path
    expect(fs.readdirSync(path.dirname(runtimeDir)).filter((n) => n.includes('restore-quarantine'))).toHaveLength(0);
    // idempotent: backups are gone now — a re-run is a clean no-op
    const rerun = restoreBackup(extBackup, runtimeBackup);
    expect(rerun.restored).toBe(true);
    expect(rerun.extension?.status).toBe('no_backup');
    expect(rerun.runtime?.status).toBe('no_backup');
    expect(fs.readFileSync(path.join(extDir, 'plugin', 'bundle.js'), 'utf8')).toBe('BACKUP-EXT');
  });

  it('reports a partial restore when the RUNTIME tree fails — extension restored, runtime preserved (never destroyed)', { timeout: 60_000 }, async () => {
    const { restoreBackup } = await importInstaller();
    const { extDir, runtimeDir, extBackup, runtimeBackup } = layoutOldInstall();
    // Fail the rename that would bring the runtime backup back:
    // call 1 = extension aside, call 2 = extension backup restore,
    // call 3 = runtime aside, call 4 = runtime backup restore <- fails here.
    renameInjection.failAt = 4;
    const result = restoreBackup(extBackup, runtimeBackup);

    expect(result.restored).toBe(false);
    expect(result.partial).toBe(true);
    // extension REALLY landed (its files are back)
    expect(fs.readFileSync(path.join(extDir, 'plugin', 'bundle.js'), 'utf8')).toBe('BACKUP-EXT');
    // runtime: aside-undo must have put the live tree back (no delete-first!)
    expect(fs.readFileSync(path.join(runtimeDir, 'console', 'marker.txt'), 'utf8')).toBe('OLD-RUNTIME');
    expect(result.extension?.status).toBe('restored');
    expect(result.runtime?.status).toBe('failed');
    // the runtime backup is PRESERVED, never destroyed
    expect(fs.existsSync(runtimeBackup)).toBe(true);
    expect(result.runtime?.preservedDirs).toContain(runtimeBackup);
    // the failure detail is machine-readable + human-usable
    expect(result.error).toContain('runtime=failed');
  });

  it('reports a partial restore when the EXTENSION tree fails — runtime restored, extension preserved', { timeout: 60_000 }, async () => {
    const { restoreBackup } = await importInstaller();
    const { extDir, runtimeDir, extBackup, runtimeBackup } = layoutOldInstall();
    // call 1 = extension aside, call 2 = extension backup restore <- fails.
    renameInjection.failAt = 2;
    const result = restoreBackup(extBackup, runtimeBackup);

    expect(result.restored).toBe(false);
    expect(result.extension?.status).toBe('failed');
    // extension aside-undo keeps the live extension tree intact (not deleted)
    expect(fs.readFileSync(path.join(extDir, 'plugin', 'bundle.js'), 'utf8')).toBe('OLD-EXT');
    // the extension backup is preserved
    expect(fs.existsSync(extBackup)).toBe(true);
    // runtime was still restored independently (per-tree outcomes)
    expect(result.runtime?.status).toBe('restored');
    expect(fs.readFileSync(path.join(runtimeDir, 'console', 'marker.txt'), 'utf8')).toBe('BACKUP-RUNTIME');
  });
});

describe('backupExistingInstall — partial backup compensation (P0-3)', () => {
  it('compensates a partial backup: extension move undone when the runtime move fails (zero side effects)', { timeout: 60_000 }, async () => {
    const { backupExistingInstall } = await importInstaller();
    const { extDir, runtimeDir } = layoutOldInstall();
    // call 1 = ext -> backup (ok), call 2 = runtime -> backup (fails).
    renameInjection.failAt = 2;
    expect(() => backupExistingInstall()).toThrow(/Could not backup existing install/);
    // compensation put the extension tree BACK — no stranded NEW backup (the
    // pre-seeded .backup.1700000000000 fixture from layoutOldInstall may stay)
    expect(fs.readFileSync(path.join(extDir, 'plugin', 'bundle.js'), 'utf8')).toBe('OLD-EXT');
    expect(fs.readdirSync(path.join(tmpHome, '.openclaw', 'pd-backups'))
      .filter((n) => n.startsWith('principles-disciple.backup.') && n !== 'principles-disciple.backup.1700000000000')).toHaveLength(0);
    expect(fs.existsSync(runtimeDir)).toBe(true);
  });

  it('throws BackupIntegrityError carrying the preserved path when the compensation ALSO fails', { timeout: 60_000 }, async () => {
    const { backupExistingInstall, BackupIntegrityError } = await importInstaller();
    const { extDir } = layoutOldInstall();
    // Fail from call 2 onward: runtime backup move fails AND the extension
    // compensation undo fails — the paths must escape via BackupIntegrityError.
    renameInjection.failFrom = 2;
    let caught: unknown;
    try {
      backupExistingInstall();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BackupIntegrityError);
    const integrityError = caught as InstanceType<typeof import('../src/installer.js').BackupIntegrityError>;
    // the moved extension backup path is carried out for the failure handler
    expect(integrityError.extensionBackupDir).not.toBeNull();
    expect(fs.existsSync(integrityError.extensionBackupDir!)).toBe(true);
    expect(fs.existsSync(extDir)).toBe(false); // it IS displaced — and now visible
  });
});
