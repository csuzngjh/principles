// PRI-1147 harness regression tests (§8 of the remediation directive).
//
// Offline (no network, no provider): the outcome taxonomy, dataset
// validation, acceptance gates, run isolation, and the real Stage-2 cycle
// driven by real production functions against real SQLite workspaces with
// controlled classifier stand-ins (provider-shape faithful: null verdicts,
// low-confidence verdicts — the same shapes the seam contract produces).
// "默认预算下 timeout 必须为正整数" is covered in
// packages/host-runtime/tests/signal-stage2-cycle.test.ts and live by the
// D-DEF1-postfix checks of run-fault-injection.mjs.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifySampleOutcome, SAMPLE_OUTCOMES, EXECUTION_FAILURE_OUTCOMES, STAGE2_DECIDED_OUTCOMES } from '../dev/pain-real-llm-bdd/lib/outcomes.mjs';
import { validateDatasetRows, computeDatasetMetrics, computeGates, buildEvidenceRows } from '../dev/pain-real-llm-bdd/lib/metrics-core.mjs';
import { acquireRunLock, assertFreshOutputs, generateRunId, openRunContext, recordPhase, PHASES } from '../dev/pain-real-llm-bdd/lib/run-context.mjs';
import * as lib from '../dev/pain-real-llm-bdd/lib/chain-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const datasetPath = path.join(here, '..', 'dev', 'pain-real-llm-bdd', 'golden-dataset.json');
const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));

function row(overrides = {}) {
  // PRI-1150 review fix 2: the frozen dataset is authoritative — derive the
  // expected block from the sample's own frozen entry (the real chain runner
  // copies it per sample), so fixture rows always carry truthful expectations.
  const sampleId = overrides.sample_id ?? 'A1';
  const frozenSample = dataset.samples.find((s) => s.sample_id === sampleId)
    ?? { expected_label: 'correction', expected_stage: 'stage2_via_pending', expected_final: 'admitted' };
  const finalOutcome = overrides.final_outcome ?? 'admitted';
  return {
    run_id: 'run-test',
    sample_id: sampleId,
    category: frozenSample.category ?? 'A',
    expected: { label: frozenSample.expected_label, stage: frozenSample.expected_stage, final: frozenSample.expected_final },
    pending_pre_stage2: frozenSample.expected_stage === 'stage2_via_pending',
    pain_created: finalOutcome === 'admitted',
    final_outcome: finalOutcome,
    final_outcome_reason: null,
    stage1: { marker_decision_pre: 'pending_llm_review', marker_reason_pre: null, observation_persisted: true },
    stage2_result: {
      marker_decision_post: finalOutcome,
      attempts: 1,
      confidence: 0.9,
      verdict: finalOutcome === 'resolved_none' ? 'none' : 'correction',
    },
    llm_calls: [{ latency_ms: 3000, status: 'ok', verdict: { type: 'correction', confidence: 0.9 } }],
    input_hash: 'deadbeef',
    provider_status: 'ok',
    latency_ms: 3000,
    attempts: 1,
    ...overrides,
  };
}

