// CEB-002 preregistration contract consistency tests — the machine-readable
// contract in preregistration.draft.json must match the builder's output,
// the statistical implementation, and the frozen study state.
//
// SAFETY ARCHITECTURE (Owner final safety rounds):
//   - resolveOutputDir is imported from lib/ceb002-cli.mjs (the PURE module),
//     never from build-ceb002-suite.mjs.
//   - Import-side-effect testing uses a SEPARATE Node child process to
//     bypass ESM module caching (in-process import would hit the cache).
//   - Real CEB-002 directory protection uses FULL recursive directory-tree
//     snapshots (every file, every byte — not just prereg + 3 ledgers).
//
// These tests detect: field deletion, value tampering, builder drift, and
// statistical-boundary misstatements.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

import { mcnemarExactPValue, mcnemarExactPower, reduceCaseLevel } from '../dev/principle-learning-lab/lib/ceb002-stats.mjs';
import { resolveOutputDir } from '../dev/principle-learning-lab/lib/ceb002-cli.mjs';

const labRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dev/principle-learning-lab');
const study = path.join(labRoot, 'challenge-studies', 'CEB-002');

/** Containment guard: resolves segments under root, refuses escape. */
function inside(root: string, ...segments: string[]): string {
  const abs = path.resolve(root, ...segments);
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error(`test helper: path escapes root (${segments.join('/')})`);
  }
  return abs;
}

/** FULL recursive directory snapshot: Map<relativePath, contents> for every file. */
function snapshotDir(root: string): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = inside(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else map.set(r, fs.readFileSync(abs, 'utf8'));
    }
  };
  walk(root, '');
  return map;
}

/** Assert two directory snapshots are IDENTICAL: same file set + same byte content per file. */
function expectSnapshotsIdentical(before: Map<string, string>, after: Map<string, string>, label: string) {
  const created = [...after.keys()].filter((k) => !before.has(k));
  const deleted = [...before.keys()].filter((k) => !after.has(k));
  const modified = [...before.keys()].filter((k) => after.has(k) && after.get(k) !== before.get(k));
  const problems: string[] = [];
  if (created.length > 0) problems.push(`files created: ${created.join(', ')}`);
  if (deleted.length > 0) problems.push(`files deleted: ${deleted.join(', ')}`);
  if (modified.length > 0) problems.push(`files modified: ${modified.join(', ')}`);
  if (before.size !== after.size) problems.push(`file count changed: ${before.size} → ${after.size}`);
  expect(problems, `${label}: REAL CEB-002 directory was modified`).toEqual([]);
}

const readJson = (p: string): any => JSON.parse(fs.readFileSync(p, 'utf8'));

