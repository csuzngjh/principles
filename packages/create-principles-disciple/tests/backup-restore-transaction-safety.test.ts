/**
 * Backup/restore transaction-safety matrix (Round 3 §7 / Devin reviews xc8K +
 * xc8p).
 *
 * Every scenario drives the REAL production functions (backupExistingInstall /
 * restoreBackup) against a real filesystem, with ONE fs primitive overridden
 * at a time to inject the fault. Each case pins the exact final data state —
 * at least one complete, restorable copy must survive every failure, and a
 * partial copy must never be treated as a valid backup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
    cpSync: vi.fn(actual.cpSync),
    rmSync: vi.fn(actual.rmSync),
  };
});

import { backupExistingInstall, restoreBackup, BackupIntegrityError } from '../src/installer.js';

const savedEnv: Record<string, string | undefined> = {};
const ISOLATED_ENV_KEYS = ['PD_EXPERIMENT_ROOT', 'OPENCLAW_STATE_DIR', 'OPENCLAW_HOME', 'CODEX_HOME', 'WORKBUDDY_CONFIG_DIR', 'HOME'] as const;
let tmpRoot: string;
// HOME sandbox is a SEPARATE dir from PD_EXPERIMENT_ROOT: the shared resolver
// refuses a lab that overlaps the production home (HOME=tmpRoot AND root=
// tmpRoot would self-reject), while HOME only feeds the disjointness target.
let homeSandbox: string;

const realFs = await vi.importActual<typeof import('fs')>('fs');

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ISOLATED_ENV_KEYS) savedEnv[key] = process.env[key];
  tmpRoot = realFs.realpathSync.native(realFs.mkdtempSync(path.join(os.tmpdir(), 'pd-bk-txn-')));
  homeSandbox = realFs.realpathSync.native(realFs.mkdtempSync(path.join(os.tmpdir(), 'pd-bk-txn-home-')));
  process.env.PD_EXPERIMENT_ROOT = tmpRoot;
  process.env.HOME = homeSandbox;
  delete process.env.OPENCLAW_STATE_DIR;
  delete process.env.OPENCLAW_HOME;
  delete process.env.CODEX_HOME;
  delete process.env.WORKBUDDY_CONFIG_DIR;
});

afterEach(() => {
  // Restore every overridden primitive BEFORE the env/dir teardown so cleanup
  // runs on the real fs.
  vi.mocked(fs.renameSync).mockImplementation(realFs.renameSync);
  vi.mocked(fs.cpSync).mockImplementation(realFs.cpSync);
  vi.mocked(fs.rmSync).mockImplementation(realFs.rmSync);
  for (const key of ISOLATED_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  if (tmpRoot && realFs.existsSync(tmpRoot)) {
    realFs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  if (homeSandbox && realFs.existsSync(homeSandbox)) {
    realFs.rmSync(homeSandbox, { recursive: true, force: true });
  }
});

/** Seed an install tree exercising the verification dimensions (§7.3). */
function seedInstallTree(root: string): void {
  realFs.mkdirSync(path.join(root, 'nested', 'deeper'), { recursive: true });
  realFs.writeFileSync(path.join(root, 'entry.txt'), 'entry-content');
  realFs.writeFileSync(path.join(root, 'empty.txt'), '');
  realFs.writeFileSync(path.join(root, 'nested', 'mid.txt'), 'x'.repeat(1000));
  // "Large" file: multi-chunk streamed compare (1MiB chunks).
  realFs.writeFileSync(path.join(root, 'nested', 'deeper', 'big.bin'), Buffer.alloc(2 * 1024 * 1024 + 7, 6));
  for (let i = 0; i < 40; i++) {
    realFs.writeFileSync(path.join(root, `mod-${i}.txt`), `module ${i}`);
  }
}

function extensionsDir(): string {
  // mirrors mvp-config derivation: <PD_HOME rooted at tmpRoot>/.openclaw/extensions
  return path.join(tmpRoot, '.openclaw', 'extensions');
}

function pdBackupsDir(): string {
  return path.join(tmpRoot, '.pd', 'backups');
}

