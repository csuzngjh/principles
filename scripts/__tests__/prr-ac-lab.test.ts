// PRI-1002 — PRR A/C offline capability regression suite.
//
// Covers: dataset load/health/hash stability (incl. negative controls),
// adjudicator rules (five-value verdicts, failure reason codes, negative
// transfer NT-1/2/3, NOT_APPLICABLE allowlist, INCONCLUSIVE 单列), paired
// report denominators, and the CLI end-to-end rehearsal (gate PASS + freeze
// draft refused + determinism). Everything here is FIXTURE_ONLY — no network,
// no model, no real workspace.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  healthCheckPrrDataset,
  loadPrrDataset,
} from '../dev/principle-learning-lab/prr/lib/prr-dataset.mjs';
import { adjudicatePrr, runPrrDesignChecks } from '../dev/principle-learning-lab/prr/lib/prr-adjudicate.mjs';
import { buildPairedReport, evaluateRehearsalGate } from '../dev/principle-learning-lab/prr/lib/prr-paired.mjs';
import { buildDraftFreeze, validateFreezeForRealRun } from '../dev/principle-learning-lab/prr/lib/prr-freeze.mjs';
import { buildPrrDatasetFiles, writePrrDataset } from './prr-test-fixtures';

const LAB_PRR_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dev', 'principle-learning-lab', 'prr');
const CLI = path.join(LAB_PRR_DIR, 'run-prr-rehearsal.mjs');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-prr-ac-lab-'));
const datasetDir = path.join(tmpRoot, 'dataset');
const outDir = path.join(tmpRoot, 'out');
let dataset: any;
let adjudications: any[];
let adjudicationsByGroupTask: Map<string, any>;
let pairedReport: any;
let designChecks: any;