describe('CEB-002 preregistration contract consistency', () => {
  const pr = readJson(inside(study, 'preregistration.draft.json'));
  const manifest = readJson(inside(study, 'suite-manifest.json'));
  const auth = readJson(inside(study, 'run-authorization.json'));

  it('1. design: EXPLORATORY, fixed 2 reps, 16 cases, 3 arms, 96 units', () => {
    // The archived (frozen-lineage) draft carries the statistical contract at
    // top level (prepare-ceb002-freeze merged shape) instead of the builder's
    // nested `design` object — same contract, authoritative frozen shape.
    expect(pr.positioning).toBe('EXPLORATORY');
    expect(pr.repetitions.planned).toBe(2);
    expect(pr.arms.map((a: any) => a.armId)).toEqual(['A', 'B', 'C']);
    expect(manifest.caseCount).toBe(16);
    expect(pr.denominator.assignedUnits).toContain('96 execution units');
    expect(pr.repetitions.planned * pr.arms.length * manifest.caseCount).toBe(96);
  });

  it('2. primary analysis: L2+L3 discriminative tier, n=8 independent case-level units', () => {
    expect(pr.primaryAnalysis.scope).toContain('L2+L3');
    expect(pr.primaryAnalysis.independentUnits).toBe(8);
    expect(pr.primaryAnalysis.independence).toContain('never independent samples');
    expect(pr.primaryAnalysis.independence).toContain('repeated measurements');
  });

  it('3. reduceCaseLevel semantics including mixed outcomes', () => {
    expect(pr.primaryAnalysis.reductionRule).toContain('reduceCaseLevel');
    expect(pr.primaryAnalysis.reductionRule).toContain('FIXED BEFORE any results');
    expect(reduceCaseLevel([{ bFail: true, cFail: false }, { bFail: false, cFail: false }])).toEqual({ bWorse: true, cWorse: false });
    expect(reduceCaseLevel([{ bFail: false, cFail: true }, { bFail: false, cFail: true }])).toEqual({ bWorse: false, cWorse: true });
    expect(reduceCaseLevel([{ bFail: true, cFail: false }, { bFail: false, cFail: true }])).toEqual({ bWorse: false, cWorse: false });
    expect(reduceCaseLevel([{ bFail: true, cFail: true }, { bFail: false, cFail: false }])).toEqual({ bWorse: false, cWorse: false });
    expect(reduceCaseLevel([{ bFail: true, cFail: true }, { bFail: true, cFail: true }])).toEqual({ bWorse: false, cWorse: false });
    expect(reduceCaseLevel([{ bFail: false, cFail: false }, { bFail: false, cFail: false }])).toEqual({ bWorse: false, cWorse: false });
  });

  it('4. exact McNemar: rejection boundary and power claims match implementation', () => {
    expect(mcnemarExactPValue(6, 0)).toBeCloseTo(0.03125, 5);
    expect(mcnemarExactPValue(5, 0)).toBeCloseTo(0.0625, 5);
    expect(mcnemarExactPValue(5, 0)).toBeGreaterThan(0.05);
    expect(mcnemarExactPValue(7, 0)).toBeCloseTo(0.015625, 6);
    expect(mcnemarExactPValue(8, 0)).toBeCloseTo(0.0078125, 7);
    expect(mcnemarExactPValue(0, 6)).toBeCloseTo(0.03125, 5);
    const pl = pr.primaryAnalysis.powerLimitation;
    expect(pl).toContain('(6,0)');
    expect(pl).toContain('does NOT reject');
    expect(mcnemarExactPower({ pairs: 8, p10: 0.5, p01: 0 })).toBeCloseTo(0.1445, 3);
    expect(mcnemarExactPower({ pairs: 8, p10: 0.375, p01: 0.125 })).toBeCloseTo(0.024, 2);
    expect(mcnemarExactPower({ pairs: 8, p10: 0.1, p01: 0.1 })).toBeLessThan(0.001);
    expect(pl).toContain('0.1445');
    expect(pl).toContain('0.024');
    expect(pl).toContain('INFEASIBLE');
  });

  it('5. reference views: both labeled; 32-pair NON-INDEPENDENT', () => {
    expect(pr.referenceViews.length).toBe(2);
    const v16 = pr.referenceViews.find((v: any) => v.view.includes('16'));
    const v32 = pr.referenceViews.find((v: any) => v.view.includes('32'));
    expect(v16.status).toContain('reference only');
    expect(v32.status).toContain('NON-INDEPENDENT');
    expect(v32.forbiddenUse).toContain('inflate');
  });

  it('6. no automatic escalation', () => {
    expect(pr.escalation.automatic).toBe(false);
    expect(pr.escalation.rule).toContain('NONE');
    expect(pr.escalation.rule).toContain('SEPARATE preregistration');
  });

  it('7. confound and claim boundary', () => {
    expect(pr.confounds[0].name).toContain('2:5');
    expect(pr.confounds[0].preregistered).toBe(true);
    expect(pr.claimBoundary.doesNotSupport.some((s: string) => s.includes('causal attribution'))).toBe(true);
    expect(pr.claimBoundary.doesNotSupport.some((s: string) => s.includes('confirmatory'))).toBe(true);
    expect(pr.claimBoundary.supports.some((s: string) => s.includes('exploratory comparison'))).toBe(true);
  });

  it('8a. stopping rules: every field value-matched (frozen stoppingConditions array, exact match)', () => {
    // Exact-match the archived frozen contract's stoppingConditions — stronger
    // than the previous per-field reads of the builder's stoppingRules object.
    expect(pr.stoppingConditions).toEqual([
      'consecutiveUnknown: 2 (halt immediately after 2 consecutive RESULT_UNKNOWN units)',
      'batchUnknownRateNotEvaluable: 0.40 (batch UNKNOWN rate > 40% → study NOT_EVALUABLE)',
      'identityAnomaly: halt immediately',
      'hashDrift: halt immediately',
      'ledgerInconsistency: halt immediately',
      'budgetBreach: halt immediately',
      'missingData: retained in denominator, never attributed to behavior',
    ]);
  });

  it('9. FROZEN+EXECUTED states (evidence archive): frozen hash pinned, authorization window byte-pinned, in-force twin present', () => {
    // CEB-002 was frozen, authorized and executed 2026-10-27, and its evidence
    // archived 2026-10-28 (previously these protected the DRAFT placeholders).
    // The live-clock expiry of the historical authorization is enforced
    // SEPARATELY in principle-learning-lab-archived-authorization-gate.test.ts
    // (RED until 2026-10-28T12:22:47.763Z — the natural-expiry merge gate from
    // the Owner P1-1 review finding; this test only pins the record BYTES).
    const FROZEN_SUITE = '02cbc15cfd9cf8a8b9e986950fdf722fcda6632604f4e62d4bd50ea0950d04f5';
    const hashes = readJson(inside(study, 'hashes.json'));
    expect(manifest.suiteHash).toBe(FROZEN_SUITE);
    expect(hashes.suiteHash.value).toBe(FROZEN_SUITE);
    expect(auth.status).toBe('APPROVED');
    expect(auth.suiteHash).toBe(FROZEN_SUITE);
    expect(auth.studyPlanHash).toBe(hashes.preregistrationHash.value);
    // the historical authorization record is pinned byte-exact (any tampering
    // with its window breaks the pin). Its 24h window extended into
    // 2026-10-28T12:22:47.763Z; the original study's budget exhaustion
    // (96/96) does NOT revoke it — the gate and the per-directory ledger are
    // different checks, so the natural-expiry merge gate lives in
    // principle-learning-lab-archived-authorization-gate.test.ts (Owner P1-1).
    expect(auth.validFrom).toBe('2026-10-27T12:22:47.763Z');
    expect(auth.validUntil).toBe('2026-10-28T12:22:47.763Z');
    expect(auth.halted).toBe(false);
    expect(auth.revoked).toBe(false);
    // frozen-lineage draft + the in-force twin the authorization binds
    expect(pr.status).toBe('DRAFT');
    expect(fs.existsSync(inside(study, 'preregistration.json'))).toBe(true);
    expect(pr.freezeRequirement).toContain('Owner approval');
  });

  it('11. resolveOutputDir (from PURE module lib/ceb002-cli.mjs): fail-closed, every illegal form throws', () => {
    const def = '/default/CEB-002';
    expect(resolveOutputDir([], def)).toBe(def);
    expect(resolveOutputDir(['--foo', 'bar'], def)).toBe(def);
    expect(resolveOutputDir(['--output-dir', '/tmp/x'], def)).toBe(path.resolve('/tmp/x'));
    expect(resolveOutputDir(['--other', '1', '--output-dir', 'rel/dir'], def)).toBe(path.resolve('rel/dir'));
    expect(() => resolveOutputDir(['--output-dir'], def)).toThrow(/non-empty path/);
    expect(() => resolveOutputDir(['--output-dir', ''], def)).toThrow(/non-empty path/);
    expect(() => resolveOutputDir(['--output-dir', '   '], def)).toThrow(/non-empty path/);
    expect(() => resolveOutputDir(['--output-dir', '--flag'], def)).toThrow(/not another option/);
    expect(() => resolveOutputDir(['--output-dir', '/a', '--output-dir', '/b'], def)).toThrow(/exactly one/);
  });

  it('10a. IMPORTING the builder module (via SEPARATE child process) has ZERO side effects on the real CEB-002 directory', { timeout: 30000 }, () => {
    const before = snapshotDir(study);
    // spawnSync a dedicated Node process that ONLY imports the module —
    // this bypasses the vitest ESM module cache entirely (a fresh V8 context)
    const importScript = `import(${JSON.stringify(`file:///${path.join(labRoot, 'build-ceb002-suite.mjs').replace(/\\/g, '/')}`)}).then(() => console.log('IMPORTED')).catch(e => { console.error(e.message); process.exit(1); })`;
    const result = spawnSync('node', ['--input-type=module', '-e', importScript], { encoding: 'utf8', timeout: 20000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('IMPORTED');
    expectSnapshotsIdentical(before, snapshotDir(study), 'import-side-effect check');
  });

  it('10b. ISOLATED CLI rebuild: deterministic (two rebuilds byte-identical), builder authority-reference intact; real CEB-002 directory FULLY unchanged', { timeout: 30000 }, () => {
    // The real directory now holds the FROZEN+EXECUTED archive (its draft is
    // prepare-ceb002-freeze's merged lineage), so the byte comparison target
    // moved from "real dir" to "a second isolated rebuild" (determinism), and
    // the builder-side authority-reference protection (#2184) is asserted on
    // the isolated rebuild itself.
    const before = snapshotDir(study);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ceb002-determinism-'));
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ceb002-determinism-'));
    try {
      execFileSync('node', [path.join(labRoot, 'build-ceb002-suite.mjs'), '--output-dir', tmp], { encoding: 'utf8', stdio: 'pipe' });
      execFileSync('node', [path.join(labRoot, 'build-ceb002-suite.mjs'), '--output-dir', tmp2], { encoding: 'utf8', stdio: 'pipe' });
      const isolated = fs.readFileSync(inside(tmp, 'preregistration.draft.json'), 'utf8');
      expect(isolated).toBe(fs.readFileSync(inside(tmp2, 'preregistration.draft.json'), 'utf8'));
      const isolatedPr = JSON.parse(isolated);
      expect(isolatedPr.status).toBe('DRAFT-NOT-IN-FORCE');
      expect(isolatedPr.authority).toContain('CEB-002-DELIVERY-PACK.md');
      expect(isolatedPr.authority).not.toContain('CEB-002-PREREGISTRATION.md');
      expectSnapshotsIdentical(before, snapshotDir(study), 'isolated-build protection');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(tmp2, { recursive: true, force: true });
    }
  });

  it('10c. ALL illegal CLI arguments exit code 1 BEFORE any file write; real directory FULLY unchanged', { timeout: 30000 }, () => {
    const before = snapshotDir(study);
    const illegalForms = [
      ['--output-dir'],
      ['--output-dir', ''],
      ['--output-dir', '--flag'],
      ['--output-dir', '/a', '--output-dir', '/b'],
    ];
    for (const args of illegalForms) {
      const result = spawnSync('node', [path.join(labRoot, 'build-ceb002-suite.mjs'), ...args], { encoding: 'utf8', timeout: 15000, stdio: 'pipe' });
      expect(result.status).toBe(1);
    }
    expectSnapshotsIdentical(before, snapshotDir(study), 'illegal-args protection');
  });
});