/**
 * Simulate a cross-volume boundary for ONE specific move: only the rename
 * `from → to` dies with EXDEV; every other rename (quarantine asides, staging
 * renames) stays real so the production flow under test is exercised exactly.
 * `to` may be a predicate — production derives its own Date.now()-suffixed
 * destination internally, so an exact string cannot be predicted.
 */
async function mockExdevFor(
  moveFrom: string,
  moveTo: string | ((to: string) => boolean),
): Promise<void> {
  const matches = typeof moveTo === 'string' ? (to: string) => to === moveTo : moveTo;
  vi.mocked(fs.renameSync).mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
    if (String(from) === moveFrom && matches(String(to))) {
      throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
    }
    return realFs.renameSync(from, to);
  }) as typeof fs.renameSync);
}

/** EXDEV for the backup move: the destination is whatever timestamped name production derives. */
async function mockExdevForBackup(extDir: string): Promise<void> {
  await mockExdevFor(extDir, (to) => to.startsWith(pdBackupsDir()));
}

describe('backup transaction safety (§7.1)', () => {
  it('EXDEV fallback: copy → verify → remove leaves a COMPLETE backup and removes the original only after verification', async () => {
    const extDir = path.join(extensionsDir(), 'principles-disciple');
    seedInstallTree(extDir);
    const backupDir = path.join(pdBackupsDir(), `principles-disciple.backup.${Date.now()}`);
    await mockExdevForBackup(extDir);

    const result = backupExistingInstall();

    expect(result.type).toBe('backed_up');
    expect(result.backupDir).not.toBeNull();
    // The backup is complete: entry count AND content were verified by the
    // REAL verifier inside backupExistingInstall (it ran verifyCopiedTree).
    expect(realFs.readdirSync(result.backupDir!, { recursive: true }).length).toBe(46);
    expect(realFs.readFileSync(path.join(result.backupDir!, 'nested', 'deeper', 'big.bin')).length).toBe(2 * 1024 * 1024 + 7);
    expect(realFs.readFileSync(path.join(result.backupDir!, 'empty.txt'), 'utf8')).toBe('');
    expect(realFs.readFileSync(path.join(result.backupDir!, 'nested', 'mid.txt'), 'utf8')).toBe('x'.repeat(1000));
    // The original was removed only AFTER the verified copy.
    expect(realFs.existsSync(extDir)).toBe(false);
  });

  it('mid-copy failure (ENOSPC): the original is untouched and NO partial backup dir survives', async () => {
    const extDir = path.join(extensionsDir(), 'principles-disciple');
    seedInstallTree(extDir);
    const backupDir = path.join(pdBackupsDir(), `principles-disciple.backup.${Date.now()}`);
    await mockExdevForBackup(extDir);
    const realCp = realFs.cpSync;
    // Inferred (string | URL) parameters — the same no-cast discipline as the P0.
    vi.mocked(fs.cpSync).mockImplementation((source, dest) => {
      // Copy only the FIRST entry, then die like a full disk would.
      const entries = realFs.readdirSync(String(source), { withFileTypes: true });
      const first = entries[0]!;
      realCp(path.join(String(source), first.name), path.join(String(dest), first.name), { recursive: first.isDirectory() });
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    });

    expect(() => backupExistingInstall()).toThrow(/ENOSPC/);

    // Final state: the original tree is INTACT and the partial backup dir was
    // cleaned up (nothing references it — it must not linger as a "backup").
    expect(realFs.readdirSync(extDir, { recursive: true }).length).toBe(46);
    expect(realFs.readFileSync(path.join(extDir, 'entry.txt'), 'utf8')).toBe('entry-content');
    // The backups ROOT may exist (mkdir runs before the move), but it must be
    // EMPTY — no partial backup directory survived the failure.
    expect(realFs.existsSync(pdBackupsDir()) ? realFs.readdirSync(pdBackupsDir()) : []).toEqual([]);
  });

  it('verification failure (silent partial copy): refuse before touching the original', async () => {
    const extDir = path.join(extensionsDir(), 'principles-disciple');
    seedInstallTree(extDir);
    const backupDir = path.join(pdBackupsDir(), `principles-disciple.backup.${Date.now()}`);
    await mockExdevForBackup(extDir);
    const realCp = realFs.cpSync;
    // Parameter types are inferred from fs.cpSync's own signature (string | URL)
    // — exactly what the real cpSync accepts (same discipline as the P0 fix).
    vi.mocked(fs.cpSync).mockImplementation((source, dest) => {
      realCp(source, dest, { recursive: true });
      // Simulate silent truncation: drop one file from the finished copy.
      realFs.rmSync(path.join(String(dest), 'mod-7.txt'), { force: true });
    });

    expect(() => backupExistingInstall()).toThrow(/copy verification failed/);

    // The original tree was NEVER touched (verify runs BEFORE removal).
    expect(realFs.readFileSync(path.join(extDir, 'mod-7.txt'), 'utf8')).toBe('module 7');
    // The unverifiable partial backup was cleaned up — the backups root (which
    // mkdir creates before the move) holds NO backup entries.
    expect(realFs.existsSync(pdBackupsDir()) ? realFs.readdirSync(pdBackupsDir()) : []).toEqual([]);
  });

  it('source cleanup failure AFTER a verified copy: BackupIntegrityError carries the complete backup path (xc8K)', async () => {
    const extDir = path.join(extensionsDir(), 'principles-disciple');
    seedInstallTree(extDir);
    const backupDir = path.join(pdBackupsDir(), `principles-disciple.backup.${Date.now()}`);
    await mockExdevForBackup(extDir);
    vi.mocked(fs.rmSync).mockImplementation(((target: fs.PathLike) => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    }) as typeof fs.rmSync);

    let integrityError: BackupIntegrityError | null = null;
    try {
      backupExistingInstall();
    } catch (error) {
      integrityError = error instanceof BackupIntegrityError ? error : null;
    }

    // The typed error carries the COMPLETE backup for the restore machinery.
    expect(integrityError).not.toBeNull();
    expect(integrityError!.extensionBackupDir).not.toBeNull();
    const carriedBackupDir = integrityError!.extensionBackupDir!;
    expect(carriedBackupDir.startsWith(pdBackupsDir())).toBe(true);
    expect(realFs.readFileSync(path.join(carriedBackupDir, 'entry.txt'), 'utf8')).toBe('entry-content');

    // The install-entry handler consumes it: restore succeeds over the residue.
    vi.mocked(fs.rmSync).mockImplementation(realFs.rmSync);
    const restored = restoreBackup(carriedBackupDir, null);
    expect(restored.restored).toBe(true);
    expect(realFs.readFileSync(path.join(extensionsDir(), 'principles-disciple', 'entry.txt'), 'utf8')).toBe('entry-content');
  });
});

