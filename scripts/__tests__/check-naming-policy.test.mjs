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

  it('the PR-3 tree is clean: strict exits 0 and no rule is gated-failing', () => {
    // PRI-1136 inverted this assertion: PR-1 pinned "strict fails while gated
    // findings remain"; after the rename the same invocation must pass. If it
    // ever fails again, a `runtime-v2` path came back.
    const plain = run('--strict');
    const json = run('--strict', '--json');
    expect(plain.status).toBe(0);
    expect(json.status).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.gatedFindings).toBe(0);
    expect(parsed.findings).toEqual([]);
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

describe('check-naming-policy rule gating is explicit (PRI-1136 / PR-6 boundary)', () => {
  it('the registry decides which rules can fail the build', () => {
    const parsed = JSON.parse(run('--json').stdout);
    expect(parsed.gatedRules).toContain('runtime-v2-import');
    expect(parsed.gatedRules).toContain('runtime-v2-identifier');
    expect(parsed.gatedRules).toContain('runtime-v2-config');
    // PRI-1139 (PR-6) flips the write side; until then this rule must not gate.
    expect(parsed.gatedRules).not.toContain('versioned-output-ref');
  });

  it('pending-rule findings are reported but never fail the build', () => {
    const parsed = JSON.parse(run('--strict', '--json').stdout);
    expect(parsed.pendingFindings).toBeGreaterThan(0);
    for (const finding of parsed.pending) expect(finding.rule).toBe('versioned-output-ref');
    expect(run('--strict').status).toBe(0);
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

  it('counts a bare ./runtime-v2 directory-entry import (#4) and fails on it', () => {
    const root = tempScanRoot();
    fs.writeFileSync(path.join(root, 'entry.ts'), "export * from './runtime-v2';\n");
    const result = runRoot(root, '--strict', '--json');
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.inventory['runtime-v2-import']).toBeGreaterThan(0);
    expect(parsed.findings.some((f) => f.rule === 'runtime-v2-import')).toBe(true);
  });

  it('counts an outputSchemaRef whose value is on the next line (#6) without gating it yet', () => {
    const root = tempScanRoot();
    fs.writeFileSync(path.join(root, 'runner.ts'), "const input = {\n  outputSchemaRef:\n    'foo-output-v1',\n};\n");
    const result = runRoot(root, '--strict', '--json');
    // PRI-1136: the rule stays in the inventory but is a PRI-1139 deliverable,
    // so a hit here is pending — reported, not fatal.
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.inventory['versioned-output-ref']).toBeGreaterThan(0);
    expect(parsed.pending.some((f) => f.rule === 'versioned-output-ref')).toBe(true);
  });
});

describe('check-naming-policy config surface (PRI-1136 scan redesign)', () => {
  it('does not flag the policy registry own rule ids or prose', () => {
    // A plain text sweep would match `runtime-v2-import` / `runtime-v2-config`
    // inside namingPolicy itself; the field-aware pass must not.
    const parsed = JSON.parse(run('--strict', '--json').stdout);
    expect(parsed.inventory['runtime-v2-config']).toBe(0);
  });

  it('the registry keeps its gated rules and clean seam paths', () => {
    const registryPath = fileURLToPath(
      new URL('../../packages/principles-core/io-seam-registry.json', import.meta.url),
    );
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    expect(Array.isArray(registry.seams)).toBe(true);
    expect(registry.seams.flatMap((s) => s.files ?? []).every((f) => !f.includes('runtime-v2'))).toBe(true);
    expect(registry.namingPolicy.gatedRules).toEqual([
      'runtime-v2-import',
      'runtime-v2-identifier',
      'runtime-v2-config',
    ]);
  });
});

describe('check-naming-policy inventory vs exemptions (PR #2367 CodeRabbit #5)', () => {
  it('exempt server/UI files still contribute their /api/v1 route literals', () => {
    const parsed = JSON.parse(run('--json').stdout);
    // server/index.ts and ui/api.ts hold the bulk of the '/api/v1/' literals;
    // both files are gated-rule exemptions but MUST appear in the inventory.
    expect(parsed.inventory['api-v1-route']).toBeGreaterThanOrEqual(130);
  });

  it('the default scan surface includes the root plugin payload', () => {
    // The two shipped plugin scripts are temporarily exempt until the Core 5.x
    // runtime-pins move; they still must be inventoried, which proves plugins/**
    // is scanned at all (PRI-1136 review P2).
    const parsed = JSON.parse(run('--json').stdout);
    expect(parsed.inventory['runtime-v2-import']).toBeGreaterThanOrEqual(2);
  });
});

describe('check-naming-policy identifier revival (PRI-1136 review P2)', () => {
  it('flags RuntimeV2 / runtimeV2 / RUNTIME_V2 identifiers and fails strict', () => {
    const root = tempScanRoot();
    fs.writeFileSync(
      path.join(root, 'identifiers.ts'),
      'export const RuntimeV2Thing = 1;\nexport const runtimeV2Thing = RuntimeV2Thing;\nexport const RUNTIME_V2_THING = 2;\n',
    );
    const result = runRoot(root, '--strict', '--json');
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.inventory['runtime-v2-identifier']).toBe(4);
    expect(parsed.findings.some((finding) => finding.rule === 'runtime-v2-identifier')).toBe(true);
  });

  it('suppresses only the exact deprecated token, not the whole line or file', () => {
    const root = tempScanRoot();
    fs.writeFileSync(
      path.join(root, 'alias.ts'),
      'export const RUNTIME_V2_EVENT_LOG_CANDIDATE_DIRS = 1; export const RuntimeV2Thing = 2;\n',
    );
    const result = runRoot(root, '--strict', '--json');
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.inventory['runtime-v2-identifier']).toBe(2);
    const identifierFindings = parsed.findings.filter((finding) => finding.rule === 'runtime-v2-identifier');
    expect(identifierFindings).toHaveLength(1);
    expect(identifierFindings[0].count).toBe(1);
  });

  it('the deprecated alias alone is inventoried but never gated', () => {
    const root = tempScanRoot();
    fs.writeFileSync(
      path.join(root, 'alias.ts'),
      'export const RUNTIME_V2_EVENT_LOG_CANDIDATE_DIRS = 1;\n',
    );
    const result = runRoot(root, '--strict', '--json');
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.inventory['runtime-v2-identifier']).toBe(1);
    expect(parsed.findings).toEqual([]);
  });
});
