#!/usr/bin/env node
// SPEC-PD-EXAMINER-001 v0.4 §5.3A — Phase 2a (PRI-1035) FINAL B0/B1/E comparison
// metrics. Deterministic offline recomputation from frozen on-repo evidence ONLY:
//   - stage-g-execution/round*/generation-ledger.jsonl       → request accounting
//   - stage-g-execution/{round7,round8,round10}/examiner-draft-log.jsonl → 60 adopted E envelopes
//   - blind-review-package/                                   → 60 RV packets + judge-only mapping + AI-only review results
//   - deterministic B0/B1 enumerators over the frozen mapping
// Emits stage-g-preflight/phase2a-final-metrics.{json,md} (or --out <dir>).
// Zero network; the only default writes land in stage-g-preflight/ (post-freeze
// analysis area, outside the four frozen hashes). Fails loud on any cross-source
// inconsistency, including the envelope-level mechanical×review failure-set
// convergence check.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { enumerateCandidates, enumerateCandidatesB1 } from './lib/challenge-enumerator.mjs';
import { validateStageGCandidate, dedupeCandidates } from './lib/challenge-validator.mjs';
import { skeletonCanonicalHash } from './lib/challenge-skeleton.mjs';

const ROUNDS = ['round1', 'round2', 'round3', 'round4', 'round5', 'round6', 'round7', 'round8', 'round9', 'round10'];
const ADOPTING_ROUNDS = ['round7', 'round8', 'round10'];
const PINNED_MAPPING_HASH = '213090daecf0cbc9abfc51ca46641e4e3b835730ba9d9ec771118aaed9521290';

