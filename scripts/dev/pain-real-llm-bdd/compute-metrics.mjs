/**
 * PRI-1147 — metrics + acceptance gates for ONE run_id (P1-2 / P2).
 *
 * Reads ONLY the run directory .tmp/pri-1147/runs/<run_id>/ (never a fixed
 * legacy path, never another run's data) and computes:
 *   dataset_ok / d6_ok / fault_injection_ok / openclaw_ok / overall_ok
 * A missing phase summary is NEVER a pass; a partial dataset run marks the
 * whole result partial. Also writes the desensitized per-sample evidence to
 * docs/reports/evidence/pri-1147-<run_id>/ (§6).
 *
 * Usage:
 *   node scripts/dev/pain-real-llm-bdd/compute-metrics.mjs --run-id run-...
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { validateDatasetRows, computeDatasetMetrics, computeGates, buildEvidenceRows, reconcileRowExpectedWithDataset } from './lib/metrics-core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const datasetPath = path.join(here, 'golden-dataset.json');
const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const runId = argValue('--run-id', null);
const resultsRoot = argValue('--results-root', null) ?? path.join('.tmp', 'pri-1147');
const evidenceRoot = argValue('--evidence-root', null) ?? path.join(repoRoot, 'docs', 'reports', 'evidence');
if (!runId) {
  const runsDir = path.join(resultsRoot, 'runs');
  const available = fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : [];
  console.error(JSON.stringify({
    ok: false,
    reason: 'run_id_required',
    available_run_ids: available,
    nextAction: 'pass --run-id <id> (metrics must never read another run\'s data)',
  }));
  process.exit(1);
}

const runDir = path.join(resultsRoot, 'runs', runId);
if (!fs.existsSync(runDir)) {
  console.error(JSON.stringify({ ok: false, reason: 'run_dir_missing', details: runDir, nextAction: 'run the four phases with the same --run-id first' }));
  process.exit(1);
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return null;
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try { rows.push(JSON.parse(trimmed)); } catch { rows.push({ unparseable: true, sample_id: null }); }
  }
  return rows;
}
function readJsonOptional(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { unreadable: true, ok: false }; }
}

const chainSummary = readJsonOptional(path.join(runDir, 'codex-chain.summary.json'));
const chain = readJsonl(path.join(runDir, 'codex-chain.jsonl'));
if (chain === null || chainSummary === null) {
  console.error(JSON.stringify({ ok: false, reason: 'codex_chain_results_missing', details: runDir, nextAction: 'run scripts/dev/pain-real-llm-bdd/run-codex-chain.mjs with this --run-id first' }));
  process.exit(1);
}

const d6Summary = readJsonOptional(path.join(runDir, 'd6-pending.summary.json'));
const faultSummary = readJsonOptional(path.join(runDir, 'fault-injection.summary.json'));
const openclawSummary = readJsonOptional(path.join(runDir, 'openclaw-host.summary.json'));

const isPartial = chainSummary.partial_run === true;
const validation = validateDatasetRows(chain, dataset);

const runMeta = readJsonOptional(path.join(runDir, 'run-meta.json'));
// PRI-1150 review fix 3: ONE final verdict that spans every exit — dataset
// SHA missing/invalid/mismatched, missing or foreign row run_ids, phase or
// metadata identity contradictions, and frozen expectation contradictions all
// produce a failed summary, a non-zero exit, and NO successful evidence export.
const frozenDatasetSha = crypto.createHash('sha256').update(fs.readFileSync(datasetPath, 'utf8')).digest('hex');
const declaredDatasetSha = runMeta?.dataset_sha256 ?? null;
const datasetShaMatches = declaredDatasetSha !== null && declaredDatasetSha === frozenDatasetSha;
const foreignRunIdRows = chain
  .filter((r) => typeof r.run_id === 'string' && r.run_id !== runId)
  .map((r) => r.sample_id);
const runIdMissingRows = chain
  .filter((r) => r.unparseable !== true && typeof r.run_id !== 'string')
  .map((r) => r.sample_id);
const metaIdentityOk = runMeta === null || runMeta.run_id === undefined || runMeta.run_id === runId;
const expectedContradictions = validation.problems.filter((p) =>
  p.kind === 'expected_field_rejected'
  || p.kind === 'expected_block_missing'
  || p.kind === 'expected_mismatch_with_frozen_dataset');
const integrityOk = datasetShaMatches
  && foreignRunIdRows.length === 0
  && runIdMissingRows.length === 0
  && metaIdentityOk
  && expectedContradictions.length === 0;

// Metrics classification and evidence must NOT trust unverified inline labels:
// reconcile every row's expected block to the authoritative frozen entry.
// (Verified rows keep identical values — clean input is a no-op.)
const reconciledRows = reconcileRowExpectedWithDataset(chain, dataset);
const datasetMetrics = computeDatasetMetrics(reconciledRows, dataset);
const mode = isPartial || validation.problems.length > 0 ? 'partial' : 'full';
const gates = computeGates({ datasetMetrics, validation, d6Summary, faultSummary, openclawSummary, runId, mode });
gates.partial_run = isPartial;

const integrity = {
  dataset_sha256_matches: datasetShaMatches,
  declared_dataset_sha256: declaredDatasetSha,
  frozen_dataset_sha256: frozenDatasetSha,
  foreign_run_id_rows: foreignRunIdRows,
  run_id_missing_rows: runIdMissingRows,
  meta_identity_ok: metaIdentityOk,
  expected_contradiction_count: expectedContradictions.length,
};
const finalOk = gates.overall_ok && integrityOk;
const metricsSummary = {
  ok: finalOk,
  experiment: 'PRI-1147 real-LLM BDD metrics + acceptance gates',
  generated_at: new Date().toISOString(),
  run_id: runId,
  mode,
  partial_run: isPartial,
  gates,
  integrity,
  run_meta: {
    git_commit_sha: runMeta?.git_commit_sha ?? null,
    dataset_sha256: declaredDatasetSha,
    frozen_dataset_sha256: frozenDatasetSha,
    provider: runMeta?.provider ?? chainSummary.provider ?? null,
    model: runMeta?.model ?? chainSummary.model ?? null,
    api_key_env: runMeta?.api_key_env ?? null,
  },
  dataset: datasetMetrics,
  phase_summaries: {
    d6_pending: d6Summary === null ? { present: false } : { present: true, ok: d6Summary.ok === true, totals: d6Summary.totals ?? null },
    fault_injection: faultSummary === null ? { present: false } : { present: true, ok: faultSummary.ok === true, totals: faultSummary.totals ?? null, honesty: faultSummary.honesty ?? null },
    openclaw_host: openclawSummary === null ? { present: false } : { present: true, ok: openclawSummary.ok === true, totals: openclawSummary.totals ?? null },
  },
  fp_list: datasetMetrics.fp_list,
  fn_list: datasetMetrics.fn_list,
};

fs.writeFileSync(path.join(runDir, 'metrics-summary.json'), JSON.stringify(metricsSummary, null, 2));

// §6 desensitized evidence (committed artifact): identity + outcome + provider
// facts only — no sample text, no logs, no credentials.
// PRI-1150 review fix 3: evidence publishes ONLY when the unified final
// verdict passes; failed runs keep their diagnostics in the run directory
// (explicitly marked rejected) and never publish into the evidence root.
const evidenceRows = buildEvidenceRows(reconciledRows);
if (!isPartial && finalOk) {
  const evidenceDir = path.join(evidenceRoot, `pri-1147-${runId}`);
  fs.mkdirSync(evidenceDir, { recursive: true });
  const perSamplePath = path.join(evidenceDir, 'per-sample.json');
  if (fs.existsSync(perSamplePath)) {
    console.error(JSON.stringify({
      ok: false,
      reason: 'evidence_already_exists',
      details: perSamplePath,
      nextAction: 'use a new --run-id; existing committed evidence is never overwritten',
    }));
    process.exit(1);
  }
  fs.writeFileSync(perSamplePath, JSON.stringify({
    run_id: runId,
    git_commit_sha: runMeta?.git_commit_sha ?? null,
    dataset_sha256: declaredDatasetSha,
    frozen_dataset_sha256: frozenDatasetSha,
    dataset_sha256_matches: datasetShaMatches,
    provider: runMeta?.provider ?? null,
    model: runMeta?.model ?? null,
    generated_at: new Date().toISOString(),
    desensitization_note: '仅含样本标识/期望/观测/结局/延迟/哈希；不含样本完整原文、日志或凭据。expected 字段以冻结数据集为权威源核对。样本文本以 input_hash 指纹引用，原文见冻结数据集 golden-dataset.json',
    samples: evidenceRows,
  }, null, 2));
  fs.writeFileSync(path.join(evidenceDir, 'metrics-summary.json'), JSON.stringify(metricsSummary, null, 2));
} else if (!finalOk) {
  // Failed run: keep diagnostics inside the run directory, explicitly marked
  // rejected — never mixed into the success evidence export.
  fs.writeFileSync(path.join(runDir, 'rejected-evidence.json'), JSON.stringify({
    rejected: true,
    reason: 'final verdict failed — this file is a diagnostic, NOT acceptance evidence',
    integrity,
    gates,
    dataset_problems: validation.problems,
  }, null, 2));
}

console.log(JSON.stringify({
  ok: finalOk,
  integrity_ok: integrityOk,
  integrity,
  run_id: runId,
  mode,
  gates: {
    dataset_ok: gates.dataset_ok,
    d6_ok: gates.d6_ok,
    fault_injection_ok: gates.fault_injection_ok,
    openclaw_ok: gates.openclaw_ok,
    overall_ok: gates.overall_ok,
  },
  dataset_problems: gates.dataset_problems,
  missing_phases: gates.missing_phases,
  run_id_mismatches: gates.run_id_mismatches,
  confusion: datasetMetrics.confusion_matrix,
  metrics: datasetMetrics.metrics,
  stage2: datasetMetrics.stage2,
  output: path.join(runDir, 'metrics-summary.json'),
}, null, 2));
process.exitCode = finalOk ? 0 : 1;
