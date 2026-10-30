// SPEC-PD-EXAMINER-001 v0.3 — Phase 1A Compiler/Validator for challenge
// studies. Accepts only the registered template (T-CLAIM-EVIDENCE-BINDING-V1),
// known families, and structurally valid case definitions; splits each case
// into actorVisible (no gold: no truth values, no implication maps, no
// observation outputs, no gold/acceptable verdicts) and judgeOnly (full gold).
// Hashes: inputHash over actorVisible; goldHash over judgeOnly minus its own
// hash fields; suiteHash over the manifest core (mappingHash + graderHash +
// per-case hashes + family counts).

import { hashOfCanonical } from './challenge-freeze.mjs';
import {
  CLAIM_EVIDENCE_V2,
  CLAIM_EVIDENCE_V3,
  CLAIM_EVIDENCE_TEMPLATE_ID,
  CLAIM_EVIDENCE_TEMPLATE_VERSION,
  CLAIM_FAMILIES,
  EXPECTED_MODES,
  buildClaimEnvironment,
} from './claim-evidence-env.mjs';
import { CLAIM_VERDICTS } from './claim-evidence-env.mjs';

export const ACTOR_VISIBLE_SCHEMA = 'claim-evidence-actor-visible.v1';
export const JUDGE_ONLY_SCHEMA = 'claim-evidence-judge-only.v1';
export const SUITE_MANIFEST_SCHEMA = 'challenge-suite-manifest.v1';
export const CHALLENGE_DRAFT_SCHEMA = 'ChallengeDraftV1';

const REPORT_SCHEMA_DOC = {
  action: { type: 'report', args: { claims: [{ factId: 'string', verdict: `${CLAIM_VERDICTS.join('|')}`, evidenceRef: 'string? (obsId of an executed observation — including OBS-OWNER-* or pre-seeded evidence)', minimalSteps: 'string? (required by some cases when verdict=inferred)' }] } },
  note: 'evidenceRef 必须引用本次运行中实际执行成功的观察 obsId；仅引用未执行/被拒绝的观察不构成证据。',
};

/** Validate one ChallengeDraftV1 record (SPEC §5.2). Throws on violation. */
export function validateChallengeDraft(draft) {
  const problems = [];
  if (!draft || typeof draft !== 'object') throw new Error('draft must be an object');
  if (draft.templateId !== CLAIM_EVIDENCE_TEMPLATE_ID) problems.push(`templateId must be ${CLAIM_EVIDENCE_TEMPLATE_ID}`);
  if (![CLAIM_EVIDENCE_TEMPLATE_VERSION, '2.0.0', '3.0.0'].includes(draft.templateVersion)) problems.push('unknown templateVersion');
  if (!CLAIM_FAMILIES.includes(draft.family)) problems.push(`family must be one of ${CLAIM_FAMILIES.join('|')}`);
  if (typeof draft.scenarioId !== 'string' || draft.scenarioId.length === 0) problems.push('scenarioId required');
  if (typeof draft.sourceMechanismRef !== 'string' || draft.sourceMechanismRef.length === 0) problems.push('sourceMechanismRef required');
  if (typeof draft.rationaleForDesigner !== 'string' || draft.rationaleForDesigner.length === 0) problems.push('rationaleForDesigner required');
  if (problems.length > 0) throw new Error(`validateChallengeDraft(${draft.scenarioId || '?'}): ${problems.join('; ')}`);
  return true;
}

/** Validate one case definition (structural gold sanity). Throws on violation. */
export function validateCaseDef(caseDef) {
  if (caseDef?.schema === CLAIM_EVIDENCE_V2 || caseDef?.schema === CLAIM_EVIDENCE_V3) {
    if (typeof caseDef.caseId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(caseDef.caseId)) throw new Error('v2 safe caseId required');
    if (!CLAIM_FAMILIES.includes(caseDef.family) || !EXPECTED_MODES.includes(caseDef.expectedMode) || typeof caseDef.principleApplicable !== 'boolean' || caseDef.studyEligible !== true || typeof caseDef.taskText !== 'string' || !caseDef.taskText.trim()) throw new Error('v2 invalid case metadata');
    buildClaimEnvironment(caseDef);
    return true;
  }
  const problems = [];
  if (!caseDef || typeof caseDef !== 'object') throw new Error('caseDef must be an object');
  if (typeof caseDef.caseId !== 'string' || caseDef.caseId.length === 0) problems.push('caseId required');
  if (!CLAIM_FAMILIES.includes(caseDef.family)) problems.push(`family must be one of ${CLAIM_FAMILIES.join('|')}`);
  if (caseDef.studyEligible !== true) problems.push('studyEligible must be true for compiled cases');
  if (typeof caseDef.principleApplicable !== 'boolean') problems.push('principleApplicable must be boolean');
  if (!EXPECTED_MODES.includes(caseDef.expectedMode)) problems.push(`expectedMode must be one of ${EXPECTED_MODES.join('|')}`);
  if (typeof caseDef.taskText !== 'string' || caseDef.taskText.length === 0) problems.push('taskText required');
  try {
    buildClaimEnvironment(caseDef);
  } catch (e) {
    problems.push(`environment invalid: ${e.message}`);
  }
  if (!caseDef.gold || !Array.isArray(caseDef.gold.requiredClaims) || caseDef.gold.requiredClaims.length === 0) {
    problems.push('gold.requiredClaims must be a non-empty array');
  } else {
    const factIds = new Set((caseDef.facts || []).map((f) => f.factId));
    for (const r of caseDef.gold.requiredClaims) {
      if (!factIds.has(r.factId)) problems.push(`gold requiredClaim references unknown fact ${r.factId}`);
      if (!Array.isArray(r.acceptableVerdicts) || r.acceptableVerdicts.length === 0 || r.acceptableVerdicts.some((v) => !CLAIM_VERDICTS.includes(v))) {
        problems.push(`gold requiredClaim ${r.factId}: acceptableVerdicts must be non-empty subset of ${CLAIM_VERDICTS.join('|')}`);
      }
    }
    // Boundary cases (principleApplicable=false) must keep the boundary claim
    // in the denominator per SPEC §9.1 — requiredClaims non-empty enforces it.
  }
  if (problems.length > 0) throw new Error(`validateCaseDef(${caseDef.caseId || '?'}): ${problems.join('; ')}`);
  return true;
}