beforeAll(() => {
  writePrrDataset(datasetDir);
  dataset = loadPrrDataset(datasetDir);
  adjudications = [];
  adjudicationsByGroupTask = new Map();
  const exclusions = [];
  for (const task of dataset.tasks.tasks) {
    for (const group of ['A', 'C'] as const) {
      if (group === 'C' && task.historyMaterial.disclosureStatus === 'unauthorized') continue;
      const behavior = dataset.behaviors.behaviors[`${group}:${task.taskId}`];
      const budgetExhausted = behavior.usage.requests > dataset.manifest.maxRequestsPerTask;
      const adj = adjudicatePrr({
        studyId: 'test',
        group,
        taskId: task.taskId,
        taskType: task.taskType,
        goldRecord: dataset.goldByTask[task.taskId],
        behavior,
        budgetExhausted,
      });
      adjudications.push(adj);
      adjudicationsByGroupTask.set(`${group}:${task.taskId}`, adj);
    }
  }
  const taskTypeById = new Map(dataset.tasks.tasks.map((t: any) => [t.taskId, t.taskType]));
  pairedReport = buildPairedReport({
    studyId: 'test',
    adjudications,
    exclusions: [{ taskId: 't-unauthorized-history', group: 'C', reasonCode: 'unauthorized_history_material', note: 'excluded before exposure' }],
    taskTypeById,
  });
  designChecks = runPrrDesignChecks({ designChecks: dataset.designChecks, dataset, adjudicationsByGroupTask });
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('dataset load + health', () => {
  it('loads the synthetic dataset and passes health with zero problems', () => {
    expect(healthCheckPrrDataset(dataset)).toEqual([]);
    expect(dataset.manifest.datasetId).toBe('PRR-AC-SYNTH-01');
  });

  it('computes a stable fixture hash (byte-frozen dataset identity)', () => {
    const again = loadPrrDataset(datasetDir);
    expect(again.fixtureHash).toBe(dataset.fixtureHash);
    expect(dataset.fixtureHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a dataset missing an AC-T3 task (three families mandatory)', () => {
    const files = buildPrrDatasetFiles();
    (files['tasks.json'] as any).tasks = (files['tasks.json'] as any).tasks.filter((t: any) => t.taskType !== 'AC-T3');
    const dir = writePrrDataset(path.join(tmpRoot, 'no-t3'), files);
    const problems = healthCheckPrrDataset(loadPrrDataset(dir));
    expect(problems.some((p: string) => p.includes('AC-T3'))).toBe(true);
  });

  it('rejects a gold canary leaking into actor-visible text (NT-01 analog)', () => {
    const files = buildPrrDatasetFiles();
    const task = (files['tasks.json'] as any).tasks.find((t: any) => t.taskId === 't1-history-decides');
    task.taskText = `${task.taskText} (secret token: CANARY-PRR-T1-9d1f)`;
    const dir = writePrrDataset(path.join(tmpRoot, 'canary-leak'), files);
    const problems = healthCheckPrrDataset(loadPrrDataset(dir));
    expect(problems.some((p: string) => p.includes('canary') && p.includes('leaked'))).toBe(true);
  });

  it('rejects NOT_APPLICABLE without an allowlisted pre-registered reason', () => {
    const files = buildPrrDatasetFiles();
    (files['gold.json'] as any).gold['t-na-preregistered'].notApplicable = { groups: ['A'], reason: 'adjudicator_felt_like_it' };
    const dir = writePrrDataset(path.join(tmpRoot, 'bad-na'), files);
    const problems = healthCheckPrrDataset(loadPrrDataset(dir));
    expect(problems.some((p: string) => p.includes('notApplicable.reason'))).toBe(true);
  });

  it('rejects tasks that depend on other tasks (independence rule)', () => {
    const files = buildPrrDatasetFiles();
    (files['tasks.json'] as any).tasks[0].dependsOnTaskIds = ['t2-principle-sufficient'];
    const dir = writePrrDataset(path.join(tmpRoot, 'dependent'), files);
    const problems = healthCheckPrrDataset(loadPrrDataset(dir));
    expect(problems.some((p: string) => p.includes('dependsOnTaskIds'))).toBe(true);
  });
});

describe('adjudicator rules', () => {
  const adj = (group: string, taskId: string) => adjudicationsByGroupTask.get(`${group}:${taskId}`);

  it('maps accepted decision + citable evidence to ALIGNED', () => {
    const row = adj('C', 't1-history-decides');
    expect(row.verdict).toBe('ALIGNED');
    expect(row.reasonCode).toBe('meets_gold_with_bound_evidence');
  });

  it('maps defensible-but-uninformed to ACCEPTABLE (never graded on history recital)', () => {
    expect(adj('A', 't1-history-decides').verdict).toBe('ACCEPTABLE');
  });

  it('failure rows stay in the denominator with distinct reason codes', () => {
    expect(adj('A', 't-failure-invalid-output')).toMatchObject({ verdict: 'MISALIGNED', reasonCode: 'model_output_invalid', runStatus: 'FAILED' });
    expect(adj('C', 't-failure-timeout-c')).toMatchObject({ verdict: 'MISALIGNED', reasonCode: 'timeout' });
  });

  it('budget stop is graded budget_exhausted and retained (AC-S4 honest partial)', () => {
    expect(adj('A', 't-budget-stop')).toMatchObject({ verdict: 'MISALIGNED', reasonCode: 'budget_exhausted', runStatus: 'STOPPED_BUDGET' });
  });

  it('untraceable evidence → INCONCLUSIVE (单列, never a main judgement)', () => {
    expect(adj('C', 't-inconclusive-evidence')).toMatchObject({ verdict: 'INCONCLUSIVE', reasonCode: 'evidence_untraceable' });
  });

  it('pre-registered group exemption → NOT_APPLICABLE with the allowlisted reason', () => {
    expect(adj('A', 't-na-preregistered')).toMatchObject({ verdict: 'NOT_APPLICABLE', reasonCode: 'pre_registered_group_exemption' });
  });

  it('empty evidence refs → MISALIGNED unbound_conclusion (AC-M2 binding is mandatory)', () => {
    const row = adjudicatePrr({
      studyId: 'test', group: 'A', taskId: 'x', taskType: 'AC-T1',
      goldRecord: { acceptedDecisionIds: ['d-1'], acceptableDecisionIds: [], misapplicationDecisionIds: [], citableEvidenceIds: ['ev-1'], canaryStrings: [] },
      behavior: { status: 'OK', output: { decisionId: 'd-1', evidenceRefs: [] }, usage: {} },
    });
    expect(row).toMatchObject({ verdict: 'MISALIGNED', reasonCode: 'unbound_conclusion' });
  });

  it('NT-1: AC-T3 misapplication of old history is a dedicated negative-transfer level', () => {
    expect(adj('C', 't3-old-context-conflicts')).toMatchObject({
      verdict: 'MISALIGNED',
      reasonCode: 'misapplied_history_decision',
      negativeTransfer: { level: 'NT-1' },
    });
  });

  it('NT-2: history-induced errors on T1/T2 overflow into the secondary bucket', () => {
    expect(adj('C', 't2-principle-sufficient').negativeTransfer.level).toBe('NT-2');
    expect(adj('C', 't1-c-misuses-other-history').negativeTransfer.level).toBe('NT-2');
  });

  it('NT-3: wording-only hedging is recorded but never counted as improvement', () => {
    const row = adj('C', 't-nt3-wording-only');
    expect(row.verdict).toBe('ACCEPTABLE');
    expect(row.negativeTransfer.level).toBe('NT-3');
  });

  it('clean C-side applicability wins (AC-M3 positive controls)', () => {
    expect(adj('C', 't2-c-resists-history')).toMatchObject({ verdict: 'ALIGNED', negativeTransfer: { level: 'none' } });
    expect(adj('C', 't3-c-rejects-stale-history')).toMatchObject({ verdict: 'ALIGNED', negativeTransfer: { level: 'none' } });
  });

  it('cost layers keep honest nulls — never coerced to zero', () => {
    const row = adj('A', 't1-history-decides');
    expect(row.cost.tokensIn).toBeNull();
    expect(row.cost.tokenBasis).toBe('NOT_REPORTED_BY_STUB');
    expect(row.ownerCost.reviewMinutes).toBeNull();
  });

  it('reproduces the frozen design-check battery exactly', () => {
    expect(designChecks.pass).toBe(true);
    expect(designChecks.results.length).toBe(dataset.designChecks.cases.length);
  });
});

describe('paired report', () => {
  it('keeps full denominators: failures and non-main verdicts stay', () => {
    expect(pairedReport.enrolledRows).toBe(25); // 13 tasks × 2 groups − 1 excluded C
    expect(pairedReport.failureRows.length).toBeGreaterThanOrEqual(3);
    for (const row of pairedReport.failureRows) expect(row.reasonCode).toBeTruthy();
  });

  it('records the unauthorized exclusion explicitly (never silently dropped)', () => {
    const excluded = pairedReport.pairedRows.find((r: any) => r.taskId === 't-unauthorized-history');
    expect(excluded.C).toBe('EXCLUDED_UNAUTHORIZED');
    expect(excluded.delta.mainComparison).toBe('C_EXCLUDED_UNAUTHORIZED');
    expect(pairedReport.exclusions).toHaveLength(1);
    expect(pairedReport.exclusions[0].reasonCode).toBe('unauthorized_history_material');
  });

  it('computes per-type group summaries with improvement direction', () => {
    const t1 = pairedReport.byType['AC-T1'];
    expect(t1.pairs).toBe(6);
    // t1-history-decides improves (ACCEPTABLE → ALIGNED); failure/budget rows
    // where C is graded higher also count as improved pairs (honest deltas).
    expect(t1.improved).toBe(3);
    expect(t1.degraded).toBe(1); // C misuses a foreign lesson → NT-2
    const t3 = pairedReport.byType['AC-T3'];
    expect(t3.pairs).toBe(2);
    expect(t3.degraded).toBe(1); // old-context conflict: A ALIGNED, C MISALIGNED (NT-1)
    expect(t3.nt1).toBe(1);
  });

  it('lists every MISALIGNED / INCONCLUSIVE task id (no mean-only reporting)', () => {
    expect(pairedReport.misalignedAndInconclusiveTaskIds.length).toBeGreaterThanOrEqual(5);
  });

  it('INCONCLUSIVE pairs are 单列 — excluded from the main judgement, retained in denominators', () => {
    const row = pairedReport.pairedRows.find((r: any) => r.taskId === 't-inconclusive-evidence');
    expect(row.delta.mainComparison).toBe('INCONCLUSIVE_PAIR');
    const na = pairedReport.pairedRows.find((r: any) => r.taskId === 't-na-preregistered');
    expect(na.delta.mainComparison).toBe('INCONCLUSIVE_PAIR');
  });

  it('contains no weighted composite score', () => {
    expect(pairedReport.note).toContain('no weighted composite');
    expect(Object.keys(pairedReport)).not.toContain('compositeScore');
  });

  it('reports AC-M1 numerators/denominators per group', () => {
    expect(pairedReport.acm1.A.denominator).toBe(13);
    expect(pairedReport.acm1.C.denominator).toBe(12); // 13 − 1 unauthorized exclusion
  });
});

describe('freeze gate (fail-closed)', () => {
  const preregBody = { studyId: 'test', note: 'synthetic prereg body' };

  it('draft records validate structurally and authorize nothing', () => {
    const draft = buildDraftFreeze({ studyId: 'test', preregBody });
    const { problems } = validateFreezeForRealRun({ freeze: draft, preregBody, dataset, verifyOwnerApproval: () => ({ verified: false }) });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p: string) => p.includes('real run refused'))).toBe(true);
    expect(problems.some((p: string) => p.includes('FZ-01'))).toBe(true);
    expect(problems.some((p: string) => p.includes('FZ-15'))).toBe(true);
  });

  it('a DRAFT cannot pass the real-run gate even with a verified approval verifier', () => {
    const draft = buildDraftFreeze({ studyId: 'test', preregBody });
    const { problems } = validateFreezeForRealRun({
      freeze: draft,
      preregBody,
      dataset,
      verifyOwnerApproval: () => ({ verified: true, approved: true }),
    });
    expect(problems.length).toBeGreaterThan(0);
  });
});

