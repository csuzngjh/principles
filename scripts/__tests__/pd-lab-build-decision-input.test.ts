// PRI-1255 / PD-Lab v0.3 T4: subprocess tests for build-decision-input.mjs.
//
// Spawns the real CLI (node scripts/dev/pd-lab/build-decision-input.mjs) on
// self-contained synthetic directories and asserts exit codes plus the
// on-disk decision-input.json / final-comparisons.json. A startup crash is
// never a valid rejection.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dev', 'pd-lab', 'build-decision-input.mjs');

let tempRoot: string;

beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-lab-decision-input-'));
});

afterAll(() => {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function assignmentKey(caseId: string, repetitionId: string) {
  return `cfg-candidate+${caseId}@v1+opp-1+${repetitionId}+ref-1`;
}

/** blindmap entries are keyed per judgment record (display order can swap between exchanges). */
function candidateAtA(judgmentId: string) {
  return { [judgmentId]: { A: 'candidate', B: 'reference' } };
}

function judgmentRecord(judgmentId: string, caseId: string, repetitionId: string, displayVerdict: string) {
  return {
    judgmentId,
    assignmentKey: assignmentKey(caseId, repetitionId),
    judgeProtocolRef: 'jp-test@1',
    comparisonInputDigest: 'sha256:synthetic',
    displayVerdict,
  };
}

/** Two planned units of one case; rep-1 judged CANDIDATE_BETTER, rep-2 missing. */
function missingReviewDir(name: string, blindmapMap: Record<string, { A: string; B: string }>) {
  const dir = path.join(tempRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  const plan = {
    schemaVersion: 'pd-lab-plan.v1',
    benchmarkId: 'bench-cli',
    benchmarkVersion: '1',
    comparisonDesign: 'CHANGE_VS_BASELINE',
    judgeProtocolRef: 'jp-test@1',
    judgeProtocol: { requiredJudgments: 1 },
    analysisPolicy: { alpha: 0.05 },
    owners: [{ ownerId: 'O1', weight: 1 }],
    scenarios: [{ scenarioId: 'SC1', ownerId: 'O1', weight: 1 }],
    assignments: [
      { candidateConfigId: 'cfg-candidate', caseId: 'case-1', caseVersion: 'v1', opportunityId: 'opp-1', repetitionId: 'rep-1', referenceId: 'ref-1', scenarioId: 'SC1' },
      { candidateConfigId: 'cfg-candidate', caseId: 'case-1', caseVersion: 'v1', opportunityId: 'opp-1', repetitionId: 'rep-2', referenceId: 'ref-1', scenarioId: 'SC1' },
    ],
  };
  fs.writeFileSync(path.join(dir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  // A_BETTER with A=candidate -> CANDIDATE_BETTER for rep-1; rep-2 unjudged.
  fs.writeFileSync(path.join(dir, 'judgments.json'), `${JSON.stringify([judgmentRecord('j-1', 'case-1', 'rep-1', 'A_BETTER')], null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'blindmap.json'), `${JSON.stringify({ map: blindmapMap }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'source-groups.json'), `${JSON.stringify({ groups: { 'case-1': 'sg-1' }, rationales: {} }, null, 2)}\n`, 'utf8');
  return dir;
}

function runCli(args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

function readOutJson(outDir: string, file: string) {
  return JSON.parse(fs.readFileSync(path.join(outDir, file), 'utf8'));
}

describe('build-decision-input CLI (subprocess)', () => {
  it('a plan-internal missing review stays an UNKNOWN unit instead of dropping it', () => {
    const inputDir = missingReviewDir('missing-review', candidateAtA('j-1'));
    const outDir = path.join(inputDir, 'out');
    const result = runCli([
      '--plan', path.join(inputDir, 'plan.json'),
      '--judgments', path.join(inputDir, 'judgments.json'),
      '--blindmap', path.join(inputDir, 'blindmap.json'),
      '--source-groups', path.join(inputDir, 'source-groups.json'),
      '--out-dir', outDir,
    ]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const decision = readOutJson(outDir, 'decision-input.json');
    expect(decision.status).toBe('BOUNDED_ONLY');
    expect(decision.pointEstimate).toBe(null);
    expect(decision.missingBounds).toEqual({ lower: 50, upper: 100 });
    expect(decision.counts.planned).toBe(2);
    expect(decision.counts.resolved).toBe(1);
    expect(decision.counts.unknown).toBe(1);
    const comparisons = readOutJson(outDir, 'final-comparisons.json');
    expect(comparisons).toHaveLength(2); // both planned units present
    const missing = comparisons.find((fc: { assignmentKey: string }) => fc.assignmentKey === assignmentKey('case-1', 'rep-2'));
    expect(missing.verdict).toBe('UNKNOWN');
    expect(missing.reasonCode).toBe('MISSING_JUDGMENTS');
    const judged = comparisons.find((fc: { assignmentKey: string }) => fc.assignmentKey === assignmentKey('case-1', 'rep-1'));
    expect(judged.verdict).toBe('CANDIDATE_BETTER'); // A restored to candidate via blindmap
    expect(decision.decision.outcome).toBe('INCONCLUSIVE'); // single group, n=1 < 6
    expect(decision.decision.unknownsCouldChangeVerdict).toBe(false);
  });

  it('a blindmap missing the mapping for a judged unit exits non-zero as INVALID', () => {
    const inputDir = missingReviewDir('blindmap-missing', {});
    const outDir = path.join(inputDir, 'out');
    const result = runCli([
      '--plan', path.join(inputDir, 'plan.json'),
      '--judgments', path.join(inputDir, 'judgments.json'),
      '--blindmap', path.join(inputDir, 'blindmap.json'),
      '--source-groups', path.join(inputDir, 'source-groups.json'),
      '--out-dir', outDir,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('BLINDMAP_MISSING');
    const decision = readOutJson(outDir, 'decision-input.json');
    expect(decision.status).toBe('INVALID');
    expect(decision.problems.some((p: { code: string }) => p.code === 'BLINDMAP_MISSING')).toBe(true);
    expect(decision.pointEstimate).toBe(null);
  });

  it('the same input produces byte-identical outputs across runs (digest stability)', () => {
    const inputDir = missingReviewDir('stable', candidateAtA('j-1'));
    const out1 = path.join(inputDir, 'out-1');
    const out2 = path.join(inputDir, 'out-2');
    const args = (outDir: string) => [
      '--plan', path.join(inputDir, 'plan.json'),
      '--judgments', path.join(inputDir, 'judgments.json'),
      '--blindmap', path.join(inputDir, 'blindmap.json'),
      '--source-groups', path.join(inputDir, 'source-groups.json'),
      '--out-dir', outDir,
    ];
    const first = runCli(args(out1));
    const second = runCli(args(out2));
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(first.stdout).toBe(second.stdout);
    expect(fs.readFileSync(path.join(out2, 'decision-input.json'), 'utf8'))
      .toBe(fs.readFileSync(path.join(out1, 'decision-input.json'), 'utf8'));
    expect(fs.readFileSync(path.join(out2, 'final-comparisons.json'), 'utf8'))
      .toBe(fs.readFileSync(path.join(out1, 'final-comparisons.json'), 'utf8'));
    const decision1 = readOutJson(out1, 'decision-input.json');
    const decision2 = readOutJson(out2, 'decision-input.json');
    expect(decision1.bindings).toEqual(decision2.bindings);
    expect(decision1.bindings.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('a full 14-group SC-13 run through judgments reaches IMPROVED end to end', () => {
    const dir = path.join(tempRoot, 'sc13');
    fs.mkdirSync(dir, { recursive: true });
    const assignments = [];
    const judgments = [];
    const map: Record<string, { A: string; B: string }> = {};
    const groups: Record<string, string> = {};
    for (let i = 1; i <= 14; i += 1) {
      const caseId = `case-${i}`;
      assignments.push({
        candidateConfigId: 'cfg-candidate', caseId, caseVersion: 'v1',
        opportunityId: 'opp-1', repetitionId: 'rep-1', referenceId: 'ref-1', scenarioId: 'SC1',
      });
      judgments.push(judgmentRecord(`j-${i}`, caseId, 'rep-1', i <= 12 ? 'A_BETTER' : 'B_BETTER'));
      Object.assign(map, candidateAtA(`j-${i}`));
      groups[caseId] = `sg-${i}`;
    }
    const plan = {
      schemaVersion: 'pd-lab-plan.v1',
      benchmarkId: 'bench-cli', benchmarkVersion: '1',
      comparisonDesign: 'CHANGE_VS_BASELINE',
      judgeProtocolRef: 'jp-test@1',
      judgeProtocol: { requiredJudgments: 1 },
      analysisPolicy: { alpha: 0.05 },
      owners: [{ ownerId: 'O1', weight: 1 }],
      scenarios: [{ scenarioId: 'SC1', ownerId: 'O1', weight: 1 }],
      assignments,
    };
    fs.writeFileSync(path.join(dir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(dir, 'judgments.json'), `${JSON.stringify(judgments, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(dir, 'blindmap.json'), `${JSON.stringify({ map }, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(dir, 'source-groups.json'), `${JSON.stringify({ groups, rationales: {} }, null, 2)}\n`, 'utf8');
    const outDir = path.join(dir, 'out');
    const result = runCli([
      '--plan', path.join(dir, 'plan.json'),
      '--judgments', path.join(dir, 'judgments.json'),
      '--blindmap', path.join(dir, 'blindmap.json'),
      '--source-groups', path.join(dir, 'source-groups.json'),
      '--out-dir', outDir,
    ]);
    expect(result.status).toBe(0);
    const decision = readOutJson(outDir, 'decision-input.json');
    expect(decision.status).toBe('ESTIMABLE');
    expect(decision.pointEstimate).toBeCloseTo(85.7143, 3);
    expect(decision.decision.outcome).toBe('IMPROVED');
    expect(decision.decision.threshold).toBe(12);
    expect(decision.decision.definiteWins).toBe(12);
    expect(decision.counts.planned).toBe(14);
    expect(result.stdout).toContain('status=ESTIMABLE');
  });

  it('usage errors exit 2 without writing outputs', () => {
    const inputDir = missingReviewDir('usage', candidateAtA('j-1'));
    const missingFlag = runCli([
      '--plan', path.join(inputDir, 'plan.json'),
      '--judgments', path.join(inputDir, 'judgments.json'),
      '--blindmap', path.join(inputDir, 'blindmap.json'),
      '--source-groups', path.join(inputDir, 'source-groups.json'),
    ]);
    expect(missingFlag.status).toBe(2);
    expect(missingFlag.stderr).toContain('--out-dir');

    const unknownFlag = runCli([
      '--plan', path.join(inputDir, 'plan.json'),
      '--judgments', path.join(inputDir, 'judgments.json'),
      '--blindmap', path.join(inputDir, 'blindmap.json'),
      '--source-groups', path.join(inputDir, 'source-groups.json'),
      '--out-dir', path.join(inputDir, 'out-x'),
      '--verbose',
    ]);
    expect(unknownFlag.status).toBe(2);

    const badFile = runCli([
      '--plan', path.join(inputDir, 'nonexistent-plan.json'),
      '--judgments', path.join(inputDir, 'judgments.json'),
      '--blindmap', path.join(inputDir, 'blindmap.json'),
      '--source-groups', path.join(inputDir, 'source-groups.json'),
      '--out-dir', path.join(inputDir, 'out-y'),
    ]);
    expect(badFile.status).toBe(2);
    expect(badFile.stderr).toContain('cannot read');
    expect(fs.existsSync(path.join(inputDir, 'out-y'))).toBe(false);
  });
});
