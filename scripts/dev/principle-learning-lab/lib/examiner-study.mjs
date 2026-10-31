// SPEC-PD-EXAMINER-001 v0.9 §2/§4/§5.1 — dual-mode experiment contract.
//
// This module implements the v0.9 Experiment Designer surface on TOP of the
// existing freeze/runner/report pipeline — it is a contract layer, NOT a
// second research engine:
//   - Study Manifest (§4.1 ExaminerStudyManifest, schema examiner-study-manifest.v1)
//   - Host-effective Principle Set (§2.2.1 HEPS)
//   - RuleCode Policy (§2.1 / §2.2.3 / §2.2.4 principle_only vs bundled)
//   - Primary Endpoint (§5.1 — exactly one per study, frozen before execution)
//   - Pair assignment + randomized balanced execution order (§3.2/§3.3)
//   - Preflight gate (§8.2B equivalent, offline-first)
//
// Every durable fact carries a canonical SHA-256 (hashOfCanonical) and every
// verification is fail-closed: an unverified declaration never authorizes
// anything. PD's REAL production statuses are the five-state
// candidate/probation/active/archived/deprecated (principle-enums.ts is the
// SSoT); the SPEC's nominal DRAFT/PENDING_APPROVAL/REVOKED vocabulary is
// mapped explicitly below and the mapping itself is frozen into the snapshot.
//
// Zero network, zero clock, zero production writes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashOfCanonical, sha256, challengeImplementationManifest } from './challenge-freeze.mjs';
import { compileCase, compileSuite } from './challenge-compile.mjs';
import { recordCapacityCompetition } from './examiner-injection-evidence.mjs';

export const EXAMINER_MANIFEST_SCHEMA = 'examiner-study-manifest.v1';
export const PAIR_ASSIGNMENT_SCHEMA = 'examiner-pair-assignment.v1';

export const EXPERIMENT_MODES = ['isolated_principle', 'full_library_incremental'];
export const INTERVENTION_TYPES = ['principle_only', 'bundled_intervention'];
export const DEFAULT_EXPERIMENT_MODE = 'full_library_incremental';

// PD five-state → v0.9 eligibility. Documented deviation (audit §6.1):
// probation is NOT host-effective (its Owner approval chain is incomplete);
// only 'active' qualifies by default. The mapping ships inside the snapshot.
export const PRINCIPLE_STATUS_ELIGIBILITY = {
  candidate: 'INELIGIBLE_NOT_APPROVED',
  probation: 'INELIGIBLE_PROMOTION_PENDING',
  active: 'ELIGIBLE',
  archived: 'INELIGIBLE_ARCHIVED',
  deprecated: 'INELIGIBLE_DEPRECATED',
};
export const DEFAULT_ELIGIBLE_STATUSES = ['active'];

// v0.9 §5.1: the Primary Endpoint must bind to a Scorer V3 dimension through
// a FROZEN reduction — no ad-hoc metric language. The registry maps each
// endpoint id to (dimension, failure predicate). F semantics follow the
// existing F derivation family: 1 = target failure event, 0 = no failure.
export const PRIMARY_ENDPOINT_DEFINITIONS = {
  target_unsupported_completion_assertion_rate: {
    dimension: 'evidenceAlignment',
    failWhen: 'FAIL',
    statisticUnit: 'pair',
    description: 'Rate of asserting task completion/claims without the necessary verification evidence, over preregistered applicable challenge units',
    mechanismBinding: 'EVIDENCE_ALIGNMENT ↔ conclusion-beyond-observation failure family (Pain #44 line)',
  },
  principle_conformance_failure_rate: {
    dimension: 'principleConformance',
    failWhen: 'FAIL',
    statisticUnit: 'pair',
    description: 'Rate of violating the target Principle\'s frozen behavioral predicates on applicable units',
    mechanismBinding: 'PRINCIPLE_CONFORMANCE ↔ target principle predicates',
  },
  objective_task_failure_rate: {
    dimension: 'objectiveTaskOutcome',
    failWhen: 'FAIL',
    statisticUnit: 'pair',
    description: 'Rate of objectively failing the frozen task contract (independent of principle conformance)',
    mechanismBinding: 'OBJECTIVE_TASK_OUTCOME ↔ frozen task objective',
  },
};

const HASH_RE = /^[a-f0-9]{64}$/;
const text = (v) => typeof v === 'string' && v.trim().length > 0;

function assertMode(mode) {
  if (!EXPERIMENT_MODES.includes(mode)) {
    throw new Error(`examiner-study: experimentMode must be one of ${EXPERIMENT_MODES.join(' | ')} (got '${String(mode)}')`);
  }
}

// ---------------------------------------------------------------------------
// §2.2.1 Host-effective Principle Set
// ---------------------------------------------------------------------------

/**
 * Build the HEPS from caller-assembled principle facts. The caller OWNS the
 * facts' provenance (production ledger or declared fixture facts — preflight
 * requires a source declaration); this function owns only the ELIGIBILITY
 * judgement and the frozen snapshot.
 *
 * @param {Array<{id:string, version:string, text:string, status:string,
 *   hostApplicable?:boolean, ownerApproved?:boolean, promptActivated?:boolean}>} principles
 * @param {string} targetPrincipleId — the intervention variable, managed
 *   separately from the base library per §2.2.1.
 * @param {object} [options]
 */
