/**
 * PRI-1147 harness — dataset validation + acceptance gates (P1-2 / P2).
 *
 * Pure, importable functions so the CLI (compute-metrics.mjs) and the
 * regression tests (harness-regression.test.mjs) share ONE implementation.
 *
 * Acceptance semantics (P2): a full acceptance requires
 *   dataset_ok          — 45 rows, exact sample set, no dups, no execution
 *                         failures (execution_error / classifier_unavailable /
 *                         pending_unresolved), every row carries the run_id
 *   d6_ok               — d6-pending.summary.json present, ok:true, same run_id
 *   fault_injection_ok  — fault-injection.summary.json present, ok:true, same run_id
 *   openclaw_ok         — openclaw-host.summary.json present, ok:true, same run_id
 *   overall_ok          — all four above (missing phase results are NEVER a pass)
 * A partial dataset run (--samples) or missing phases can still be computed,
 * but the summary is marked partial and overall_ok stays false.
 */
import { SAMPLE_OUTCOMES, EXECUTION_FAILURE_OUTCOMES, STAGE2_DECIDED_OUTCOMES } from './outcomes.mjs';

/** Validate the codex-chain rows against the frozen dataset (P1-2). */
export function validateDatasetRows(rows, dataset) {
  const problems = [];
  const expectedIds = dataset.samples.map((s) => s.sample_id);
  const expectedSet = new Set(expectedIds);
  const rowIds = rows.map((r) => r.sample_id);
  const seen = new Set();
  const duplicated = new Set();
  for (const id of rowIds) {
    if (seen.has(id)) duplicated.add(id);
    seen.add(id);
  }
  if (rowIds.length !== expectedIds.length) {
    problems.push({ kind: 'row_count_mismatch', expected: expectedIds.length, actual: rowIds.length });
  }
  if (duplicated.size > 0) {
    problems.push({ kind: 'duplicate_sample_ids', sample_ids: [...duplicated] });
  }
  const missing = expectedIds.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    problems.push({ kind: 'missing_samples', sample_ids: missing });
  }
  const extra = rowIds.filter((id) => !expectedSet.has(id));
  if (extra.length > 0) {
    problems.push({ kind: 'extra_samples', sample_ids: extra });
  }
  // PRI-1150 review P2-B: a row's expected* facts must MATCH the frozen
  // dataset entry for its sample_id — a drifted row silently rewrites the
  // acceptance contract.
  const expectedMismatches = [];
  const byId = new Set(dataset.samples.map((s) => s.sample_id));
  for (const r of rows) {
    if (r.unparseable === true || !byId.has(r.sample_id)) continue;
    const expectedSample = dataset.samples.find((s) => s.sample_id === r.sample_id);
    const rowExpected = r.expected ?? {};
    for (const key of ['label', 'stage', 'final']) {
      if (expectedSample.expected && expectedSample.expected[key] !== undefined
        && rowExpected[key] !== undefined && rowExpected[key] !== expectedSample.expected[key]) {
        expectedMismatches.push({ sample_id: r.sample_id, field: key, dataset: expectedSample.expected[key], row: rowExpected[key] });
      }
    }
  }
  if (expectedMismatches.length > 0) {
    problems.push({ kind: 'expected_mismatch_with_frozen_dataset', mismatches: expectedMismatches });
  }
  const unparseable = rows.filter((r) => r.unparseable === true);
  if (unparseable.length > 0) {
    problems.push({ kind: 'unparseable_rows', count: unparseable.length });
  }
  const noRunId = rows.filter((r) => r.unparseable !== true && typeof r.run_id !== 'string');
  if (noRunId.length > 0) {
    problems.push({ kind: 'rows_without_run_id', sample_ids: noRunId.map((r) => r.sample_id ?? null) });
  }
  const executionFailures = rows
    .filter((r) => r.unparseable !== true && EXECUTION_FAILURE_OUTCOMES.includes(r.final_outcome))
    .map((r) => ({ sample_id: r.sample_id, outcome: r.final_outcome, reason: r.final_outcome_reason ?? null }));
  const missingOutcome = rows.filter((r) => r.unparseable !== true && !SAMPLE_OUTCOMES.includes(r.final_outcome));
  if (missingOutcome.length > 0) {
    problems.push({ kind: 'rows_without_valid_final_outcome', sample_ids: missingOutcome.map((r) => r.sample_id) });
  }
  return { problems, executionFailures, duplicatedIds: [...duplicated], missingIds: missing, extraIds: extra };
}