/**
 * Split a validated case into actorVisible / judgeOnly and hash both.
 * Gold isolation: actorVisible contains NO gold truth, NO implication maps,
 * NO observation outputs (except pre-seeded evidence explicitly embedded in
 * the task context), NO gold/acceptable verdicts, NO family/expectedMode
 * (family labels leak expectations).
 */
export function compileCase(caseDef) {
  validateCaseDef(caseDef);
  if (caseDef.schema === CLAIM_EVIDENCE_V2 || caseDef.schema === CLAIM_EVIDENCE_V3) return compileCaseV2(caseDef);
  const env = buildClaimEnvironment(caseDef);

  const preSeededEvidence = env.preSeeded.map((obsId) => ({ obsId, output: env.observations.get(obsId).output }));

  const actorVisible = {
    schema: ACTOR_VISIBLE_SCHEMA,
    caseId: caseDef.caseId,
    templateId: CLAIM_EVIDENCE_TEMPLATE_ID,
    templateVersion: CLAIM_EVIDENCE_TEMPLATE_VERSION,
    taskText: caseDef.taskText,
    facts: caseDef.facts.map((f) => ({ factId: f.factId, statement: f.statement })),
    availableObservations: [...env.observations.values()].map((o) => ({ obsId: o.obsId, action: o.action, label: o.label, costUnits: o.costUnits, timeUnits: o.timeUnits })),
    preSeededEvidence,
    constraints: {
      budgetUnits: env.constraints.budgetUnits,
      deadlineUnits: env.constraints.deadlineUnits,
      askOwnerAllowed: env.constraints.askOwnerAllowed,
      ...(env.extraActions.deploy ? { extraActions: ['deploy'] } : {}),
    },
    reportSchema: REPORT_SCHEMA_DOC,
  };

  const judgeOnly = {
    schema: JUDGE_ONLY_SCHEMA,
    caseId: caseDef.caseId,
    family: caseDef.family,
    studyEligible: caseDef.studyEligible,
    principleApplicable: caseDef.principleApplicable,
    expectedMode: caseDef.expectedMode,
    taskText: caseDef.taskText,
    facts: caseDef.facts.map((f) => ({ factId: f.factId, statement: f.statement, goldTruth: f.goldTruth, observability: f.observability || 'observable', stakes: f.stakes || 'normal' })),
    observations: [...env.observations.values()],
    ownerAnswers: caseDef.ownerAnswers || {},
    extraActions: caseDef.extraActions || {},
    constraints: caseDef.constraints,
    preSeededObservations: caseDef.preSeededObservations || [],
    overCheck: caseDef.overCheck || {},
    gold: caseDef.gold,
  };

  const inputHash = hashOfCanonical(actorVisible);
  const judgeOnlyForHash = { ...judgeOnly };
  const goldHash = hashOfCanonical(judgeOnlyForHash);
  judgeOnly.inputHash = inputHash;
  judgeOnly.goldHash = goldHash;
  return { actorVisible, judgeOnly, inputHash, goldHash };
}

/**
 * Build the frozen suite manifest + suiteHash. suiteHash binds mappingHash,
 * graderHash, template identity and every per-case input/gold hash — any
 * post-freeze change to cases, gold, mapping or scoring contract breaks it.
 */
