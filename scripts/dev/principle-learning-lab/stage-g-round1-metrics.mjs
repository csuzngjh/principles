#!/usr/bin/env node
// Stage G round-1 mechanical metrics (pre-registered denominators, results-agnostic tooling).
// Reads the E-arm generation ledger + draft log and the B0/B1 enumerators; emits
// stage-g-preflight/round1-metrics.json + a markdown summary table.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enumerateCandidates, enumerateCandidatesB1 } from './lib/challenge-enumerator.mjs';
import { validateStageGCandidate, dedupeCandidates, coverageStats } from './lib/challenge-validator.mjs';
import { skeletonCanonicalHash } from './lib/challenge-skeleton.mjs';
import { canonicalJson } from './lib/challenge-freeze.mjs';

const labRoot = path.dirname(fileURLToPath(import.meta.url));
const studyDir = path.join(labRoot, 'challenge-studies', 'CEB-001');
const execDir = path.join(studyDir, 'stage-g-execution', 'round1');
const outDir = path.join(studyDir, 'stage-g-preflight');

const FROZEN_REFS = { mappingId: 'PMM-001-ASSERT-EVIDENCE-V1', mappingHash: '213090daecf0cbc9abfc51ca46641e4e3b835730ba9d9ec771118aaed9521290', templateId: 'T-CLAIM-EVIDENCE-BINDING-V1', templateVersion: '1.0.0' };

const b0 = enumerateCandidates(FROZEN_REFS);
const b1 = enumerateCandidatesB1({ ...FROZEN_REFS, verify: (a) => validateStageGCandidate({ candidate: a.candidate, frozenRefs: FROZEN_REFS }) });

function metricsFor(name, candidates, extra = {}) {
  const verdicts = candidates.map((c) => validateStageGCandidate({ candidate: c, frozenRefs: FROZEN_REFS }));
  const passed = verdicts.filter((v) => v.ok).length;
  const paramPoints = new Set(candidates.filter((_, i) => verdicts[i].ok).map((c) => `${c.caseDef.constraints.budgetUnits},${c.caseDef.constraints.deadlineUnits}`));
  const fullCombos = new Set(candidates.filter((_, i) => verdicts[i].ok).map((c) => `${c.draft.parameters.domain}|${c.draft.parameters.distractor}|${c.caseDef.constraints.budgetUnits}|${c.caseDef.constraints.deadlineUnits}|${(c.caseDef.facts || []).map((f) => f.stakes).join(',')}`));
  const substantive = new Set(candidates.filter((_, i) => verdicts[i].ok).map((c) => `${skeletonCanonicalHash(c.caseDef)}|${c.caseDef.constraints.budgetUnits},${c.caseDef.constraints.deadlineUnits}`));
  const dup = dedupeCandidates(candidates);
  const facets = new Set();
  candidates.forEach((_, i) => { if (verdicts[i].ok) for (const f of verdicts[i].mechanismFacets || []) facets.add(f); });
  return {
    arm: name,
    candidatesSubmitted: candidates.length,
    validatorPassRate: `${passed}/${candidates.length}`,
    budgetDeadlineGridCoverage: `${paramPoints.size}/110`,
    fullLegalComboCoverage: `${fullCombos.size}/31680`,
    substantiveDecisionDiversity: `${substantive.size}/3960`,
    structuralDuplicates: { exact: dup.exactDuplicatePairs.length, structural: dup.structuralDuplicatePairs.length, skeleton: dup.skeletonDuplicatePairs.length },
    mechanismFacetsCovered: [...facets].sort(),
    goldIndependenceViolations: verdicts.filter((v) => !v.ok && ['skeleton_mismatch', 'value_domain_violation', 'expression_leak', 'domain_proposal'].includes(v.goldIndependence && v.goldIndependence.tier)).length,
    ...extra,
  };
}

