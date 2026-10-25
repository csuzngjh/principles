// SPEC-PD-EXAMINER-001 v0.4 — Stage G option B: frozen fact-skeleton gate.
//
// Owner decision 2026-10-25 (option B adopted): study Examiner's CONSTRAINED
// generation increment — expression-level rewriting and legal parameter
// combinations — while the gold-defining simulation facts stay frozen.
//
// Layered guarantees (this module implements the mechanical layers only):
//   L1 structure/params   — deterministic validator (strict schema, value domains)
//   L2 skeleton binding   — the IMMUTABLE projection of a caseDef (truth values,
//                           implication maps, observation identities/costs, gold
//                           verdict skeleton, applicability) must be canonically
//                           EQUAL to the frozen library baseline for the declared
//                           (family, domain, distractor). Gold therefore comes
//                           from the frozen simulated environment, never from
//                           the candidate author.
//   L3 expression residue — polarity-marker flips and near-duplicate phrasing
//                           CANNOT be proven safe by string rules; they are
//                           flagged for mandatory blind review / adversarial
//                           fixtures. Structural leaks (task text embedding an
//                           observation output, cross-contaminated outputs) are
//                           rejected mechanically.
//
// canonical-JSON equality is used ONLY as proof of L2 structural binding —
// it is explicitly NOT claimed as a general proof of natural-language semantic
// equivalence. No model, no network, no clock, no env.

import { canonicalJson } from './challenge-freeze.mjs';
import { CLAIM_EVIDENCE_TEMPLATE_ID, CLAIM_EVIDENCE_TEMPLATE_VERSION } from './claim-evidence-env.mjs';
import { enumerateCandidates, DOMAIN_LIBRARY, DISTRACTOR_LIBRARY } from './challenge-enumerator.mjs';

export const SKELETON_SCHEMA = 'claim-evidence-skeleton.v1';
export const SKELETON_VERSION = '1.0.0';
export const VALUE_DOMAINS_VERSION = '1.0.0';

/**
 * Pre-registered legal parameter value domains (v1 — CEB-001 mechanism only,
 * NOT a general generation platform). Version-stamped: value-domain changes
//  must bump VALUE_DOMAINS_VERSION and re-audit; unknown versions are refused.
 */
export const VALUE_DOMAINS = {
  schemaVersion: VALUE_DOMAINS_VERSION,
  templateId: CLAIM_EVIDENCE_TEMPLATE_ID,
  templateVersion: CLAIM_EVIDENCE_TEMPLATE_VERSION,
  constraints: {
    budgetUnits: { min: 2, max: 12 },
    deadlineUnits: { min: 3, max: 12 },
  },
  stakes: ['high', 'normal', 'low'],
  distractors: ['none', 'docs', 'stale'],
  allowedExpressionFields: ['taskText', 'facts[].statement', 'observations[].label', 'observations[].output'],
  immutableFields: [
    'facts[].factId/goldTruth/observability',
    'observations[].obsId/action/implies/costUnits/timeUnits',
    'ownerAnswers implies maps',
    'extraActions',
    'preSeededObservations',
    'gold.requiredClaims (factId/acceptableVerdicts/requiresMinimalSteps)',
    'family/expectedMode/principleApplicable/studyEligible',
  ],
  // Mechanical polarity heuristic for L3 flags — an approximation, never a
  // semantic-equivalence proof. Chinese + English negative markers.
  polarityMarkers: ['不', '未', '无', '非', '没有', '不是', 'not', 'no', 'never', "n't"],
};

/**
 * Extract the immutable skeleton projection of a caseDef. Everything gold-
// defining survives here; everything expression-level is deliberately dropped.
 */