/**
 * Confusion matrix + metrics with the P1-1 adjudication rules:
 *   - provider/infra failures are never NONE: rows whose final_outcome is an
 *     execution failure are excluded from the matrix entirely and reported
 *     (they are neither TP/FP/TN/FN nor "valid NONE").
 *   - Stage-1 zero-hit expected-correction rows (final_outcome
 *     stage1_not_admitted with expected_stage stage1_no_hit_reject) are the
 *     frozen Stage-1 coverage FN bucket.
 *   - Stage-2 accuracy counts ONLY rows with a valid Stage-2 verdict, i.e.
 *     final_outcome ∈ {admitted, resolved_none} (STAGE2_DECIDED_OUTCOMES).
 *     abandoned_low_confidence / abandoned_llm_error / pending_unresolved are
 *     unresolved and excluded from BOTH numerator and denominator.
 */
export function computeDatasetMetrics(rows, dataset) {
  const matrixRows = rows.filter((r) => EXECUTION_FAILURE_OUTCOMES.includes(r.final_outcome) === false);
  let tp = 0, fp = 0, tn = 0, fnDetection = 0, fnCoverage = 0;
  const fpList = [];
  const fnList = [];
  for (const r of matrixRows) {
    const isCorrection = r.expected?.label === 'correction';
    const pain = r.pain_created === true;
    if (isCorrection && pain) tp += 1;
    else if (!isCorrection && pain) {
      fp += 1;
      fpList.push({ sample_id: r.sample_id, category: r.category, final_outcome: r.final_outcome, marker_decision: r.stage2_result?.marker_decision_post ?? r.stage1?.marker_decision_pre ?? null });
    } else if (isCorrection && !pain) {
      if (r.expected?.stage === 'stage1_no_hit_reject') {
        fnCoverage += 1;
        fnList.push({ sample_id: r.sample_id, category: r.category, kind: 'stage1_coverage', final_outcome: r.final_outcome });
      } else {
        fnDetection += 1;
        fnList.push({ sample_id: r.sample_id, category: r.category, kind: 'detection_or_gate', final_outcome: r.final_outcome, marker_decision: r.stage2_result?.marker_decision_post ?? null });
      }
    } else tn += 1;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recallInclCoverage = tp + fnDetection + fnCoverage > 0 ? tp / (tp + fnDetection + fnCoverage) : null;
  const recallDetectionOnly = tp + fnDetection > 0 ? tp / (tp + fnDetection) : null;
  const specificity = tn + fp > 0 ? tn / (tn + fp) : null;
  const accuracy = matrixRows.length > 0 ? (tp + tn) / matrixRows.length : null;

  // Stage-2 accuracy: only model-verified adjudications count.
  const stage2Rows = rows.filter((r) => r.pending_pre_stage2 === true);
  const stage2Decided = stage2Rows.filter((r) => STAGE2_DECIDED_OUTCOMES.includes(r.final_outcome));
  const stage2Correct = stage2Decided.filter((r) =>
    (r.expected?.final === 'admitted' && r.final_outcome === 'admitted')
    || (r.expected?.final === 'no_pain' && r.final_outcome === 'resolved_none'));
  const stage2Unresolved = stage2Rows.filter((r) => !STAGE2_DECIDED_OUTCOMES.includes(r.final_outcome));
  const stage2Accuracy = stage2Decided.length > 0 ? stage2Correct.length / stage2Decided.length : null;

  const llmCalls = rows.flatMap((r) => Array.isArray(r.llm_calls) ? r.llm_calls : []);
  const okCalls = llmCalls.filter((c) => c.status === 'ok');
  const latencies = okCalls.map((c) => c.latency_ms).sort((a, b) => a - b);
  const outcomeCounts = {};
  for (const r of rows) outcomeCounts[r.final_outcome] = (outcomeCounts[r.final_outcome] ?? 0) + 1;

  return {
    total_rows: rows.length,
    matrix_rows: matrixRows.length,
    excluded_execution_failures: rows.length - matrixRows.length,
    confusion_matrix: { tp, fp, tn, fn_detection: fnDetection, fn_stage1_coverage: fnCoverage },
    metrics: {
      precision: round4(precision),
      recall_incl_stage1_coverage: round4(recallInclCoverage),
      recall_detection_only: round4(recallDetectionOnly),
      specificity: round4(specificity),
      accuracy: round4(accuracy),
    },
    stage2: {
      reached_stage2: stage2Rows.length,
      decided: stage2Decided.length,
      correct: stage2Correct.length,
      unresolved_excluded_from_accuracy: stage2Unresolved.length,
      accuracy: round4(stage2Accuracy),
      unresolved_samples: stage2Unresolved.map((r) => ({ sample_id: r.sample_id, final_outcome: r.final_outcome })),
    },
    outcome_counts: outcomeCounts,
    llm_stats: {
      total_calls: llmCalls.length,
      ok_calls: okCalls.length,
      no_verdict_calls: llmCalls.filter((c) => c.status === 'no_verdict').length,
      threw_calls: llmCalls.filter((c) => c.status === 'threw').length,
      avg_latency_ms: okCalls.length === 0 ? null : Math.round(okCalls.reduce((s, c) => s + c.latency_ms, 0) / okCalls.length),
      p95_latency_ms: latencies.length === 0 ? null : latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))],
    },
    fp_list: fpList,
    fn_list: fnList,
  };
}

