// Report entry over recorded AA evidence. It reuses summarize-adaptive-coverage
// for the T/V/O/D math and only adds source adapters, provenance and an Owner
// brief. No host turn, model call, HTTP request or production write is made.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { summarizeAdaptiveStudy } from './summarize-adaptive-coverage.mjs';
import {
  adaptAaEvidence,
  attachCoverage,
  FIELD_MAPPING,
  SUMMARY_SCHEMA,
} from './lib/adaptive/adaptive-evidence-adapter.mjs';

const CLI_KEYS = new Set([
  '--linkage', '--budget', '--run-record', '--offline-reevaluation',
  '--plan', '--pollution-audit', '--output', '--brief',
]);
const MULTI_KEYS = new Set(['--linkage', '--run-record', '--offline-reevaluation', '--plan']);
const SINGLE_KEYS = new Set(['--budget', '--pollution-audit', '--output', '--brief']);

const text = (value) => typeof value === 'string' && value.trim().length > 0;

function readJson(file, role) {
  const bytes = fs.readFileSync(file);
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new TypeError(`${role}_not_json`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${role}_not_object`);
  }
  return {
    value,
    name: path.basename(file),
    hash: createHash('sha256').update(bytes).digest('hex'),
  };
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 2; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!CLI_KEYS.has(flag) || !text(value)) throw new TypeError('invalid_arguments');
    if (MULTI_KEYS.has(flag)) {
      (parsed[flag] ??= []).push(value);
      continue;
    }
    if (!SINGLE_KEYS.has(flag)) throw new TypeError('invalid_arguments');
    if (Object.hasOwn(parsed, flag)) throw new TypeError('duplicate_argument');
    parsed[flag] = value;
  }
  if (!parsed['--linkage'] || !parsed['--budget'] || !parsed['--run-record']) {
    throw new TypeError('required_arguments_missing');
  }
  return parsed;
}

function roleEntries(files, role) {
  return (files ?? []).map((file) => readJson(file, role));
}

function runEntries(files) {
  return roleEntries(files, 'run_record').map((entry) => {
    if (!text(entry.value.runId)) throw new TypeError('run_record_missing_run_id');
    return { ...entry, runId: entry.value.runId };
  });
}

function planEntries(files) {
  return roleEntries(files, 'run_plan').map((entry) => {
    if (!text(entry.value.runId)) throw new TypeError('run_plan_missing_run_id');
    return { ...entry, runId: entry.value.runId };
  });
}

function reevaluationEntries(files) {
  return roleEntries(files, 'offline_reevaluation').map((entry) => {
    if (!text(entry.value.sourceRun)) throw new TypeError('offline_reevaluation_missing_source_run');
    return { ...entry, sourceRun: entry.value.sourceRun };
  });
}

function short(hash) {
  return text(hash) ? hash.slice(0, 12) : 'unknown';
}

function percent(value) {
  return typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : 'unknown';
}

function renderLayer(layer, label) {
  const state = layer.state === 'confirmed' ? 'confirmed'
    : layer.state === 'lower_bound' ? 'lower_bound（下界）'
      : layer.state === 'not_applicable' ? 'not_applicable（分母为 0）'
        : layer.state === 'unknown' ? 'unknown（未知）' : layer.state;
  return `- ${label}: ${state}（confirmed=${layer.confirmed}，unknown=${layer.unknown}）`;
}

/** One-page Chinese Owner brief. No benefit, causal or overall-coverage claim. */
export function renderOwnerBrief(summary) {
  const runs = Array.isArray(summary.runs) ? summary.runs : [];
  const cover = summary.coverage ?? {};
  const interpretation = summary.coverageInterpretation ?? {};
  const budget = summary.budget ?? {};
  const failed = runs.filter((run) => run.originalVerdict?.ok === false).length;
  const controlledConsumed = runs.filter((run) => run.controlledFacts?.admissionConsumed === 'confirmed');
  const targetReached = runs.filter((run) => run.controlledFacts?.targetBodyReachedEndpoint === 'confirmed');
  const strongRun = runs.filter((run) => run.linkage?.association === 'strong_run');
  const lines = [
    '# PRI-1115 AA 证据汇总 — Owner 简报',
    '',
    `生成时间：${summary.generatedAt ?? 'unknown'}　口径：${summary.conclusionScope ?? 'unknown'}`,
    '',
    '## 一句话结论',
    '',
    '本次证据只能证明：受控准入在 1258 运行中被消费、目标正文到达本地假端点，且两次运行各存在一次 run 级只读行动关联'
    + '（1105 以时间邻近匹配，1258 以 host identity 匹配）。它不能证明 request 级送达、timely、行为收益、'
    + '因果改善或总体覆盖率。原运行判定仍为失败，对照未执行。',
    '',
    '## 已观察事实',
    '',
    `- 运行数：${summary.units?.runs?.observed ?? 'unknown'}；实验尝试：${summary.units?.experimentAttempts?.observed ?? 'unknown'}`
    + `；其中原判定失败 ${failed} 次，受控接线被证明 ${summary.units?.experimentAttempts?.succeeded ?? 'unknown'} 次。`,
    `- 调用数：${summary.units?.calls?.observed ?? 'unknown'}（linkage 窗口内，调用不等于决策机会）。`,
    `- 决策机会：${summary.units?.decisionOpportunities?.state ?? 'unknown'} — 没有任务机会普查，不能把调用或运行当分母`
    + `（未链接调用 ${cover.diagnostics?.unlinkedRecords ?? 'unknown'} 条）。`,
    `- 受控准入被消费：${controlledConsumed.map((run) => run.runId).join('、') || '无'}`
    + `；目标正文到达端点：${targetReached.map((run) => run.runId).join('、') || '无'}。`,
    `- 关联为 strong_run：${strongRun.map((run) => `${run.runId}（requestAssociation=${run.linkage?.requestAssociation ?? 'unknown'}，ordering=${run.linkage?.actionOrdering?.join('/') ?? 'unknown'}）`).join('；') || '无'}。`,
    '',
  ];
  for (const run of runs) {
    const re = run.offlineReevaluation;
    lines.push(
      `### ${run.runId}`,
      '',
      `- 原判定：${run.originalVerdict?.ok === true ? '通过' : run.originalVerdict?.ok === false ? '失败' : 'unknown'}`
      + `${run.originalVerdict?.failures?.length ? `（${run.originalVerdict.failures.map((failure) => failure.id).join('、')}）` : ''}`,
      `- 受控接线：${run.controlledFacts?.controlledInstrumentationProven === true ? '已证明' : '未证明'}`
      + `（deliveryPath=${run.deliveryPath}，admissionConsumed=${run.controlledFacts?.admissionConsumed}，`
      + `targetBody=${run.controlledFacts?.targetBodyReachedEndpoint}）`,
      `- 事后复核：${re?.state === 'present' ? `存在（correctedGate=${re.correctedGateOk}，仅作派生结果，不改原判定）` : '缺失'}`
      + `${re?.knownDefectsFixedAfterTheRun?.length ? `；复核器修正了原判定中的 ${re.knownDefectsFixedAfterTheRun.length} 个门禁缺陷，不改变实验结论` : ''}`,
      `- 端点用户正文摘要与冻结输入：${run.endpoint?.userMessageMatchesFrozenInput ?? 'unknown'}`
      + `（endpoint=${short(run.endpoint?.endpointUserMessageSha256)}，frozen=${short(run.endpoint?.frozenInputSha256)}）`,
      `- 本次运行成本：${run.cost?.state === 'recorded' ? JSON.stringify(run.cost.currentRun) : 'unknown'}`
      + `；证据 sha256=${short(run.evidenceSha256)}`,
      '',
    );
  }
  lines.push(
    '## 覆盖口径（T/V/O/D）',
    '',
    renderLayer(interpretation.T ?? {}, 'T（决策机会）'),
    renderLayer(interpretation.V ?? {}, 'V（原则可得）'),
    renderLayer(interpretation.O ?? {}, 'O（行动前被识别）'),
    renderLayer(interpretation.D ?? {}, 'D（request 级送达）'),
    `- D/T：${cover.ratios?.['D/T']?.status ?? 'unknown'}（value=${percent(cover.ratios?.['D/T']?.value)}）`,
    `- 链接子集 D/T：${interpretation.zeroDenominator?.linkedSubsetDOverT ?? 'unknown'}（链接子集无分母，不等于总体确定为零）`,
    `- 收益：${interpretation.benefit?.state ?? 'not_evaluated'}；损害：${interpretation.harm?.state ?? 'not_evaluated'}`,
    `- 已记录调用/运行不是覆盖率分母；离线 13/13 复核通过不等于原实验成功。`,
    '',
    '## 成本',
    '',
    `- 累计账本：caps=${JSON.stringify(budget.caps ?? null)}，used=${JSON.stringify(budget.used ?? null)}，`
    + `remaining=${JSON.stringify(budget.remaining ?? null)}${budget.overBudget ? '，已超预算' : ''}。`,
    `- 单次运行成本取 run-record.attempt.used；历史工具调用与历史 HTTP 不重复计入当前运行。`,
    '',
    '## 来源与哈希',
    '',
  );
  const provenance = summary.provenance ?? {};
  for (const entry of [...(provenance.linkage ?? []), ...(provenance.budget ?? []),
    ...(provenance.runs ?? []), ...(provenance.reevaluations ?? []),
    ...(provenance.plans ?? []), ...(provenance.pollutionAudits ?? [])]) {
    lines.push(`- ${entry.role}: ${entry.source} sha256=${short(entry.sha256)}${entry.runId ? ` run=${entry.runId}` : ''}`);
  }
  lines.push(
    '',
    '## 未知',
    '',
    ...(summary.unknowns ?? []).map((item) => `- ${item}`),
    '',
    '## 下一步决定（Owner）',
    '',
    ...(summary.nextDecisions ?? []).map((item, index) => `${index + 1}. ${item}`),
    '',
    '## 边界',
    '',
    '未新增模型调用、宿主回合、生产数据库写入、安装或发布；未修改冻结证据、历史判定或实验预算；'
    + '未删除生产记录；未把缺对照当成离线统计开发的阻塞。',
    '',
  );
  return lines.join('\n');
}