describe('restore transaction safety (§7.2)', () => {
  it('cross-volume restore stages on the target volume; the source is cleaned only after the verified rename (xc8p)', async () => {
    const backupDir = path.join(pdBackupsDir(), 'principles-disciple.backup.1');
    seedInstallTree(backupDir);
    const targetDir = path.join(extensionsDir(), 'principles-disciple');
    realFs.mkdirSync(path.dirname(targetDir), { recursive: true });
    await mockExdevFor(backupDir, targetDir);

    const restored = restoreBackup(backupDir, null);

    expect(restored.restored).toBe(true);
    expect(realFs.readFileSync(path.join(targetDir, 'nested', 'deeper', 'big.bin')).length).toBe(2 * 1024 * 1024 + 7);
    expect(realFs.readFileSync(path.join(targetDir, 'empty.txt'), 'utf8')).toBe('');
    expect(realFs.existsSync(backupDir)).toBe(false);
  });

  it('mid-copy restore failure: the live tree comes back from quarantine and the target never stays half-written (xc8p)', async () => {
    const backupDir = path.join(pdBackupsDir(), 'principles-disciple.backup.2');
    seedInstallTree(backupDir);
    const targetDir = path.join(extensionsDir(), 'principles-disciple');
    realFs.mkdirSync(targetDir, { recursive: true });
    realFs.writeFileSync(path.join(targetDir, 'live.txt'), 'live-install');
    await mockExdevFor(backupDir, targetDir);
    vi.mocked(fs.cpSync).mockImplementation((() => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    }) as typeof fs.cpSync);

    const restored = restoreBackup(backupDir, null);

    // The restore FAILED, but the LIVE tree is back (quarantine undo worked
    // because the staging strategy kept the formal target ABSENT).
    expect(restored.restored).toBe(false);
    expect(restored.extension?.status).toBe('failed');
    expect(realFs.readFileSync(path.join(targetDir, 'live.txt'), 'utf8')).toBe('live-install');
    // No staging residue survived.
    const leftovers = realFs.readdirSync(extensionsDir()).filter((name) => name.includes('restore-staging'));
    expect(leftovers).toEqual([]);
  });

  it('source cleanup failure after a COMPLETE restore is a DEGRADED note, not a failed restore (§7.2)', async () => {
    const backupDir = path.join(pdBackupsDir(), 'principles-disciple.backup.3');
    seedInstallTree(backupDir);
    const targetDir = path.join(extensionsDir(), 'principles-disciple');
    realFs.mkdirSync(path.dirname(targetDir), { recursive: true });
    await mockExdevFor(backupDir, targetDir);
    vi.mocked(fs.rmSync).mockImplementation(((target: fs.PathLike) => {
      if (String(target) === backupDir) {
        throw Object.assign(new Error('EPERM: source busy'), { code: 'EPERM' });
      }
      return realFs.rmSync(target, { recursive: true, force: true });
    }) as typeof fs.rmSync);

    const restored = restoreBackup(backupDir, null);

    // Restore SUCCEEDED; the cleanup failure is reported, never fatal.
    expect(restored.restored).toBe(true);
    expect(restored.extension?.detail).toContain('source cleanup failed');
    expect(realFs.readFileSync(path.join(targetDir, 'entry.txt'), 'utf8')).toBe('entry-content');
    // The leftover source is the complete data — nothing was destroyed.
    expect(realFs.readFileSync(path.join(backupDir, 'entry.txt'), 'utf8')).toBe('entry-content');
  });

  it('an interrupted prior run leaves a stale staging dir that does not block a later restore', async () => {
    const backupDir = path.join(pdBackupsDir(), 'principles-disciple.backup.4');
    seedInstallTree(backupDir);
    const targetDir = path.join(extensionsDir(), 'principles-disciple');
    realFs.mkdirSync(path.dirname(targetDir), { recursive: true });
    // Simulate a previous run that died between copy-complete and switch:
    // its staging dir is still on the target volume.
    const staleStaging = 'principles-disciple.restore-staging.1700000000000';
    realFs.mkdirSync(path.join(extensionsDir(), staleStaging), { recursive: true });
    realFs.writeFileSync(path.join(extensionsDir(), staleStaging, 'stale.txt'), 'stale');

    // Force the cross-volume path: staging dirs are only created/used by
    // moveTreeAside's EXDEV fallback. Without this, backup and target share the
    // same temp volume, the first renameSync succeeds, and the staging branch
    // is bypassed entirely — the stale staging dir would never be exercised.
    await mockExdevFor(backupDir, targetDir);

    const restored = restoreBackup(backupDir, null);

    expect(restored.restored).toBe(true);
    expect(realFs.readFileSync(path.join(targetDir, 'entry.txt'), 'utf8')).toBe('entry-content');
    // Prove the cross-volume STAGING branch actually ran (a same-volume rename
    // would bypass it and never copy): the backup was copied into a fresh
    // restore-staging dir on the target volume before the atomic switch.
    expect(
      vi.mocked(fs.cpSync).mock.calls.some(
        ([src, dest]) => String(src) === backupDir && String(dest).includes('restore-staging'),
      ),
    ).toBe(true);
    // The fresh staging dir this run created was verified and renamed onto the
    // target (consumed); the only staging residue left is the inert stale dir
    // from the prior run, which did not block the restore.
    const leftovers = realFs.readdirSync(extensionsDir()).filter((name) => name.includes('restore-staging'));
    expect(leftovers).toEqual([staleStaging]);
  });
});