// E arm: adopted (eligible) candidates from the draft log + slot accounting from ledger
const ledgerLines = fs.readFileSync(path.join(execDir, 'generation-ledger.jsonl'), 'utf8').split('\n').filter((l) => l.trim());
const ledger = ledgerLines.map((l) => JSON.parse(l));
const drafts = fs.readFileSync(path.join(execDir, 'examiner-draft-log.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const events = fs.readFileSync(path.join(execDir, 'generation-events.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

const reserves = ledger.filter((e) => e.type === 'REQUEST_RESERVE');
const results = ledger.filter((e) => e.type === 'REQUEST_RESULT');
const refusals = ledger.filter((e) => e.type === 'REQUEST_REFUSED');
const adoptedDrafts = drafts.filter((d) => d.validation && d.validation.ok && d.validation.tier && d.validation.tier !== 'domain_proposal');
const adoptedCandidates = adoptedDrafts.map((d) => d.rawDraftEnvelope);

const slotBook = [];
adoptedDrafts.forEach((d, i) => slotBook.push({ slot: `SLOT-E-${String(i + 1).padStart(3, '0')}`, requestId: d.requestId, candidateId: d.candidateId, tier: d.validation.tier }));

const eMetrics = metricsFor('E', adoptedCandidates, {
  requestAccounting: {
    reserved: reserves.length,
    succeeded: results.filter((r) => r.result === 'SUCCEEDED').length,
    failedKnown: results.filter((r) => r.result === 'FAILED_KNOWN').length,
    resultUnknown: results.filter((r) => r.result === 'RESULT_UNKNOWN').length + ledger.filter((e) => e.type === 'REQUEST_AMBIGUOUS').length,
    refused: refusals.length,
    refusalReasons: refusals.map((r) => r.reason),
  },
  latencyAndTokens: {
    totalInputTokens: results.reduce((a, r) => a + ((r.usage && r.usage.inputTokens) || 0), 0),
    totalOutputTokens: results.reduce((a, r) => a + ((r.usage && r.usage.outputTokens) || 0), 0),
    totalNominalServerCost: results.reduce((a, r) => a + ((r.usage && r.usage.nominalServerCost) || 0), 0),
    modelBudgetCost: 0,
  },
  expressionFlags: adoptedDrafts.reduce((a, d) => a + ((d.validation.expressionFlags || []).length), 0),
  slots: slotBook,
});

const report = {
  schema: 'stage-g-round1-metrics.v1',
  generatedAt: new Date().toISOString(),
  denominators: { slotsPerArm: 36, paramGrid: 110, fullLegalCombos: 31680, substantiveSituations: 3960 },
  arms: [
    metricsFor('B0', b0, { role: 'historical reference' }),
    metricsFor('B1v2', b1, { role: 'primary comparator', strategy: 'b1-deterministic-strategy.v2', modelCost: 0 }),
    eMetrics,
  ],
  notes: 'expressionQualityBlindScore / humanRevisionMinutes / arbitration: PENDING (no blind reviewers assigned yet — honest placeholder per prereg).validatorPassRate for B0/B1 is structural 1.0 (ceiling metric).',
};
fs.writeFileSync(path.join(outDir, 'round1-metrics.json'), JSON.stringify(report, null, 2) + '\n');

const md = ['# Stage G Round-1 机械指标（预注册口径）', '', '| 臂 | 提交 | validator 通过 | 网格覆盖(/110) | 完整组合(/31680) | 实质多样性(/3960) | 结构重复(e/s/k) | Gold 违规 |', '|---|---|---|---|---|---|---|---|'];
for (const a of report.arms) {
  md.push(`| ${a.arm} | ${a.candidatesSubmitted} | ${a.validatorPassRate} | ${a.budgetDeadlineGridCoverage} | ${a.fullLegalComboCoverage} | ${a.substantiveDecisionDiversity} | ${a.structuralDuplicates.exact}/${a.structuralDuplicates.structural}/${a.structuralDuplicates.skeleton} | ${a.goldIndependenceViolations} |`);
}
md.push('', `- E 请求记账：reserved=${eMetrics.requestAccounting.reserved} succeeded=${eMetrics.requestAccounting.succeeded} failedKnown=${eMetrics.requestAccounting.failedKnown} resultUnknown=${eMetrics.requestAccounting.resultUnknown} refused=${eMetrics.requestAccounting.refused}`, `- E tokens：in=${eMetrics.latencyAndTokens.totalInputTokens} out=${eMetrics.latencyAndTokens.totalOutputTokens}；模型预算费=$0（免费层），名义服务器费累计=${eMetrics.latencyAndTokens.totalNominalServerCost}`, '- 盲评分/人工修订分钟：PENDING（盲评人员未指派，按预注册如实标记）');
fs.writeFileSync(path.join(outDir, 'round1-metrics.md'), md.join('\n') + '\n');
console.log(md.join('\n'));
