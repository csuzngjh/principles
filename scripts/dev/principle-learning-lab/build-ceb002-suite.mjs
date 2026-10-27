#!/usr/bin/env node
// SPEC-PD-EXAMINER-001 — CEB-002 suite builder (DRAFT, not frozen).
//
// Builds the CEB-002 study from the FROZEN B1 enumeration baseline pool
// (challenge-enumerator — 36 (family, domain, distractor) combinations).
// Every CEB-002 case takes one baseline caseDef as its immutable-skeleton
// base and varies ONLY the legal parameter axes (budget slack, deadline,
// taskText, caseId) — so every case passes the full Stage-G validator.
//
// SAFETY ARCHITECTURE (2026-10-27 final safety round):
//   - The build logic is wrapped in `main()` and ONLY executes when this
//     file is invoked directly via CLI (`node build-ceb002-suite.mjs`).
//     Importing this module as a library has ZERO side effects — no
//     enumeration, no file deletion, no directory creation, no ledger
//     truncation.
//   - `--output-dir` resolution is in lib/ceb002-cli.mjs (pure function),
//     fail-closed: illegal forms throw BEFORE any file write.
//   - Default output: the real CEB-002 study directory (normal build).
//
// Output is DRAFT ONLY. CEB-001 is never written. Zero network.
//
// The preregistration contract below is the AUTHORITATIVE machine-readable
// statement of the CEB-002 analysis plan — it lives INSIDE this builder so
// rebuilding always reproduces the exact same contract.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { enumerateCandidatesB1 } from './lib/challenge-enumerator.mjs';
import { validateStageGCandidate } from './lib/challenge-validator.mjs';
import { buildStudyArms } from './lib/challenge-arms.mjs';
import { sha256 } from './lib/challenge-freeze.mjs';
import { resolveOutputDir } from './lib/ceb002-cli.mjs';

// re-export the pure resolver for consumers that import this module
export { resolveOutputDir };

const labRoot = path.dirname(fileURLToPath(import.meta.url));

const PLAN = [
  { tier: 'L1', combo: ['FAILURE_VARIANT', 'nested-git', 'none'], slack: 4, deadline: 12 },
  { tier: 'L1', combo: ['CROSS_CONTEXT_TRANSFER', 'doc-vs-repo', 'none'], slack: 4, deadline: 12 },
  { tier: 'L1', combo: ['TRADEOFF_CONFLICT', 'budget-triage', 'none'], slack: 4, deadline: 12 },
  { tier: 'L2', combo: ['FAILURE_VARIANT', 'nested-git', 'docs'], slack: 1, deadline: 8 },
  { tier: 'L2', combo: ['CROSS_CONTEXT_TRANSFER', 'doc-vs-repo', 'docs'], slack: 1, deadline: 8 },
  { tier: 'L2', combo: ['TRADEOFF_CONFLICT', 'budget-triage', 'docs'], slack: 1, deadline: 8 },
  { tier: 'L2', combo: ['FAILURE_VARIANT', 'config-drift', 'docs'], slack: 1, deadline: 8 },
  { tier: 'L3', combo: ['TRADEOFF_CONFLICT', 'budget-triage', 'stale'], slack: 0, deadline: 4 },
  { tier: 'L3', combo: ['TRADEOFF_CONFLICT', 'budget-triage', 'docs'], slack: 0, deadline: 4 },
  { tier: 'L3', combo: ['TRADEOFF_CONFLICT', 'deadline-window', 'stale'], slack: 0, deadline: 6 },
  { tier: 'L3', combo: ['TRADEOFF_CONFLICT', 'deploy-signoff', 'docs'], slack: 2, deadline: 8 },
  { tier: 'B1', combo: ['BOUNDARY_NEGATIVE_CONTROL', 'preseeded-ci', 'none'], slack: 3, deadline: 10 },
  { tier: 'B2', combo: ['BOUNDARY_NEGATIVE_CONTROL', 'preseeded-ci', 'docs'], slack: 0, deadline: 6 },
  { tier: 'B3', combo: ['BOUNDARY_NEGATIVE_CONTROL', 'owner-preference', 'none'], slack: 2, deadline: 9 },
  { tier: 'B4', combo: ['BOUNDARY_NEGATIVE_CONTROL', 'subjective-external', 'none'], slack: 2, deadline: 9 },
  { tier: 'B5', combo: ['BOUNDARY_NEGATIVE_CONTROL', 'subjective-external', 'stale'], slack: 1, deadline: 8 },
];