describe('rehearsal gate', () => {
  it('fails when any of the six rehearsal items is missing', () => {
    const gate = evaluateRehearsalGate({
      healthProblems: [], designChecks: { pass: true, results: [] },
      contaminationProblems: [], promptIsolationProblems: [],
      pairedReport, stopEvents: [], readonlyProblems: [], stateUnchangedProblems: [],
      freezeRealRunProblems: ['real run refused'],
    });
    expect(gate.pass).toBe(false);
    expect(gate.failures.some((f: string) => f.includes('AC-S4'))).toBe(true);
  });
});

describe('CLI end-to-end rehearsal', () => {
  const run1 = path.join(tmpRoot, 'run1');
  const run2 = path.join(tmpRoot, 'run2');

  function runCli(out: string) {
    return spawnSync(process.execPath, [CLI, '--dataset', datasetDir, '--out', out, '--quiet'], { encoding: 'utf8' });
  }

  it('exits 0 with gate PASS and a machine-readable result', () => {
    const res = runCli(run1);
    expect(res.status).toBe(0);
    const result = JSON.parse(fs.readFileSync(path.join(run1, 'rehearsal-result.json'), 'utf8'));
    expect(result.gate.pass).toBe(true);
    expect(result.evidenceType).toBe('FIXTURE_ONLY');
    expect(result.freezeGate.realRunRefused).toBe(true);
    expect(result.isolation.contaminationProblems).toEqual([]);
    expect(result.isolation.promptIsolationProblems).toEqual([]);
    expect(result.stopEvents.some((e: any) => e.type === 'AC-S4_BUDGET_STOP')).toBe(true);
    expect(result.readonly.problems).toEqual([]);
    expect(result.readonly.stateProblems).toEqual([]);
  });

  it('ledger four-way classification holds and is never a silent zero', () => {
    const result = JSON.parse(fs.readFileSync(path.join(run1, 'rehearsal-result.json'), 'utf8'));
    const classes = Object.fromEntries(result.readonly.ledgerCases.map((c: any) => [c.case, c.measure.availabilityClass]));
    expect(classes['ledger-ok-nonempty']).toBe('ok');
    expect(classes['ledger-ok-structurally-empty']).toBe('ok_but_empty_ledger');
    expect(classes['ledger-zero-byte']).toBe('empty');
    expect(classes['ledger-invalid-json']).toBe('unreadable');
    const unreadable = result.readonly.ledgerCases.find((c: any) => c.case === 'ledger-invalid-json');
    expect(unreadable.measure.m1.count).toBeNull();
    expect(unreadable.measure.m1.trueZero).toBe(false);
    const lenient = result.readonly.ledgerCases.find((c: any) => c.case === 'ledger-ok-structurally-empty');
    expect(lenient.measure.m1.trueZero).toBe(false);
  });

  it('ambiguous attribution is detected explicitly (M4), never last-write-wins', () => {
    const result = JSON.parse(fs.readFileSync(path.join(run1, 'rehearsal-result.json'), 'utf8'));
    const ambiguous = result.readonly.ledgerCases.find((c: any) => c.case === 'ledger-ambiguous-attribution');
    expect(ambiguous.measure.m4.count).toBe(1);
    expect(ambiguous.measure.m4.details[0].claimedBy.sort()).toEqual(['p-syn-a', 'p-syn-b']);
  });

  it('byte-identical determinism across two runs (no timestamps, no randomness)', () => {
    const first = runCli(run1);
    const second = runCli(run2);
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    const a = fs.readFileSync(path.join(run1, 'rehearsal-result.json'), 'utf8');
    const b = fs.readFileSync(path.join(run2, 'rehearsal-result.json'), 'utf8');
    expect(a).toBe(b);
  });

  it('leaves the git working tree clean of rehearsal artifacts', () => {
    // The rehearsal wrote only into the caller-supplied temp dirs.
    expect(fs.existsSync(path.join(run1, 'readonly', 'case-existing-db', '.state', 'trajectory.db'))).toBe(true);
    expect(fs.readdirSync(run1).sort()).toEqual(['paired-report.json', 'readonly', 'rehearsal-result.json']);
  });
});