describe('outcome taxonomy (P1-1)', () => {
  it('maps terminal admission and a VALID model NONE', () => {
    expect(classifySampleOutcome({ hookFailed: false, observationPersisted: true, pendingExisted: true, classifierUnavailable: false, stage2Unfinished: false, markerDecision: 'admitted', markerReason: 'x' }).outcome).toBe('admitted');
    expect(classifySampleOutcome({ hookFailed: false, observationPersisted: true, pendingExisted: true, classifierUnavailable: false, stage2Unfinished: false, markerDecision: 'resolved_none', markerReason: 'x' }).outcome).toBe('resolved_none');
  });

  it('never turns provider/infra failures into NONE', () => {
    expect(classifySampleOutcome({ hookFailed: false, observationPersisted: true, pendingExisted: true, classifierUnavailable: false, stage2Unfinished: false, markerDecision: 'abandoned', markerReason: 'llm_error' }).outcome).toBe('abandoned_llm_error');
    expect(classifySampleOutcome({ hookFailed: false, observationPersisted: true, pendingExisted: true, classifierUnavailable: false, stage2Unfinished: false, markerDecision: 'abandoned', markerReason: 'low_confidence' }).outcome).toBe('abandoned_low_confidence');
    expect(classifySampleOutcome({ hookFailed: false, observationPersisted: true, pendingExisted: true, classifierUnavailable: true, stage2Unfinished: false, markerDecision: 'pending_llm_review', markerReason: null }).outcome).toBe('classifier_unavailable');
    expect(classifySampleOutcome({ hookFailed: false, observationPersisted: true, pendingExisted: true, classifierUnavailable: false, stage2Unfinished: true, markerDecision: 'pending_llm_review', markerReason: null }).outcome).toBe('pending_unresolved');
    expect(classifySampleOutcome({ hookFailed: true, observationPersisted: true, pendingExisted: false, classifierUnavailable: false, stage2Unfinished: false, markerDecision: null, markerReason: null }).outcome).toBe('execution_error');
    expect(classifySampleOutcome({ hookFailed: false, observationPersisted: false, pendingExisted: false, classifierUnavailable: false, stage2Unfinished: false, markerDecision: null, markerReason: null }).outcome).toBe('execution_error');
  });

  it('keeps Stage-1 non-admission as a real detection miss, not an infra failure', () => {
    const noHit = classifySampleOutcome({ hookFailed: false, observationPersisted: true, pendingExisted: false, classifierUnavailable: false, stage2Unfinished: false, markerDecision: null, markerReason: null });
    expect(noHit.outcome).toBe('stage1_not_admitted');
    const ingress = classifySampleOutcome({ hookFailed: false, observationPersisted: true, pendingExisted: false, classifierUnavailable: false, stage2Unfinished: false, markerDecision: 'abandoned', markerReason: 'unauthorized_source' });
    expect(ingress.outcome).toBe('stage1_not_admitted');
    expect(EXECUTION_FAILURE_OUTCOMES).not.toContain('stage1_not_admitted');
  });

  it('flags a post-pending abandon with an unknown reason as an anomaly', () => {
    const anomaly = classifySampleOutcome({ hookFailed: false, observationPersisted: true, pendingExisted: true, classifierUnavailable: false, stage2Unfinished: false, markerDecision: 'abandoned', markerReason: 'observation_only' });
    expect(anomaly.outcome).toBe('execution_error');
  });

  it('exposes the eight required outcomes', () => {
    expect(SAMPLE_OUTCOMES).toEqual(['admitted', 'resolved_none', 'stage1_not_admitted', 'abandoned_low_confidence', 'abandoned_llm_error', 'pending_unresolved', 'classifier_unavailable', 'execution_error']);
  });
});

