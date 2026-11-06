import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../check-naming-policy.mjs', import.meta.url));

function run(...args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf-8' });
}

const tempRoots = [];
function tempScanRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-naming-scan-'));
  tempRoots.push(dir);
  return dir;
}
function runRoot(root, ...flags) {
  return spawnSync(process.execPath, [script, '--scan-root', root, ...flags], { encoding: 'utf-8' });
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

/**
 * PR #2367 independent review finding M1: the strict verdict used to be
 * computed inside the human-readable output branch, so `--strict --json`
 * exited 0 even with 242 findings. These assertions pin the exit contract
 * across output formats — they must hold whatever the current inventory is.
 *
 * CodeRabbit follow-ups add CONTROLLED scan inputs (`--scan-root`) so the
 * verdict never depends on whatever happens to be in the PR tree.
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

describe('check-naming-policy controlled scan roots (PR #2367 CodeRabbit #3/#4/#6/#9)', () => {
  it('empty tree: strict exits 0 in both output formats (no findings, no errors)', () => {
    const root = tempScanRoot();
    expect(runRoot(root, '--strict').status).toBe(0);
    expect(runRoot(root, '--strict', '--json').status).toBe(0);
  });

  it('unreadable tree: strict exits 1 in both output formats from scan errors alone', () => {
    const missing = path.join(tempScanRoot(), 'does-not-exist');
    const plain = runRoot(missing, '--strict');
    const json = runRoot(missing, '--strict', '--json');
    expect(plain.status).toBe(1);
    expect(json.status).toBe(1);
    expect(JSON.parse(json.stdout).scanErrors.length).toBeGreaterThan(0);
  });

  it('excludes .test.tsx files from the production scan (#3)', () => {
    const root = tempScanRoot();
    fs.writeFileSync(path.join(root, 'fixture.test.tsx'), "export const ref = 'outputSchemaRef: foo-v1';\n");
    const result = runRoot(root, '--strict', '--json');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).inventory['versioned-output-ref']).toBe(0);
  });

  it('counts a bare ./runtime-v2 directory-entry import (#4)', () => {
    const root = tempScanRoot();
    fs.writeFileSync(path.join(root, 'entry.ts'), "export * from './runtime-v2';\n");
    const result = runRoot(root, '--strict', '--json');
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.inventory['runtime-v2-import']).toBeGreaterThan(0);
    expect(parsed.findings.some((f) => f.rule === 'runtime-v2-import')).toBe(true);
  });

  it('counts an outputSchemaRef whose value is on the next line (#6)', () => {
    const root = tempScanRoot();
    fs.writeFileSync(path.join(root, 'runner.ts'), "const input = {\n  outputSchemaRef:\n    'foo-output-v1',\n};\n");
    const result = runRoot(root, '--strict', '--json');
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.inventory['versioned-output-ref']).toBeGreaterThan(0);
    expect(parsed.findings.some((f) => f.rule === 'versioned-output-ref')).toBe(true);
  });
});

describe('check-naming-policy inventory vs exemptions (PR #2367 CodeRabbit #5)', () => {
  it('exempt server/UI files still contribute their /api/v1 route literals', () => {
    const parsed = JSON.parse(run('--json').stdout);
    // server/index.ts has 54 and ui/api.ts has 76 '/api/v1/' literals; both
    // files are gated-rule exemptions but MUST appear in the inventory.
    expect(parsed.inventory['api-v1-route']).toBeGreaterThanOrEqual(130);
  });
});