function main(argv) {
  try {
    const args = parseArgs(argv);
    const adapted = adaptAaEvidence({
      linkage: roleEntries(args['--linkage'], 'linkage'),
      budget: roleEntries([args['--budget']], 'budget'),
      runRecords: runEntries(args['--run-record']),
      reevaluations: reevaluationEntries(args['--offline-reevaluation']),
      plans: planEntries(args['--plan']),
      pollutionAudits: roleEntries(args['--pollution-audit'] ? [args['--pollution-audit']] : [], 'pollution_audit'),
      generatedAt: new Date().toISOString(),
    });
    const coverage = summarizeAdaptiveStudy(adapted.coverageInput, adapted.trust);
    const summary = attachCoverage(adapted, coverage);
    const result = { ok: true, fieldMapping: FIELD_MAPPING, ...summary };
    if (args['--output']) {
      fs.mkdirSync(path.dirname(path.resolve(args['--output'])), { recursive: true });
      fs.writeFileSync(args['--output'], `${JSON.stringify(result, null, 2)}\n`);
    }
    if (args['--brief']) {
      fs.mkdirSync(path.dirname(path.resolve(args['--brief'])), { recursive: true });
      fs.writeFileSync(args['--brief'], `${renderOwnerBrief(result)}\n`);
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      reason: error instanceof TypeError ? `coverage_evidence_invalid:${error.message}` : 'coverage_report_failed',
      nextAction: '核对 linkage / budget / run-record / offline-reevaluation 的 schemaVersion、runId 与证据哈希。',
    })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv);
}
