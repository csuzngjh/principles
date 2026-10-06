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

vi.mock('child_process', () => ({
  execSync: vi.fn(() => ''),
  execFileSync: vi.fn(() => ''),
}));

import { uninstall } from '../src/uninstaller.js';
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

describe('PRI-894 + PRI-895: uninstall reclaims shared-runtime update residue', () => {
  let savedEnv: Record<string, string | undefined>;
  let sandboxRoot: string;
  let pdHome: string;

  beforeEach(() => {
    vi.clearAllMocks();
    savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    sandboxRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-894-reclaim-')));
    pdHome = path.join(sandboxRoot, '.pd');
    // Pin BOTH so getHomeDir() (HOME) and os.homedir() (USERPROFILE on win32)
    // agree on the sandbox as "~".
    process.env.HOME = sandboxRoot;
    process.env.USERPROFILE = sandboxRoot;
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'success').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env.HOME = savedEnv.HOME;
    process.env.USERPROFILE = savedEnv.USERPROFILE;
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
  });

  it('preserves a corrupt active.json instead of deleting evidence', async () => {
    seedPdHome(pdHome, { hosts: ['codex'], active: '{ not valid json' });

    const result = await uninstall({ host: 'codex', force: true });

    expect(result.success).toBe(true);
    // residue dirs are still reclaimed; only the unreadable pointer is kept.
    expect(fs.existsSync(path.join(pdHome, 'staging'))).toBe(false);
    expect(fs.existsSync(path.join(pdHome, 'releases'))).toBe(false);
    expect(fs.existsSync(path.join(pdHome, 'backups'))).toBe(false);
    expect(fs.existsSync(path.join(pdHome, 'active.json'))).toBe(true);
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
});