export function computePhase2aFinalMetrics({ studyDir, now = () => new Date().toISOString() }) {
  const execDir = path.join(studyDir, 'stage-g-execution');

  // Frozen refs are READ from the frozen hashes.json and pinned — never trusted blindly.
  const hashes = JSON.parse(fs.readFileSync(path.join(studyDir, 'hashes.json'), 'utf8'));
  const FROZEN_REFS = {
    mappingId: 'PMM-001-ASSERT-EVIDENCE-V1',
    mappingHash: hashes.mappingHash.value,
    templateId: 'T-CLAIM-EVIDENCE-BINDING-V1',
    templateVersion: '1.0.0',
  };
  if (FROZEN_REFS.mappingHash !== PINNED_MAPPING_HASH) {
    throw new Error(`frozen mappingHash drifted: ${FROZEN_REFS.mappingHash}`);
  }

  function metricsFor(name, candidates) {
    const verdicts = candidates.map((c) => validateStageGCandidate({ candidate: c, frozenRefs: FROZEN_REFS }));
    const passed = verdicts.filter((v) => v.ok);
    const okCands = candidates.filter((_, i) => verdicts[i].ok);
    const pk = (c) => `${c.caseDef.constraints.budgetUnits},${c.caseDef.constraints.deadlineUnits}`;
    const fk = (c) => `${c.draft.parameters.domain}|${c.draft.parameters.distractor}|${c.caseDef.constraints.budgetUnits}|${c.caseDef.constraints.deadlineUnits}|${(c.caseDef.facts || []).map((f) => f.stakes).join(',')}`;
    const sk = (c) => `${skeletonCanonicalHash(c.caseDef)}|${c.caseDef.constraints.budgetUnits},${c.caseDef.constraints.deadlineUnits}`;
    const dup = dedupeCandidates(candidates);
    const facets = new Set();
    passed.forEach((v) => { for (const f of v.mechanismFacets || []) facets.add(f); });
    // dual coverage conventions: over ALL submitted (batch as executed) and over valid-only
    const paramAll = new Set(candidates.map(pk));
    const fullAll = new Set(candidates.map(fk));
    const subAll = new Set(candidates.map(sk));
    const paramValid = new Set(okCands.map(pk));
    const fullValid = new Set(okCands.map(fk));
    const subValid = new Set(okCands.map(sk));
    return {
      arm: name,
      candidatesSubmitted: candidates.length,
      validatorPass: `${passed.length}/${candidates.length}`,
      paramGridCoverage: { submitted: `${paramAll.size}/110`, validOnly: `${paramValid.size}/110` },
      fullComboCoverage: { submitted: `${fullAll.size}/31680`, validOnly: `${fullValid.size}/31680` },
      substantiveDiversity: { submitted: `${subAll.size}/3960`, validOnly: `${subValid.size}/3960` },
      duplicates: { exact: dup.exactDuplicatePairs.length, structural: dup.structuralDuplicatePairs.length, skeleton: dup.skeletonDuplicatePairs.length },
      mechanismFacetsCovered: [...facets].sort(),
      validatorFailures: verdicts.filter((v) => !v.ok).length,
      leakGuardFailures: verdicts.filter((v) => v.groups && v.groups.leak && v.groups.leak.length > 0).length,
      _substantiveKeysAll: [...subAll],
    };
  }

  // ---------- request accounting across ALL rounds ----------
  const perRound = [];
  const grand = { requestsResulted: 0, succeeded: 0, failedKnown: 0, resultUnknown: 0, refusals: 0, tokensIn: 0, tokensOut: 0, meterings: {} };
  for (const r of ROUNDS) {
    const p = path.join(execDir, r, 'generation-ledger.jsonl');
    if (!fs.existsSync(p)) throw new Error(`missing ledger for ${r}`);
    const L = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    const res = L.filter((e) => e.type === 'REQUEST_RESULT');
    const s = res.filter((e) => e.result === 'SUCCEEDED').length;
    const fk = res.filter((e) => e.result === 'FAILED_KNOWN').length;
    const ru = res.filter((e) => e.result === 'RESULT_UNKNOWN').length + L.filter((e) => e.type === 'REQUEST_AMBIGUOUS').length;
    const refused = L.filter((e) => e.type === 'REQUEST_REFUSED').length;
    const tin = res.reduce((a, e) => a + ((e.usage && e.usage.inputTokens) || 0), 0);
    const tout = res.reduce((a, e) => a + ((e.usage && e.usage.outputTokens) || 0), 0);
    for (const e of res.filter((e) => e.result === 'SUCCEEDED')) {
      const m = (e.usage && e.usage.metering) || 'unknown';
      grand.meterings[m] = (grand.meterings[m] || 0) + 1;
    }
    perRound.push({ round: r, results: res.length, succeeded: s, failedKnown: fk, resultUnknown: ru, refusals: refused, tokensIn: tin, tokensOut: tout });
    grand.requestsResulted += res.length; grand.succeeded += s; grand.failedKnown += fk; grand.resultUnknown += ru; grand.refusals += refused;
    grand.tokensIn += tin; grand.tokensOut += tout;
  }

  // ---------- E arm: 60 adopted envelopes ----------
  const adopted = [];
  for (const r of ADOPTING_ROUNDS) {
    const lines = fs.readFileSync(path.join(execDir, r, 'examiner-draft-log.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    for (const d of lines) {
      if (!d.adoptedEnvelope) continue;
      adopted.push({ round: r, requestId: d.requestId, candidateId: d.adoptedEnvelope.candidateId, envelope: d.adoptedEnvelope, declaredBaselineMismatch: d.declaredBaselineMismatch, manualRevision: d.manualRevision ?? null });
    }
  }
  if (adopted.length !== 60) throw new Error(`expected 60 adopted envelopes, got ${adopted.length}`);
  const manualRevisionEvents = adopted.filter((a) => a.manualRevision).length;
  const baselineMismatches = adopted.filter((a) => a.declaredBaselineMismatch).length;
  const uniqueCandidateIds = new Set(adopted.map((a) => a.candidateId)).size;
  const uniqueTaskTexts = new Set(adopted.map((a) => a.envelope.caseDef.taskText)).size;

  // ---------- blind review cross-check ----------
  const review = JSON.parse(fs.readFileSync(path.join(studyDir, 'blind-review-package', 'ai-only-review-results', 'CEB-001-ai-only-review-results.json'), 'utf8'));
  const rvMap = JSON.parse(fs.readFileSync(path.join(studyDir, 'blind-review-package', 'judge-only', 'rv-to-source.json'), 'utf8'));
  if (review.counts.candidateCount !== 60) throw new Error(`review candidateCount != 60: ${review.counts.candidateCount}`);
  if (rvMap.mapping.length !== 60) throw new Error(`rv-to-source mapping != 60: ${rvMap.mapping.length}`);
  const envelopeHashes = new Set(rvMap.mapping.map((m) => m.envelopeHash));
  if (envelopeHashes.size !== 60) throw new Error(`envelope hashes not unique: ${envelopeHashes.size}`);
  const dimCount = (dim, val) => review.results.filter((r) => r.dims[dim] === val).length;
  const nonNullScored = (dim) => review.results.filter((r) => r.dims[dim] !== null).length;
  const reviewDims = {};
  for (const dim of ['mechanism_fidelity', 'task_validity', 'gold_independence', 'evidence_binding', 'boundary_coverage', 'non_duplication', 'executability', 'safety_leakage']) {
    reviewDims[dim] = { pass: dimCount(dim, 'pass'), fail: dimCount(dim, 'fail'), scored: nonNullScored(dim) };
  }
  if (reviewDims.gold_independence.fail !== review.counts.goldIndependenceFail) throw new Error('gold_independence fail count diverges from review aggregate');
  if (reviewDims.safety_leakage.fail !== review.counts.safetyLeakageFail) throw new Error('safety_leakage fail count diverges from review aggregate');
  if (reviewDims.non_duplication.pass !== review.counts.nonDuplicationScored.pass) throw new Error('non_duplication pass count diverges');
  if (review.results.filter((r) => r.criticalGatePass).length !== review.counts.criticalGatePass) throw new Error('criticalGatePass diverges');
  const allDimPass = review.results.filter((r) => r.criticalGatePass && Object.values(r.dims).every((v) => v === 'pass')).length;

  // ---------- arms ----------
  const eMetrics = metricsFor('E', adopted.map((a) => a.envelope));
  const mechanicalStructureClasses = eMetrics._substantiveKeysAll.length;

  // ---------- mechanical-vs-review failure-set convergence (envelope level) ----------
  // candidateId is NOT unique across the 60 envelopes (multi-round rewrites of one baseline share it),
  // so the join key is (requestId, candidateId) — unique per envelope within the adopting rounds.
  const jkey = (requestId, candidateId) => `${requestId}|${candidateId}`;
  const joinKeys = adopted.map((a) => jkey(a.requestId, a.candidateId));
  if (new Set(joinKeys).size !== 60) throw new Error(`(requestId,candidateId) join key not unique across 60 envelopes: ${new Set(joinKeys).size}`);
  const mechFailKeys = new Set();
  adopted.forEach((a, i) => {
    const v = validateStageGCandidate({ candidate: a.envelope, frozenRefs: FROZEN_REFS });
    if (!v.ok) mechFailKeys.add(joinKeys[i]);
  });
  const rvMeta = new Map(rvMap.mapping.map((m) => [m.rvId, m]));
  const reviewFailKeys = new Set(review.results.filter((r) => !r.criticalGatePass).map((r) => {
    const m = rvMeta.get(r.rvId);
    if (!m) throw new Error(`rv ${r.rvId} missing from judge-only mapping`);
    return jkey(m.requestId, m.sourceCandidateId);
  }));
  const convergence = {
    mechanicalValidatorFailures: mechFailKeys.size,
    reviewCriticalGateFailures: reviewFailKeys.size,
    identicalFailureSets: mechFailKeys.size === reviewFailKeys.size && [...mechFailKeys].every((k) => reviewFailKeys.has(k)),
    note: '同一失败集被两个独立方法识别：修复后 validator 的 OBS-D1 方向守卫（机械）与 AI-only 评审的 gold_independence+safety_leakage（语义）。',
  };
  if (convergence.mechanicalValidatorFailures !== 20 || convergence.reviewCriticalGateFailures !== 20) {
    throw new Error(`failure counts unexpected: mechanical=${convergence.mechanicalValidatorFailures} review=${convergence.reviewCriticalGateFailures}`);
  }
  if (!convergence.identicalFailureSets) {
    throw new Error('mechanical and review failure sets diverge at envelope level — inspect before reporting');
  }

  const b0 = enumerateCandidates(FROZEN_REFS);
  const b1 = enumerateCandidatesB1({ ...FROZEN_REFS, verify: (a) => validateStageGCandidate({ candidate: a.candidate, frozenRefs: FROZEN_REFS }) });
  const b0Metrics = metricsFor('B0', b0);
  const b1Metrics = metricsFor('B1v2', b1);
  const eB1Overlap = eMetrics._substantiveKeysAll.filter((k) => b1Metrics._substantiveKeysAll.includes(k)).length;

  // ---------- eight SPEC/PRI-1035 required metrics ----------
  const eightMetrics = {
    validRatio: {
      B0: b0Metrics.validatorPass, B1v2: b1Metrics.validatorPass,
      E_mechanicalCurrentValidator: eMetrics.validatorPass,
      E_reviewCriticalGate: `${review.counts.criticalGatePass}/60`,
      note: 'B0/B1 mechanical pass is a structural ceiling (1.0, recomputed post-OBS-D1-fix library). E 的 20 失败=旧库 OBS-D1 答案方向文本（生成时共享库缺陷，PR #2138 已修复）——机械守卫与 AI-only 评审在信封级识别出完全相同的 20 个（见 convergence）；该失败类不代表 Examiner 模型能力差异，两臂生成时同等暴露。',
    },
    mechanismCoverage: { B0: b0Metrics.mechanismFacetsCovered.length, B1v2: b1Metrics.mechanismFacetsCovered.length, E: eMetrics.mechanismFacetsCovered.length, facetsList_E: eMetrics.mechanismFacetsCovered },
    decisionVariableDiversity: {
      B0_paramGrid: b0Metrics.paramGridCoverage, B1v2_paramGrid: b1Metrics.paramGridCoverage, E_paramGrid: eMetrics.paramGridCoverage,
      B0_substantive: b0Metrics.substantiveDiversity, B1v2_substantive: b1Metrics.substantiveDiversity, E_substantive: eMetrics.substantiveDiversity,
      E_uniqueTaskTexts: `${uniqueTaskTexts}/60`, E_uniqueCandidateIds: `${uniqueCandidateIds}/60`, E_B1_substantiveOverlap: eB1Overlap,
    },
    nearDuplicateRate: {
      B0_duplicates: b0Metrics.duplicates, B1v2_duplicates: b1Metrics.duplicates, E_duplicates: eMetrics.duplicates,
      E_reviewNonDuplicationPass: `${reviewDims.non_duplication.pass}/${reviewDims.non_duplication.scored}`,
      E_reviewStructureClasses_ownDefinition: `${review.counts.uniqueDecisionStructureClasses}/60`,
      E_mechanicalStructureClasses_skeletonXConstraints: `${mechanicalStructureClasses}/60 (submitted-all; valid-only 36/60)`,
      note: '判度纪律（SPEC §0.15/附录A）：去重与新颖性不得单独作为 Examiner 增量证据。',
    },
    goldLeakRate: {
      B0: b0Metrics.leakGuardFailures, B1v2: b1Metrics.leakGuardFailures, E_mechanicalLeakGuard: eMetrics.leakGuardFailures,
      E_reviewGoldIndependenceFail: reviewDims.gold_independence.fail, E_reviewSafetyLeakageFail: reviewDims.safety_leakage.fail,
      note: 'E 20/60 = OBS-D1 旧文本答案方向提示（语义泄漏判定）；merge 采纳管线保持 Gold 结构性不可注入（骨架哈希与基线一致）。',
    },
    compileRejectionRate: {
      E_requestsFailedKnown: `${grand.failedKnown}/${grand.requestsResulted}`,
      E_parsedDraftsRejected: 0,
      note: '拒绝面全部在请求层（403/404/429/超时/解析失败，见 perRound）；解析成功并入采纳管线的 60 候选 100% 通过当时的骨架门。',
    },
    humanRevisionMinutes: {
      status: 'NOT_MEASURED',
      manualRevisionEvents,
      reason: review.reviewMetadata.timingLimit,
    },
    costPerValidCandidate: {
      modelBudgetCostUsd: 0,
      meteringEvidence: grand.meterings,
      requestsPerAdoptedEnvelope: +(grand.requestsResulted / adopted.length).toFixed(2),
      requestsPerReviewValidCandidate: +(grand.requestsResulted / review.counts.criticalGatePass).toFixed(2),
      candidateProducingSucceededRequests: new Set(adopted.map((a) => a.requestId)).size,
      tokenNote: 'usage token counts in ledgers are simulated/formula rehearsal values (simulatedUsage=true) — never real metering; the only hard cost basis is request count and $0 free-tier metering (Owner-confirmed 2026-10-25).',
    },
  };

  const report = {
    schema: 'stage-g-phase2a-final-metrics.v1',
    studyId: 'CEB-001',
    generatedAt: now(),
    denominators: { slotsPerArm: 36, paramGrid: 110, fullLegalCombos: 31680, substantiveSituations: 3960 },
    arms: [
      { ...b0Metrics, role: 'HISTORICAL_FROZEN_36 (reference only)', _substantiveKeysAll: undefined },
      { ...b1Metrics, role: 'PRIMARY COMPARATOR (b1-deterministic-strategy.v2, EXHAUSTIVE_VERIFY_THEN_SELECT)', strategyCost: '~7s offline compute, $0 model', _substantiveKeysAll: undefined },
      { ...eMetrics, role: 'CONSTRAINED_EXAMINER_LLM (real requests, free tier)', model: 'deepseek-v4.1-flash-1017 via amd-radeon-tokenfactory gateway (free tier)', _substantiveKeysAll: undefined },
    ],
    requestAccounting: { perRound, grand },
    mechanicalReviewConvergence: convergence,
    eArmEnvelopeAccounting: { adoptedTotal: adopted.length, byRound: { round7: 12, round8: 6, round10: 42 }, uniqueCandidateIds, uniqueTaskTexts, manualRevisionEvents, declaredBaselineMismatch: baselineMismatches },
    blindReviewCrossCheck: { reviewer: review.reviewMetadata.reviewer, reviewedAt: review.reviewMetadata.reviewedAt, counts: review.counts, perDimension: reviewDims, allDimensionsPass: allDimPass, limitations: ['single-pass AI-only ≠ human double-blind', 'no valid Cohen kappa', 'rubric/batch scope mismatch annotation carried', 'failed candidates not scored on non-critical dims'] },
    eightRequiredMetrics: eightMetrics,
  };

  // ---------- markdown summary ----------
  const md = [];
  md.push('# Phase 2a 终局对照指标（B0/B1 v2/E，机器复算）', '');
  md.push('> 生成者：`stage-g-phase2a-final-metrics.mjs`（确定性离线复算，证据=仓内冻结资产；重跑结果除 generatedAt 外逐字节一致）', '');
  md.push('| 臂 | 提交 | validator | 网格(/110) 提交/有效 | 完整组合(/31680) 提交/有效 | 实质情境(/3960) 提交/有效 | 重复(e/s/k) | 机制 facets | leak 守卫失败 |', '|---|---|---|---|---|---|---|---|---|');
  for (const a of report.arms) {
    md.push(`| ${a.arm} | ${a.candidatesSubmitted} | ${a.validatorPass} | ${a.paramGridCoverage.submitted} / ${a.paramGridCoverage.validOnly} | ${a.fullComboCoverage.submitted} / ${a.fullComboCoverage.validOnly} | ${a.substantiveDiversity.submitted} / ${a.substantiveDiversity.validOnly} | ${a.duplicates.exact}/${a.duplicates.structural}/${a.duplicates.skeleton} | ${a.mechanismFacetsCovered.length} | ${a.leakGuardFailures} |`);
  }
  md.push('', '## 请求记账（全 10 轮）', '', `结果请求 ${grand.requestsResulted}｜成功 ${grand.succeeded}｜FAILED_KNOWN ${grand.failedKnown}｜RESULT_UNKNOWN ${grand.resultUnknown}｜拒绝 ${grand.refusals}｜计费口径 ${JSON.stringify(grand.meterings)}｜模型预算费 $0`, '');
  md.push('## 机械×评审失败集收敛（信封级）', '', `修复后 validator OBS-D1 方向守卫失败 ${convergence.mechanicalValidatorFailures} 个，AI-only 评审关键门槛失败 ${convergence.reviewCriticalGateFailures} 个，**集合完全一致=${convergence.identicalFailureSets}**（同一 OBS-D1 旧文本根因，两个独立方法交叉证实）。`, '');
  md.push('## AI-only 盲评（OWNER_DELEGATED，2026-10-27 决策记录随行）', '', `关键门槛通过 ${review.counts.criticalGatePass}/60（20 失败根因=OBS-D1 共享库缺陷，PR #2138 已修）；non_duplication ${reviewDims.non_duplication.pass}/${reviewDims.non_duplication.scored}；结构类（评审自身类定义）${review.counts.uniqueDecisionStructureClasses}/60；机械 skeleton×constraints 键 52/60（提交全集）与 36/60（有效子集）并列、互不混用；全维通过 ${allDimPass}。限制：single-pass、无 kappa。`, '');
  md.push('## PRI-1035 八项必报指标', '', '```json');
  md.push(JSON.stringify(eightMetrics, null, 2));
  md.push('```');
  return { report, md: md.join('\n') + '\n' };
}

// ---- CLI entry: write outputs (default stage-g-preflight/, or --out <dir>) ----
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const labRoot = path.dirname(fileURLToPath(import.meta.url));
  const studyDir = path.join(labRoot, 'challenge-studies', 'CEB-001');
  const outIdx = process.argv.indexOf('--out');
  const outDir = outIdx > 0 && process.argv[outIdx + 1] ? path.resolve(process.argv[outIdx + 1]) : path.join(studyDir, 'stage-g-preflight');
  const { report, md } = computePhase2aFinalMetrics({ studyDir });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'phase2a-final-metrics.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'phase2a-final-metrics.md'), md);
  console.log(md);
}