describe('dataset metrics adjudication (P1-1/P2)', () => {
  const rows = [
    row({ sample_id: 'A1', final_outcome: 'admitted' }),
    row({ sample_id: 'A5', expected: { label: 'correction', stage: 'stage2_via_pending', final: 'admitted' }, final_outcome: 'abandoned_llm_error', pain_created: false }),
    row({ sample_id: 'B4', expected: { label: 'none', stage: 'stage2_via_pending', final: 'no_pain' }, pain_created: true, final_outcome: 'admitted' }),
    row({ sample_id: 'B5', expected: { label: 'none', stage: 'stage2_via_pending', final: 'no_pain' }, pain_created: false, final_outcome: 'resolved_none' }),
    row({ sample_id: 'A3', expected: { label: 'correction', stage: 'stage1_no_hit_reject', final: 'no_pain' }, pending_pre_stage2: false, pain_created: false, final_outcome: 'stage1_not_admitted' }),
    row({ sample_id: 'E2', expected: { label: 'correction', stage: 'stage1_no_hit_reject', final: 'no_pain' }, pending_pre_stage2: false, pain_created: false, final_outcome: 'stage1_not_admitted' }),
    row({ sample_id: 'E1', expected: { label: 'correction', stage: 'stage2_via_pending', final: 'admitted' }, final_outcome: 'execution_error', pain_created: false }),
  ];

  it('excludes execution failures from the matrix and reports them', () => {
    const m = computeDatasetMetrics(rows, dataset);
    expect(m.total_rows).toBe(7);
    // PRI-1150 review P1-A: abandoned_llm_error is an infrastructure failure
    // (bounded retries exhausted on LLM ERRORS) — excluded from the matrix
    // exactly like execution_error. The 45-sample real run had zero such rows,
    // so reported acceptance numbers are unaffected by this correction.
    expect(m.matrix_rows).toBe(5);
    expect(m.excluded_execution_failures).toBe(2);
    expect(m.confusion_matrix).toEqual({ tp: 1, fp: 1, tn: 1, fn_detection: 0, fn_stage1_coverage: 2 });
  });

  it('never counts llm_error as a Stage-2 NONE; accuracy uses decided rows only', () => {
    const m = computeDatasetMetrics(rows, dataset);
    // decided = A1 (correct) + B4 (expected no_pain but admitted → incorrect) + B5 (correct)
    expect(m.stage2.decided).toBe(3);
    expect(m.stage2.correct).toBe(2);
    expect(m.stage2.accuracy).toBeCloseTo(2 / 3, 4);
    // unresolved = A5 (abandoned_llm_error, infra) + E1 (execution_error)
    expect(m.stage2.unresolved_excluded_from_accuracy).toBe(2);
    const unresolvedIds = m.stage2.unresolved_samples.map((s) => s.sample_id);
    expect(unresolvedIds).toContain('A5');
    expect(unresolvedIds).toContain('E1');
    expect(STAGE2_DECIDED_OUTCOMES).not.toContain('abandoned_llm_error');
    expect(EXECUTION_FAILURE_OUTCOMES).toContain('abandoned_llm_error');
  });

  it('attributes Stage-1 coverage FN separately from detection FN', () => {
    const m = computeDatasetMetrics(rows, dataset);
    expect(m.confusion_matrix.fn_stage1_coverage).toBe(2);
    // A5 abandoned_llm_error is now excluded as infrastructure — detection FN
    // counts only genuine in-matrix misses.
    expect(m.confusion_matrix.fn_detection).toBe(0);
  });

  it('evidence rows are desensitized (no text/logs/credentials)', () => {
    const evidence = buildEvidenceRows(rows);
    expect(evidence).toHaveLength(rows.length);
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain('text');
    expect(evidence[0]).toHaveProperty('input_hash');
    expect(evidence[0]).toHaveProperty('final_outcome');
    expect(evidence[0]).toHaveProperty('provider_status');
  });
});