export function buildHostEffectivePrincipleSet({ principles, targetPrincipleId, host, eligibleStatuses = DEFAULT_ELIGIBLE_STATUSES }) {
  if (!Array.isArray(principles) || principles.length === 0) throw new Error('buildHostEffectivePrincipleSet: principles[] required (a study without a library is not a full-library study)');
  if (!text(targetPrincipleId)) throw new Error('buildHostEffectivePrincipleSet: targetPrincipleId required');
  if (!text(host)) throw new Error('buildHostEffectivePrincipleSet: host required');
  const seen = new Set();
  for (const p of principles) {
    if (!p || !text(p.id) || !text(p.version) || !text(p.text) || !text(p.status)) {
      throw new Error(`buildHostEffectivePrincipleSet: principle ${JSON.stringify(p && p.id)} needs id/version/text/status`);
    }
    if (seen.has(p.id)) throw new Error(`buildHostEffectivePrincipleSet: duplicate principle id '${p.id}'`);
    seen.add(p.id);
  }
  const excluded = [];
  const eligible = [];
  for (const p of principles) {
    if (p.id === targetPrincipleId) continue; // target is managed separately
    const reasons = [];
    const eligibility = PRINCIPLE_STATUS_ELIGIBILITY[p.status];
    if (!eligibility) {
      throw new Error(`buildHostEffectivePrincipleSet: unknown principle status '${p.status}' (PD five-state SSoT: candidate|probation|active|archived|deprecated)`);
    }
    if (!eligibleStatuses.includes(p.status)) reasons.push(`status:${eligibility}`);
    if (p.hostApplicable === false) reasons.push('host:not_applicable');
    if (p.ownerApproved === false) reasons.push('approval:not_owner_approved');
    if (p.promptActivated === false) reasons.push('activation:not_activated');
    if (reasons.length > 0) excluded.push({ id: p.id, status: p.status, reason: reasons.join('+') });
    else eligible.push({ id: p.id, version: p.version, contentHash: hashOfCanonical({ id: p.id, version: p.version, text: p.text }) });
  }
  eligible.sort((a, b) => (a.id < b.id ? -1 : 1));
  const target = principles.find((p) => p.id === targetPrincipleId);
  const targetEligible = target ? (PRINCIPLE_STATUS_ELIGIBILITY[target.status] === 'ELIGIBLE' || eligibleStatuses.includes(target.status))
    && target.hostApplicable !== false && target.ownerApproved !== false && target.promptActivated !== false : false;
  const targetExclusionReason = target
    ? (targetEligible ? null
      : [
        eligibleStatuses.includes(target.status) ? null : `status:${PRINCIPLE_STATUS_ELIGIBILITY[target.status] || 'UNKNOWN'}`,
        target.hostApplicable === false ? 'host:not_applicable' : null,
        target.ownerApproved === false ? 'approval:not_owner_approved' : null,
        target.promptActivated === false ? 'activation:not_activated' : null,
      ].filter(Boolean).join('+') || 'ineligible')
    : 'not_in_input_set';
  const snapshot = {
    host,
    eligibilityStatuses: eligibleStatuses.slice().sort(),
    statusEligibilityMap: PRINCIPLE_STATUS_ELIGIBILITY,
    baseLibrary: eligible,
    excluded: excluded.sort((a, b) => (a.id < b.id ? -1 : 1)),
    target: { id: targetPrincipleId, qualifies: targetEligible, exclusionReason: targetExclusionReason },
  };
  return { ...snapshot, snapshotHash: hashOfCanonical(snapshot) };
}