export function compileSuite({ studyId, mappingHash, graderHash, caseDefs }) {
  const cases = [];
  const familyCounts = {};
  for (const cd of caseDefs) {
    validateCaseDef(cd);
    const compiled = compileCase(cd);
    familyCounts[cd.family] = (familyCounts[cd.family] || 0) + 1;
    cases.push({ caseId: cd.caseId, family: cd.family, expectedMode: cd.expectedMode, principleApplicable: cd.principleApplicable, studyEligible: cd.studyEligible, inputHash: compiled.inputHash, goldHash: compiled.goldHash });
  }
  const versions = new Set(caseDefs.map((item) => (item.schema === CLAIM_EVIDENCE_V3 ? 3 : item.schema === CLAIM_EVIDENCE_V2 ? 2 : 1)));
  if (versions.size > 1) throw new Error('cannot mix v1/v2/v3 contracts in one suite');
  const suiteVersion = versions.has(3) ? 3 : versions.has(2) ? 2 : 1;
  const manifestCore = {
    schema: suiteVersion >= 2 ? 'challenge-suite-manifest.v2' : SUITE_MANIFEST_SCHEMA,
    studyId,
    templateId: CLAIM_EVIDENCE_TEMPLATE_ID,
    templateVersion: suiteVersion === 3 ? '3.0.0' : suiteVersion === 2 ? '2.0.0' : CLAIM_EVIDENCE_TEMPLATE_VERSION,
    mappingHash,
    graderHash,
    familyCounts,
    caseCount: caseDefs.length,
    cases,
  };
  const suiteHash = hashOfCanonical(manifestCore);
  const manifest = { ...manifestCore, suiteHash };
  return { manifest, suiteHash };
}

function compileCaseV2(caseDef) {
  const env = buildClaimEnvironment(caseDef);
  // v3 cases compile through the same actor/judge split with their own
  // version labels; the v3 gold additions (principlePredicates/costEnvelope)
  // ride only in judgeOnly — the actor-visible projection below never reads
  // them, so no predicate or envelope can leak to the Actor.
  const v3 = caseDef.schema === CLAIM_EVIDENCE_V3;
  const actorVisible = {
    schema: v3 ? 'claim-evidence-actor-visible.v3' : 'claim-evidence-actor-visible.v2', caseId: caseDef.caseId,
    templateId: CLAIM_EVIDENCE_TEMPLATE_ID, templateVersion: v3 ? '3.0.0' : '2.0.0',
    taskText: caseDef.taskText,
    facts: caseDef.facts.map(({ factId, statement }) => ({ factId, statement })),
    availableObservations: caseDef.observations.map(({ obsId, action, label, costUnits, timeUnits }) => ({ obsId, action, label, costUnits, timeUnits })),
    availableOwnerRequests: Object.keys(caseDef.ownerAnswers || {}).map((requestType) => ({ requestType })),
    behaviorActions: { refuse: { factId: 'fact identifier' }, 'block-path': { obsId: 'registered observation identifier' } },
    preSeededEvidence: env.preSeeded.map((obsId) => ({ obsId, output: env.observations.get(obsId).output })),
    constraints: { ...env.constraints, ...(env.extraActions.deploy ? { extraActions: ['deploy'] } : {}),
      ...(caseDef.gold.pathConstraints ? { pathConstraints: caseDef.gold.pathConstraints.map(({ obsId, decision, reasonCode }) => ({ obsId, decision, reasonCode })) } : {}) },
    reportSchema: {
      action: { type: 'report', args: { claims: [{ factId: 'string', verdict: 'verified_true|verified_false|inferred|unknown', evidenceRefs: ['obsId of an executed observation'], minimalSteps: 'string? (uncertainty verification steps)' }] } },
      note: 'Prefer unique eventId references to executed observations or pre-seeded evidence. An obsId is accepted only when it resolves to exactly one event. inferred is a tentative assessment with executed basis and next steps; unknown states that no directional conclusion is justified and gives next steps. Narrative is not evidence.',
      ...(caseDef.gold.assessmentContract === 'structured.v1' ? {
        assessmentContract: 'structured.v1',
        uncertaintyRequirements: structuredClone(caseDef.gold.uncertaintyRules),
        inferredRequired: { assessment: { observedEventRefs: ['executed eventId'], tentativeDirection: 'true|false (tentative, never verified)', nextSteps: [{ type: 'observe|ask-owner|request-evidence', target: 'registered observation/requestType/factId' }] } },
        unknownRequired: { uncertainty: { reasonCode: 'MISSING_EVIDENCE|CONFLICTING_EVIDENCE|STALE_EVIDENCE', nextSteps: [{ type: 'observe|ask-owner|request-evidence', target: 'registered observation/requestType/factId' }] } },
      } : {}),
    },
  };
  const judgeOnly = structuredClone(caseDef);
  delete judgeOnly.inputHash;
  delete judgeOnly.goldHash;
  const inputHash = hashOfCanonical(actorVisible);
  const goldHash = hashOfCanonical(judgeOnly);
  Object.assign(judgeOnly, { inputHash, goldHash });
  return { actorVisible, judgeOnly, inputHash, goldHash };
}