describe('dataset validation (P1-2)', () => {
  const allIds = () => dataset.samples.map((s) => row({ sample_id: s.sample_id }));

  it('accepts a complete 45-row dataset', () => {
    const v = validateDatasetRows(allIds(), dataset);
    expect(v.problems).toEqual([]);
    expect(v.executionFailures).toEqual([]);
    expect(v.missingIds).toEqual([]);
  });

  it('fails closed when a decided Stage-2 row is missing attempts, confidence, or verdict', () => {
    const rows = allIds();
    rows.find((r) => r.sample_id === 'A1').stage2_result = {
      marker_decision_post: 'admitted',
      attempts: null,
      confidence: null,
      verdict: null,
    };
    const validation = validateDatasetRows(rows, dataset);
    const problem = validation.problems.find((p) => p.kind === 'stage2_evidence_incomplete');
    expect(problem).toBeDefined();
    expect(problem.samples[0].sample_id).toBe('A1');
    expect(problem.samples[0].fields).toEqual(expect.arrayContaining([
        { field: 'attempts', problem: 'missing_or_invalid' },
        { field: 'confidence', problem: 'missing_or_invalid' },
        { field: 'verdict', problem: 'missing_or_invalid' },
    ]));
    const gates = computeGates({
      datasetMetrics: computeDatasetMetrics(rows, dataset),
      validation,
      d6Summary: { ok: true, run_id: 'run-test' },
      faultSummary: { ok: true, run_id: 'run-test' },
      openclawSummary: { ok: true, run_id: 'run-test' },
      runId: 'run-test',
      mode: 'full',
    });
    expect(gates.dataset_ok).toBe(false);
    expect(gates.overall_ok).toBe(false);
  });

  it('fails closed if a frozen Stage-2 sample bypasses pending admission', () => {
    const rows = allIds();
    rows.find((r) => r.sample_id === 'A1').pending_pre_stage2 = false;
    const validation = validateDatasetRows(rows, dataset);
    expect(validation.problems.some((p) => p.kind === 'stage2_evidence_incomplete'
      && p.samples.some((s) => s.sample_id === 'A1'
        && s.fields.some((f) => f.field === 'pending_pre_stage2' && f.problem === 'missing_or_false')))).toBe(true);
  });

  it('rejects a Stage-2 verdict that contradicts the persisted terminal decision', () => {
    const rows = allIds();
    rows.find((r) => r.sample_id === 'A1').stage2_result.verdict = 'none';
    const validation = validateDatasetRows(rows, dataset);
    expect(validation.problems.some((p) => p.kind === 'stage2_evidence_incomplete'
      && p.samples.some((s) => s.sample_id === 'A1'
        && s.fields.some((f) => f.problem === 'contradicts_terminal_decision')))).toBe(true);
  });

  it('PRI-1150 review fix 2: a row label contradicting the frozen dataset is rejected (A1 correction → none)', () => {
    const rows = allIds();
    rows[0].expected.label = 'none';
    const v = validateDatasetRows(rows, dataset);
    expect(v.problems.some((p) => p.kind === 'expected_field_rejected'
      && p.sample_id === 'A1'
      && p.fields.some((f) => f.field === 'label' && f.problem === 'contradicts_frozen'))).toBe(true);
  });

  it('PRI-1150 review fix 2: stage and final contradictions are detected separately', () => {
    const rows = allIds();
    rows[0].expected.stage = 'stage1_strong_direct';
    rows[1].expected.final = 'no_pain';
    const v = validateDatasetRows(rows, dataset);
    expect(v.problems.some((p) => p.kind === 'expected_field_rejected'
      && p.sample_id === 'A1'
      && p.fields.some((f) => f.field === 'stage' && f.problem === 'contradicts_frozen'))).toBe(true);
    expect(v.problems.some((p) => p.kind === 'expected_field_rejected'
      && p.sample_id === 'A2'
      && p.fields.some((f) => f.field === 'final' && f.problem === 'contradicts_frozen'))).toBe(true);
  });

  it('PRI-1150 review fix 2: an entirely missing expected block is rejected (not defaulted to none)', () => {
    const rows = allIds();
    delete rows[0].expected;
    const v = validateDatasetRows(rows, dataset);
    expect(v.problems.some((p) => p.kind === 'expected_block_missing' && p.sample_id === 'A1')).toBe(true);
    // And it must be a REJECTION, not a silent classification as no-hit.
    expect(v.problems.some((p) => p.kind === 'expected_block_missing')).toBe(true);
  });

  it('PRI-1150 review fix 2: a single missing expected field is rejected per field', () => {
    const rows = allIds();
    delete rows[0].expected.stage;
    const v = validateDatasetRows(rows, dataset);
    expect(v.problems.some((p) => p.kind === 'expected_field_rejected'
      && p.sample_id === 'A1'
      && p.fields.some((f) => f.field === 'stage' && f.problem === 'missing'))).toBe(true);
  });

  it('PRI-1150 review fix 2: an invalid expected value is rejected', () => {
    const rows = allIds();
    rows[0].expected.label = 'bogus_label';
    const v = validateDatasetRows(rows, dataset);
    expect(v.problems.some((p) => p.kind === 'expected_field_rejected'
      && p.sample_id === 'A1'
      && p.fields.some((f) => f.field === 'label' && f.problem === 'invalid'))).toBe(true);
  });

  it('detects duplicate sample_ids', () => {
    const rows = allIds();
    rows.push(row({ sample_id: 'A1' }));
    const v = validateDatasetRows(rows, dataset);
    expect(v.problems.some((p) => p.kind === 'duplicate_sample_ids' && p.sample_ids.includes('A1'))).toBe(true);
    expect(v.problems.some((p) => p.kind === 'row_count_mismatch')).toBe(true);
  });

  it('detects missing and extra samples', () => {
    const rows = allIds().filter((r) => r.sample_id !== 'B1');
    rows.push(row({ sample_id: 'ZZZ' }));
    const v = validateDatasetRows(rows, dataset);
    expect(v.missingIds).toEqual(['B1']);
    expect(v.extraIds).toEqual(['ZZZ']);
  });

  it('flags rows without run_id and invalid outcomes', () => {
    const rows = allIds();
    delete rows[0].run_id;
    rows[1].final_outcome = 'mystery_state';
    const v = validateDatasetRows(rows, dataset);
    expect(v.problems.some((p) => p.kind === 'rows_without_run_id')).toBe(true);
    expect(v.problems.some((p) => p.kind === 'rows_without_valid_final_outcome')).toBe(true);
  });

  it('identifies execution failures as distinct from semantic outcomes', () => {
    const rows = allIds();
    rows[0].final_outcome = 'classifier_unavailable';
    const v = validateDatasetRows(rows, dataset);
    expect(v.executionFailures).toEqual([{ sample_id: 'A1', outcome: 'classifier_unavailable', reason: null }]);
  });

  it('PRI-1150 review P1-A negative control: an ALL-abandoned_llm_error run fails dataset_ok and overall_ok (never PASS)', () => {
    // Owner-verified defect: 45 rows whose every LLM call threw in 1ms → every
    // row abandoned_llm_error. Before the fix, EXECUTION_FAILURE_OUTCOMES did
    // not include it → dataset_ok=true, overall_ok=true, specificity=1.0 —
    // the gate passed on a total infrastructure failure.
    const rows = allIds().map((r) => ({
      ...r,
      pain_created: false,
      pending_pre_stage2: true,
      final_outcome: 'abandoned_llm_error',
      final_outcome_reason: 'llm_error',
      stage1: { marker_decision_pre: 'pending_llm_review', marker_reason_pre: null, observation_persisted: true },
      stage2_result: { marker_decision_post: 'abandoned' },
      llm_calls: [{ latency_ms: 1, status: 'threw' }],
    }));
    const v = validateDatasetRows(rows, dataset);
    expect(v.executionFailures).toHaveLength(45);
    expect(v.executionFailures.every((f) => f.outcome === 'abandoned_llm_error')).toBe(true);
    const metrics = computeDatasetMetrics(rows, dataset);
    // No confusion matrix from pure infrastructure failure.
    expect(metrics.matrix_rows).toBe(0);
    expect(metrics.metrics.specificity).toBeNull();
    const g = computeGates({
      datasetMetrics: metrics,
      validation: v,
      d6Summary: { ok: true, run_id: 'run-test' },
      faultSummary: { ok: true, run_id: 'run-test' },
      openclawSummary: { ok: true, run_id: 'run-test' },
      runId: 'run-test',
      mode: 'full',
    });
    expect(g.dataset_ok).toBe(false);
    expect(g.overall_ok).toBe(false);
  });
});