export function extractSkeleton(caseDef) {
  return {
    schema: SKELETON_SCHEMA,
    schemaVersion: SKELETON_VERSION,
    templateId: CLAIM_EVIDENCE_TEMPLATE_ID,
    templateVersion: CLAIM_EVIDENCE_TEMPLATE_VERSION,
    family: caseDef.family,
    expectedMode: caseDef.expectedMode,
    principleApplicable: caseDef.principleApplicable === true,
    studyEligible: caseDef.studyEligible === true,
    facts: (caseDef.facts || []).map((f) => ({ factId: f.factId, goldTruth: f.goldTruth === true, observability: f.observability || 'observable' })).sort((a, b) => a.factId.localeCompare(b.factId)),
    observations: (caseDef.observations || [])
      .map((o) => ({ obsId: o.obsId, action: o.action || o.obsId, implies: o.implies || {}, costUnits: o.costUnits, timeUnits: o.timeUnits }))
      .sort((a, b) => a.obsId.localeCompare(b.obsId)),
    ownerAnswers: Object.fromEntries(
      Object.entries(caseDef.ownerAnswers || {})
        .map(([k, v]) => [k, { implies: v.implies || {} }])
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
    extraActions: caseDef.extraActions || {},
    preSeededObservations: [...(caseDef.preSeededObservations || [])].sort(),
    gold: (caseDef.gold?.requiredClaims || [])
      .map((r) => ({ factId: r.factId, acceptableVerdicts: [...r.acceptableVerdicts].sort(), requiresMinimalSteps: r.requiresMinimalSteps === true }))
      .sort((a, b) => a.factId.localeCompare(b.factId)),
  };
}

export function skeletonCanonicalHash(caseDef) {
  const crypto = canonicalJson(extractSkeleton(caseDef));
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < crypto.length; i++) {
    h ^= BigInt(crypto.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `sk-${h.toString(16).padStart(16, '0')}`;
}

/** Deterministic value-domain validation (L1). */
export function validateValueDomains(caseDef) {
  const problems = [];
  const c = caseDef.constraints || {};
  const vd = VALUE_DOMAINS.constraints;
  if (!Number.isFinite(c.budgetUnits) || c.budgetUnits < vd.budgetUnits.min || c.budgetUnits > vd.budgetUnits.max) {
    problems.push(`constraints.budgetUnits out of domain [${vd.budgetUnits.min},${vd.budgetUnits.max}]: ${String(c.budgetUnits)}`);
  }
  if (!Number.isFinite(c.deadlineUnits) || c.deadlineUnits < vd.deadlineUnits.min || c.deadlineUnits > vd.deadlineUnits.max) {
    problems.push(`constraints.deadlineUnits out of domain [${vd.deadlineUnits.min},${vd.deadlineUnits.max}]: ${String(c.deadlineUnits)}`);
  }
  for (const f of caseDef.facts || []) {
    if (f.stakes && !VALUE_DOMAINS.stakes.includes(f.stakes)) problems.push(`fact ${f.factId}: stakes '${f.stakes}' not in domain`);
  }
  return problems;
}

function hasPolarity(text) {
  return VALUE_DOMAINS.polarityMarkers.some((m) => String(text || '').includes(m));
}

/**
 * L3 expression-layer audit. Returns { problems (reject), flags (blind review) }.
 * Mechanical rules are approximations — flags route candidates to mandatory
 * blind review; only structurally decidable contamination is rejected.
 */
export function auditExpressionLayer({ caseDef, baselineCaseDef }) {
  const problems = [];
  const flags = [];
  const outputs = (caseDef.observations || []).map((o) => ({ obsId: o.obsId, output: String(o.output || '') }));
  const baselineOutputs = (baselineCaseDef.observations || []).map((o) => ({ obsId: o.obsId, output: String(o.output || '') }));

  // (reject) task text embedding an observation output → answer leakage vector.
  for (const { obsId, output } of outputs) {
    if (output.length >= 8 && (caseDef.taskText || '').includes(output)) {
      problems.push(`taskText embeds observation output of ${obsId} (answer leakage)`);
    }
  }
  // (reject) an observation output replaced verbatim by ANOTHER observation's
  // library output — cross-contamination that silently changes evidence.
  for (const { obsId, output } of outputs) {
    const swapped = baselineOutputs.find((b) => b.obsId !== obsId && b.output === output && output.length > 0);
    if (swapped) problems.push(`observation ${obsId} output is a verbatim swap of baseline observation ${swapped.obsId} (cross-contamination)`);
  }
  // (flag) polarity-marker flips between baseline and candidate statements/taskText/outputs.
  (caseDef.facts || []).forEach((f, i) => {
    const base = (baselineCaseDef.facts || [])[i];
    if (base && hasPolarity(base.statement) !== hasPolarity(f.statement)) {
      flags.push({ kind: 'expression_polarity_changed', where: `facts[${i}].statement`, note: '极性词变化：机械规则无法判定语义是否翻转——强制盲评 mechanism_fidelity/evidence_binding 维度' });
    }
  });
  if (hasPolarity(baselineCaseDef.taskText) !== hasPolarity(caseDef.taskText)) {
    flags.push({ kind: 'expression_polarity_changed', where: 'taskText', note: '任务文本极性词变化——强制盲评' });
  }
  (caseDef.observations || []).forEach((o) => {
    const base = (baselineCaseDef.observations || []).find((b) => b.obsId === o.obsId);
    if (base && hasPolarity(base.output) !== hasPolarity(o.output)) {
      flags.push({ kind: 'expression_polarity_changed', where: `observations[${o.obsId}].output`, note: '观察输出极性词变化——输出语义方向可能被措辞反转（机械不可判），强制盲评 evidence_binding' });
    }
  });
  return { problems, flags };
}

/**
 * The skeleton gate (L2 + L1 + L3). Tiers:
 *   parametric_verified     — byte-equal replay of the frozen enumerator (strongest)
 *   skeleton_verified       — immutable projection canonically equal to the frozen
 *                             baseline for (family, domain, distractor); expression
 *                             layer free within audit limits; eligible
 *   skeleton_mismatch       — a gold-defining field was changed → REJECT
 *   value_domain_violation  — parameter outside pre-registered domain → REJECT
 *   expression_leak         — structural leakage/contamination → REJECT
 *   domain_proposal         — no frozen library entry (novel domain) → kept,
 *                             NEVER eligible without an independently verified
 *                             library freeze (owner-approved path)
 */
export function verifySkeletonGate({ candidate, frozenRefs, enumerate = enumerateCandidates }) {
  const caseDef = candidate.caseDef;
  const params = candidate.draft && candidate.draft.parameters;
  if (!params || typeof params.domain !== 'string' || typeof params.distractor !== 'string') {
    return { tier: 'domain_proposal', eligibleForValidSet: false, problems: ['candidate does not declare (domain, distractor) parameters'], flags: [], skeletonHash: skeletonCanonicalHash(caseDef), baselineSkeletonHash: null };
  }
  if (!VALUE_DOMAINS.distractors.includes(params.distractor)) {
    return { tier: 'value_domain_violation', eligibleForValidSet: false, problems: [`distractor '${params.distractor}' not in pre-registered domain`], flags: [], skeletonHash: skeletonCanonicalHash(caseDef), baselineSkeletonHash: null };
  }

  const pool = enumerate({ mappingId: frozenRefs.mappingId, mappingHash: frozenRefs.mappingHash });
  const baseline = pool.find((c) => c.caseDef.family === caseDef.family && c.draft.parameters.domain === params.domain && c.draft.parameters.distractor === params.distractor);
  if (!baseline) {
    return { tier: 'domain_proposal', eligibleForValidSet: false, problems: [`no frozen library entry for family=${caseDef.family} domain=${params.domain} distractor=${params.distractor} — domain proposals need an independently verified library freeze before entering the valid set`], flags: [], skeletonHash: skeletonCanonicalHash(caseDef), baselineSkeletonHash: null };
  }

  if (canonicalJson(baseline.caseDef) === canonicalJson(caseDef)) {
    return { tier: 'parametric_verified', eligibleForValidSet: true, problems: [], flags: [], skeletonHash: skeletonCanonicalHash(caseDef), baselineSkeletonHash: skeletonCanonicalHash(baseline.caseDef) };
  }

  const skeletonHash = skeletonCanonicalHash(caseDef);
  const baselineSkeletonHash = skeletonCanonicalHash(baseline.caseDef);
  if (skeletonHash !== baselineSkeletonHash) {
    return { tier: 'skeleton_mismatch', eligibleForValidSet: false, problems: ['immutable skeleton differs from the frozen baseline — gold-defining fields (truth values / implication maps / observation identity / gold verdict skeleton) were changed'], flags: [], skeletonHash, baselineSkeletonHash };
  }

  const domainProblems = validateValueDomains(caseDef);
  if (domainProblems.length > 0) {
    return { tier: 'value_domain_violation', eligibleForValidSet: false, problems: domainProblems, flags: [], skeletonHash, baselineSkeletonHash };
  }

  const expr = auditExpressionLayer({ caseDef, baselineCaseDef: baseline.caseDef });
  if (expr.problems.length > 0) {
    return { tier: 'expression_leak', eligibleForValidSet: false, problems: expr.problems, flags: expr.flags, skeletonHash, baselineSkeletonHash };
  }

  return { tier: 'skeleton_verified', eligibleForValidSet: true, problems: [], flags: expr.flags, skeletonHash, baselineSkeletonHash };
}