function round4(value) {
  return value === null ? null : Math.round(value * 10000) / 10000;
}

/**
 * P2 acceptance gates. Each phase summary must be present, ok:true, and carry
 * the SAME run_id as the dataset rows. `mode`:
 *   'full'    — all four gates required
 *   'partial' — missing phases are recorded but overall_ok stays false
 */
export function computeGates({ datasetMetrics, validation, d6Summary, faultSummary, openclawSummary, runId, mode }) {
  const datasetOk = validation.problems.length === 0 && validation.executionFailures.length === 0;
  const sameRun = (s) => s !== null && typeof s === 'object' && s.run_id === runId;
  const d6Ok = datasetOk && sameRun(d6Summary) && d6Summary.ok === true;
  const faultOk = datasetOk && sameRun(faultSummary) && faultSummary.ok === true;
  const openclawOk = datasetOk && sameRun(openclawSummary) && openclawSummary.ok === true;
  // A partial run (or a dataset with problems) is NEVER a full acceptance:
  // phase facts are still computed and recorded, but overall_ok stays false.
  const overallOk = mode === 'full' && datasetOk && d6Ok && faultOk && openclawOk;
  return {
    mode,
    run_id: runId,
    dataset_ok: datasetOk,
    d6_ok: d6Ok,
    fault_injection_ok: faultOk,
    openclaw_ok: openclawOk,
    overall_ok: overallOk,
    missing_phases: [
      ...(d6Summary === null ? ['d6_pending'] : []),
      ...(faultSummary === null ? ['fault_injection'] : []),
      ...(openclawSummary === null ? ['openclaw_host'] : []),
    ],
    run_id_mismatches: [
      ...(d6Summary !== null && !sameRun(d6Summary) ? ['d6_pending'] : []),
      ...(faultSummary !== null && !sameRun(faultSummary) ? ['fault_injection'] : []),
      ...(openclawSummary !== null && !sameRun(openclawSummary) ? ['openclaw_host'] : []),
    ],
    dataset_problems: validation.problems,
    execution_failures: validation.executionFailures,
  };
}

/**
 * Desensitized per-sample evidence rows (§6): identity + outcome + provider
 * facts only — no sample text, no logs, no credentials.
 */
export function buildEvidenceRows(rows) {
  return rows.map((r) => ({
    sample_id: r.sample_id,
    category: r.category,
    expected_label: r.expected?.label ?? null,
    expected_stage: r.expected?.stage ?? null,
    observed_stage1: {
      marker_decision: r.stage1?.marker_decision_pre ?? null,
      marker_reason: r.stage1?.marker_reason_pre ?? null,
      observation_persisted: r.stage1?.observation_persisted ?? null,
      pending_pre_stage2: r.pending_pre_stage2 ?? false,
    },
    observed_stage2: {
      marker_decision: r.stage2_result?.marker_decision_post ?? null,
      verdict: r.stage2_result?.verdict ?? null,
      confidence: r.stage2_result?.confidence ?? null,
      cycles: Array.isArray(r.stage2?.cycles) ? r.stage2.cycles.length : null,
    },
    final_outcome: r.final_outcome ?? null,
    final_outcome_reason: r.final_outcome_reason ?? null,
    pain_created: r.pain_created === true,
    provider_status: r.provider_status ?? null,
    latency_ms: r.latency_ms ?? null,
    attempts: r.stage2_result?.attempts ?? null,
    input_hash: r.input_hash ?? null,
    run_id: r.run_id ?? null,
  }));
}
