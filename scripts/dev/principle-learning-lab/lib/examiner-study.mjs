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
import { hashOfCanonical, sha256, challengeImplementationManifest, verifyCanonicalHash } from './challenge-freeze.mjs';
import { compileCase, compileSuite } from './challenge-compile.mjs';
import { recordCapacityCompetition } from './examiner-injection-evidence.mjs';
import { createChallengeLedger } from './challenge-ledger.mjs';

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
 * @param {number} [targetRuleCodeCount] — how many RuleCodes the workspace
 *   attributes to the target Principle. When it exceeds the resolved entries
 *   the baseline is UNRESOLVED and no intervention claim can be made.
 * @param {boolean} [principleRuleCodeIndependence] — CAN the system toggle the
 *   target Principle's prompt injection while holding its RuleCode at
 *   baseline? NO DEFAULT: an omitted value is missing evidence, never an
 *   implicit 'yes'. When the target has RuleCodes and independence is not
 *   proven, the intervention is NOT IDENTIFIABLE (a `principle_only` label
 *   would be a false claim, and a bundle nobody can deliver is not a bundle).
 */
export function buildRuleCodePolicy({ mode, ruleCodes = [], targetPrincipleId, principleRuleCodeIndependence, targetRuleCodeCount = null }) {
  assertMode(mode);
  if (!text(targetPrincipleId)) throw new Error('buildRuleCodePolicy: targetPrincipleId required');
  for (const rc of ruleCodes) {
    if (!text(rc.ruleCodeId) || !text(rc.principleId) || !['ON', 'OFF'].includes(rc.baselineState)) {
      throw new Error(`buildRuleCodePolicy: ruleCode ${JSON.stringify(rc && rc.ruleCodeId)} needs ruleCodeId/principleId/baselineState(ON|OFF)`);
    }
  }
  if (targetRuleCodeCount !== null && (!Number.isInteger(targetRuleCodeCount) || targetRuleCodeCount < 0)) {
    throw new Error('buildRuleCodePolicy: targetRuleCodeCount must be a non-negative integer when supplied');
  }
  const targetRuleCodes = ruleCodes.filter((rc) => rc.principleId === targetPrincipleId);
  const targetBaselineOn = targetRuleCodes.filter((rc) => rc.baselineState === 'ON');
  const declaredTargetRuleCodeCount = targetRuleCodeCount === null ? targetRuleCodes.length : targetRuleCodeCount;
  const unresolvedTargetRuleCodes = declaredTargetRuleCodeCount - targetRuleCodes.length;
  const baseline = Object.fromEntries(ruleCodes.map((rc) => [rc.ruleCodeId, rc.baselineState]).sort(([a], [b]) => (a < b ? -1 : 1)));

  let interventionType = 'principle_only';
  let couplingReason = null;
  let executable = true;
  let identifiability = 'IDENTIFIABLE';
  let unresolvedEvidence = [];
  if (declaredTargetRuleCodeCount > 0) {
    if (unresolvedTargetRuleCodes !== 0) {
      interventionType = 'bundled_intervention';
      identifiability = 'INTERVENTION_NOT_IDENTIFIABLE';
      executable = false;
      unresolvedEvidence = ['target RuleCode baseline state'];
      couplingReason = `the workspace attributes ${declaredTargetRuleCodeCount} RuleCode(s) to the target Principle but only ${targetRuleCodes.length} were resolved — the RuleCode baseline is UNKNOWN, so neither principle_only nor a delivered bundle can be claimed`;
    } else if (principleRuleCodeIndependence !== true && principleRuleCodeIndependence !== false) {
      interventionType = 'bundled_intervention';
      identifiability = 'INTERVENTION_NOT_IDENTIFIABLE';
      executable = false;
      unresolvedEvidence = ['Principle/RuleCode independence'];
      couplingReason = `independence evidence is missing (${principleRuleCodeIndependence === undefined ? 'not supplied' : JSON.stringify(principleRuleCodeIndependence)}) for the target's RuleCode (${targetRuleCodes.map((rc) => rc.ruleCodeId).join(', ')}) — independent control is UNKNOWN, never assumed`;
    } else if (principleRuleCodeIndependence === false) {
      interventionType = 'bundled_intervention';
      identifiability = 'INTERVENTION_NOT_IDENTIFIABLE';
      executable = false;
      couplingReason = `target Principle and its RuleCode (${targetRuleCodes.map((rc) => rc.ruleCodeId).join(', ')}) cannot be controlled independently; a bundled intervention is only real when the two arm configs actually switch the bundle together, and the frozen payload arms cannot — INTERVENTION_NOT_IDENTIFIABLE`;
    }
  }

  let control;
  let treatment;
  if (mode === 'isolated_principle') {
    // §2.1: EVERY PD RuleCode is OFF in BOTH arms — including the target's.
    control = { targetPrinciple: 'OFF', targetRuleCode: 'OFF', otherRuleCodes: 'ALL_OFF' };
    treatment = { targetPrinciple: 'ON', targetRuleCode: 'OFF', otherRuleCodes: 'ALL_OFF' };
  } else {
    // §2.2.3: every RuleCode keeps its CURRENT BASELINE state in both arms —
    // a baseline-ON target RuleCode must NOT be switched off for the study.
    control = { targetPrinciple: 'OFF', targetRuleCode: targetBaselineOn.length > 0 ? 'BASELINE_ON' : 'BASELINE_OFF', otherRuleCodes: 'BASELINE_FROZEN' };
    treatment = { ...control, targetPrinciple: 'ON' };
  }
  const snapshot = {
    mode,
    policy: mode === 'isolated_principle' ? 'ALL_OFF_BOTH_ARMS' : 'BASELINE_FROZEN_BOTH_ARMS',
    baseline,
    targetRuleCodes: targetRuleCodes.map((rc) => ({ ruleCodeId: rc.ruleCodeId, baselineState: rc.baselineState })).sort((a, b) => (a.ruleCodeId < b.ruleCodeId ? -1 : 1)),
    declaredTargetRuleCodeCount,
    principleRuleCodeIndependence: principleRuleCodeIndependence === true ? true : principleRuleCodeIndependence === false ? false : null,
    interventionType,
    identifiability,
    unresolvedEvidence,
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
  const problems = [];
  if (!INTERVENTION_TYPES.includes(policy.interventionType)) problems.push(`interventionType '${String(policy.interventionType)}' unsupported`);
  const expectedIdentifiability = policy.executable === false ? 'INTERVENTION_NOT_IDENTIFIABLE' : 'IDENTIFIABLE';
  if (policy.identifiability !== expectedIdentifiability) {
    problems.push(`identifiability '${String(policy.identifiability)}' contradicts executable=${String(policy.executable)}`);
  }
  if (policy.interventionType === 'bundled_intervention' && policy.executable === true) {
    problems.push('bundled_intervention declared as executable without verifiable coupled arm configs — relabelling the report is not implementing the bundle');
  }
  if (Number(policy.declaredTargetRuleCodeCount) > 0 && typeof policy.principleRuleCodeIndependence !== 'boolean') {
    problems.push('target RuleCodes exist but independence evidence is missing — independent control is UNKNOWN, not assumed');
  }
  if (policy.interventionType === 'principle_only' && policy.executable === false) {
    problems.push('principle_only cannot be declared non-executable — a coupled intervention must be labelled bundled/not-identifiable');
  }
  return problems.length === 0 ? { ok: true } : { ok: false, reason: problems.join('; ') };
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
// §4.1 cross-file preregistration binding + immutable anchor
// ---------------------------------------------------------------------------
//
// Every frozen study file only proves ITSELF (a recomputed manifestHash says
// nothing about pair-assignment.json). Preflight/runner/report each rebuilt a
// subset from different inputs, so a file that was edited in a mutually
// consistent way (e.g. heps-principles.json + arm configs) could pass every
// single-file check while the preregistered facts no longer agreed. The
// binding below re-derives EVERY link from the files on disk and records the
// resulting bundle hash once, at creation time, as an append-only ledger
// anchor: after that, rewriting the frozen files cannot move the anchor.

export const PREREG_BINDING_SCHEMA = 'examiner-study-bindings.v1';
export const PREREG_ANCHOR_SCHEMA = 'examiner-preregistration-anchor.v1';
export const PREREGISTRATION_ANCHOR_EVENT = 'PREREGISTRATION_FROZEN';

function readBindingsJson(studyDir, rel) {
  const root = path.resolve(studyDir);
  const file = path.resolve(root, rel);
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  if (norm(file) !== norm(root) && !norm(file).startsWith(`${norm(root)}${path.sep}`)) {
    throw new Error(`study file '${rel}' escapes the study directory`);
  }
  if (!fs.existsSync(file)) throw new Error(`study file '${rel}' missing`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const setOf = (values) => new Set(values.map(String));

/**
 * Recompute the complete preregistration picture from the files on disk:
 * manifest ↔ preregistration ↔ pair assignment ↔ HEPS ↔ RuleCode baseline ↔
 * arm configs ↔ suite ↔ mapping ↔ scoring contract ↔ hashes.json. PURE with
 * respect to the study (reads only; writes nothing).
 *
 * @returns { ok, problems[], binding, bindingHash }
 */
export function computeExaminerStudyBindings(studyDir) {
  const problems = [];
  const push = (detail) => problems.push(detail);
  let files;
  try {
    files = {
      manifest: readBindingsJson(studyDir, 'examiner-manifest.json'),
      prereg: readBindingsJson(studyDir, 'preregistration.json'),
      pair: readBindingsJson(studyDir, 'pair-assignment.json'),
      hepsInput: readBindingsJson(studyDir, 'heps-principles.json'),
      rulecode: readBindingsJson(studyDir, 'rulecode-baseline.json'),
      arms: readBindingsJson(studyDir, 'examiner-arm-configs.json'),
      suite: readBindingsJson(studyDir, 'suite-manifest.json'),
      mapping: readBindingsJson(studyDir, 'pain-mechanism-mapping.json'),
      scoring: readBindingsJson(studyDir, 'scoring-contract.json'),
      principle: readBindingsJson(studyDir, 'principle-frozen.json'),
      inputManifest: readBindingsJson(studyDir, 'input-manifest.json'),
      hashes: readBindingsJson(studyDir, 'hashes.json'),
    };
  } catch (e) {
    return { ok: false, problems: [e.message], binding: null, bindingHash: null };
  }
  const { manifest, prereg, pair, hepsInput, rulecode, arms, suite, mapping, scoring, principle, inputManifest, hashes } = files;

  const manifestCheck = verifyExaminerManifest(manifest);
  if (!manifestCheck.ok) push(`manifest: ${manifestCheck.problems.join('; ')}`);

  // --- preregistration ↔ manifest -----------------------------------------
  if (prereg.schema !== 'challenge-preregistration.v1') push(`preregistration schema '${String(prereg.schema)}' unsupported`);
  if (prereg.status !== 'FROZEN') push(`preregistration status '${String(prereg.status)}' is not FROZEN`);
  if (prereg.studyId !== manifest.studyId) push(`preregistration studyId '${String(prereg.studyId)}' != manifest '${String(manifest.studyId)}'`);
  const examiner = prereg.examiner || {};
  if (examiner.manifestHash !== manifest.manifestHash) push('preregistration.examiner.manifestHash != manifest.manifestHash');
  if (examiner.pairAssignmentHash !== pair.assignmentHash) push('preregistration.examiner.pairAssignmentHash != pair-assignment.assignmentHash');
  if (prereg.controlArm !== 'A' || prereg.treatmentArm !== 'B') push('preregistration control/treatment arm must be A/B');
  if (!Number.isInteger(prereg.repetitions?.planned) || prereg.repetitions.planned !== manifest.repetitionsPerCase) {
    push(`preregistration.repetitions.planned '${String(prereg.repetitions?.planned)}' != manifest.repetitionsPerCase '${String(manifest.repetitionsPerCase)}'`);
  }
  const preregistrationHash = hashOfCanonical(prereg);
  if (hashes.preregistrationHash?.value !== preregistrationHash) push('hashes.preregistrationHash != recomputed preregistration hash');

  // --- pair assignment ↔ manifest ↔ suite ----------------------------------
  const pairCheck = verifyPairAssignment(pair);
  if (!pairCheck.ok) push(`pair assignment: ${pairCheck.reason}`);
  if (pair.assignmentHash !== manifest.pairAssignmentHash) push('pair assignment hash != manifest.pairAssignmentHash');
  if (pair.seed !== manifest.randomizationSeed) push(`pair assignment seed '${String(pair.seed)}' != manifest randomizationSeed '${String(manifest.randomizationSeed)}'`);
  if (!Array.isArray(pair.pairs) || pair.pairs.length !== manifest.plannedPairs) {
    push(`pair assignment plannedPairs '${String(pair.pairs?.length)}' != manifest.plannedPairs '${String(manifest.plannedPairs)}'`);
  }
  const suiteCases = Array.isArray(suite.cases) ? suite.cases.map((c) => c.caseId) : [];
  const pairCases = Array.isArray(pair.pairs) ? [...setOf(pair.pairs.map((p) => p.caseId))] : [];
  if (pairCases.length !== suiteCases.length || pairCases.some((id) => !suiteCases.includes(id))) {
    push('pair assignment cases do not cover the frozen suite cases exactly');
  }
  if (Array.isArray(pair.unitOrder)) {
    const expectedUnits = new Set();
    for (const p of pair.pairs || []) {
      for (const armId of ['A', 'B']) expectedUnits.add(`${p.caseId}/${armId}/r${String(p.repetitionId)}`);
    }
    const orderUnits = pair.unitOrder.map((u) => `${u.caseId}/${u.armId}/r${String(u.repetitionId)}`);
    if (orderUnits.length !== expectedUnits.size || orderUnits.some((k) => !expectedUnits.has(k))) {
      push('pair assignment unitOrder does not cover the planned unit set exactly');
    }
  } else {
    push('pair assignment unitOrder missing — the frozen dispatch order is required');
  }

  // --- suite ↔ scoring ↔ mapping ↔ principle ------------------------------
  const suiteCheck = verifyCanonicalHash(suite, suite.suiteHash, { stripFields: ['suiteHash'] });
  if (!suiteCheck.ok) push('suite-manifest suiteHash drift');
  if (suite.suiteHash !== manifest.challengeSuiteHash) push('suite hash != manifest.challengeSuiteHash');
  if (hashes.suiteHash?.value !== suite.suiteHash) push('hashes.suiteHash != suite-manifest.suiteHash');
  const graderHash = hashOfCanonical(scoring);
  if (hashes.graderHash?.value !== graderHash) push('hashes.graderHash != recomputed scoring contract hash');
  if (suite.graderHash !== graderHash) push('suite manifest graderHash != scoring contract hash');
  if (hashOfCanonical(scoring.implementation) !== hashOfCanonical(challengeImplementationManifest())) {
    push('scoring-contract implementation manifest drifted from the current lab implementation');
  }
  if (!verifyCanonicalHash(mapping, mapping.mappingHash, { stripFields: ['mappingHash'] }).ok) push('mappingHash drift');
  const principleContentHash = hashOfCanonical(principle.contentJson);
  if (inputManifest.expectedSourceHashes?.principleContentHash !== principleContentHash) push('principle content hash != input-manifest expectation');
  if (mapping.principleContentHash !== principleContentHash) push('mapping.principleContentHash != principle content hash');
  if (hashes.principleContentHash?.value !== principleContentHash) push('hashes.principleContentHash != principle content hash');
  const targetContentFact = (hepsInput.principles || []).find((p) => p.id === hepsInput.targetPrincipleId);
  if (targetContentFact && manifest.targetPrinciple?.contentHash !== hashOfCanonical({ id: targetContentFact.id, version: targetContentFact.version, text: targetContentFact.text })) {
    push('manifest targetPrinciple.contentHash != the HEPS target principle content');
  }
  if (suite.mappingHash !== mapping.mappingHash) push('suite manifest mappingHash != mapping mappingHash');
  if (hashes.mappingHash?.value !== mapping.mappingHash) push('hashes.mappingHash != mapping mappingHash');

  // --- HEPS ↔ manifest ----------------------------------------------------
  let heps = null;
  let targetFact = null;
  try {
    heps = buildHostEffectivePrincipleSet({ principles: hepsInput.principles, targetPrincipleId: hepsInput.targetPrincipleId, host: hepsInput.host });
    const hepsCheck = verifyHostEffectivePrincipleSet(heps);
    if (!hepsCheck.ok) push(`HEPS snapshot: ${hepsCheck.reason}`);
    if (heps.snapshotHash !== manifest.principleSetSnapshotHash) push('HEPS snapshot hash != manifest principleSetSnapshotHash');
    targetFact = (hepsInput.principles || []).find((p) => p.id === hepsInput.targetPrincipleId) || null;
    if (!targetFact) push(`target principle '${String(hepsInput.targetPrincipleId)}' missing from heps-principles.json`);
    if (manifest.targetPrinciple?.id !== hepsInput.targetPrincipleId) push('manifest targetPrinciple.id != heps-principles targetPrincipleId');
  } catch (e) {
    push(`HEPS rebuild failed: ${e.message}`);
  }

  // --- RuleCode baseline ↔ manifest --------------------------------------
  if (rulecode.ruleCodes !== undefined) {
    try {
      const policy = buildRuleCodePolicy({
        mode: manifest.experimentMode,
        ruleCodes: rulecode.ruleCodes,
        targetPrincipleId: hepsInput.targetPrincipleId,
        principleRuleCodeIndependence: rulecode.principleRuleCodeIndependence,
        targetRuleCodeCount: rulecode.targetRuleCodeCount ?? null,
      });
      if (policy.ruleCodeSnapshotHash !== manifest.ruleCodeSnapshotHash) push('RuleCode policy snapshot hash != manifest ruleCodeSnapshotHash');
      if (policy.interventionType !== manifest.interventionType) push('RuleCode interventionType != manifest interventionType');
      if (policy.executable !== true || policy.identifiability !== 'IDENTIFIABLE') {
        push(`RuleCode intervention is not identifiable (${policy.identifiability}): ${policy.couplingReason || 'no reason recorded'}`);
      }
    } catch (e) {
      push(`RuleCode policy rebuild failed: ${e.message}`);
    }
  } else {
    push('rulecode-baseline.json missing ruleCodes');
  }

  // --- arm configs ↔ manifest ↔ prereg ------------------------------------
  let armPayloadHashes = null;
  if (heps && targetFact) {
    try {
      const budgetChars = Number.isInteger(arms.budgetChars) ? arms.budgetChars : null;
      if (budgetChars === null) push('examiner-arm-configs budgetChars must be an integer');
      if (prereg.delivery?.budgetChars !== budgetChars) push('preregistration.delivery.budgetChars != arm configs budgetChars');
      const rebuilt = buildDualModeArmPayloads({
        mode: manifest.experimentMode,
        heps,
        targetPrinciple: targetFact,
        principleFacts: hepsInput.principles,
        budgetChars,
        ordering: arms.ordering || 'id-asc',
      });
      if (!rebuilt.isolationAudit.ok) push(`arm isolation audit: ${rebuilt.isolationAudit.problems.join('; ')}`);
      for (const [side, armId] of [['control', 'A'], ['treatment', 'B']]) {
        const stored = arms.arms?.[side];
        if (!stored) { push(`arm config ${side} missing`); continue; }
        if (stored.payloadHash !== rebuilt.arms[side].payloadHash) push(`arm ${armId} payloadHash != rebuilt dual-mode payload`);
        if (typeof stored.payloadText === 'string' && sha256(stored.payloadText) !== stored.payloadHash) push(`arm ${armId} payloadText does not match its payloadHash`);
        if (manifest.armPayloadHashes && manifest.armPayloadHashes[side] !== rebuilt.arms[side].payloadHash) push(`manifest armPayloadHashes.${side} != rebuilt payload`);
      }
      armPayloadHashes = {
        control: rebuilt.arms.control.payloadHash,
        treatment: rebuilt.arms.treatment.payloadHash,
      };
      if (manifest.armPayloadHashes && (manifest.armPayloadHashes.control !== armPayloadHashes.control || manifest.armPayloadHashes.treatment !== armPayloadHashes.treatment)) {
        push('manifest armPayloadHashes != rebuilt arm payloads');
      }
    } catch (e) {
      push(`arm payload rebuild failed: ${e.message}`);
    }
  }

  if (hashes.examinerManifestHash?.value !== manifest.manifestHash) push('hashes.examinerManifestHash != manifest.manifestHash');
  if (hashes.pairAssignmentHash?.value !== pair.assignmentHash) push('hashes.pairAssignmentHash != pair assignment hash');

  const binding = {
    schema: PREREG_BINDING_SCHEMA,
    studyId: manifest.studyId ?? null,
    experimentMode: manifest.experimentMode ?? null,
    interventionType: manifest.interventionType ?? null,
    targetPrincipleId: hepsInput.targetPrincipleId ?? null,
    manifestHash: manifest.manifestHash ?? null,
    pairAssignmentHash: pair.assignmentHash ?? null,
    preregistrationHash,
    suiteHash: suite.suiteHash ?? null,
    mappingHash: mapping.mappingHash ?? null,
    graderHash,
    principleContentHash,
    principleSetSnapshotHash: heps ? heps.snapshotHash : (manifest.principleSetSnapshotHash ?? null),
    ruleCodeSnapshotHash: manifest.ruleCodeSnapshotHash ?? null,
    // The frozen primary endpoint rides in the anchor: changing the statistical
    // definition after freezing (even with every file re-hashed) moves this.
    primaryEndpointHash: hashOfCanonical(manifest.primaryEndpoint ?? null),
    armPayloadHashes,
    plannedPairs: manifest.plannedPairs ?? null,
    repetitionsPerCase: manifest.repetitionsPerCase ?? null,
  };
  return { ok: problems.length === 0, problems, binding, bindingHash: hashOfCanonical(binding) };
}

/**
 * Fail-closed cross-file verification for an existing study: the recomputed
 * binding must hold AND match the append-only anchor written at creation.
 * A study whose frozen files were rewritten after freezing (even
 * consistently) cannot move the anchor and is refused.
 */
export function verifyExaminerStudyBindings(studyDir, { requireAnchor = true } = {}) {
  const computed = computeExaminerStudyBindings(studyDir);
  if (!computed.ok) return { ...computed, anchor: 'NOT_CHECKED' };
  const eventsFile = path.join(studyDir, 'events.jsonl');
  const events = fs.existsSync(eventsFile)
    ? fs.readFileSync(eventsFile, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean)
    : [];
  const anchors = events.filter((e) => e && e.type === PREREGISTRATION_ANCHOR_EVENT);
  const problems = [];
  let anchor = 'MISSING';
  if (anchors.length === 0) {
    if (requireAnchor) problems.push('immutable preregistration anchor MISSING — the study was not frozen by the anchored creation path');
  } else if (anchors.length > 1) {
    problems.push(`multiple preregistration anchors (${anchors.length}) — the append-only freeze record was duplicated`);
    anchor = 'MISMATCH';
  } else {
    const record = anchors[0];
    anchor = 'VERIFIED';
    if (record.schema !== PREREG_ANCHOR_SCHEMA) { problems.push(`anchor schema '${String(record.schema)}' unsupported`); anchor = 'MISMATCH'; }
    if (record.studyId !== computed.binding.studyId) { problems.push('anchor studyId != manifest studyId'); anchor = 'MISMATCH'; }
    if (record.bindingHash !== computed.bindingHash) {
      problems.push('anchor bindingHash != recomputed binding — the frozen files were rewritten after the anchor was written');
      anchor = 'MISMATCH';
    }
    if (!record.binding || hashOfCanonical(record.binding) !== record.bindingHash) {
      problems.push('anchor binding payload does not match its own bindingHash');
      anchor = 'MISMATCH';
    }
  }
  return { ...computed, ok: problems.length === 0, problems: problems.length > 0 ? problems : [], anchor };
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
 * deterministic SKIP-AND-CONTINUE policy: walk the order and deliver every
 * principle that still fits, so a late small principle may be delivered after
 * an earlier one was evicted. This was historically mislabelled
 * 'legacy_fifo_prefix_v1' (a prefix policy stops at the first non-fitting
 * item), so the honest name is 'skip_and_continue_v1' — the SELECTION RULE
 * itself is unchanged. Returns { payloadText, delivered, evicted }.
 */
export const LIBRARY_SELECTION_RULE = 'skip_and_continue_v1';

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
 * @param {object} [options] — { budgetChars = 2000, ordering = 'id-asc', principleFacts }
 *   `principleFacts` (the full-principle facts the HEPS was built from) is
 *   REQUIRED for full-library mode: the HEPS snapshot carries identity +
 *   contentHash only, so without the facts the delivered library text cannot
 *   be rendered. Rendering a placeholder instead is refused — a payload that
 *   says "undefined" is not the frozen library.
 */
export function buildDualModeArmPayloads({ mode, heps, targetPrinciple, principleFacts = null, budgetChars = 2000, ordering = 'id-asc' }) {
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
  const factById = new Map((Array.isArray(principleFacts) ? principleFacts : []).map((p) => [p && p.id, p]));
  // Resolve the frozen TEXT for a HEPS entry and prove it hashes back to the
  // frozen contentHash — a mismatched or missing text is a refusal, never a
  // silently rendered placeholder.
  const resolveLibraryEntry = (entry) => {
    const fact = factById.get(entry.id);
    const resolvedText = fact && text(fact.text) ? fact.text : entry.text;
    if (!text(resolvedText)) {
      throw new Error(`buildDualModeArmPayloads: no frozen text for library principle '${entry.id}' — pass principleFacts (a payload carrying 'undefined' is refused)`);
    }
    const contentHash = hashOfCanonical({ id: entry.id, version: entry.version, text: resolvedText });
    if (entry.contentHash && entry.contentHash !== contentHash) {
      throw new Error(`buildDualModeArmPayloads: library principle '${entry.id}' text does not match its frozen contentHash`);
    }
    return { id: entry.id, version: entry.version, text: resolvedText, contentHash, ...(entry.priority !== undefined ? { priority: entry.priority } : {}) };
  };

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
    const baseLibrary = heps.baseLibrary.map(resolveLibraryEntry);
    control = renderLibraryPayload({ orderedPrinciples: orderBy(baseLibrary), budgetChars });
    treatment = renderLibraryPayload({ orderedPrinciples: orderBy([...baseLibrary, target]), budgetChars });
    controlCapacity = recordCapacityCompetition({ eligible: baseLibrary, delivered: control.delivered, budgetChars, policy: `examiner-offline:${LIBRARY_SELECTION_RULE}:${ordering}`, targetPrincipleId: target.id });
    controlCapacity.armId = 'A';
    treatmentCapacity = recordCapacityCompetition({ eligible: [...baseLibrary, target], delivered: treatment.delivered, budgetChars, policy: `examiner-offline:${LIBRARY_SELECTION_RULE}:${ordering}`, targetPrincipleId: target.id });
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
  const ruleCodePolicy = buildRuleCodePolicy({ mode: input.experimentMode, ruleCodes: ruleCodeFacts.ruleCodes, targetPrincipleId: hepsPrinciples.targetPrincipleId, principleRuleCodeIndependence: ruleCodeFacts.principleRuleCodeIndependence, targetRuleCodeCount: ruleCodeFacts.targetRuleCodeCount ?? null });
  if (ruleCodePolicy.executable === false) {
    throw new Error(`writeExaminerStudyArtifacts: INTERVENTION_NOT_IDENTIFIABLE — ${ruleCodePolicy.couplingReason} (the study cannot be preregistered with an intervention that cannot be delivered)`);
  }
  const armPayloads = buildDualModeArmPayloads({ mode: input.experimentMode, heps, targetPrinciple: targetFact, principleFacts: hepsPrinciples.principles, budgetChars, ordering });
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
  writeJson('rulecode-baseline.json', {
    ruleCodes: ruleCodeFacts.ruleCodes,
    principleRuleCodeIndependence: ruleCodeFacts.principleRuleCodeIndependence ?? null,
    targetRuleCodeCount: ruleCodeFacts.targetRuleCodeCount ?? null,
  });
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
  // Cross-file self-check BEFORE the identity is published: a study whose
  // files do not agree with each other is not a valid preregistration.
  const bindings = computeExaminerStudyBindings(studyDir);
  if (!bindings.ok) {
    fs.rmSync(studyDir, { recursive: true, force: true });
    throw new Error(`writeExaminerStudyArtifacts: written artifacts are internally inconsistent (${bindings.problems.join('; ')}) — nothing was published`);
  }
  // The immutable anchor: one append-only ledger row recorded at freeze time.
  // Later verification recomputes the binding and must find it unchanged.
  createChallengeLedger(studyDir).appendEvent({
    type: PREREGISTRATION_ANCHOR_EVENT,
    owner: 'examiner-study-freeze',
    schema: PREREG_ANCHOR_SCHEMA,
    studyId: input.studyId,
    bindingHash: bindings.bindingHash,
    binding: bindings.binding,
  });
  return { studyDir, manifest, pairAssignment, heps, ruleCodePolicy, armPayloads, suiteManifest, bindingHash: bindings.bindingHash };
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
  const { manifest, heps, ruleCodePolicy, pairAssignment, primaryEndpoint, armConfigs, isolation, goldStatus, injectionCapability, authorization, studyDirStatus, bindings } = input || {};

  const manifestCheck = verifyExaminerManifest(manifest);
  check('manifest_verifiable', 'blocker', manifestCheck.ok, manifestCheck.ok ? 'manifest hash verified' : (manifestCheck.problems || ['no manifest']).join('; '));
  const hepsCheck = verifyHostEffectivePrincipleSet(heps);
  check('heps_snapshot_verified', 'blocker', hepsCheck.ok, hepsCheck.ok ? `HEPS snapshot ${heps.snapshotHash.slice(0, 12)}… verified (${heps.baseLibrary.length} non-target principles, ${heps.excluded.length} excluded)` : hepsCheck.reason);
  if (heps) {
    check('target_principle_eligible', 'blocker', heps.target && heps.target.qualifies === true,
      heps.target && heps.target.qualifies ? `target '${heps.target.id}' qualifies for host-effective status` : `target Principle is not host-effective (${heps.target ? heps.target.exclusionReason : 'missing'}) — an ineligible intervention cannot be studied`);
  }
  const rcCheck = verifyRuleCodePolicy(ruleCodePolicy);
  check('rulecode_policy_verified', 'blocker', rcCheck.ok, rcCheck.ok ? `RuleCode policy ${ruleCodePolicy.policy} verified (interventionType=${ruleCodePolicy.interventionType}, identifiability=${ruleCodePolicy.identifiability})` : rcCheck.reason);
  if (ruleCodePolicy) {
    check('rulecode_policy_executable', 'blocker', ruleCodePolicy.executable !== false,
      ruleCodePolicy.executable !== false ? 'RuleCode policy executable under current controllability facts' : `INTERVENTION_NOT_IDENTIFIABLE: ${ruleCodePolicy.couplingReason}`);
    check('bundled_intervention_declared', ruleCodePolicy.interventionType === 'bundled_intervention' ? 'warning' : 'info', true,
      ruleCodePolicy.interventionType === 'bundled_intervention'
        ? `BUNDLED intervention declared — conclusions may only attribute to the Principle+RuleCode bundle, never to the Principle alone (${ruleCodePolicy.couplingReason})`
          + (ruleCodePolicy.unresolvedEvidence?.length ? ` [unresolved evidence: ${ruleCodePolicy.unresolvedEvidence.join(', ')}]` : '')
        : 'principle_only intervention — the target Principle is the only treatment variable');
  }
  const pairCheck = verifyPairAssignment(pairAssignment);
  check('pair_assignment_verified', 'blocker', pairCheck.ok, pairCheck.ok ? `${pairAssignment.pairs.length} pairs, balanced ${pairAssignment.balance.controlFirst}/${pairAssignment.balance.treatmentFirst}, seed frozen` : pairCheck.reason);
  // P1-3: every frozen file only proves itself; this check folds in the
  // cross-file binding + immutable anchor computed from the study directory.
  // It is a blocker whenever the caller supplies a binding verdict (the
  // production paths always do), so a study whose files were rewritten in a
  // mutually consistent way can never pass preflight.
  if (bindings !== undefined && bindings !== null) {
    const ok = bindings.ok === true && bindings.anchor === 'VERIFIED';
    check('preregistration_bindings_verified', 'blocker', ok,
      ok
        ? `cross-file preregistration binding ${String(bindings.bindingHash).slice(0, 12)}… matches the immutable anchor`
        : `preregistration binding not verified: ${(bindings.problems || ['anchor not verified']).join('; ')}`);
  }

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
