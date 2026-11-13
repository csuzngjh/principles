/**
 * PRI-850 review fix (cli-1): `repair-update-chain --json` stdout must be
 * EXACTLY one parseable JSON document — logger banners silenced, exit code
 * reflects success. Exercises the REAL compiled CLI entry (cli-7).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI_ENTRY = path.resolve(__dirname, '..', 'dist', 'index.js');

describe('repair-update-chain CLI (real entry, cli-1)', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-repair-cli-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('stdout parses as one JSON document; bootstrap deployed and no product version touched', { timeout: 180_000 }, () => {
    const stdout = execFileSync(process.execPath, [CLI_ENTRY, 'repair-update-chain', '--json'], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PD_RELEASE_METADATA_URL: 'https://example.invalid/relnotes-test',
      },
      encoding: 'utf8',
      timeout: 150_000,
    });

    let parsed: { success?: boolean; installedProductVersion?: unknown; bootstrap?: { bootstrapVersion?: string } };
    expect(() => { parsed = JSON.parse(stdout); }).not.toThrow();
    parsed = JSON.parse(stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.bootstrap?.bootstrapVersion).toMatch(/^\d+\.\d+\.\d+$/);
    // The registered executor re-verifies against the deployed bytes.
    const registration = JSON.parse(fs.readFileSync(path.join(home, '.pd', 'bootstrap', 'bootstrap.json'), 'utf8')) as { bootstrapVersion?: string; executorDigest?: string };
    expect(registration.bootstrapVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(registration.executorDigest).toMatch(/^[a-f0-9]{64}$/);
    // No active.json was written — repair must not invent a product identity.
    expect(fs.existsSync(path.join(home, '.pd', 'active.json'))).toBe(false);
  });
});

/**
 * PRI-1204 follow-up (cli-1 / cli-7): the repair is dry-run by default and
 * `--json` stdout stays exactly one parseable document, including refusals.
 */
describe('repair-host-manifest CLI (real entry)', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-host-repair-cli-'));
    fs.mkdirSync(path.join(home, '.pd'), { recursive: true });
    fs.mkdirSync(path.join(home, '.workbuddy', 'plugins'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.workbuddy', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'principles-disciple@principles-disciple-market': {} } }),
    );
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  function writeManifest(hosts: string[]): string {
    const manifestPath = path.join(home, '.pd', 'install.json');
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify({ layoutVersion: 1, mode: 'canonical', hosts, workspaces: [home], channel: 'stable' })}\n`,
    );
    return manifestPath;
  }

  function run(args: string[]): { status: number | null; stdout: string } {
    const result = spawnSync(process.execPath, [CLI_ENTRY, 'repair-host-manifest', ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: result.status, stdout: result.stdout };
  }

  it('dry run reports the plan as one JSON document and leaves the manifest untouched', () => {
    const manifestPath = writeManifest(['openclaw', 'workbuddy']);
    const original = fs.readFileSync(manifestPath, 'utf8');

    const { status, stdout } = run(['--json']);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.manifestPath).toBe(manifestPath);
    expect(parsed.applied).toBe(false);
    expect(parsed.removed).toEqual(['openclaw']);
    expect(parsed.after).toEqual(['workbuddy']);
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(original);
  });

  it('--apply writes the repair with a backup; an unreadable manifest refuses with exit 1', () => {
    const manifestPath = writeManifest(['openclaw', 'workbuddy']);
    const original = fs.readFileSync(manifestPath, 'utf8');

    const applied = JSON.parse(run(['--apply', '--json']).stdout);
    expect(applied.applied).toBe(true);
    expect(applied.backupPath).toBeDefined();
    expect(fs.readFileSync(applied.backupPath, 'utf8')).toBe(original);
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).hosts).toEqual(['workbuddy']);

    fs.writeFileSync(manifestPath, '{ broken');
    const refused = run(['--apply', '--json']);
    expect(refused.status).toBe(1);
    const refusal = JSON.parse(refused.stdout);
    expect(refusal.success).toBe(false);
    expect(refusal.reason).toContain('install_manifest_unreadable');
  });
});