export function verifyHostEffectivePrincipleSet(set) {
  if (!set || set.snapshotHash === undefined) return { ok: false, reason: 'no HEPS supplied' };
  const { snapshotHash, ...core } = set;
  if (!HASH_RE.test(String(snapshotHash)) || hashOfCanonical(core) !== snapshotHash) {
    return { ok: false, reason: 'HEPS snapshotHash mismatch — the eligibility snapshot was modified after freezing' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// §2.1 / §2.2.3 / §2.2.4 RuleCode Policy
// ---------------------------------------------------------------------------

/**
 * @param {Array<{ruleCodeId:string, principleId:string, baselineState:'ON'|'OFF'}>} ruleCodes
 * @param {boolean} principleRuleCodeIndependence — CAN the system toggle the
 *   target Principle's prompt injection while holding its RuleCode at
 *   baseline? When false and the target's baseline RuleCode is ON, a
 *   full-library study is a bundled_intervention (§2.2.4) and an isolated
 *   study is structurally unable to hold RuleCode OFF → blocked.
 */
export function buildRuleCodePolicy({ mode, ruleCodes = [], targetPrincipleId, principleRuleCodeIndependence = true }) {
  assertMode(mode);
  if (!text(targetPrincipleId)) throw new Error('buildRuleCodePolicy: targetPrincipleId required');
  for (const rc of ruleCodes) {
    if (!text(rc.ruleCodeId) || !text(rc.principleId) || !['ON', 'OFF'].includes(rc.baselineState)) {
      throw new Error(`buildRuleCodePolicy: ruleCode ${JSON.stringify(rc && rc.ruleCodeId)} needs ruleCodeId/principleId/baselineState(ON|OFF)`);
    }
  }
  const targetRuleCodes = ruleCodes.filter((rc) => rc.principleId === targetPrincipleId);
  const targetBaselineOn = targetRuleCodes.filter((rc) => rc.baselineState === 'ON');
  const baseline = Object.fromEntries(ruleCodes.map((rc) => [rc.ruleCodeId, rc.baselineState]).sort(([a], [b]) => (a < b ? -1 : 1)));

  let interventionType = 'principle_only';
  let couplingReason = null;
  let executable = true;
  let control;
  let treatment;
  if (mode === 'isolated_principle') {
    // §2.1: EVERY PD RuleCode is OFF in BOTH arms — including the target's.
    // If the target's baseline-ON RuleCode cannot be held OFF independently,
    // the isolated design cannot exist honestly.
    control = { targetPrinciple: 'OFF', targetRuleCode: 'OFF', otherRuleCodes: 'ALL_OFF' };
    treatment = { targetPrinciple: 'ON', targetRuleCode: 'OFF', otherRuleCodes: 'ALL_OFF' };
    if (targetBaselineOn.length > 0 && principleRuleCodeIndependence === false) {
      interventionType = 'bundled_intervention';
      couplingReason = `isolated mode requires the target's baseline-ON RuleCode (${targetBaselineOn.map((rc) => rc.ruleCodeId).join(', ')}) to be OFF in both arms, but Principle/RuleCode cannot be controlled independently`;
      executable = false;
    }
  } else {
    // §2.2.3: every RuleCode keeps its CURRENT BASELINE state in both arms —
    // a baseline-ON target RuleCode must NOT be switched off for the study.
    control = { targetPrinciple: 'OFF', targetRuleCode: targetBaselineOn.length > 0 ? 'BASELINE_ON' : 'BASELINE_OFF', otherRuleCodes: 'BASELINE_FROZEN' };
    treatment = { ...control, targetPrinciple: 'ON' };
    if (targetBaselineOn.length > 0 && principleRuleCodeIndependence === false) {
      interventionType = 'bundled_intervention';
      couplingReason = `target Principle and its baseline-ON RuleCode (${targetBaselineOn.map((rc) => rc.ruleCodeId).join(', ')}) cannot be controlled independently — the intervention is the bundle, and the report may only attribute to the bundle`;
    }
  }
  const snapshot = {
    mode,
    policy: mode === 'isolated_principle' ? 'ALL_OFF_BOTH_ARMS' : 'BASELINE_FROZEN_BOTH_ARMS',
    baseline,
    targetRuleCodes: targetRuleCodes.map((rc) => ({ ruleCodeId: rc.ruleCodeId, baselineState: rc.baselineState })).sort((a, b) => (a.ruleCodeId < b.ruleCodeId ? -1 : 1)),
    principleRuleCodeIndependence,
    interventionType,
    couplingReason,
    executable,
    arms: { control, treatment },
  };
  return {
    ...snapshot,
    ruleCodeSnapshotHash: hashOfCanonical(snapshot),
  };
}

export function verifyRuleCodePolicy(policy) {
  if (!policy || policy.ruleCodeSnapshotHash === undefined) return { ok: false, reason: 'no RuleCode policy supplied' };
  const { ruleCodeSnapshotHash, ...core } = policy;
  if (!HASH_RE.test(String(ruleCodeSnapshotHash)) || hashOfCanonical(core) !== ruleCodeSnapshotHash) {
    return { ok: false, reason: 'ruleCodeSnapshotHash mismatch — the RuleCode policy was modified after freezing' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// §5.1 Primary Endpoint
// ---------------------------------------------------------------------------

/**
 * Freeze ONE primary endpoint per study. definitionHash binds the endpoint to
 * its Scorer V3 dimension reduction; applicabilityRuleHash binds the
 * applicability predicate (frozen in gold). After the manifest is frozen the
 * endpoint may not change (§5.1 / §13.D).
 */
export function definePrimaryEndpoint({ id, applicability = { field: 'principleApplicable', equals: true }, reductionOverride = null }) {
  const definition = PRIMARY_ENDPOINT_DEFINITIONS[id];
  if (!definition) {
    throw new Error(`definePrimaryEndpoint: unknown endpoint id '${String(id)}' — the registry is closed; map a Scorer V3 dimension instead of inventing a metric language (known: ${Object.keys(PRIMARY_ENDPOINT_DEFINITIONS).join(' | ')})`);
  }
  const reduction = reductionOverride || {
    dimension: definition.dimension,
    failWhen: definition.failWhen,
    fMapping: 'dimension.status === failWhen → F=1; PASS → F=0; otherwise F=\'UNKNOWN\'',
  };
  const core = { id, statisticUnit: definition.statisticUnit, description: definition.description, mechanismBinding: definition.mechanismBinding, reduction };
  if (!applicability || !text(applicability.field) || !('equals' in applicability)) {
    throw new Error('definePrimaryEndpoint: applicability {field, equals} required — NOT_APPLICABLE units must be excludable by a frozen predicate, never by post-hoc judgement');
  }
  return {
    schema: 'examiner-primary-endpoint.v1',
    ...core,
    definitionHash: hashOfCanonical(core),
    applicabilityRule: applicability,
    applicabilityRuleHash: hashOfCanonical(applicability),
  };
}

/**
 * Evaluate the primary-endpoint F value for one adjudication under a frozen
 * endpoint. PURE; reads only the frozen endpoint + the scorer output + the
 * frozen case applicability.
 * @returns {1|0|'UNKNOWN'|'NOT_APPLICABLE'}
 */
export function evaluatePrimaryEndpointF({ endpoint, adjudication, caseDef }) {
  if (!endpoint || !HASH_RE.test(String(endpoint.definitionHash))) throw new Error('evaluatePrimaryEndpointF: frozen endpoint required');
  if (!adjudication || typeof adjudication !== 'object') return 'UNKNOWN';
  const applicable = caseDef ? caseDef[endpoint.applicabilityRule.field] : undefined;
  if (applicable !== endpoint.applicabilityRule.equals) return 'NOT_APPLICABLE';
  const dimension = adjudication.dimensions && adjudication.dimensions[endpoint.reduction.dimension];
  const status = dimension && (dimension.status !== undefined ? dimension.status : dimension);
  if (status === endpoint.reduction.failWhen) return 1;
  if (status === 'PASS') return 0;
  return 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// §3.2/§3.3 Pair assignment + randomized balanced execution order
// ---------------------------------------------------------------------------

/** Deterministic seeded PRNG (mulberry32) — same seed, same assignment, any Node ≥22. */
function seededRandom(seedText) {
  let h = 1779033703 ^ seedText.length;
  for (let i = 0; i < seedText.length; i += 1) {
    h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Assign pairs Case × Repetition with BALANCED randomization of the intra-pair
 * arm order (§3.3: A→B / B→A balanced; the assignment freezes BEFORE any
 * execution and its hash detects post-hoc tampering).
 *
 * @returns record {schema, strategy, seed, pairs[], unitOrder[], assignmentHash}
 *   pairs: [{pairId, caseId, repetitionId, armOrder:[first,second]}]
 *   unitOrder: flattened dispatch order [{caseId, armId, repetitionId}]
 */
export function assignPairs({ cases, repetitionsPerCase, controlArm = 'A', treatmentArm = 'B', seed }) {
  if (!Array.isArray(cases) || cases.length === 0) throw new Error('assignPairs: cases[] required');
  if (!Number.isInteger(repetitionsPerCase) || repetitionsPerCase < 1) throw new Error('assignPairs: repetitionsPerCase must be a positive integer');
  if (!text(seed)) throw new Error('assignPairs: seed required — an unseeded "randomization" is not reproducible and not preregistrable');
  if (controlArm === treatmentArm) throw new Error('assignPairs: controlArm and treatmentArm must differ');
  const rand = seededRandom(seed);
  const sortedCases = cases.slice().sort((a, b) => (a < b ? -1 : 1));
  const pairs = [];
  let controlFirst = 0;
  let treatmentFirst = 0;
  let index = 0;
  for (const caseId of sortedCases) {
    for (let rep = 1; rep <= repetitionsPerCase; rep += 1) {
      index += 1;
      // balanced: when the counts diverge, the lagging order goes next;
      // when tied, the coin decides — recorded honestly as 'balanced-randomized'.
      let controlGoesFirst;
      if (controlFirst < treatmentFirst) controlGoesFirst = true;
      else if (treatmentFirst < controlFirst) controlGoesFirst = false;
      else controlGoesFirst = rand() < 0.5;
      const armOrder = controlGoesFirst ? [controlArm, treatmentArm] : [treatmentArm, controlArm];
      if (controlGoesFirst) controlFirst += 1; else treatmentFirst += 1;
      pairs.push({
        pairId: `P-${String(index).padStart(3, '0')}`,
        caseId,
        repetitionId: String(rep),
        armOrder,
      });
    }
  }
  const unitOrder = pairs.flatMap((pair) => pair.armOrder.map((armId) => ({ caseId: pair.caseId, armId, repetitionId: pair.repetitionId })));
  const core = {
    schema: PAIR_ASSIGNMENT_SCHEMA,
    strategy: 'balanced-randomized',
    seed,
    controlArm,
    treatmentArm,
    balance: { controlFirst, treatmentFirst },
    pairs,
    unitOrder,
  };
  return { ...core, assignmentHash: hashOfCanonical(core) };
}

export function verifyPairAssignment(record) {
  if (!record || record.assignmentHash === undefined) return { ok: false, reason: 'no pair assignment supplied' };
  const { assignmentHash, ...core } = record;
  if (!HASH_RE.test(String(assignmentHash)) || hashOfCanonical(core) !== assignmentHash) {
    return { ok: false, reason: 'assignmentHash mismatch — the randomization record was modified after freezing (post-hoc order manipulation)' };
  }
  const repsByCase = new Map();
  for (const p of core.pairs) repsByCase.set(p.caseId, (repsByCase.get(p.caseId) || 0) + 1);
  const caseList = [...repsByCase.keys()].sort();
  const reps = [...new Set(repsByCase.values())];
  if (reps.length !== 1) {
    return { ok: false, reason: 'pair assignment has heterogeneous repetitions per case — not producible by a deterministic assignment' };
  }
  const rebuild = assignPairs({
    cases: caseList,
    repetitionsPerCase: reps[0],
    controlArm: core.controlArm,
    treatmentArm: core.treatmentArm,
    seed: core.seed,
  });
  if (rebuild.assignmentHash !== assignmentHash) {
    return { ok: false, reason: 'pair assignment is not reproducible from its own seed — the record does not match a deterministic randomization' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// §4.1 ExaminerStudyManifest
// ---------------------------------------------------------------------------

/**
 * Assemble the v0.9 §4.1 manifest from already-frozen components. Every
 * component hash is verified first (fail-closed: a manifest over unverified
 * parts is itself unverified), then the manifest hash freezes the whole.
 */
export function buildExaminerStudyManifest({
  studyId,
  targetPrinciple,
  experimentMode = DEFAULT_EXPERIMENT_MODE,
  heps,
  ruleCodePolicy,
  hostManifest,
  modelManifest,
  runtimeManifest,
  challengeSuiteHash,
  goldSnapshotHash,
  scorerVersion,
  primaryEndpoint,
  secondaryEndpoints = [],
  negativeTransferMetrics = [],
  operationalCostMetrics = [],
  pairAssignment,
  analysisPlan,
  invalidationPolicy,
  armPayloadHashes = null,
  authorizationRef = null,
}) {
  if (!text(studyId)) throw new Error('buildExaminerStudyManifest: studyId required');
  if (!/^[A-Z0-9][A-Z0-9-]*$/.test(studyId)) throw new Error(`buildExaminerStudyManifest: studyId '${studyId}' must be UPPER-CASE with digits/dashes`);
  assertMode(experimentMode);
  if (!targetPrinciple || !text(targetPrinciple.id) || !text(targetPrinciple.version) || !HASH_RE.test(String(targetPrinciple.contentHash))) {
    throw new Error('buildExaminerStudyManifest: targetPrinciple {id, version, contentHash} required');
  }
  for (const [name, hash] of [['challengeSuiteHash', challengeSuiteHash], ['goldSnapshotHash', goldSnapshotHash]]) {
    if (!HASH_RE.test(String(hash))) throw new Error(`buildExaminerStudyManifest: ${name} must be a sha256 hex`);
  }
  if (!text(scorerVersion)) throw new Error('buildExaminerStudyManifest: scorerVersion required');
  if (!text(analysisPlan) && typeof analysisPlan !== 'object') throw new Error('buildExaminerStudyManifest: analysisPlan required (object or reference string)');
  if (!invalidationPolicy || typeof invalidationPolicy !== 'object') throw new Error('buildExaminerStudyManifest: invalidationPolicy required');

  const hepsCheck = verifyHostEffectivePrincipleSet(heps);
  if (!hepsCheck.ok) throw new Error(`buildExaminerStudyManifest: HEPS not verifiable — ${hepsCheck.reason}`);
  const rcCheck = verifyRuleCodePolicy(ruleCodePolicy);
  if (!rcCheck.ok) throw new Error(`buildExaminerStudyManifest: RuleCode policy not verifiable — ${rcCheck.reason}`);
  if (ruleCodePolicy.mode !== experimentMode) throw new Error('buildExaminerStudyManifest: RuleCode policy mode differs from the manifest experimentMode');
  const pairCheck = verifyPairAssignment(pairAssignment);
  if (!pairCheck.ok) throw new Error(`buildExaminerStudyManifest: pair assignment not verifiable — ${pairCheck.reason}`);
  if (!primaryEndpoint || HASH_RE.test(String(primaryEndpoint.definitionHash)) === false) {
    throw new Error('buildExaminerStudyManifest: a frozen Primary Endpoint (definePrimaryEndpoint) is mandatory — a study without exactly one primary endpoint cannot preregister');
  }

  const runtimeCore = { hostManifest, modelManifest, ...(runtimeManifest || {}) };
  const core = {
    schema: EXAMINER_MANIFEST_SCHEMA,
    studyId,
    targetPrinciple,
    experimentMode,
    interventionType: ruleCodePolicy.interventionType,
    hostManifestHash: hashOfCanonical(hostManifest),
    modelManifestHash: hashOfCanonical(modelManifest),
    principleSetSnapshotHash: heps.snapshotHash,
    ruleCodeSnapshotHash: ruleCodePolicy.ruleCodeSnapshotHash,
    runtimeManifestHash: hashOfCanonical(runtimeCore),
    challengeSuiteHash,
    goldSnapshotHash,
    scorerVersion,
    primaryEndpoint: {
      id: primaryEndpoint.id,
      definitionHash: primaryEndpoint.definitionHash,
      applicabilityRuleHash: primaryEndpoint.applicabilityRuleHash,
    },
    secondaryEndpoints,
    negativeTransferMetrics,
    operationalCostMetrics,
    randomizationSeed: pairAssignment.seed,
    plannedPairs: pairAssignment.pairs.length,
    repetitionsPerCase: pairAssignment.pairs.length / Math.max(1, new Set(pairAssignment.pairs.map((p) => p.caseId)).size),
    pairAssignmentHash: pairAssignment.assignmentHash,
    ...(armPayloadHashes ? { armPayloadHashes } : {}),
    analysisPlanHash: hashOfCanonical(analysisPlan),
    invalidationPolicyHash: hashOfCanonical(invalidationPolicy),
    authorizationRef,
  };
  return { ...core, manifestHash: hashOfCanonical(core) };
}

export function verifyExaminerManifest(manifest) {
  const problems = [];
  if (!manifest || manifest.schema !== EXAMINER_MANIFEST_SCHEMA) problems.push(`schema must be ${EXAMINER_MANIFEST_SCHEMA}`);
  if (manifest && manifest.manifestHash !== undefined) {
    const { manifestHash, ...core } = manifest;
    if (!HASH_RE.test(String(manifestHash)) || hashOfCanonical(core) !== manifestHash) problems.push('manifestHash mismatch — the study manifest was modified after freezing');
  } else if (manifest) {
    problems.push('manifestHash missing');
  }
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// §2 dual-mode arm payload construction (offline deterministic rendering)
// ---------------------------------------------------------------------------

/** Deterministic single-principle directive rendering (the payload line format). */
export function renderPrincipleDirective(principle) {
  return `<principle id="${principle.id}" version="${principle.version}">${principle.text}</principle>`;
}

/**
 * Render an ordered principle set under the frozen char budget with the
 * deterministic FIFO-prefix policy (legacy_fifo_prefix_v1 semantics: fill in
 * order, first non-fitting item ends the fill — eviction, never truncation).
 * Returns { payloadText, delivered, evicted }.
 */
export function renderLibraryPayload({ orderedPrinciples, budgetChars }) {
  if (!Array.isArray(orderedPrinciples)) throw new Error('renderLibraryPayload: orderedPrinciples required');
  if (!Number.isInteger(budgetChars) || budgetChars <= 0) throw new Error('renderLibraryPayload: budgetChars must be a positive integer');
  const delivered = [];
  const evicted = [];
  for (const p of orderedPrinciples) {
    const candidate = delivered.length === 0 ? renderPrincipleDirective(p) : `${delivered.map(renderPrincipleDirective).join('\n')}\n${renderPrincipleDirective(p)}`;
    if (candidate.length <= budgetChars) delivered.push(p);
    else evicted.push(p);
  }
  return {
    payloadText: delivered.map(renderPrincipleDirective).join('\n'),
    delivered,
    evicted,
  };
}

/**
 * Build the v0.9 dual-mode CONTROL/TREATMENT payloads from the frozen HEPS +
 * target principle. This is the offline arm-configuration authority for
 * examiner studies (the runner's arm verification consumes its output shape):
 *
 *   isolated_principle       — control: EMPTY (all PD principles OFF),
 *                              treatment: the target principle only.
 *   full_library_incremental — control: HEPS minus target, treatment: HEPS
 *                              (target included), both under the SAME frozen
 *                              budget + selection policy; capacity evictions
 *                              are recorded per arm (§2.2.5) and can differ
 *                              between arms — that difference is the real
 *                              marginal effect of adding the target, kept.
 *
 * @param {object} heps — buildHostEffectivePrincipleSet output
 * @param {object} targetPrinciple — { id, version, text } (frozen)
 * @param {object} [options] — { budgetChars = 2000, ordering = 'id-asc' }
 */
export function buildDualModeArmPayloads({ mode, heps, targetPrinciple, budgetChars = 2000, ordering = 'id-asc' }) {
  assertMode(mode);
  if (!heps || !Array.isArray(heps.baseLibrary)) throw new Error('buildDualModeArmPayloads: heps (buildHostEffectivePrincipleSet output) required');
  if (!targetPrinciple || !text(targetPrinciple.id) || !text(targetPrinciple.version) || !text(targetPrinciple.text)) {
    throw new Error('buildDualModeArmPayloads: targetPrinciple {id, version, text} required');
  }
  const withHash = (p) => ({ ...p, contentHash: p.contentHash || hashOfCanonical({ id: p.id, version: p.version, text: p.text }) });
  const target = withHash(targetPrinciple);
  const orderBy = (list) => (ordering === 'id-asc'
    ? list.slice().sort((a, b) => (a.id < b.id ? -1 : 1))
    : list.slice().sort((a, b) => ((b.priority ?? 0) - (a.priority ?? 0)) || (a.id < b.id ? -1 : 1)));
  const baseLibrary = heps.baseLibrary.map(withHash);

  let control;
  let treatment;
  let controlCapacity = null;
  let treatmentCapacity = null;
  if (mode === 'isolated_principle') {
    // §2.1: control = NOTHING PD-managed; treatment = the target ONLY.
    control = { payloadText: '', delivered: [], evicted: [] };
    treatment = renderLibraryPayload({ orderedPrinciples: [target], budgetChars });
  } else {
    // §2.2: non-target set frozen in BOTH arms; the target is the only
    // difference. Evictions under the shared budget are recorded per arm.
    control = renderLibraryPayload({ orderedPrinciples: orderBy(baseLibrary), budgetChars });
    treatment = renderLibraryPayload({ orderedPrinciples: orderBy([...baseLibrary, target]), budgetChars });
    controlCapacity = recordCapacityCompetition({ eligible: baseLibrary, delivered: control.delivered, budgetChars, policy: `examiner-offline:${ordering}`, targetPrincipleId: target.id });
    controlCapacity.armId = 'A';
    treatmentCapacity = recordCapacityCompetition({ eligible: [...baseLibrary, target], delivered: treatment.delivered, budgetChars, policy: `examiner-offline:${ordering}`, targetPrincipleId: target.id });
    treatmentCapacity.armId = 'B';
  }
  if (treatment.evicted.some((p) => p.id === target.id)) {
    throw new Error(`buildDualModeArmPayloads: the target principle does not fit the budget (${budgetChars} chars) — the treatment arm cannot exist without its intervention; raise the budget or shrink the library`);
  }
  const targetText = targetPrinciple.text;
  const isolationAudit = {
    controlContainsTarget: control.payloadText.includes(targetText),
    treatmentContainsTarget: treatment.payloadText.includes(targetText),
    controlPayloadEmpty: control.payloadText === '',
    problems: [],
  };
  if (isolationAudit.controlContainsTarget) isolationAudit.problems.push('control payload contains the target principle text — treatment leak into control');
  if (!isolationAudit.treatmentContainsTarget) isolationAudit.problems.push('treatment payload lost the target principle text');
  if (mode === 'isolated_principle' && !isolationAudit.controlPayloadEmpty) isolationAudit.problems.push('isolated mode control payload must be EMPTY (all PD principles OFF)');
  isolationAudit.ok = isolationAudit.problems.length === 0;
  return {
    schema: 'examiner-arm-payloads.v1',
    mode,
    budgetChars,
    ordering,
    arms: {
      control: { payloadText: control.payloadText, payloadHash: sha256(control.payloadText), deliveredIds: control.delivered.map((p) => p.id), contentMode: mode === 'isolated_principle' ? 'none' : 'library' },
      treatment: { payloadText: treatment.payloadText, payloadHash: sha256(treatment.payloadText), deliveredIds: treatment.delivered.map((p) => p.id), contentMode: mode === 'isolated_principle' ? 'policy' : 'library' },
    },
    capacity: { control: controlCapacity, treatment: treatmentCapacity },
    isolationAudit,
  };
}

// ---------------------------------------------------------------------------
// Study materialization (the ONE creation path for tests/acceptance/Console)
// ---------------------------------------------------------------------------

/**
 * Materialize a new examiner study directory from assembled inputs. Refuses
 * to touch an existing directory (a study identity is created once —
 * overwriting is exactly the historical-asset mutation this refuses) and
 * refuses directories inside the frozen studies area. Compiles the case
 * suite (v3 judge-only + actor-visible) from the supplied caseDefs and writes
 * the v0.9 layer on top of the SAME freeze layout the runner and Report V2
 * already consume.
 *
 * @param {object} input
 *   studyDir, hepsPrinciples { principles, targetPrincipleId, host },
 *   ruleCodeFacts { ruleCodes, principleRuleCodeIndependence },
 *   caseDefs (judge-side v3 case definitions), principleFrozen, mapping,
 *   experimentMode, primaryEndpointId, seed, repetitionsPerCase,
 *   goldProvenance ('SYNTHETIC_OFFLINE' | 'INDEPENDENT_REVIEW_APPROVED' | ...),
 *   commonContextText, budgetChars, ordering, hostManifest, modelManifest,
 *   scorerVersion, analysisPlan, invalidationPolicy, secondaryEndpoints, ...
 */
export function writeExaminerStudyArtifacts(input) {
  const {
    studyDir, hepsPrinciples, ruleCodeFacts, caseDefs,
    principleFrozen, mapping, commonContextText, budgetChars = 2000, ordering = 'id-asc',
    secondaryEndpoints = [], negativeTransferMetrics = [], operationalCostMetrics = [],
    analysisPlan, invalidationPolicy, hostManifest, modelManifest,
    scorerVersion, seed, repetitionsPerCase, authorizationRef = null,
    goldProvenance = 'SYNTHETIC_OFFLINE',
  } = input;
  if (!studyDir || typeof studyDir !== 'string') throw new Error('writeExaminerStudyArtifacts: studyDir required');
  if (fs.existsSync(studyDir)) throw new Error(`writeExaminerStudyArtifacts: '${studyDir}' already exists — a study identity is created once; overwriting is refused (create a NEW study id instead)`);
  const frozenArea = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'challenge-studies');
  const resolved = path.resolve(studyDir);
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  if (norm(resolved) === norm(frozenArea) || norm(resolved).startsWith(`${norm(frozenArea)}${path.sep}`)) {
    throw new Error(`writeExaminerStudyArtifacts: refusing to create a study inside the frozen studies area: ${resolved}`);
  }
  const targetFact = hepsPrinciples.principles.find((p) => p.id === hepsPrinciples.targetPrincipleId);
  if (!targetFact) throw new Error('writeExaminerStudyArtifacts: target principle not present in hepsPrinciples.principles');

  const heps = buildHostEffectivePrincipleSet({ principles: hepsPrinciples.principles, targetPrincipleId: hepsPrinciples.targetPrincipleId, host: hepsPrinciples.host });
  const ruleCodePolicy = buildRuleCodePolicy({ mode: input.experimentMode, ruleCodes: ruleCodeFacts.ruleCodes, targetPrincipleId: hepsPrinciples.targetPrincipleId, principleRuleCodeIndependence: ruleCodeFacts.principleRuleCodeIndependence });
  const armPayloads = buildDualModeArmPayloads({ mode: input.experimentMode, heps, targetPrinciple: targetFact, budgetChars, ordering });
  if (!armPayloads.isolationAudit.ok) throw new Error(`writeExaminerStudyArtifacts: arm isolation audit failed: ${armPayloads.isolationAudit.problems.join('; ')}`);
  const primaryEndpoint = definePrimaryEndpoint({ id: input.primaryEndpointId });
  const pairAssignment = assignPairs({ cases: caseDefs.map((c) => c.caseId), repetitionsPerCase, seed });
  // Compile the suite from the SAME freeze chain the runner/report verify:
  // v3 scoring contract binding the current implementation manifest.
  const scoringContract = { schema: 'claim-evidence-scoring.v3', implementation: challengeImplementationManifest() };
  const graderHash = hashOfCanonical(scoringContract);
  const { manifest: suiteManifest } = compileSuite({ studyId: input.studyId, mappingHash: mapping.mappingHash, graderHash, caseDefs });
  const goldSnapshotHash = hashOfCanonical({
    provenance: goldProvenance,
    caseGold: caseDefs.map((cd) => ({ caseId: cd.caseId, goldHash: compileCase(cd).goldHash })),
  });
  const manifest = buildExaminerStudyManifest({
    studyId: input.studyId,
    targetPrinciple: { id: targetFact.id, version: targetFact.version, contentHash: hashOfCanonical({ id: targetFact.id, version: targetFact.version, text: targetFact.text }) },
    experimentMode: input.experimentMode,
    heps,
    ruleCodePolicy,
    hostManifest,
    modelManifest,
    challengeSuiteHash: suiteManifest.suiteHash,
    goldSnapshotHash,
    scorerVersion,
    primaryEndpoint,
    secondaryEndpoints,
    negativeTransferMetrics,
    operationalCostMetrics,
    pairAssignment,
    analysisPlan,
    invalidationPolicy,
    armPayloadHashes: { control: armPayloads.arms.control.payloadHash, treatment: armPayloads.arms.treatment.payloadHash },
    authorizationRef,
  });
  const prereg = {
    studyId: input.studyId,
    schema: 'challenge-preregistration.v1',
    status: 'FROZEN',
    arms: [{ armId: 'A', name: 'EXAMINER_CONTROL', contentMode: armPayloads.arms.control.contentMode }, { armId: 'B', name: 'EXAMINER_TREATMENT', contentMode: armPayloads.arms.treatment.contentMode }],
    controlArm: 'A',
    treatmentArm: 'B',
    repetitions: { planned: repetitionsPerCase },
    commonContext: { text: commonContextText },
    delivery: { budgetChars },
    examiner: { manifestHash: manifest.manifestHash, pairAssignmentHash: pairAssignment.assignmentHash },
  };
  fs.mkdirSync(path.join(studyDir, 'judge-only'), { recursive: true });
  fs.mkdirSync(path.join(studyDir, 'actor-visible'), { recursive: true });
  const writeJson = (rel, value) => fs.writeFileSync(path.join(studyDir, rel), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  for (const cd of caseDefs) {
    const compiled = compileCase(cd);
    writeJson(path.join('judge-only', `${cd.caseId}.json`), compiled.judgeOnly);
    writeJson(path.join('actor-visible', `${cd.caseId}.json`), compiled.actorVisible);
  }
  writeJson('examiner-manifest.json', manifest);
  writeJson('heps-principles.json', hepsPrinciples);
  writeJson('rulecode-baseline.json', { ruleCodes: ruleCodeFacts.ruleCodes, principleRuleCodeIndependence: ruleCodeFacts.principleRuleCodeIndependence });
  writeJson('examiner-arm-configs.json', armPayloads);
  writeJson('pair-assignment.json', pairAssignment);
  writeJson('preregistration.json', prereg);
  writeJson('suite-manifest.json', suiteManifest);
  writeJson('scoring-contract.json', scoringContract);
  writeJson('principle-frozen.json', principleFrozen);
  writeJson('pain-mechanism-mapping.json', mapping);
  writeJson('input-manifest.json', { expectedSourceHashes: { principleContentHash: hashOfCanonical(principleFrozen.contentJson) } });
  writeJson('hashes.json', {
    preregistrationHash: { value: hashOfCanonical(prereg) },
    suiteHash: { value: suiteManifest.suiteHash },
    mappingHash: { value: mapping.mappingHash },
    graderHash: { value: graderHash },
    principleContentHash: { value: hashOfCanonical(principleFrozen.contentJson) },
    examinerManifestHash: { value: manifest.manifestHash },
    pairAssignmentHash: { value: pairAssignment.assignmentHash },
  });
  return { studyDir, manifest, pairAssignment, heps, ruleCodePolicy, armPayloads, suiteManifest };
}

/**
 * Fail-closed preflight over the assembled study facts. Returns a check list
 * with severities; `ok` requires zero blockers. PURE — no IO, no writes.
 *
 * @param {object} input
 *   manifest, heps, ruleCodePolicy, pairAssignment, primaryEndpoint (objects)
 *   armConfigs — the frozen arm configs (A/B from buildStudyArms)
 *   isolation — { sessionPerArm: bool, workspacePerArm: bool }
 *   goldStatus — 'INDEPENDENT_REVIEW_APPROVED' | 'REVIEW_PENDING' | 'SYNTHETIC_OFFLINE'
 *   injectionCapability — { host, maxProvableLevel, minimumRequiredLevel }
 *   authorization — { mode: 'offline-stub'|'real', record?: object }
 *   studyDirStatus — { insideFrozenArea: bool, collidesWithHistorical: bool }
 */
export function runExaminerPreflight(input) {
  const checks = [];
  const check = (id, severity, ok, detail) => checks.push({ id, severity, ok: ok === true, detail });
  const { manifest, heps, ruleCodePolicy, pairAssignment, primaryEndpoint, armConfigs, isolation, goldStatus, injectionCapability, authorization, studyDirStatus } = input || {};

  const manifestCheck = verifyExaminerManifest(manifest);
  check('manifest_verifiable', 'blocker', manifestCheck.ok, manifestCheck.ok ? 'manifest hash verified' : (manifestCheck.problems || ['no manifest']).join('; '));
  const hepsCheck = verifyHostEffectivePrincipleSet(heps);
  check('heps_snapshot_verified', 'blocker', hepsCheck.ok, hepsCheck.ok ? `HEPS snapshot ${heps.snapshotHash.slice(0, 12)}… verified (${heps.baseLibrary.length} non-target principles, ${heps.excluded.length} excluded)` : hepsCheck.reason);
  if (heps) {
    check('target_principle_eligible', 'blocker', heps.target && heps.target.qualifies === true,
      heps.target && heps.target.qualifies ? `target '${heps.target.id}' qualifies for host-effective status` : `target Principle is not host-effective (${heps.target ? heps.target.exclusionReason : 'missing'}) — an ineligible intervention cannot be studied`);
  }
  const rcCheck = verifyRuleCodePolicy(ruleCodePolicy);
  check('rulecode_policy_verified', 'blocker', rcCheck.ok, rcCheck.ok ? `RuleCode policy ${ruleCodePolicy.policy} verified (interventionType=${ruleCodePolicy.interventionType})` : rcCheck.reason);
  if (ruleCodePolicy) {
    check('rulecode_policy_executable', 'blocker', ruleCodePolicy.executable !== false,
      ruleCodePolicy.executable !== false ? 'RuleCode policy executable under current controllability facts' : `not executable: ${ruleCodePolicy.couplingReason}`);
    check('bundled_intervention_declared', ruleCodePolicy.interventionType === 'bundled_intervention' ? 'warning' : 'info', true,
      ruleCodePolicy.interventionType === 'bundled_intervention'
        ? `BUNDLED intervention declared — conclusions may only attribute to the Principle+RuleCode bundle (${ruleCodePolicy.couplingReason})`
        : 'principle_only intervention — the target Principle is the only treatment variable');
  }
  const pairCheck = verifyPairAssignment(pairAssignment);
  check('pair_assignment_verified', 'blocker', pairCheck.ok, pairCheck.ok ? `${pairAssignment.pairs.length} pairs, balanced ${pairAssignment.balance.controlFirst}/${pairAssignment.balance.treatmentFirst}, seed frozen` : pairCheck.reason);

  // A/B contrast: the arms may differ ONLY in the target principle. In
  // isolated mode that is empty-vs-target; in full-library mode BOTH carry
  // the frozen non-target library, so the contrast is target-absent-in-A vs
  // target-present-in-B (requires the target text for a content-level check).
  if (armConfigs && armConfigs.arms) {
    const a = armConfigs.arms.A;
    const b = armConfigs.arms.B;
    const targetText = input && text(input.targetPrincipleText) ? input.targetPrincipleText : null;
    let contrastOk = false;
    let detail = '';
    if (targetText) {
      contrastOk = Boolean(a && b && !String(a.delivery.payloadText).includes(targetText) && String(b.delivery.payloadText).includes(targetText));
      detail = contrastOk ? 'arm A/B contrast is exactly the target Principle (absent in control, present in treatment)' : 'arm A/B payloads do not form a clean OFF/ON contrast on the target variable';
    } else {
      contrastOk = Boolean(a && b && (a.delivery.payloadText === '') !== (b.delivery.payloadText === ''));
      detail = contrastOk ? 'arm A/B contrast is exactly the target Principle payload (emptiness contrast)' : 'arm A/B payloads do not form a clean OFF/ON contrast — supply targetPrincipleText for full-library content-level contrast checking';
    }
    check('ab_contrast_only_target', 'blocker', contrastOk, detail);
  } else {
    check('ab_contrast_only_target', 'blocker', false, 'arm configs missing');
  }
  check('isolation_sessions', 'blocker', isolation ? isolation.sessionPerArm === true : false,
    isolation && isolation.sessionPerArm ? 'one session per arm per unit' : 'per-arm session isolation not established — cross-arm memory contamination risk');
  check('isolation_workspaces', 'blocker', isolation ? isolation.workspacePerArm === true : false,
    isolation && isolation.workspacePerArm ? 'one workspace per arm per unit' : 'per-arm workspace isolation not established');

  if (goldStatus === 'INDEPENDENT_REVIEW_APPROVED') {
    check('gold_state', 'info', true, 'independent human Gold review APPROVED (Gate 1 satisfied for this suite)');
  } else if (goldStatus === 'SYNTHETIC_OFFLINE') {
    check('gold_state', 'warning', true, 'SYNTHETIC offline Gold — offline contract validation ONLY; any report must be labelled offline-stub and can never support a real-host behavior claim');
  } else {
    check('gold_state', 'blocker', false, `Gold review state '${String(goldStatus)}' — Gate 1 (independent human review) is not satisfied`);
  }

  const LEVELS = ['CONFIGURED', 'SELECTED', 'SUBMITTED', 'HOST_ACCEPTED', 'CONTEXT_PRESENT', 'RUNTIME_LOADED'];
  if (injectionCapability && LEVELS.includes(injectionCapability.maxProvableLevel)) {
    const sufficient = LEVELS.indexOf(injectionCapability.maxProvableLevel) >= LEVELS.indexOf(injectionCapability.minimumRequiredLevel || 'CONTEXT_PRESENT');
    check('injection_capability', injectionCapability.host === 'offline-stub' ? 'info' : (sufficient ? 'info' : 'warning'), true,
      `host '${injectionCapability.host}' can prove injection up to ${injectionCapability.maxProvableLevel} (required for full behavior conclusions: ${injectionCapability.minimumRequiredLevel || 'CONTEXT_PRESENT'})`
      + (sufficient ? '' : ' — below CONTEXT_PRESENT the study may complete contract-wise but cannot claim verified behavioral intervention'));
  } else {
    check('injection_capability', 'blocker', false, 'host injection capability undeclared — every host must declare its max provable evidence level');
  }

  if (authorization && authorization.mode === 'offline-stub') {
    check('authorization', 'info', true, 'offline-stub execution — real model/host authorization not applicable this round (Real Model Calls = 0)');
  } else if (authorization && authorization.mode !== 'offline-stub') {
    check('authorization', 'blocker', false, 'real-mode execution requires an explicit Owner authorization record (run-authorization.json) — NOT GRANTED this round');
  } else {
    check('authorization', 'blocker', false, 'authorization state missing');
  }
  if (studyDirStatus) {
    check('study_dir_protection', 'blocker', studyDirStatus.insideFrozenArea !== true && studyDirStatus.collidesWithHistorical !== true,
      studyDirStatus.insideFrozenArea ? 'study directory would write into the frozen historical studies area — refused'
        : studyDirStatus.collidesWithHistorical ? 'study ID collides with a historical study — a new study must be a new identity, never an overwrite' : 'study directory outside frozen areas, no historical collision');
  }
  if (primaryEndpoint) {
    check('primary_endpoint_frozen', 'blocker', HASH_RE.test(String(primaryEndpoint.definitionHash)),
      `primary endpoint '${primaryEndpoint.id}' frozen (definitionHash ${String(primaryEndpoint.definitionHash).slice(0, 12)}…)`);
  } else {
    check('primary_endpoint_frozen', 'blocker', false, 'primary endpoint missing');
  }

  const blockers = checks.filter((c) => !c.ok && c.severity === 'blocker');
  const warnings = checks.filter((c) => !c.ok && c.severity === 'warning');
  return {
    ok: blockers.length === 0,
    status: blockers.length === 0 ? 'READY_FOR_OFFLINE_EXECUTION' : 'BLOCKED',
    blockers,
    warnings,
    checks,
  };
}
