/**
 * Regression coverage for the trust-root ceremony's atomic creation
 * (PRI-732 / #1732 TOCTOU fix).
 *
 * These assertions run the REAL ceremony as a child process against the
 * committed packages/.../trust/root.json. They MUST NOT modify the committed
 * root, so the only scenario exercised here is the safe one: a root already
 * exists and the ceremony is re-run WITHOUT --force. The atomicity fix makes
 * the write exclusive (`wx`); the existing-root write raises EEXIST, which the
 * ceremony maps to its governance error — leaving the existing bytes untouched.
 *
 * The --force success path is intentionally NOT executed against the committed
 * root (it would mutate the repository's trust anchor); that path is covered by
 * the provisioned-root assertions in trust-root-provisioning.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const here = fileURLToPath(new URL('.', import.meta.url));
const SCRIPT = resolve(here, '..', 'scripts', 'generate-trust-root.mjs');
const ROOT = resolve(here, '..', 'trust', 'root.json');

describe('generate-trust-root ceremony: atomic creation (wx)', () => {
  it('refuses to overwrite an existing pinned root without --force and leaves bytes unchanged', () => {
    const before = readFileSync(ROOT);
    const keyOut = resolve(tmpdir(), `pd-trust-ceremony-${process.pid}.pem`);

    let stderr = '';
    let threw = false;
        try {
      execFileSync('node', [SCRIPT, '--private-key-output', keyOut], {
        encoding: 'utf8',
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (error) {
      threw = true;
      const e = error as { stderr?: string; message?: string };
      stderr = (e.stderr ?? '') + (e.message ?? '');
    }

    // 1. Ceremony must fail (non-zero exit).
    expect(threw, 'ceremony should refuse when a root already exists without --force').toBe(true);

    // 2. Failure surfaces as the governance message (no silent rotation).
    expect(stderr).toMatch(/A pinned trust root already exists/);
    expect(stderr).toMatch(/rotation requires an explicit governance decision/);
    expect(stderr).toMatch(/Pass --force only for that decision/);

    // 3. The committed root bytes are byte-for-byte unchanged.
    const after = readFileSync(ROOT);
    expect(after.equals(before)).toBe(true);
  });
});
