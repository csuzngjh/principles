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
  COVERAGE_DEFINITIONS,
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
  if (!parsed['--linkage'] || !parsed['--budget']) {
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
  const definitions = summary.definitions ?? COVERAGE_DEFINITIONS;
  const runsKnown = summary.units?.runs?.state !== 'unknown';
  const failed = runs.filter((run) => run.originalVerdict?.ok === false);
  const passed = runs.filter((run) => run.originalVerdict?.ok === true);
  const unknownVerdict = runs.filter((run) => run.originalVerdict?.ok !== true
    && run.originalVerdict?.ok !== false);
  const controlledConsumed = runs.filter((run) => run.controlledFacts?.admissionConsumed === 'confirmed');
  const targetReached = runs.filter((run) => run.controlledFacts?.targetBodyReachedEndpoint === 'confirmed');
  const strongLinked = runs.filter((run) => run.linkage?.experimentLevelStrongLink === true);
  const weakLinked = runs.filter((run) => run.linkage?.state === 'weak_candidate');
  const ambiguousLinked = runs.filter((run) => run.linkage?.state === 'ambiguous');
  const reevalPassed = runs.filter((run) => run.offlineReevaluation?.state === 'present'
    && run.offlineReevaluation.correctedGateOk === true);
  const controlExecuted = summary.units?.experimentAttempts?.controlArmsExecuted ?? 0;
  const ids = (list) => list.map((run) => run.runId).join('、');
  const idsOrUnknown = (list) => (list.length ? ids(list) : (runsKnown ? '无' : 'unknown（未提供运行记录）'));

  const conclusionParts = [];
  if (runs.length === 0) {
    conclusionParts.push('本次输入未提供运行记录；只能陈述调用、预算与来源哈希，不能得出实验或覆盖结论');
  } else {
    conclusionParts.push(`本次输入包含 ${runs.length} 条运行记录（${ids(runs)}）`);
    if (passed.length) conclusionParts.push(`原判定通过 ${passed.length} 条（${ids(passed)}）`);
    if (failed.length) conclusionParts.push(`原判定失败 ${failed.length} 条（${ids(failed)}）`);
    if (unknownVerdict.length) conclusionParts.push(`原判定未知 ${unknownVerdict.length} 条（${ids(unknownVerdict)}）`);
    if (controlledConsumed.length) {
      conclusionParts.push(`受控准入被消费 ${controlledConsumed.length} 条（${ids(controlledConsumed)}）`);
    }
    if (targetReached.length) {
      conclusionParts.push(`目标正文到达端点 ${targetReached.length} 条（${ids(targetReached)}）`);
    }
    if (failed.length && (controlledConsumed.length || targetReached.length)) {
      conclusionParts.push('原判定失败只表示该次实验门禁未通过，不表示受控接线事实不存在');
    }
    if (reevalPassed.length) {
      conclusionParts.push(`离线复核通过 ${reevalPassed.length} 条（${ids(reevalPassed)}），仅为派生结果，不改原判定，也不等于原实验成功`);
    }
    conclusionParts.push(controlExecuted === 0 ? '对照未执行' : `对照执行 ${controlExecuted} 条`);
    if (controlExecuted === 0) conclusionParts.push('因此收益、损害与因果改善不评价');
    conclusionParts.push('任何关联或离线通过都不能证明 request 级送达、timely、行为收益或总体覆盖率');
  }
  const conclusion = `${conclusionParts.join('；')}。`;

  const lines = [
    '# PRI-1115 AA 证据汇总 — Owner 简报',
    '',
    `生成时间：${summary.generatedAt ?? 'unknown'}　口径：${summary.conclusionScope ?? 'unknown'}`,
    '',
    '## 一句话结论',
    '',
    conclusion,
    '',
    '## 证据层级（互不替代）',
    '',
    '- 原始运行判定：run-record 的 positiveGate / controlGate，保留原值，不被事后复核改写。',
    '- 受控接线事实：同一 run-record 内的门禁检查；与原始判定分开陈述，原判定失败不等于这些事实不存在。',
    '- 端点观察：本地假端点的 userMessageSha256 与冻结输入比较；差异是限制，不单独决定 D。',
    '- 事后复核：offline-reevaluation，派生结果；不改原判定，也不等于原实验成功。',
    '- 独立观察：只有输入显式提供时才陈述；未提供保持 unknown。',
    '',
    '## 已观察事实',
    '',
  ];
  if (runs.length) {
    lines.push(
      `- 运行数：${runs.length}（${ids(runs)}）；运行证据状态：${summary.units?.runs?.state ?? 'unknown'}。`,
      `- 原判定：失败 ${failed.length} 条（${idsOrUnknown(failed)}）；通过 ${passed.length} 条（${idsOrUnknown(passed)}）；未知 ${unknownVerdict.length} 条。`,
      `- 受控接线整体证明：${summary.units?.experimentAttempts?.succeeded ?? 'unknown'} 条；对照执行 ${controlExecuted} 条。`,
      `- 受控准入被消费：${idsOrUnknown(controlledConsumed)}；目标正文到达端点：${idsOrUnknown(targetReached)}。`,
    );
  } else {
    lines.push(
      '- 运行数：0（未提供运行记录）；运行证据状态：unknown。',
      '- 原判定、受控接线与对照：unknown（未提供运行记录，不能写成确定的 0）。',
    );
  }
  lines.push(
    `- 调用数：${summary.units?.calls?.observed ?? 'unknown'}（linkage 窗口内，调用不等于决策机会）。`,
    `- 决策机会：${summary.units?.decisionOpportunities?.state ?? 'unknown'} — 没有任务机会普查，不能把调用或运行当分母`
    + `（未链接调用 ${cover.diagnostics?.unlinkedRecords ?? 'unknown'} 条）。`,
    `- 实验级强关联：${idsOrUnknown(strongLinked)}；弱候选（不作为实验级强关联）：${idsOrUnknown(weakLinked)}`
    + `${ambiguousLinked.length ? `；歧义候选 ${ids(ambiguousLinked)}` : ''}。`,
    '',
  );

  for (const run of runs) {
    const re = run.offlineReevaluation;
    const linkage = run.linkage ?? {};
    const delta = Number.isFinite(linkage.matchDeltaMs) ? `，deltaMs=${linkage.matchDeltaMs}` : '';
    const linkageText = linkage.state === 'matched_by_run'
      ? `strong（basis=${linkage.matchBasis}${delta}；实验级强关联=是；linkage 自身 association=${linkage.association}）`
      : linkage.state === 'weak_candidate'
        ? `弱候选（basis=${linkage.matchBasis}${delta}；实验级强关联=否；不升级为 matched_by_run；linkage 自身 association=${linkage.association}）`
        : linkage.state === 'ambiguous'
          ? `歧义（candidate=${(linkage.candidateHookInvocationIds ?? []).join('、') || 'unknown'}；未任取第一条；实验级强关联=否）`
          : linkage.state === 'contradictory_identity'
            ? `矛盾（${linkage.reason ?? 'identity_contradiction'}；实验级强关联=否）`
            : `未关联（${linkage.reason ?? 'no reliable identity'}；不补造身份）`;
    const wiringNote = run.originalVerdict?.ok === false
      && (run.controlledFacts?.admissionConsumed === 'confirmed'
        || run.controlledFacts?.targetBodyReachedEndpoint === 'confirmed')
      ? '；原判定失败不表示受控接线事实不存在' : '';
    lines.push(
      `### ${run.runId}`,
      '',
      `- 原始运行判定：${run.originalVerdict?.ok === true ? '通过' : run.originalVerdict?.ok === false ? '失败' : 'unknown'}`
      + `${run.originalVerdict?.failures?.length ? `（${run.originalVerdict.failures.map((failure) => failure.id).join('、')}）` : ''}`,
      `- 受控接线事实：admissionConsumed=${run.controlledFacts?.admissionConsumed}，`
      + `targetBody=${run.controlledFacts?.targetBodyReachedEndpoint}；整体受控接线门禁：`
      + `${run.controlledFacts?.controlledInstrumentationProven === true ? '已证明' : '未证明'}`
      + `（deliveryPath=${run.deliveryPath}）${wiringNote}`,
      `- 端点观察：用户正文摘要与冻结输入=${run.endpoint?.userMessageMatchesFrozenInput ?? 'unknown'}`
      + `（endpoint=${short(run.endpoint?.endpointUserMessageSha256)}，frozen=${short(run.endpoint?.frozenInputSha256)}）`,
      `- 事后复核：${re?.state === 'present' ? `存在（correctedGate=${re.correctedGateOk}，仅作派生结果，不改原判定）` : '缺失'}`
      + `${re?.knownDefectsFixedAfterTheRun?.length ? `；复核器修正了原判定中的 ${re.knownDefectsFixedAfterTheRun.length} 个门禁缺陷，不改变实验结论` : ''}`,
      `- 运行内关联：${linkageText}`,
      `- 本次运行成本：${run.cost?.state === 'recorded' ? JSON.stringify(run.cost.currentRun) : 'unknown'}`
      + `；证据 sha256=${short(run.evidenceSha256)}`,
      '',
    );
  }
  if (runs.length === 0) lines.push('本轮没有逐运行记录。', '');
  lines.push(
    '## 覆盖口径（T/V/O/D，SPEC v0.6 §6.1）',
    '',
    renderLayer(interpretation.T ?? {}, 'T（理论决策机会）'),
    renderLayer(interpretation.V ?? {}, 'V（事前可见的合格信号）'),
    renderLayer(interpretation.O ?? {}, 'O（PD 在行动前实际识别）'),
    renderLayer(interpretation.D ?? {}, 'D（独立确认目标正文进入实际请求且早于关键行动）'),
    `- 定义：T=${definitions.T}；V=${definitions.V}；O=${definitions.O}；D=${definitions.D}。`,
    '- 口径：V 不等于送达；O 不等于 Agent 遵循；缺证据保持 unknown，不用 strong_run、端点送达或离线通过替代。',
    `- D/T：${cover.ratios?.['D/T']?.status ?? 'unknown'}（value=${percent(cover.ratios?.['D/T']?.value)}）`,
    `- 链接子集 D/T：${interpretation.zeroDenominator?.linkedSubsetDOverT ?? 'unknown'}（链接子集无分母，不等于总体确定为零）`,
    `- 收益：${interpretation.benefit?.state ?? 'not_evaluated'}；损害：${interpretation.harm?.state ?? 'not_evaluated'}`,
    '- 已记录调用/运行不是覆盖率分母；离线复核通过（若存在）只作派生结果，不等于原实验成功。',
    '',
    '## 成本',
    '',
    budget.state === 'recorded'
      ? `- 累计账本：caps=${JSON.stringify(budget.caps ?? null)}，used=${JSON.stringify(budget.used ?? null)}，`
        + `remaining=${JSON.stringify(budget.remaining ?? null)}${budget.overBudget ? '，已超预算' : ''}。`
      : '- 累计账本：unknown（未提供或无效），不能写成 0。',
    '- 单次运行成本取 run-record.attempt.used；历史工具调用与历史 HTTP 不重复计入当前运行。',
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