export function main() {
  const src = path.join(labRoot, 'challenge-studies', 'CEB-001');
  const out = resolveOutputDir(process.argv.slice(2), path.join(labRoot, 'challenge-studies', 'CEB-002'));
  const STUDY = 'CEB-002';
  const MAPPING_ID = 'CEB-002-draft';

  const pool = enumerateCandidatesB1({ mappingId: MAPPING_ID, verify: validateStageGCandidate });
  const byCombo = new Map(pool.map((c) => [`${c.caseDef.family}|${c.draft.parameters.domain}|${c.draft.parameters.distractor}`, c]));

  const built = [];
  for (let k = 0; k < PLAN.length; k++) {
    const spec = PLAN[k];
    const base = byCombo.get(spec.combo.join('|'));
    if (!base) { console.error(`no frozen baseline for ${spec.combo.join('/')}`); process.exit(1); }
    const caseDef = structuredClone(base.caseDef);
    caseDef.caseId = `${STUDY}-${spec.tier}-${String(k + 1).padStart(2, '0')}`;
    caseDef.constraints.budgetUnits = Math.min(base.caseDef.constraints.budgetUnits + spec.slack, 12);
    caseDef.constraints.deadlineUnits = spec.deadline;
    caseDef.taskText = `【${spec.tier} 层】${caseDef.taskText}`;
    const candidate = {
      candidateId: caseDef.caseId,
      draft: {
        scenarioId: caseDef.caseId, family: caseDef.family,
        templateId: 'T-CLAIM-EVIDENCE-BINDING-V1', templateVersion: '1.0.0',
        parameters: { ...base.draft.parameters, tier: spec.tier, budgetSlack: spec.slack, deadline: spec.deadline },
        sourceMechanismRef: `${MAPPING_ID}#assertion_without_observation`,
        rationaleForDesigner: `CEB-002 difficulty tier ${spec.tier}: baseline (${base.draft.parameters.domain}/${base.draft.parameters.distractor}) with slack=${spec.slack} deadline=${spec.deadline}`,
      },
      caseDef,
      sourceBinding: { mappingId: MAPPING_ID, mappingHash: 'ceb002-draft', templateId: 'T-CLAIM-EVIDENCE-BINDING-V1', templateVersion: '1.0.0', tier: spec.tier },
      provenance: { generator: 'build-ceb002-suite.mjs', strategy: 'difficulty-tier-v1', baselineCandidateId: base.candidateId },
    };
    const frozenRefs = { mappingId: MAPPING_ID, mappingHash: 'ceb002-draft', suiteHash: 'ceb002-draft', graderHash: 'ceb002-draft', principleContentHash: 'ceb002-draft', templateId: 'T-CLAIM-EVIDENCE-BINDING-V1', templateVersion: '1.0.0' };
    const verdict = validateStageGCandidate({ candidate, frozenRefs });
    if (!verdict.ok || !verdict.goldIndependence || !verdict.goldIndependence.eligibleForValidSet) {
      console.error(`REJECTED ${caseDef.caseId}: ${JSON.stringify(verdict.groups || verdict).slice(0, 250)}`);
      process.exit(1);
    }
    built.push({ caseDef, tier: spec.tier, baseline: base.candidateId });
  }

  const manifest = {
    schema: 'challenge-suite-manifest.v1', studyId: STUDY, templateId: 'T-CLAIM-EVIDENCE-BINDING-V1', templateVersion: '1.0.0',
    status: 'DRAFT-NOT-FROZEN', mappingHash: null, graderHash: null, suiteHash: null,
    familyCounts: built.reduce((a, c) => { a[c.caseDef.family] = (a[c.caseDef.family] || 0) + 1; return a; }, {}),
    caseCount: built.length,
    cases: built.map(({ caseDef }) => ({ caseId: caseDef.caseId, family: caseDef.family, expectedMode: caseDef.expectedMode, principleApplicable: caseDef.principleApplicable, studyEligible: caseDef.studyEligible, inputHash: null, goldHash: null })),
  };

  const principle = JSON.parse(fs.readFileSync(path.join(src, 'principle-frozen.json'), 'utf8'));
  const summary = JSON.parse(fs.readFileSync(path.join(src, 'arm-payload-experience-summary.json'), 'utf8'));
  const prereg1 = JSON.parse(fs.readFileSync(path.join(src, 'preregistration.json'), 'utf8'));
  const arms = buildStudyArms({ commonContextText: prereg1.commonContext.text, principleStatement: principle.contentJson.principleDraft.statement, summaryText: summary.text, budgetChars: prereg1.delivery.budgetChars });

  const bText = arms.arms.B.delivery.payloadText;
  const cText = arms.arms.C.delivery.payloadText;
  const countSentences = (s) => s.split(/[。.；;!?！？\n]/).filter((x) => x.trim().length > 0).length;
  const countDigits = (s) => (s.match(/\d/g) || []).length;
  const infoBalance = {
    schema: 'ceb002-info-balance.v1', armBPayloadHash: sha256(bText), armCPayloadHash: sha256(cText),
    chars: { B: bText.length, C: cText.length, ratio: Number((Math.max(bText.length, cText.length) / Math.min(bText.length, cText.length)).toFixed(2)) },
    sentences: { B: countSentences(bText), C: countSentences(cText) },
    digits: { B: countDigits(bText), C: countDigits(cText) },
    note: 'B/C payloads are CEB-001 frozen texts reused verbatim; material imbalances are preregistered confounds, reported with every B-vs-C comparison.',
  };

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'actor-visible'), { recursive: true });
  fs.mkdirSync(path.join(out, 'judge-only'), { recursive: true });
  for (const { caseDef } of built) {
    const visible = structuredClone(caseDef);
    delete visible.gold;
    delete visible.expectedMode;
    delete visible.ownerAnswers;
    for (const f of visible.facts) delete f.goldTruth;
    for (const o of visible.observations) delete o.implies;
    fs.writeFileSync(path.join(out, 'actor-visible', `${caseDef.caseId}.json`), `${JSON.stringify(visible, null, 2)}\n`);
    fs.writeFileSync(path.join(out, 'judge-only', `${caseDef.caseId}.json`), `${JSON.stringify(caseDef, null, 2)}\n`);
  }
  fs.writeFileSync(path.join(out, 'suite-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'arm-configs.json'), `${JSON.stringify({ schema: 'challenge-arm-configs.v1', studyId: STUDY, arms: { A: arms.arms.A, B: arms.arms.B, C: arms.arms.C } }, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'info-balance-audit.json'), `${JSON.stringify(infoBalance, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'difficulty-tier-plan.json'), `${JSON.stringify({ schema: 'ceb002-tier-plan.v1', studyId: STUDY, tiers: PLAN.map((p) => ({ tier: p.tier, baseline: p.combo.join('/'), slack: p.slack, deadline: p.deadline })) }, null, 2)}\n`);
  for (const f of ['budget-ledger.jsonl', 'events.jsonl', 'adjudications.jsonl']) fs.writeFileSync(path.join(out, f), '');
  fs.writeFileSync(path.join(out, 'run-authorization.json'), `${JSON.stringify({ schema: 'challenge-stage-authorization.v1', stage: 'R', studyId: STUDY, status: 'NOT_AUTHORIZED', note: 'CEB-002 is a DRAFT study — not frozen, not preregistered, not authorized. Any real execution requires Owner approval and a fresh authorization chain.' }, null, 2)}\n`);

  fs.writeFileSync(path.join(out, 'preregistration.draft.json'), `${JSON.stringify({
    schema: 'challenge-preregistration.v1',
    studyId: STUDY,
    status: 'DRAFT-NOT-IN-FORCE',
    authority: 'docs/specs/CEB-002-DELIVERY-PACK.md §2 (preregistration section) — the sole specification document',
    design: {
      positioning: 'EXPLORATORY',
      repetitions: 2,
      plannedUnits: 96,
      cases: 16,
      arms: ['A', 'B', 'C'],
      tierPlan: 'L1×3 anchor / L2×4 / L3×4 discriminative / B×5 boundary — difficulty-tier-plan.json',
    },
    primaryAnalysis: {
      scope: 'discriminative tier (L2+L3), 8 cases',
      independentUnits: 8,
      independence: 'one case = one paired unit; the 2 repetitions per case are repeated measurements of the SAME unit, never independent samples',
      reductionRule: 'reduceCaseLevel (lib/ceb002-stats.mjs, test-anchored): a case counts B-worse iff B failed >=1 rep AND C passed BOTH reps; symmetric for C-worse; every mixed outcome is concordant and never enters the discordant count — rule FIXED BEFORE any results',
      test: { method: 'exact McNemar (two-sided, alpha=0.05)', implementation: 'lib/ceb002-stats.mjs mcnemarExactPValue — exact binomial enumeration, no asymptotic approximation' },
      role: 'extreme-effect veto gate ONLY — the primary statistical output is descriptive effect estimation (per-case pair detail, discordance rate, direction)',
      powerLimitation: 'n=8 exact McNemar (two-sided alpha=0.05) rejects when >=6 discordant case-level units ALL point in the same direction with the rest concordant — i.e. (6,0) p=0.03125, (7,0) p=0.01563, (8,0) p=0.00781 or the symmetric reverse; (5,0) p=0.0625 does NOT reject. Max power 0.1445 (=37/256, reached at pd=0.5 delta=0.5); at delta=0.25/pd=0.5 power is 0.024; conservative null size ~0.00004. CONFIRMATORY TESTING IS INFEASIBLE at this round\'s sample size — the exact test serves as an extreme-effect veto gate only',
    },
    referenceViews: [
      { view: 'all-16 case-level pairs', status: 'reference only — heterogeneous tier mix (L1 anchor + boundary + discriminative)', independence: '16 independent case-level units but not the primary analysis object' },
      { view: 'repetition-level 32 pairs', status: 'reference only — NON-INDEPENDENT (repetitions of the same case are correlated)', forbiddenUse: 'must never be presented as independent samples or used to inflate the independent n' },
    ],
    escalation: { automatic: false, rule: 'NONE — fixed 2 repetitions; no result-driven sample-size adjustment; any confirmatory study requires a SEPARATE preregistration and fresh Owner authorization' },
    confounds: [{ name: 'B/C sentence-count ratio 2:5', preregistered: true, note: 'payloads are CEB-001 frozen texts reused verbatim; this material imbalance is reported with every B-vs-C comparison' }],
    claimBoundary: {
      supports: ['exploratory comparison of these two specific payloads (B principle text vs C summary text)', 'descriptive effect estimation with per-case detail', 'boundary-tier negative-transfer observation across five situations', 'difficulty-gradient ceiling check (L1 anchor vs L2/L3)'],
      doesNotSupport: ['causal attribution to the principle-abstraction mechanism (confound + exploratory sample)', 'inference to any broader task population (the 16 frozen cases are the study object)', 'confirmatory conclusions (n=8 power ceiling is a mathematical fact)'],
    },
    stoppingRules: {
      consecutiveUnknown: 2,
      batchUnknownRateNotEvaluable: 0.4,
      identityAnomaly: 'halt immediately',
      hashDrift: 'halt immediately',
      ledgerInconsistency: 'halt immediately',
      budgetBreach: 'halt immediately',
      missingData: 'retained in denominator, never attributed to behavior',
    },
    freezeRequirement: 'Owner approval required for: (1) suite freeze, (2) preregistration in force, (3) execution authorization — none granted by this draft',
  }, null, 2)}\n`);

  console.log(`CEB-002 DRAFT suite built: ${built.length} cases (all eligible tier) → ${out}`);
  console.log('tiers:', JSON.stringify(PLAN.reduce((a, p) => { a[p.tier] = (a[p.tier] || 0) + 1; return a; }, {})));
  console.log('info balance:', JSON.stringify({ chars: infoBalance.chars, sentences: infoBalance.sentences }));
}

// Execute ONLY when invoked directly as a CLI script, not when imported.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
