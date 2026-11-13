import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { repairInstallManifestHosts } from '../src/installer.js';
import { WORKBUDDY_PLUGIN_KEY, WORKBUDDY_PLUGIN_NAME, WORKBUDDY_MARKETPLACE_NAME } from '../src/installers/workbuddy-host-installer.js';

/**
 * PRI-1204 follow-up: repair of historical `hosts` pollution.
 *
 * Before the apply() fix, every console update deployed as `host: 'openclaw'`
 * and the installer's manifest merge recorded `openclaw` on machines that only
 * serve WorkBuddy (or Codex). The repair may remove such a host ONLY when the
 * host's own evidence surface is readable and proves absence.
 */

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'pd-host-repair-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function writeManifest(hosts: string[]): string {
  const pdDir = path.join(home, '.pd');
  mkdirSync(pdDir, { recursive: true });
  const manifestPath = path.join(pdDir, 'install.json');
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      { layoutVersion: 1, mode: 'canonical', hosts, workspaces: [path.join(home, 'ws')], channel: 'stable' },
      null,
      2,
    )}\n`,
  );
  return manifestPath;
}

function registerWorkbuddyPlugin(): void {
  const pluginsDir = path.join(home, '.workbuddy', 'plugins');
  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(
    path.join(pluginsDir, 'installed_plugins.json'),
    JSON.stringify({ plugins: { [WORKBUDDY_PLUGIN_KEY]: {} } }),
  );
}

describe('repairInstallManifestHosts (PRI-1204 follow-up)', () => {
  it('removes a recorded host only when absence is proven, backing up the original value first', () => {
    const manifestPath = writeManifest(['openclaw', 'workbuddy']);
    registerWorkbuddyPlugin();
    const original = readFileSync(manifestPath, 'utf8');

    // Dry run: the plan is reported, the file and backups directory are untouched.
    const dryRun = repairInstallManifestHosts();
    expect(dryRun.success).toBe(true);
    expect(dryRun.applied).toBe(false);
    expect(dryRun.removed).toEqual(['openclaw']);
    expect(dryRun.after).toEqual(['workbuddy']);
    expect(dryRun.entries).toEqual([
      { host: 'openclaw', verdict: 'absent', detail: expect.stringContaining('.openclaw') },
      { host: 'workbuddy', verdict: 'installed', detail: expect.stringContaining('installed_plugins.json') },
    ]);
    expect(readFileSync(manifestPath, 'utf8')).toBe(original);
    expect(existsSync(path.join(home, '.pd', 'backups'))).toBe(false);

    const applied = repairInstallManifestHosts({ apply: true });
    expect(applied.success).toBe(true);
    expect(applied.applied).toBe(true);
    expect(applied.removed).toEqual(['openclaw']);
    expect(applied.backupPath).toBeDefined();
    // Verbatim original value, recoverable forever.
    expect(readFileSync(applied.backupPath!, 'utf8')).toBe(original);
    expect(applied.restoreCommand).toContain(applied.backupPath!);

    const written = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(written.hosts).toEqual(['workbuddy']);
    // The repair owns `hosts` only — other writers' fields survive (PRI-709).
    expect(written.channel).toBe('stable');
    expect(written.workspaces).toEqual([path.join(home, 'ws')]);
  });

  it('keeps a host whose evidence surface cannot be read and explains why', () => {
    const manifestPath = writeManifest(['workbuddy']);
    const pluginsDir = path.join(home, '.workbuddy', 'plugins');
    mkdirSync(pluginsDir, { recursive: true });
    // A registry that exists but is not parseable: absence CANNOT be proven.
    writeFileSync(path.join(pluginsDir, 'installed_plugins.json'), '{ not json');
    const original = readFileSync(manifestPath, 'utf8');

    const result = repairInstallManifestHosts({ apply: true });
    expect(result.success).toBe(true);
    expect(result.applied).toBe(false);
    expect(result.removed).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ host: 'workbuddy', verdict: 'undecidable' });
    expect(result.entries[0]!.detail).toContain('installed_plugins.json');
    expect(result.backupPath).toBeUndefined();
    expect(readFileSync(manifestPath, 'utf8')).toBe(original);
  });

  it('never judges an unknown host id recorded by a newer installer', () => {
    writeManifest(['openclaw', 'future-host']);

    const result = repairInstallManifestHosts({ apply: true });
    expect(result.success).toBe(true);
    expect(result.removed).toEqual(['openclaw']);
    expect(result.after).toEqual(['future-host']);
    expect(result.entries.find((entry) => entry.host === 'future-host')).toMatchObject({ verdict: 'not-judged' });
  });

  it('refuses to write an empty host record', () => {
    const manifestPath = writeManifest(['openclaw']);
    const original = readFileSync(manifestPath, 'utf8');

    const result = repairInstallManifestHosts({ apply: true });
    expect(result.success).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.reason).toContain('manifest_would_be_empty');
    expect(readFileSync(manifestPath, 'utf8')).toBe(original);
    expect(result.nextAction).toContain('official installer');
  });

  it('pins the workbuddy key shape the verdict depends on', () => {
    // Guards the fixture against a plugin-key rename silently turning the
    // "installed" case into an "absent" one.
    expect(WORKBUDDY_PLUGIN_KEY).toBe(`${WORKBUDDY_PLUGIN_NAME}@${WORKBUDDY_MARKETPLACE_NAME}`);
  });
});
