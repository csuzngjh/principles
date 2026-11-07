/**
 * PRI-1147 — 指标汇总：读取 Phase 2（codex-chain-full.jsonl）真实运行记录与
 * Phase 4/5、OpenClaw 子集的 summary，产出合并指标视图。
 *
 * 输入（均为相对 worktree 根，脚本以 cwd=worktree 根运行）：
 *   .tmp/pri-1147/results/codex-chain-full.jsonl      主数据集真实链运行（必需；
 *                                                     run-codex-chain.mjs --label full 产出）
 *   .tmp/pri-1147/results/d6-pending.summary.json     D6 pending 生命周期验收（可选）
 *   .tmp/pri-1147/results/fault-injection.summary.json 故障注入（可选，simulated_fault）
 *   .tmp/pri-1147/results/openclaw-host.summary.json  OpenClaw host 子集（可选）
 *
 * 输出：
 *   .tmp/pri-1147/results/metrics-summary.json（+ stdout 摘要）
 *
 * 指标语义（与 golden-dataset.json 冻结标签对齐）：
 *   - 混淆矩阵：expected_label(correction/none) × pain_created(true/false)；
 *     expected_label=correction 且无 pain 的 stage1_no_hit 样本按数据集冻结规则
 *     单列为 stage1_coverage（管线级 FN），不计入 Stage-1/2 判定错误。
 *   - stage-wise：按 expected_stage 分组的 pain 结果分布。
 *   - Stage-2 精度：进入 Stage-2（pending_pre_stage2）且终态样本中，
 *     终态与 expected_final 一致的比例（abandoned 属诚实降级，单列）。
 *   - pending 进入率、LLM 调用统计、FP/FN 清单、C4 冻结对抗样本分析。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const resultsDir = argValue('--results-dir', path.join('.tmp', 'pri-1147', 'results'));
const chainFile = path.join(resultsDir, 'codex-chain-full.jsonl');
const outFile = path.join(resultsDir, 'metrics-summary.json');

function readJsonl(file) {
  if (!fs.existsSync(file)) return null;
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try { rows.push(JSON.parse(trimmed)); } catch { rows.push({ unparseable: true }); }
  }
  return rows;
}

function readJsonOptional(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { unreadable: true }; }
}

function round2(value) {
  return value === null ? null : Math.round(value * 10000) / 10000;
}

const chain = readJsonl(chainFile);
if (chain === null) {
  console.error(JSON.stringify({
    ok: false,
    reason: 'codex-chain-full.jsonl missing',
    nextAction: 'node scripts/dev/pain-real-llm-bdd/run-codex-chain.mjs --label full --provider zai --model glm-5.3-flash --apiKeyEnv ZAI_API_KEY',
  }));
  process.exit(1);
}

// ─── 主数据集指标 ────────────────────────────────────────────────────────────

const valid = chain.filter((r) => r.expected && typeof r.pain_created === 'boolean');
const erroredRows = chain.filter((r) => r.error || typeof r.pain_created !== 'boolean');

// 1) 混淆矩阵（含 stage1_coverage 单列）
let tp = 0, fp = 0, tn = 0, fnDetection = 0, fnCoverage = 0;
const fpList = [];
const fnList = [];
for (const r of valid) {
  const isCorrection = r.expected.label === 'correction';
  const pain = r.pain_created === true;
  if (isCorrection && pain) tp += 1;
  else if (!isCorrection && pain) { fp += 1; fpList.push({ sample_id: r.sample_id, category: r.category, text: r.text, stage: r.expected.stage, marker_decision: r.stage2_result?.marker_decision_post ?? r.stage1?.marker_decision_pre ?? null }); }
  else if (isCorrection && !pain) {
    if (r.expected.stage === 'stage1_no_hit_reject') {
      fnCoverage += 1; // 冻结规则：Stage-1 关键词覆盖边界，诚实单列
      fnList.push({ sample_id: r.sample_id, category: r.category, text: r.text, kind: 'stage1_coverage', stage: r.expected.stage });
    } else {
      fnDetection += 1; // 进入了正确的 Stage，但判定/终态未产出 pain
      fnList.push({ sample_id: r.sample_id, category: r.category, text: r.text, kind: 'detection_or_gate', stage: r.expected.stage, marker_decision: r.stage2_result?.marker_decision_post ?? null, verdict: r.stage2_result?.verdict ?? null, confidence: r.stage2_result?.confidence ?? null });
    }
  } else tn += 1;
}
const precision = tp + fp > 0 ? tp / (tp + fp) : null;
const recall = tp + fnDetection + fnCoverage > 0 ? tp / (tp + fnDetection + fnCoverage) : null;
const specificity = tn + fp > 0 ? tn / (tn + fp) : null;
const accuracy = valid.length > 0 ? (tp + tn) / valid.length : null;

// 2) stage-wise 分布
const stageGroups = {};
for (const r of valid) {
  const stage = r.expected.stage;
  stageGroups[stage] = stageGroups[stage] ?? { total: 0, pain_created: 0, no_pain: 0, samples: [] };
  stageGroups[stage].total += 1;
  if (r.pain_created) stageGroups[stage].pain_created += 1;
  else stageGroups[stage].no_pain += 1;
  stageGroups[stage].samples.push({ sample_id: r.sample_id, expected_label: r.expected.label, pain_created: r.pain_created });
}

// 3) Stage-2 精度（进入 Stage-2 且有终态的样本）
const stage2Rows = valid.filter((r) => r.pending_pre_stage2 === true && r.stage2_result?.marker_decision_post);
const stage2Terminal = stage2Rows.filter((r) => ['admitted', 'resolved_none', 'abandoned'].includes(r.stage2_result.marker_decision_post));
const stage2Correct = stage2Terminal.filter((r) =>
  (r.expected.final === 'admitted' && r.stage2_result.marker_decision_post === 'admitted')
  || (r.expected.final === 'no_pain' && r.stage2_result.marker_decision_post === 'resolved_none'));
const stage2Abandoned = stage2Terminal.filter((r) => r.stage2_result.marker_decision_post === 'abandoned');
const stage2Accuracy = stage2Terminal.length > 0 ? stage2Correct.length / stage2Terminal.length : null;

// 4) pending 进入率
const pendingExpected = valid.filter((r) => r.expected.stage === 'stage2_via_pending');
const pendingEntered = pendingExpected.filter((r) => r.pending_pre_stage2 === true);
const pendingEntryRate = pendingExpected.length > 0 ? pendingEntered.length / pendingExpected.length : null;

// 5) LLM 调用统计
const llmCalls = chain.flatMap((r) => Array.isArray(r.llm_calls) ? r.llm_calls : []);
const okCalls = llmCalls.filter((c) => c.status === 'ok');
const latencies = okCalls.map((c) => c.latency_ms).sort((a, b) => a - b);
const verdictCounts = {};
for (const c of okCalls) {
  const key = c.verdict ? `${c.verdict.type}@${c.verdict.confidence >= 0.7 ? 'high' : 'low'}` : 'unknown';
  verdictCounts[key] = (verdictCounts[key] ?? 0) + 1;
}

// 6) C4 冻结对抗样本分析
const c4 = chain.find((r) => r.sample_id === 'C4');
const c4Analysis = c4 ? {
  sample_id: 'C4',
  expected: c4.expected,
  pain_created: c4.pain_created ?? null,
  marker_decision: c4.stage2_result?.marker_decision_post ?? c4.stage1?.marker_decision_pre ?? null,
  frozen_prediction: '预期管线判 STRONG 直达 → 产生 FP（P-1 守卫覆盖边界，冻结的对抗样本）',
  realized_as_frozen_prediction: c4.pain_created === true,
  owner_note: '若实测确为 FP，按数据集冻结规则记录为需 Owner 决策的发现，不在本工单擅自扩表',
} : null;

const datasetMetrics = {
  source_file: chainFile,
  run_meta: chain[0] ? { provider: chain[0].provider, model: chain[0].model, api_key_env: chain[0].api_key_env } : null,
  total_rows: chain.length,
  valid_rows: valid.length,
  errored_rows: erroredRows.map((r) => ({ sample_id: r.sample_id, error: r.error ?? 'pain_created_missing' })),
  confusion_matrix: {
    tp, fp, tn,
    fn_detection: fnDetection,
    fn_stage1_coverage: fnCoverage,
    note: 'fn_stage1_coverage = 冻结的 Stage-1 关键词覆盖边界（管线级 FN），单列不计入检测错误',
  },
  metrics: {
    precision: round2(precision),
    recall_incl_stage1_coverage: round2(recall),
    recall_detection_only: round2(tp + fnDetection > 0 ? tp / (tp + fnDetection) : null),
    specificity: round2(specificity),
    accuracy: round2(accuracy),
  },
  stage_wise: stageGroups,
  stage2: {
    reached_stage2: stage2Rows.length,
    terminal: stage2Terminal.length,
    correct: stage2Correct.length,
    abandoned_honest_degradation: stage2Abandoned.length,
    accuracy: round2(stage2Accuracy),
    abandoned_samples: stage2Abandoned.map((r) => ({ sample_id: r.sample_id, reason: r.stage2_result?.verdict_reason ?? null, attempts: r.stage2_result?.attempts ?? null })),
  },
  pending_entry: {
    expected_stage2_samples: pendingExpected.length,
    entered_pending: pendingEntered.length,
    entry_rate: round2(pendingEntryRate),
  },
  llm_stats: {
    total_calls: llmCalls.length,
    ok_calls: okCalls.length,
    no_verdict_calls: llmCalls.filter((c) => c.status === 'no_verdict').length,
    threw_calls: llmCalls.filter((c) => c.status === 'threw').length,
    avg_latency_ms: okCalls.length === 0 ? null : Math.round(okCalls.reduce((s, c) => s + c.latency_ms, 0) / okCalls.length),
    p95_latency_ms: latencies.length === 0 ? null : latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))],
    verdict_distribution: verdictCounts,
  },
  fp_list: fpList,
  fn_list: fnList,
  c4_frozen_adversarial: c4Analysis,
};

// ─── 合并 Phase 4/5 + OpenClaw 子集 ─────────────────────────────────────────

function summarizeSummary(name, data) {
  if (data === null) return { present: false };
  return {
    present: true,
    ok: data.ok === true,
    totals: data.totals ?? null,
    ...(name === 'openclaw' ? { llm_summary: data.llm_summary ?? null, rate_limit_check: data.rate_limit_check ?? null } : {}),
    ...(name === 'fault' ? { honesty: data.honesty ?? null } : {}),
  };
}

const combined = {
  ok: datasetMetrics.errored_rows.length === 0 && valid.length > 0,
  experiment: 'PRI-1147 real-LLM BDD combined metrics',
  generated_at: new Date().toISOString(),
  dataset: datasetMetrics,
  d6_pending: summarizeSummary('d6', readJsonOptional(path.join(resultsDir, 'd6-pending.summary.json'))),
  fault_injection: summarizeSummary('fault', readJsonOptional(path.join(resultsDir, 'fault-injection.summary.json'))),
  openclaw_host: summarizeSummary('openclaw', readJsonOptional(path.join(resultsDir, 'openclaw-host.summary.json'))),
};

fs.writeFileSync(outFile, JSON.stringify(combined, null, 2));
console.log(JSON.stringify({
  ok: combined.ok,
  confusion: { tp, fp, tn, fn_detection: fnDetection, fn_stage1_coverage: fnCoverage },
  metrics: datasetMetrics.metrics,
  stage2_accuracy: datasetMetrics.stage2.accuracy,
  pending_entry_rate: datasetMetrics.pending_entry.entry_rate,
  llm_stats: datasetMetrics.llm_stats,
  merged: { d6: combined.d6_pending.present, fault: combined.fault_injection.present, openclaw: combined.openclaw_host.present },
  output: outFile,
}, null, 2));
process.exit(combined.ok ? 0 : 1);
