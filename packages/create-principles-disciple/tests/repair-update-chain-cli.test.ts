/**
 * PRI-850 review fix (cli-1): `repair-update-chain --json` stdout must be
 * EXACTLY one parseable JSON document — logger banners silenced, exit code
 * reflects success. Exercises the REAL compiled CLI entry (cli-7).
 */
import { execFileSync } from 'node:child_process';
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