describe('Stage-2 evidence extraction (P1-B)', () => {
  it('reconciles D6-minimized terminal facts with the final measured classifier verdict', () => {
    const facts = lib.readMarkerFacts({
      decision: 'resolved_none',
      reason: 'model returned none',
      attempts: 2,
      confidence: 0.82,
      settledAt: '2026-11-08T00:00:00.000Z',
    }, [
      { status: 'ok', verdict: { type: 'correction', confidence: 0.4, reason: 'first low-confidence result' } },
      { status: 'ok', verdict: { type: 'none', confidence: 0.82, reason: 'final model result' } },
    ]);
    expect(facts).toEqual({
      attempts: 2,
      confidence: 0.82,
      verdict: 'none',
      reason: 'model returned none',
    });
  });

  it('recovers classifier facts when admitted settlement replaces the review payload with pain data', () => {
    const facts = lib.readMarkerFacts({
      painType: 'user_correction',
      source: 'user_correction',
      reason: 'User correction detected: 不是这个',
      score: 70,
    }, [
      { status: 'no_verdict' },
      { status: 'ok', verdict: { type: 'correction', confidence: 0.9, reason: 'model detected a correction' } },
    ]);
    expect(facts).toEqual({
      attempts: 2,
      confidence: 0.9,
      verdict: 'correction',
      reason: 'model detected a correction',
    });
  });

  it('prefers durable pending review facts over the measured trace', () => {
    const facts = lib.readMarkerFacts({
      review: { attempts: 2, reviewResult: { verdict: 'none', confidence: 0.75, reason: 'durable review result' } },
    }, [
      { status: 'ok', verdict: { type: 'correction', confidence: 0.99, reason: 'later trace' } },
    ]);
    expect(facts).toEqual({
      attempts: 2,
      confidence: 0.75,
      verdict: 'none',
      reason: 'durable review result',
    });
  });

  it('does not invent a verdict when the classifier returned no verdict', () => {
    const facts = lib.readMarkerFacts(null, [{ status: 'no_verdict' }]);
    expect(facts).toEqual({ attempts: 1, confidence: null, verdict: null, reason: null });
  });

  it('publishes the complete Stage-2 facts in the desensitized evidence shape', () => {
    const evidence = buildEvidenceRows([row({
      stage2_result: {
        marker_decision_post: 'admitted',
        attempts: 2,
        verdict: 'correction',
        confidence: 0.91,
        verdict_reason: 'private classifier reason must not be exported',
      },
    })])[0];
    expect(evidence.observed_stage2).toMatchObject({
      marker_decision: 'admitted',
      attempts: 2,
      verdict: 'correction',
      confidence: 0.91,
    });
    expect(evidence.attempts).toBe(2);
    expect(JSON.stringify(evidence)).not.toContain('private classifier reason');
  });
});

