import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../check-naming-policy.mjs', import.meta.url));

function run(...args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf-8' });
}

/**
 * PR #2367 independent review finding M1: the strict verdict used to be
 * computed inside the human-readable output branch, so `--strict --json`
 * exited 0 even with 242 findings. These assertions pin the exit contract
 * across output formats — they must hold whatever the current inventory is.
 */
describe('check-naming-policy exit contract', () => {
  it('--strict verdict is identical with and without --json (no format bypass)', () => {
    const plain = run('--strict');
    const json = run('--strict', '--json');
    expect(plain.status).toBe(json.status);
    expect(JSON.parse(json.stdout).mode).toBe('strict');
  });

  it('--strict fails while gated findings remain in the PR-1 tree', () => {
    expect(run('--strict').status).toBe(1);
    expect(run('--strict', '--json').status).toBe(1);
  });

  it('warn mode never fails, in either output format', () => {
    expect(run().status).toBe(0);
    expect(run('--json').status).toBe(0);
  });

  it('--json emits exactly one parseable object with inventory and scan errors', () => {
    const result = run('--json');
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.mode).toBe('warn');
    expect(parsed.inventory).toBeTypeOf('object');
    expect(Array.isArray(parsed.scanErrors)).toBe(true);
    expect(Array.isArray(parsed.findings)).toBe(true);
    expect(parsed.gatedFindings).toBe(parsed.findings.length);
  });
});
