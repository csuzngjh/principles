/**
 * PRI-894 / PRI-895 — uninstall reclaims shared-runtime update residue.
 *
 * Before this fix, `uninstall --force` on the LAST host removed the runtime,
 * install.json, plugins, host configs and the `pd` shim, but left:
 *   - ~/.pd/staging/   (~/.pd/releases/   ~/.pd/backups/   — a GB-scale leak), and
 *   - ~/.pd/active.json pointing at a release that no longer exists (dangling).
 *
 * These are real-fs integration tests that drive the actual public `uninstall()`
 * boundary. Sandbox discipline (non-negotiable): getHomeDir() reads process.env
 * HOME first and os.homedir() reads USERPROFILE on Windows, so BOTH are pinned
 * at a throwaway temp root — every installed path (~/.pd/*) resolves inside the
 * sandbox. Nothing is ever deleted from the real home, and the npm-global probe
 * is mocked so no real `npm` / `powershell` process is spawned.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import fse from 'fs-extra';

vi.mock('child_process', () => ({
  execSync: vi.fn(() => ''),
  execFileSync: vi.fn(() => ''),
}));

import { uninstall, checkInstallStatus } from '../src/uninstaller.js';
import { getPluginExtDir } from '../src/utils/env.js';
import { logger } from '../src/utils/logger.js';

const REAL_DIG = 'a'.repeat(64);

function validActiveRecord(releaseId: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    generation: 1,
    releaseId,
    releaseMetadataDigest: REAL_DIG,
    previousReleaseId: null,
    transactionId: 'tx-1',
    productVersion: '2.0.0',
  });
}

function seedPdHome(pdHome: string, opts: { hosts: string[]; active?: string | null }): void {
  fs.mkdirSync(path.join(pdHome, 'runtime', 'console'), { recursive: true });
  fs.writeFileSync(path.join(pdHome, 'runtime', 'console', 'server.js'), 'runtime');
  fs.mkdirSync(path.join(pdHome, 'releases', 'rel-1'), { recursive: true });
  fs.writeFileSync(path.join(pdHome, 'releases', 'rel-1', 'payload'), 'release');
  fs.mkdirSync(path.join(pdHome, 'staging', 'tx-1'), { recursive: true });
  fs.writeFileSync(path.join(pdHome, 'staging', 'tx-1', 'partial'), 'staging');
  fs.mkdirSync(path.join(pdHome, 'backups', 'rel-0'), { recursive: true });
  fs.writeFileSync(path.join(pdHome, 'backups', 'rel-0', 'old'), 'backup');
  if (opts.active !== null) {
    fs.writeFileSync(path.join(pdHome, 'active.json'), opts.active ?? validActiveRecord('rel-1'));
  }
  fs.writeFileSync(path.join(pdHome, 'install.json'), JSON.stringify({
    layoutVersion: 1,
    mode: 'canonical',
    hosts: opts.hosts,
  }));
  // Codex install markers so checkInstallStatus reports an install (otherwise
  // uninstall early-returns with "no install detected").
  fs.mkdirSync(path.join(pdHome, 'codex'), { recursive: true });
  fs.writeFileSync(path.join(pdHome, 'codex', 'pd-hooks.marker'), 'owned');
  fs.writeFileSync(path.join(pdHome, 'codex', 'pd-hook-entry.cjs'), 'entry');
}

// PRI-945: replace linkPath (if present) with a symlink/junction whose target
// does not exist. existsSync follows it and returns false; a lstat gate sees the
// entry and reclaims it. 'junction' needs no admin on Windows; the target must
// be absolute for a junction.
const LINK_TYPE: 'junction' | 'dir' = process.platform === 'win32' ? 'junction' : 'dir';
function makeDangling(linkPath: string, missingTarget: string): void {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.rmSync(linkPath, { recursive: true, force: true });
  fs.symlinkSync(missingTarget, linkPath, LINK_TYPE);
}

describe('PRI-894 + PRI-895: uninstall reclaims shared-runtime update residue', () => {
  let savedEnv: Record<string, string | undefined>;
  let sandboxRoot: string;
  let pdHome: string;
  let warnLines: string[];
  let successLines: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    sandboxRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-894-reclaim-')));
    pdHome = path.join(sandboxRoot, '.pd');
    // Pin BOTH so getHomeDir() (HOME) and os.homedir() (USERPROFILE on win32)
    // agree on the sandbox as "~".
    process.env.HOME = sandboxRoot;
    process.env.USERPROFILE = sandboxRoot;
    warnLines = [];
    successLines = [];
    vi.spyOn(logger, 'warn').mockImplementation((msg: string) => { warnLines.push(String(msg)); });
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'success').mockImplementation((msg: string) => { successLines.push(String(msg)); });
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    // Restore each saved var ONLY if it was originally present; deleting when
    // absent avoids leaving the string "undefined" (HOME is unset on Windows,
    // and getHomeDir() reads HOME first, so a stale "undefined" would leak a
    // bogus home dir into the next test file sharing this worker).
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.restoreAllMocks();
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  });

  it('full last-host uninstall removes staging/, releases/, backups/ and a now-dangling active.json', async () => {
    seedPdHome(pdHome, { hosts: ['codex'] });

    const result = await uninstall({ host: 'codex', force: true });

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(pdHome, 'staging'))).toBe(false);
    expect(fs.existsSync(path.join(pdHome, 'releases'))).toBe(false);
    expect(fs.existsSync(path.join(pdHome, 'backups'))).toBe(false);
    expect(fs.existsSync(path.join(pdHome, 'active.json'))).toBe(false);
    expect(result.removedFiles).toContain(path.join(pdHome, 'active.json'));
    expect(result.removedDirs).toContain(path.join(pdHome, 'releases'));
    expect(result.removedDirs).toContain(path.join(pdHome, 'staging'));
    expect(result.removedDirs).toContain(path.join(pdHome, 'backups'));
    // PRI-895 observability: the reclaimed GB-scale residue is surfaced to the
    // operator, not just recorded in the returned result.
    const reclaimLog = successLines.join('\n');
    expect(reclaimLog).toMatch(/Reclaimed update residue/);
    expect(reclaimLog).toContain('releases/');
    expect(reclaimLog).toContain('active.json');
  });

  it('preserves a corrupt active.json instead of deleting evidence', async () => {
    seedPdHome(pdHome, { hosts: ['codex'], active: '{ not valid json' });

    const result = await uninstall({ host: 'codex', force: true });

    // Intentional preservation is NOT a failure: install.json is still cleaned
    // (reclaimFailed stays false), so the re-run advice must NOT be promised.
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(pdHome, 'staging'))).toBe(false);
    expect(fs.existsSync(path.join(pdHome, 'releases'))).toBe(false);
    expect(fs.existsSync(path.join(pdHome, 'backups'))).toBe(false);
    expect(fs.existsSync(path.join(pdHome, 'active.json'))).toBe(true);
    expect(warnLines.join('\n')).toMatch(/active\.json is unreadable/);
    expect(warnLines.join('\n')).not.toMatch(/re-run to reclaim both/i);
  });

  it('is failure-open: a locked releases/ keeps install.json and preserves the pointer with its target', async () => {
    seedPdHome(pdHome, { hosts: ['codex'] });
    const releasesDir = path.join(pdHome, 'releases');
    const originalRemove = fse.remove.bind(fse);
    vi.spyOn(fse, 'remove').mockImplementation(async (p: string) => {
      if (p === releasesDir) throw new Error('simulated removal failure');
      return originalRemove(p);
    });

    const result = await uninstall({ host: 'codex', force: true });

    // releases/ removal threw → reclaimFailed → success false, manifest kept.
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/PD update releases/);
    // staging + backups are independent removes and still reclaim.
    expect(fs.existsSync(path.join(pdHome, 'staging'))).toBe(false);
    expect(fs.existsSync(path.join(pdHome, 'backups'))).toBe(false);
    // releases survived, so the pointer must survive with it (never a pointer
    // deleted while its target is present, nor a stranded un-reclaimable state).
    expect(fs.existsSync(releasesDir)).toBe(true);
    expect(fs.existsSync(path.join(pdHome, 'active.json'))).toBe(true);
    expect(result.removedFiles).not.toContain(path.join(pdHome, 'active.json'));
    // install.json is kept so a re-run can retry the stranded residue.
    expect(fs.existsSync(path.join(pdHome, 'install.json'))).toBe(true);
    expect(warnLines.join('\n')).toMatch(/still points at releases\/rel-1/);
  });

  it('partial (single-host) uninstall preserves every residue path', async () => {
    seedPdHome(pdHome, { hosts: ['codex', 'openclaw'] });

    const result = await uninstall({ host: 'codex', force: true });

    // openclaw still remains → removeSharedRuntime is false → nothing reclaimed.
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(pdHome, 'staging'))).toBe(true);
    expect(fs.existsSync(path.join(pdHome, 'releases'))).toBe(true);
    expect(fs.existsSync(path.join(pdHome, 'backups'))).toBe(true);
    expect(fs.existsSync(path.join(pdHome, 'active.json'))).toBe(true);
    // runtime + manifest survive too (merged, not deleted).
    expect(fs.existsSync(path.join(pdHome, 'runtime'))).toBe(true);
    expect(fs.existsSync(path.join(pdHome, 'install.json'))).toBe(true);
  });

  it('leaves transactions/, logs/, trust/, channels/ untouched', async () => {
    seedPdHome(pdHome, { hosts: ['codex'] });
    for (const keep of ['transactions', 'logs', 'trust', 'channels', 'bootstrap']) {
      fs.mkdirSync(path.join(pdHome, keep), { recursive: true });
      fs.writeFileSync(path.join(pdHome, keep, 'data'), keep);
    }

    await uninstall({ host: 'codex', force: true });

    // The reclaim deletes exactly staging/releases/backups + active.json — never
    // a glob of ~/.pd/*, so these non-update paths survive.
    for (const keep of ['transactions', 'logs', 'trust', 'channels', 'bootstrap']) {
      expect(fs.existsSync(path.join(pdHome, keep, 'data'))).toBe(true);
    }
  });

  // PRI-945 — the deletion gates must reclaim a dangling symlink/junction, not
  // silently skip it (existsSync follows to a missing target → false → strand).
  // Each test turns RED before the lstat gate change and GREEN after; every
  // removal must unlink the LINK and never touch (or create) the missing target.

  it('PRI-945 Gate E: reclaims a dangling releases/ junction instead of stranding it', async () => {
    seedPdHome(pdHome, { hosts: ['codex'], active: null });
    const releasesDir = path.join(pdHome, 'releases');
    const missingTarget = path.join(pdHome, 'missing-release-xyz');
    makeDangling(releasesDir, missingTarget);

    const result = await uninstall({ host: 'codex', force: true });

    expect(result.success).toBe(true);
    expect(result.removedDirs).toContain(releasesDir);
    expect(() => fs.lstatSync(releasesDir)).toThrow();
    expect(fs.existsSync(missingTarget)).toBe(false);
  });

  it('PRI-945 Gate B: reclaims a dangling ~/.pd/runtime junction', async () => {
    seedPdHome(pdHome, { hosts: ['codex'] });
    const runtimeDir = path.join(pdHome, 'runtime');
    const missingTarget = path.join(pdHome, 'missing-runtime-xyz');
    makeDangling(runtimeDir, missingTarget);

    const result = await uninstall({ host: 'codex', force: true });

    expect(result.success).toBe(true);
    expect(result.removedDirs).toContain(runtimeDir);
    expect(() => fs.lstatSync(runtimeDir)).toThrow();
    expect(fs.existsSync(missingTarget)).toBe(false);
  });

  it('PRI-945 Gate F: reclaims a dangling active.json pointer', async () => {
    seedPdHome(pdHome, { hosts: ['codex'], active: null });
    const activePath = path.join(pdHome, 'active.json');
    const missingTarget = path.join(pdHome, 'missing-pointer-target');
    makeDangling(activePath, missingTarget);

    const result = await uninstall({ host: 'codex', force: true });

    expect(result.success).toBe(true);
    expect(result.removedFiles).toContain(activePath);
    expect(() => fs.lstatSync(activePath)).toThrow();
    expect(fs.existsSync(missingTarget)).toBe(false);
  });

  it('PRI-945 Gate A (稳妥 B): reclaims a dangling plugin ext junction while status still reports it missing', async () => {
    seedPdHome(pdHome, { hosts: ['codex'] });
    const extDir = getPluginExtDir();
    const missingTarget = path.join(pdHome, 'missing-installed-plugin');
    makeDangling(extDir, missingTarget);

    // The public decision under 稳妥 B: the CLI --check consumer must STILL see a
    // dangling link as "not installed" (checkInstallStatus.exists stays follow-based).
    const status = checkInstallStatus('all');
    expect(status.paths.find(p => p.path === extDir)?.exists).toBe(false);

    // Yet uninstall reclaims the dangling entry at the deletion site.
    const result = await uninstall({ host: 'all', force: true });

    expect(result.success).toBe(true);
    expect(result.removedDirs).toContain(extDir);
    expect(() => fs.lstatSync(extDir)).toThrow();
    expect(fs.existsSync(missingTarget)).toBe(false);
  });
});