describe('acceptance gates (P2)', () => {
  const base = () => ({ datasetMetrics: {}, validation: { problems: [], executionFailures: [] }, runId: 'run-test', mode: 'full' });

  it('requires all four phases with the same run_id for overall_ok', () => {
    const d6 = { ok: true, run_id: 'run-test' };
    const fault = { ok: true, run_id: 'run-test' };
    const oc = { ok: true, run_id: 'run-test' };
    expect(computeGates({ ...base(), d6Summary: d6, faultSummary: fault, openclawSummary: oc }).overall_ok).toBe(true);
  });

  it('a missing phase summary is NEVER a pass', () => {
    const d6 = { ok: true, run_id: 'run-test' };
    const fault = { ok: true, run_id: 'run-test' };
    const g = computeGates({ ...base(), d6Summary: d6, faultSummary: fault, openclawSummary: null });
    expect(g.openclaw_ok).toBe(false);
    expect(g.overall_ok).toBe(false);
    expect(g.missing_phases).toEqual(['openclaw_host']);
  });

  it('a run_id mismatch between phases fails the gate', () => {
    const g = computeGates({ ...base(), d6Summary: { ok: true, run_id: 'run-OTHER' }, faultSummary: { ok: true, run_id: 'run-test' }, openclawSummary: { ok: true, run_id: 'run-test' } });
    expect(g.d6_ok).toBe(false);
    expect(g.overall_ok).toBe(false);
    expect(g.run_id_mismatches).toEqual(['d6_pending']);
  });

  it('dataset problems fail dataset_ok and every phase gate', () => {
    const g = computeGates({ ...base(), validation: { problems: [{ kind: 'duplicate_sample_ids', sample_ids: ['A1'] }], executionFailures: [] }, d6Summary: { ok: true, run_id: 'run-test' }, faultSummary: { ok: true, run_id: 'run-test' }, openclawSummary: { ok: true, run_id: 'run-test' } });
    expect(g.dataset_ok).toBe(false);
    expect(g.d6_ok).toBe(false);
    expect(g.overall_ok).toBe(false);
  });

  it('a partial run keeps phase facts but overall_ok stays false', () => {
    const g = computeGates({ ...base(), mode: 'partial', d6Summary: { ok: true, run_id: 'run-test' }, faultSummary: { ok: true, run_id: 'run-test' }, openclawSummary: { ok: true, run_id: 'run-test' } });
    expect(g.mode).toBe('partial');
    expect(g.dataset_ok).toBe(true);
    expect(g.d6_ok).toBe(true);
    expect(g.overall_ok).toBe(false); // partial results are never a full PASS
  });
});

describe('run isolation (P1-2)', () => {
  it('refuses to write over existing outputs without --append', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pri1147-gate-test-'));
    try {
      const existing = path.join(tmp, 'results.jsonl');
      fs.writeFileSync(existing, '{"x":1}\n');
      expect(() => assertFreshOutputs({ runDir: tmp, outputs: [existing], appendAuthorized: false })).toThrow(/existing results/);
      expect(() => assertFreshOutputs({ runDir: tmp, outputs: [existing], appendAuthorized: true })).not.toThrow();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('run_id format is filesystem-safe and invalid ids are rejected', () => {
    expect(generateRunId()).toMatch(/^run-\d{8}T\d{6}Z-[0-9a-f]{4}$/);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pri1147-ctx-test-'));
    const repoRoot = path.resolve(here, '..', '..');
    try {
      expect(() => openRunContext({ runIdArg: '../escape', resultsRoot: tmp, repoRoot, datasetPath, phaseInfo: { provider: 'x', model: 'x', apiKeyEnv: 'X' } })).toThrow(/invalid run_id/);
      const ctx = openRunContext({ runIdArg: 'run-fixed', resultsRoot: tmp, repoRoot, datasetPath, phaseInfo: { provider: 'zai', model: 'glm-5.3-flash', apiKeyEnv: 'ZAI_API_KEY' } });
      expect(ctx.runDir).toBe(path.join(tmp, 'runs', 'run-fixed'));
      expect(ctx.meta.git_commit_sha).toMatch(/^[0-9a-f]{40}$/);
      expect(ctx.meta.dataset_sha256).toMatch(/^[0-9a-f]{64}$/);
      recordPhase(ctx.metaPath, ctx.meta, PHASES.d6Pending, { ok: true });
      const reread = JSON.parse(fs.readFileSync(ctx.metaPath, 'utf8'));
      expect(reread.phases.d6_pending.ok).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('one run_id has an exclusive lock across phases and releases it on completion', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pri1147-run-lock-test-'));
    const runDir = path.join(tmp, 'runs', 'run-lock');
    fs.mkdirSync(runDir, { recursive: true });
    let first;
    let second;
    try {
      first = acquireRunLock({ runDir, runId: 'run-lock', phase: PHASES.codexChain });
      const lockPath = path.join(runDir, '.active-run.lock');
      const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      expect(holder).toMatchObject({ run_id: 'run-lock', phase: PHASES.codexChain, pid: process.pid });
      expect(() => acquireRunLock({ runDir, runId: 'run-lock', phase: PHASES.metrics })).toThrow(/already active/);

      first.release();
      expect(fs.existsSync(lockPath)).toBe(false);

      second = acquireRunLock({ runDir, runId: 'run-lock', phase: PHASES.metrics });
      expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).phase).toBe(PHASES.metrics);
    } finally {
      first?.release();
      second?.release();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('real Stage-2 cycle outcomes through the harness taxonomy (offline)', () => {
  function bootstrap(text) {
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pri1147-cycle-test-'));
    const config = lib.buildWorkspaceConfig({ provider: 'zai', model: 'glm-5.3-flash', apiKeyEnv: 'ZAI_API_KEY', timeoutMs: 60000, maxTokens: 4096, reasoning: 'low' });
    const env = lib.bootstrapSampleEnv({ runRoot, sampleId: 'cycle-test', config, learnedKeywords: null });
    const ids = lib.sampleIds('T0', 1);
    return { env, ids, key: `codex|${env.rolloutIdentity}|${ids.turnId}|user`, text, runRoot };
  }

  async function admitPending(env, ids, text) {
    const payload = lib.buildUserPromptSubmitPayload({ workspaceDir: env.workspaceDir, transcriptPath: env.transcriptPath, sessionId: ids.sessionId, turnId: ids.turnId, text });
    await lib.driveHook({ payload, workspaceDir: env.workspaceDir, codexHome: env.codexHome });
  }

  it('five null-verdict cycles abandon with llm_error and the outcome is NOT resolved_none', async () => {
    const s = bootstrap('不是这个意思，我要的是另一种方案。');
    try {
      await admitPending(s.env, s.ids, s.text);
      const pre = lib.readAdmissionState(s.env.workspaceDir, s.key);
      expect(pre.marker?.decision).toBe('pending_llm_review');
      const classifierWrap = { fn: async () => null, calls: [] };
      await lib.runStage2UntilTerminal({ workspaceDir: s.env.workspaceDir, classifierWrap, maxCycles: 8 });
      const post = lib.readAdmissionState(s.env.workspaceDir, s.key);
      const observed = classifySampleOutcome({
        hookFailed: false,
        observationPersisted: pre.observation !== null,
        pendingExisted: true,
        classifierUnavailable: false,
        stage2Unfinished: post.marker?.decision === 'pending_llm_review',
        markerDecision: post.marker?.decision ?? null,
        markerReason: post.marker?.reason ?? null,
      });
      expect(observed.outcome).toBe('abandoned_llm_error');
      expect(post.marker?.decision).toBe('abandoned');
      expect(post.marker?.reason).toBe('llm_error');
      expect(post.pain).toBe(null);
    } finally {
      fs.rmSync(s.runRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('eight budget-released cycles leave the row pending → pending_unresolved (never NONE)', async () => {
    const s = bootstrap('不是这个意思，我要的是另一种方案。');
    try {
      await admitPending(s.env, s.ids, s.text);
      const { runStage2CorrectionCycle } = await import('@principles/host-runtime');
      // Designed time-control shape: aggregateBudgetMs=0 releases the claim
      // each cycle without consuming an attempt (host-runtime P2-2 contract),
      // so the row legitimately stays pending after the driver's cycle budget.
      for (let i = 0; i < 8; i += 1) {
        await runStage2CorrectionCycle({ workspaceDir: s.env.workspaceDir, classifier: async () => ({ is_feedback: true, type: 'correction', confidence: 0.5, reason: 'low' }), classifierState: 'used', aggregateBudgetMs: 0 });
      }
      const post = lib.readAdmissionState(s.env.workspaceDir, s.key);
      const observed = classifySampleOutcome({
        hookFailed: false,
        observationPersisted: true,
        pendingExisted: true,
        classifierUnavailable: false,
        stage2Unfinished: post.marker?.decision === 'pending_llm_review',
        markerDecision: post.marker?.decision ?? null,
        markerReason: post.marker?.reason ?? null,
      });
      expect(observed.outcome).toBe('pending_unresolved');
      expect(post.marker?.decision).toBe('pending_llm_review');
    } finally {
      fs.rmSync(s.runRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('five low-confidence verdict cycles abandon with low_confidence and stay out of Stage-2 accuracy', async () => {
    const s = bootstrap('不是这个意思，我要的是另一种方案。');
    try {
      await admitPending(s.env, s.ids, s.text);
      const classifierWrap = { fn: async () => ({ is_feedback: true, type: 'correction', confidence: 0.5, reason: 'low' }), calls: [] };
      await lib.runStage2UntilTerminal({ workspaceDir: s.env.workspaceDir, classifierWrap, maxCycles: 8 });
      const post = lib.readAdmissionState(s.env.workspaceDir, s.key);
      expect(post.marker?.decision).toBe('abandoned');
      expect(post.marker?.reason).toBe('low_confidence');
      const m = computeDatasetMetrics([row({
        sample_id: 'F5',
        expected: { label: 'correction', stage: 'stage2_via_pending', final: 'admitted' },
        final_outcome: 'abandoned_low_confidence',
        pain_created: false,
      })], dataset);
      expect(m.stage2.decided).toBe(0);
      expect(m.stage2.accuracy).toBe(null);
      expect(m.stage2.unresolved_excluded_from_accuracy).toBe(1);
    } finally {
      fs.rmSync(s.runRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
