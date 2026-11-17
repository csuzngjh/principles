// PD-Lab v0.3 T4 (PRI-1255): offline judge-record merge, Owner-alignment
// scoring and two-sided change-vs-baseline decision, per
// docs/specs/CONTRACT-PD-LAB-DATA-AND-SCORING-001-v0.3.md sections 5.2, 6.1,
// 6.2, 6.5 and 7 (SC-01..SC-19), and
// docs/plans/PD-LAB-V03-IMPLEMENTATION-HANDOFF.md task T4.
//
// Purity contract (HANDOFF T4): this module MUST NOT read the filesystem,
// environment variables or the current time. It is deterministic: identical
// input objects always produce identical output objects, including digests.
// The CLI wrapper (build-decision-input.mjs) owns all I/O.
//
// Exports exactly two functions:
//   mergeJudgments(input)        -> CONTRACT section 5.2 FinalComparison[]
//   buildAlignmentReport(input)  -> CONTRACT sections 6.2 + 6.5 report
//
// Input shapes (synthetic research fixtures; see scripts/__tests__/):
//
// plan = {
//   schemaVersion: 'pd-lab-plan.v1',
//   benchmarkId, benchmarkVersion: non-empty strings,
//   comparisonDesign: 'CHANGE_VS_BASELINE' | 'HOST_VS_FIXED_REFERENCE',
//   judgeProtocolRef: non-empty string,
//   judgeProtocol: { requiredJudgments: integer >= 1 },
//   analysisPolicy: { alpha: 0 < alpha < 1 },   // required for CHANGE_VS_BASELINE
//   owners: [{ ownerId, weight }],              // weights sum to 1
//   scenarios: [{ scenarioId, ownerId, weight }], // per-owner weights sum to 1
//   assignments: [{
//     candidateConfigId, caseId, caseVersion, opportunityId, repetitionId,
//     referenceId, scenarioId,                    // all non-empty strings
//     candidateTrajectoryRef?, referenceTrajectoryRef?, expectationRef?,
//   }],
//   referenceVersion?: string,                    // bindings passthrough
//   guardrailBreaches?: [{ guardrailId, breached, detail? }], // pre-evaluated
// }
// The plan assignment key is DERIVED (never declared twice):
//   `${candidateConfigId}+${caseId}@${caseVersion}+${opportunityId}+${repetitionId}+${referenceId}`
// (CONTRACT section 4). Denominators come from the plan, never from result files.
//
// judgment = {
//   judgmentId, assignmentKey, judgeProtocolRef, comparisonInputDigest: strings,
//   displayVerdict: 'A_BETTER' | 'TIE' | 'B_BETTER' | 'UNKNOWN',
//   unknownReason: required non-empty string iff displayVerdict is UNKNOWN,
//   attempt: positive integer (REQUIRED for a verified vote; missing stays
//     null - never defaulted to 1, PR #2696 B2),
//   judgeSlotId: non-empty string (REQUIRED for a verified vote; identifies
//     the pre-registered judge slot so (judgeSlotId, attempt) dedup can
//     detect double-persisted records while distinct judges legally share
//     attempt=1, PR #2696 B2),
//   lossyInput?: boolean, evidenceRefs?: string[], reason?: string,
// }
// arbitration = {
//   arbitrationId, assignmentKey: strings,
//   boundJudgmentIds: string[],  // must cover every participating judgment
//                                // record of the unit (CONTRACT 5.2 step 5)
//   boundComparisonInputDigests: string[], // must match the participating
//                                // records' comparisonInputDigest values
//                                // (CONTRACT 5.2 step 5; PR #2696 B2)
//   verdict: 'CANDIDATE_BETTER' | 'TIE' | 'REFERENCE_BETTER' | 'UNKNOWN',
//   reason?: string,
// }
// blindmap = { map: { [judgmentId]: { A: 'candidate'|'reference',
//                                     B: 'candidate'|'reference' } } }
// The identity mapping is PER JUDGMENT RECORD (CONTRACT 5.1 stores the
// display order and controlled identity mapping on each record): two
// exchanges of the same unit may legitimately be shown in swapped display
// orders (SC-09).
// sourceGroups = { groups: { [caseId]: sourceGroupId }, rationales?: {...} }
//
// Scope boundaries (deliberate, per HANDOFF T4):
// - Trial-level trajectory/expectation EvidenceRef digest binding is verified
//   by the admission layer (T7a, CONTRACT sections 2 and 5.1); here the merge
//   verifies plan keys, judge-protocol version and per-unit record counts.
// - samplingInterval is emitted as NOT_ESTIMABLE: the clustered bootstrap of
//   CONTRACT section 6.3 requires a frozen analysis policy (seed, replicates,
//   interval method, confidence level) that is not part of this offline task.
//   No fake precision is produced.

import { createHash } from 'node:crypto';

const ANALYSIS_VERSION = 'pd-lab-alignment-report.v1';
const PLAN_SCHEMA_VERSION = 'pd-lab-plan.v1';

const COMPARISON_DESIGNS = ['CHANGE_VS_BASELINE', 'HOST_VS_FIXED_REFERENCE'];
const FINAL_VERDICTS = ['CANDIDATE_BETTER', 'TIE', 'REFERENCE_BETTER', 'UNKNOWN'];
const DISPLAY_VERDICTS = ['A_BETTER', 'TIE', 'B_BETTER', 'UNKNOWN'];
const RESOLVED_BY_VALUES = ['CONSISTENT_JUDGMENTS', 'BLIND_ARBITRATION', 'UNRESOLVED'];
const ARM_ROLES = ['candidate', 'reference'];
const WEIGHT_SUM_TOLERANCE = 1e-9;

// ---------------------------------------------------------------------------
// Small guards (rc-1/rc-4/rc-5: untrusted values validated element-wise,
// object membership via Object.hasOwn).
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function problem(code, message, detail) {
  const entry = { code, message };
  if (detail !== undefined) {
    entry.detail = detail;
  }
  return entry;
}

/**
 * Evidence problems (PR #2696 B1/B2 remediation) are structured, per-unit
 * disclosures of UNVERIFIED evidence. Unlike `problems` they do not corrupt
 * the run: the unit degrades to UNKNOWN with a reason (CONTRACT 5.2 "未完成
 * 或仍不确定则UNKNOWN"; Owner instruction 2026-11-17: 缺证据/缺上游验证凭证时
 * 不得宣称正式有效), the report stays computable with missingBounds, and the
 * condition stays observable instead of silently accepted.
 */
function evidenceProblem(code, message, assignmentKey, detail) {
  const entry = { code, message, assignmentKey };
  if (detail !== undefined) {
    entry.detail = detail;
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Deterministic canonical serialization + digests (no wall-clock input).
// PR #2696 B4: strict canonicalization per CONTRACT 1.1. Undefined-valued
// keys, non-finite numbers, functions, symbols and bigints are NOT legal
// JSON values: they are rejected with a typed error instead of being
// silently serialized into a different object (the previous behavior
// dropped undefined keys, turning an object into a different one). Key
// order is deterministic (sorted) and never affects the digest; array
// order is preserved because it is significant. No audited stricter
// canonicalization existed in the repository to reuse; T4 has no
// historical digest semantics to preserve, so the strict rejection is a
// safe first landing. JSON-parsed CLI input cannot contain these values,
// so the CLI behavior is unchanged.
// ---------------------------------------------------------------------------

class CanonicalJsonError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    const body = keys
      .map((key) => {
        const item = value[key];
        if (item === undefined) {
          throw new CanonicalJsonError(`canonicalJson: key ${JSON.stringify(key)} has an undefined value; undefined is not valid JSON, rejecting instead of silently dropping the key`);
        }
        return `${JSON.stringify(key)}:${canonicalJson(item)}`;
      })
      .join(',');
    return `{${body}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new CanonicalJsonError(`canonicalJson: ${String(value)} is not a finite JSON number`);
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new CanonicalJsonError(`canonicalJson: value of type ${typeof value} is not a legal JSON value`);
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new CanonicalJsonError('canonicalJson: value cannot be encoded as JSON');
  }
  return encoded;
}

function digestOf(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

// ---------------------------------------------------------------------------
// Plan parsing (shared by both exported functions).
// ---------------------------------------------------------------------------

function composeAssignmentKey(assignment) {
  return `${assignment.candidateConfigId}+${assignment.caseId}@${assignment.caseVersion}+${assignment.opportunityId}+${assignment.repetitionId}+${assignment.referenceId}`;
}

const ASSIGNMENT_COMPONENT_FIELDS = [
  'candidateConfigId',
  'caseId',
  'caseVersion',
  'opportunityId',
  'repetitionId',
  'referenceId',
];

function parseAssignment(raw, problems) {
  if (!isPlainObject(raw)) {
    problems.push(problem('INVALID_PLAN_FIELD', 'assignment entry must be an object'));
    return null;
  }
  for (const field of ASSIGNMENT_COMPONENT_FIELDS) {
    if (!isNonEmptyString(raw[field])) {
      problems.push(problem('INVALID_PLAN_FIELD', `assignment field ${field} must be a non-empty string`));
      return null;
    }
  }
  if (!isNonEmptyString(raw.scenarioId)) {
    problems.push(problem('INVALID_PLAN_FIELD', 'assignment field scenarioId must be a non-empty string'));
    return null;
  }
  const assignment = {
    candidateConfigId: raw.candidateConfigId,
    caseId: raw.caseId,
    caseVersion: raw.caseVersion,
    opportunityId: raw.opportunityId,
    repetitionId: raw.repetitionId,
    referenceId: raw.referenceId,
    scenarioId: raw.scenarioId,
    candidateTrajectoryRef: isNonEmptyString(raw.candidateTrajectoryRef) ? raw.candidateTrajectoryRef : null,
    referenceTrajectoryRef: isNonEmptyString(raw.referenceTrajectoryRef) ? raw.referenceTrajectoryRef : null,
    expectationRef: isNonEmptyString(raw.expectationRef) ? raw.expectationRef : null,
  };
  assignment.key = composeAssignmentKey(assignment);
  return assignment;
}

/**
 * Validate the plan core needed by both merge and scoring. Returns
 * { problems, planInfo } where planInfo is null when the plan is too
 * malformed to drive any processing.
 */
function parsePlanCore(plan) {
  const problems = [];
  if (!isPlainObject(plan)) {
    problems.push(problem('INVALID_PLAN_FIELD', 'plan must be an object'));
    return { problems, planInfo: null };
  }
  if (plan.schemaVersion !== PLAN_SCHEMA_VERSION) {
    problems.push(problem('INVALID_PLAN_SCHEMA', `plan schemaVersion must be ${PLAN_SCHEMA_VERSION}`));
  }
  if (!isNonEmptyString(plan.judgeProtocolRef)) {
    problems.push(problem('INVALID_PLAN_FIELD', 'plan judgeProtocolRef must be a non-empty string'));
  }
  let requiredJudgments = null;
  if (isPlainObject(plan.judgeProtocol) && isPositiveInteger(plan.judgeProtocol.requiredJudgments)) {
    requiredJudgments = plan.judgeProtocol.requiredJudgments;
  } else {
    problems.push(problem('REQUIRED_JUDGMENTS_INVALID', 'plan judgeProtocol.requiredJudgments must be an integer >= 1'));
  }
  if (!Array.isArray(plan.assignments) || plan.assignments.length === 0) {
    problems.push(problem('INVALID_PLAN_FIELD', 'plan assignments must be a non-empty array'));
    return { problems, planInfo: null };
  }
  const assignments = [];
  const keySet = new Set();
  const caseVersions = new Map();
  for (const raw of plan.assignments) {
    const assignment = parseAssignment(raw, problems);
    if (!assignment) continue;
    if (keySet.has(assignment.key)) {
      problems.push(problem('DUPLICATE_ASSIGNMENT_KEY', `duplicate assignment key ${assignment.key}`));
      continue;
    }
    keySet.add(assignment.key);
    const previousVersion = caseVersions.get(assignment.caseId);
    if (previousVersion === undefined) {
      caseVersions.set(assignment.caseId, assignment.caseVersion);
    } else if (previousVersion !== assignment.caseVersion) {
      problems.push(problem('CASE_VERSION_CONFLICT', `case ${assignment.caseId} declared with versions ${previousVersion} and ${assignment.caseVersion}`));
    }
    assignments.push(assignment);
  }
  if (assignments.length === 0) {
    return { problems, planInfo: null };
  }
  return {
    problems,
    planInfo: {
      judgeProtocolRef: isNonEmptyString(plan.judgeProtocolRef) ? plan.judgeProtocolRef : null,
      requiredJudgments,
      assignments,
    },
  };
}

/** Full plan validation incl. hierarchy weights and source groups. */
function validateFullPlan(plan, sourceGroups) {
  const core = parsePlanCore(plan);
  const problems = core.problems;
  const planInfo = core.planInfo;
  if (!isPlainObject(plan)) {
    return { problems, structure: null };
  }
  if (!isNonEmptyString(plan.benchmarkId) || !isNonEmptyString(plan.benchmarkVersion)) {
    problems.push(problem('INVALID_PLAN_FIELD', 'plan benchmarkId and benchmarkVersion must be non-empty strings'));
  }
  if (!COMPARISON_DESIGNS.includes(plan.comparisonDesign)) {
    problems.push(problem('INVALID_PLAN_FIELD', 'plan comparisonDesign must be CHANGE_VS_BASELINE or HOST_VS_FIXED_REFERENCE'));
  }

  let alpha = null;
  if (plan.comparisonDesign === 'CHANGE_VS_BASELINE') {
    const policy = isPlainObject(plan.analysisPolicy) ? plan.analysisPolicy : null;
    if (policy && isFiniteNumber(policy.alpha) && policy.alpha > 0 && policy.alpha < 1) {
      alpha = policy.alpha;
    } else {
      problems.push(problem('ALPHA_NOT_PREREGISTERED', 'CHANGE_VS_BASELINE plan must preregister analysisPolicy.alpha in (0,1); no default may be applied'));
    }
  }

  // Owners.
  const ownerWeight = new Map();
  if (!Array.isArray(plan.owners) || plan.owners.length === 0) {
    problems.push(problem('INVALID_PLAN_FIELD', 'plan owners must be a non-empty array'));
  } else {
    let total = 0;
    for (const owner of plan.owners) {
      if (!isPlainObject(owner) || !isNonEmptyString(owner.ownerId) || !isFiniteNumber(owner.weight) || owner.weight < 0) {
        problems.push(problem('INVALID_PLAN_FIELD', 'each owner needs ownerId and a finite weight >= 0'));
        continue;
      }
      if (ownerWeight.has(owner.ownerId)) {
        problems.push(problem('INVALID_PLAN_FIELD', `duplicate ownerId ${owner.ownerId}`));
        continue;
      }
      ownerWeight.set(owner.ownerId, owner.weight);
      total += owner.weight;
    }
    if (Math.abs(total - 1) > WEIGHT_SUM_TOLERANCE) {
      problems.push(problem('OWNER_WEIGHT_SUM', `owner weights must sum to 1, got ${total}`));
    }
  }

  // Scenarios.
  const scenarioById = new Map();
  const scenariosByOwner = new Map();
  if (!Array.isArray(plan.scenarios) || plan.scenarios.length === 0) {
    problems.push(problem('INVALID_PLAN_FIELD', 'plan scenarios must be a non-empty array'));
  } else {
    for (const scenario of plan.scenarios) {
      if (!isPlainObject(scenario) || !isNonEmptyString(scenario.scenarioId) || !isFiniteNumber(scenario.weight) || scenario.weight < 0) {
        problems.push(problem('INVALID_PLAN_FIELD', 'each scenario needs scenarioId and a finite weight >= 0'));
        continue;
      }
      if (scenarioById.has(scenario.scenarioId)) {
        problems.push(problem('INVALID_PLAN_FIELD', `duplicate scenarioId ${scenario.scenarioId}`));
        continue;
      }
      if (ownerWeight.size > 0 && !ownerWeight.has(scenario.ownerId)) {
        problems.push(problem('INVALID_PLAN_FIELD', `scenario ${scenario.scenarioId} references unknown ownerId ${String(scenario.ownerId)}`));
      }
      scenarioById.set(scenario.scenarioId, { scenarioId: scenario.scenarioId, ownerId: scenario.ownerId, weight: scenario.weight });
      if (!scenariosByOwner.has(scenario.ownerId)) scenariosByOwner.set(scenario.ownerId, []);
      scenariosByOwner.get(scenario.ownerId).push(scenario.scenarioId);
    }
    for (const [ownerId, scenarioIds] of scenariosByOwner) {
      const total = scenarioIds.reduce((sum, id) => sum + scenarioById.get(id).weight, 0);
      if (Math.abs(total - 1) > WEIGHT_SUM_TOLERANCE) {
        problems.push(problem('SCENARIO_WEIGHT_SUM', `scenario weights for owner ${ownerId} must sum to 1, got ${total}`));
      }
    }
    for (const ownerId of ownerWeight.keys()) {
      if (!scenariosByOwner.has(ownerId)) {
        problems.push(problem('EMPTY_OWNER_STRATUM', `owner ${ownerId} has no scenario group`));
      }
    }
  }

  // Assignments -> scenario membership (needs planInfo from core parse).
  const assignmentsByScenario = new Map();
  if (planInfo) {
    for (const assignment of planInfo.assignments) {
      if (!scenarioById.has(assignment.scenarioId)) {
        problems.push(problem('UNDECLARED_SCENARIO', `assignment ${assignment.key} references undeclared scenarioId ${assignment.scenarioId}`));
        continue;
      }
      if (!assignmentsByScenario.has(assignment.scenarioId)) assignmentsByScenario.set(assignment.scenarioId, []);
      assignmentsByScenario.get(assignment.scenarioId).push(assignment);
    }
  }
  for (const scenarioId of scenarioById.keys()) {
    if (!assignmentsByScenario.has(scenarioId)) {
      problems.push(problem('EMPTY_SCENARIO_GROUP', `scenario group ${scenarioId} has no planned assignments`));
    }
  }

  // Source groups: complete caseId -> sourceGroupId coverage (CONTRACT
  // section 3 + SC-19), one main scenario per group (SC-12).
  const caseToGroup = new Map();
  if (!isPlainObject(sourceGroups) || !isPlainObject(sourceGroups.groups)) {
    problems.push(problem('SOURCE_GROUP_STRUCTURE', 'sourceGroups must be an object with a groups mapping'));
  } else {
    for (const caseId of Object.keys(sourceGroups.groups)) {
      const groupId = sourceGroups.groups[caseId];
      if (!isNonEmptyString(groupId)) {
        problems.push(problem('SOURCE_GROUP_STRUCTURE', `source group mapping for case ${caseId} must be a non-empty string`));
      } else {
        caseToGroup.set(caseId, groupId);
      }
    }
    if (isPlainObject(sourceGroups.rationales)) {
      for (const groupId of Object.keys(sourceGroups.rationales)) {
        if (typeof sourceGroups.rationales[groupId] !== 'string') {
          problems.push(problem('SOURCE_GROUP_STRUCTURE', `rationale for group ${groupId} must be a string`));
        }
      }
    }
  }
  if (planInfo) {
    const groupScenarios = new Map();
    for (const assignment of planInfo.assignments) {
      const groupId = caseToGroup.get(assignment.caseId);
      if (groupId === undefined) {
        problems.push(problem('SOURCE_GROUP_MAPPING_MISSING', `planned case ${assignment.caseId} is not covered by the source-group mapping; one-case-one-group defaults are forbidden (SC-19)`));
        continue;
      }
      if (!groupScenarios.has(groupId)) groupScenarios.set(groupId, new Set());
      groupScenarios.get(groupId).add(assignment.scenarioId);
    }
    for (const [groupId, scenarioIds] of groupScenarios) {
      if (scenarioIds.size > 1) {
        problems.push(problem('SOURCE_GROUP_SPLIT_ACROSS_SCENARIOS', `source group ${groupId} is split across main scenarios ${[...scenarioIds].sort().join(', ')} (SC-12)`));
      }
    }
  }

  // Pre-evaluated guardrail breaches passthrough (CONTRACT section 6.5.6).
  const guardrailBreaches = [];
  if (plan.guardrailBreaches !== undefined) {
    if (!Array.isArray(plan.guardrailBreaches)) {
      problems.push(problem('INVALID_PLAN_FIELD', 'plan guardrailBreaches must be an array when present'));
    } else {
      for (const entry of plan.guardrailBreaches) {
        if (!isPlainObject(entry) || !isNonEmptyString(entry.guardrailId) || typeof entry.breached !== 'boolean') {
          problems.push(problem('INVALID_PLAN_FIELD', 'each guardrail entry needs guardrailId and boolean breached'));
        } else if (entry.breached) {
          guardrailBreaches.push({ guardrailId: entry.guardrailId, detail: typeof entry.detail === 'string' ? entry.detail : null });
        }
      }
    }
  }

  return {
    problems,
    structure: {
      planInfo,
      comparisonDesign: COMPARISON_DESIGNS.includes(plan.comparisonDesign) ? plan.comparisonDesign : null,
      alpha,
      ownerWeight,
      scenarioById,
      assignmentsByScenario,
      caseToGroup,
      guardrailBreaches,
    },
  };
}

// ---------------------------------------------------------------------------
// mergeJudgments: CONTRACT section 5.2 deterministic merge.
// ---------------------------------------------------------------------------

function parseBlindmap(blindmap, problems) {
  const empty = new Map();
  if (!isPlainObject(blindmap) || !isPlainObject(blindmap.map)) {
    problems.push(problem('BLINDMAP_INVALID', 'blindmap must be an object with a map mapping'));
    return empty;
  }
  const entries = new Map();
  for (const key of Object.keys(blindmap.map)) {
    const entry = blindmap.map[key];
    if (
      !isPlainObject(entry) ||
      !ARM_ROLES.includes(entry.A) ||
      !ARM_ROLES.includes(entry.B) ||
      entry.A === entry.B
    ) {
      problems.push(problem('BLINDMAP_INVALID', `blindmap entry for ${key} must assign distinct candidate/reference roles to A and B`));
      continue;
    }
    entries.set(key, entry);
  }
  return entries;
}

function parseJudgmentRecords(judgments, planInfo, problems) {
  const valid = [];
  const seenIds = new Set();
  let invalidRecords = 0;
  if (!Array.isArray(judgments)) {
    problems.push(problem('INVALID_JUDGMENT_RECORD', 'judgments input must be an array'));
    return { valid, invalidRecords: 1 };
  }
  for (const raw of judgments) {
    if (!isPlainObject(raw)) {
      problems.push(problem('INVALID_JUDGMENT_RECORD', 'judgment record must be an object'));
      invalidRecords += 1;
      continue;
    }
    if (!isNonEmptyString(raw.judgmentId) || !isNonEmptyString(raw.assignmentKey) || !isNonEmptyString(raw.judgeProtocolRef) || !isNonEmptyString(raw.comparisonInputDigest) || !DISPLAY_VERDICTS.includes(raw.displayVerdict)) {
      problems.push(problem('INVALID_JUDGMENT_RECORD', `judgment ${String(raw.judgmentId)} is missing required fields or has an invalid displayVerdict`));
      invalidRecords += 1;
      continue;
    }
    if (raw.displayVerdict === 'UNKNOWN' && !isNonEmptyString(raw.unknownReason)) {
      problems.push(problem('INVALID_JUDGMENT_RECORD', `judgment ${raw.judgmentId} is UNKNOWN without a reason (CONTRACT section 0)`));
      invalidRecords += 1;
      continue;
    }
    if (raw.attempt !== undefined && !isPositiveInteger(raw.attempt)) {
      problems.push(problem('INVALID_JUDGMENT_RECORD', `judgment ${raw.judgmentId} attempt must be a positive integer`));
      invalidRecords += 1;
      continue;
    }
    if (raw.judgeSlotId !== undefined && !isNonEmptyString(raw.judgeSlotId)) {
      problems.push(problem('INVALID_JUDGMENT_RECORD', `judgment ${raw.judgmentId} judgeSlotId must be a non-empty string when present`));
      invalidRecords += 1;
      continue;
    }
    if (raw.lossyInput !== undefined && typeof raw.lossyInput !== 'boolean') {
      problems.push(problem('INVALID_JUDGMENT_RECORD', `judgment ${raw.judgmentId} lossyInput must be a boolean`));
      invalidRecords += 1;
      continue;
    }
    if (raw.evidenceRefs !== undefined) {
      if (!Array.isArray(raw.evidenceRefs) || !raw.evidenceRefs.every((ref) => isNonEmptyString(ref))) {
        problems.push(problem('INVALID_JUDGMENT_RECORD', `judgment ${raw.judgmentId} evidenceRefs must be an array of non-empty strings`));
        invalidRecords += 1;
        continue;
      }
    }
    if (seenIds.has(raw.judgmentId)) {
      problems.push(problem('DUPLICATE_JUDGMENT_ID', `duplicate judgmentId ${raw.judgmentId}`));
      invalidRecords += 1;
      continue;
    }
    seenIds.add(raw.judgmentId);
    const record = {
      judgmentId: raw.judgmentId,
      assignmentKey: raw.assignmentKey,
      judgeProtocolRef: raw.judgeProtocolRef,
      comparisonInputDigest: raw.comparisonInputDigest,
      displayVerdict: raw.displayVerdict,
      unknownReason: raw.displayVerdict === 'UNKNOWN' ? raw.unknownReason : null,
      // PR #2696 B2: attempt is never defaulted - a missing attempt keeps
      // null so the unit cannot treat the record as verified evidence.
      attempt: raw.attempt === undefined ? null : raw.attempt,
      // PR #2696 B2: pre-registered judge-slot identity. Without it, slot
      // independence (and therefore duplicate detection by
      // (judgeSlotId, attempt)) is unverifiable.
      judgeSlotId: isNonEmptyString(raw.judgeSlotId) ? raw.judgeSlotId : null,
      lossyInput: raw.lossyInput === true,
      evidenceRefs: Array.isArray(raw.evidenceRefs) ? raw.evidenceRefs.slice() : [],
      reason: typeof raw.reason === 'string' ? raw.reason : null,
    };
    if (planInfo && planInfo.assignments.length > 0) {
      const knownKey = planInfo.assignments.some((assignment) => assignment.key === record.assignmentKey);
      if (!knownKey) {
        problems.push(problem('EXTRA_JUDGMENT_KEY', `judgment ${record.judgmentId} references assignment key ${record.assignmentKey} that is not in the plan`));
        invalidRecords += 1;
        continue;
      }
    }
    if (planInfo && planInfo.judgeProtocolRef && record.judgeProtocolRef !== planInfo.judgeProtocolRef) {
      problems.push(problem('JUDGMENT_WRONG_PROTOCOL', `judgment ${record.judgmentId} protocol ${record.judgeProtocolRef} does not match plan protocol ${planInfo.judgeProtocolRef}`));
      invalidRecords += 1;
      continue;
    }
    valid.push(record);
  }
  return { valid, invalidRecords };
}

function parseArbitrationRecords(arbitrations, planInfo, problems) {
  const valid = [];
  const seenIds = new Set();
  let invalidRecords = 0;
  if (arbitrations === undefined || arbitrations === null) {
    return { valid, invalidRecords };
  }
  if (!Array.isArray(arbitrations)) {
    problems.push(problem('INVALID_ARBITRATION_RECORD', 'arbitrations input must be an array'));
    return { valid, invalidRecords: 1 };
  }
  for (const raw of arbitrations) {
    if (
      !isPlainObject(raw) ||
      !isNonEmptyString(raw.arbitrationId) ||
      !isNonEmptyString(raw.assignmentKey) ||
      !Array.isArray(raw.boundJudgmentIds) ||
      !raw.boundJudgmentIds.every((id) => isNonEmptyString(id)) ||
      // CONTRACT 5.2 step 5 (PR #2696 B2): an arbitration must bind the
      // comparison input digests of the records it adjudicates; without the
      // binding a later input change could not invalidate a stale verdict.
      !Array.isArray(raw.boundComparisonInputDigests) ||
      !raw.boundComparisonInputDigests.every((digest) => isNonEmptyString(digest)) ||
      !FINAL_VERDICTS.includes(raw.verdict)
    ) {
      problems.push(problem('INVALID_ARBITRATION_RECORD', `arbitration ${String(raw && raw.arbitrationId)} is malformed or does not bind judgment ids plus comparison-input digests`));
      invalidRecords += 1;
      continue;
    }
    if (seenIds.has(raw.arbitrationId)) {
      problems.push(problem('DUPLICATE_ARBITRATION', `duplicate arbitrationId ${raw.arbitrationId}`));
      invalidRecords += 1;
      continue;
    }
    seenIds.add(raw.arbitrationId);
    if (planInfo && planInfo.assignments.length > 0) {
      const knownKey = planInfo.assignments.some((assignment) => assignment.key === raw.assignmentKey);
      if (!knownKey) {
        problems.push(problem('EXTRA_ARBITRATION_KEY', `arbitration ${raw.arbitrationId} references assignment key ${raw.assignmentKey} that is not in the plan`));
        invalidRecords += 1;
        continue;
      }
    }
    valid.push({
      arbitrationId: raw.arbitrationId,
      assignmentKey: raw.assignmentKey,
      boundJudgmentIds: raw.boundJudgmentIds.slice(),
      boundComparisonInputDigests: raw.boundComparisonInputDigests.slice(),
      verdict: raw.verdict,
      reason: typeof raw.reason === 'string' ? raw.reason : null,
    });
  }
  return { valid, invalidRecords };
}

function restoreVerdict(displayVerdict, roles) {
  if (displayVerdict === 'TIE' || displayVerdict === 'UNKNOWN') {
    return displayVerdict === 'TIE' ? 'TIE' : 'UNKNOWN';
  }
  const winnerRole = displayVerdict === 'A_BETTER' ? roles.A : roles.B;
  return winnerRole === 'candidate' ? 'CANDIDATE_BETTER' : 'REFERENCE_BETTER';
}

function sortedCopy(values) {
  return values.slice().sort();
}

/**
 * Merge raw judgment records (plus optional arbitration records) into the
 * per-unit FinalComparison list of CONTRACT section 5.2.
 *
 * input = { plan, judgments, arbitrations?, blindmap }
 * returns { finalComparisons, problems, evidenceProblems, invalidRecords }
 *
 * - Every planned unit yields exactly one FinalComparison; units without the
 *   protocol-required records stay UNKNOWN in the denominator (MISSING_JUDGMENTS).
 * - Structural corruption (extra keys, duplicate ids, wrong protocol version,
 *   missing blindmap mapping, over-voting) is collected in problems and the
 *   caller must treat the run as INVALID; nothing is silently dropped.
 * - Unverified evidence (PR #2696 B1/B2 remediation): judged units with
 *   incomplete evidence bindings, conflicting comparison-input digests,
 *   missing attempt numbers or unverifiable judge-slot identity stay UNKNOWN
 *   with a reason; the condition is disclosed in evidenceProblems
 *   ({code, message, assignmentKey, detail?}) without invalidating the run.
 */
export function mergeJudgments(input) {
  const problems = [];
  const evidenceProblems = [];
  if (!isPlainObject(input)) {
    return {
      finalComparisons: [],
      problems: [problem('INVALID_MERGE_INPUT', 'mergeJudgments input must be an object')],
      evidenceProblems,
      invalidRecords: 1,
    };
  }
  const core = parsePlanCore(input.plan);
  problems.push(...core.problems);
  const planInfo = core.planInfo;

  const judgmentParse = parseJudgmentRecords(input.judgments, planInfo, problems);
  const arbitrationParse = parseArbitrationRecords(input.arbitrations, planInfo, problems);
  const invalidRecords = judgmentParse.invalidRecords + arbitrationParse.invalidRecords;
  const blindmapEntries = parseBlindmap(input.blindmap, problems);

  const judgmentsByKey = new Map();
  for (const record of judgmentParse.valid) {
    if (!judgmentsByKey.has(record.assignmentKey)) judgmentsByKey.set(record.assignmentKey, []);
    judgmentsByKey.get(record.assignmentKey).push(record);
  }
  const arbitrationsByKey = new Map();
  for (const record of arbitrationParse.valid) {
    if (arbitrationsByKey.has(record.assignmentKey)) {
      problems.push(problem('DUPLICATE_ARBITRATION', `multiple arbitration records for assignment ${record.assignmentKey}`));
      continue;
    }
    arbitrationsByKey.set(record.assignmentKey, record);
  }

  const finalComparisons = [];
  if (!planInfo) {
    return { finalComparisons, problems, evidenceProblems, invalidRecords };
  }

  for (const assignment of planInfo.assignments) {
    const unitJudgments = judgmentsByKey.get(assignment.key) ?? [];
    const base = {
      assignmentKey: assignment.key,
      candidateTrajectoryRef: assignment.candidateTrajectoryRef,
      referenceTrajectoryRef: assignment.referenceTrajectoryRef,
      expectationRef: assignment.expectationRef,
      judgeProtocolRef: planInfo.judgeProtocolRef,
      judgmentRefs: unitJudgments.map((record) => record.judgmentId),
      arbitrationRef: null,
      verdict: 'UNKNOWN',
      reasonCode: 'MISSING_JUDGMENTS',
      evidenceRefs: [],
      resolvedBy: 'UNRESOLVED',
    };
    const collectEvidence = () => {
      const seen = new Set();
      for (const record of unitJudgments) {
        for (const ref of record.evidenceRefs) {
          if (!seen.has(ref)) {
            seen.add(ref);
            base.evidenceRefs.push(ref);
          }
        }
      }
    };

    if (unitJudgments.length === 0) {
      finalComparisons.push(base);
      continue;
    }

    // PR #2696 B1/B2 remediation: verify evidence credibility of judged
    // units before any verdict. All applicable conditions are collected
    // (deterministic check order below) so the audit trail shows the full
    // picture; if any condition fired, the unit is UNVERIFIED: it stays
    // UNKNOWN with the first condition's reason code and never produces
    // CANDIDATE_BETTER/REFERENCE_BETTER/TIE as a formal result. Historical
    // judgment formats that never carried these fields degrade through the
    // same path (unverified, reason disclosed); historical data is not
    // retro-fitted with synthetic bindings.
    const unitEvidenceProblems = [];
    const unitDupProblems = [];
    let reasonCode = null;
    const flagEvidenceProblem = (entry) => {
      unitEvidenceProblems.push(entry);
      if (reasonCode === null) {
        reasonCode = entry.code;
      }
    };
    // Duplicate-persistence disclosures are recorded but do NOT gate the
    // unit: per the remediation instruction the duplicate does not vote and
    // the remaining valid votes still decide (unless they fall short of the
    // protocol count, handled by the count checks below).
    const flagDupProblem = (entry) => {
      unitDupProblems.push(entry);
      if (reasonCode === null) {
        reasonCode = entry.code;
      }
    };
    const flushUnitEvidenceProblems = () => {
      evidenceProblems.push(...unitEvidenceProblems, ...unitDupProblems);
    };

    // Check set A (B2): judge-slot and attempt identity, and duplicate
    // persistence. Layers kept distinct: a judgeSlotId identifies the
    // pre-registered judge slot, the blindmap carries the A/B display
    // exchange per record, `attempt` numbers model invocations (including
    // failed technical retries, whose recovery policy is upstream), and the
    // final valid judgment is one participating record after this layer.
    // A missing judgeSlotId or attempt is never defaulted: slot independence
    // and attempt identity would be unverifiable, so the unit stays
    // UNKNOWN. Records sharing one (judgeSlotId, attempt) pair are one
    // attempt persisted several times: the duplicate records do not vote
    // (deterministic keep = smallest judgmentId) and are disclosed. Distinct
    // judges legally share attempt=1 because their slots differ.
    const slotMissingIds = unitJudgments.filter((record) => record.judgeSlotId === null).map((record) => record.judgmentId);
    if (slotMissingIds.length > 0) {
      flagEvidenceProblem(evidenceProblem(
        'JUDGE_SLOT_BINDING_MISSING',
        `judged assignment ${assignment.key} has judgment record(s) without a judgeSlotId; slot independence is unverifiable`,
        assignment.key,
        { judgmentIds: slotMissingIds },
      ));
    }
    const attemptMissingIds = unitJudgments.filter((record) => record.attempt === null).map((record) => record.judgmentId);
    if (attemptMissingIds.length > 0) {
      flagEvidenceProblem(evidenceProblem(
        'ATTEMPT_MISSING',
        `judged assignment ${assignment.key} has judgment record(s) without an attempt number; attempt identity is unverifiable and no default is applied`,
        assignment.key,
        { judgmentIds: attemptMissingIds },
      ));
    }
    let participating = unitJudgments;
    if (slotMissingIds.length === 0 && attemptMissingIds.length === 0) {
      const attemptGroups = new Map();
      for (const record of unitJudgments) {
        const dedupKey = `${record.judgeSlotId}\u0000${record.attempt}`;
        if (!attemptGroups.has(dedupKey)) attemptGroups.set(dedupKey, []);
        attemptGroups.get(dedupKey).push(record);
      }
      participating = [];
      const duplicateGroups = [];
      for (const members of attemptGroups.values()) {
        if (members.length === 1) {
          participating.push(members[0]);
          continue;
        }
        const keptFirst = members.slice().sort((a, b) => (a.judgmentId < b.judgmentId ? -1 : a.judgmentId > b.judgmentId ? 1 : 0));
        participating.push(keptFirst[0]);
        duplicateGroups.push({
          judgeSlotId: keptFirst[0].judgeSlotId,
          attempt: keptFirst[0].attempt,
          kept: keptFirst[0].judgmentId,
          dropped: keptFirst.slice(1).map((record) => record.judgmentId),
        });
      }
      if (duplicateGroups.length > 0) {
        flagDupProblem(evidenceProblem(
          'DUPLICATE_ATTEMPT_RECORD',
          `judged assignment ${assignment.key} has duplicate persistence record(s) for the same (judgeSlotId, attempt); duplicates do not vote`,
          assignment.key,
          { groups: duplicateGroups },
        ));
      }
    }

    // CONTRACT 5.2 step 1: verify the judge record count against the
    // preregistered protocol. Votes come from valid judge slots after the
    // identity layer above; the protocol fixes the judgment count, more
    // participating records than preregistered means votes were added after
    // the fact - padding through extra attempt numbers does not bypass this
    // cap (CONTRACT 5.1) - and fewer records keeps the unit UNKNOWN.
    if (planInfo.requiredJudgments !== null && participating.length > planInfo.requiredJudgments) {
      flushUnitEvidenceProblems();
      problems.push(problem('JUDGMENT_COUNT_EXCEEDED', `assignment ${assignment.key} has ${participating.length} participating judgment records, protocol requires ${planInfo.requiredJudgments}`));
      base.reasonCode = 'JUDGMENT_COUNT_EXCEEDED';
      finalComparisons.push(base);
      continue;
    }

    if (planInfo.requiredJudgments !== null && participating.length < planInfo.requiredJudgments) {
      flushUnitEvidenceProblems();
      base.reasonCode = reasonCode !== null ? reasonCode : 'MISSING_JUDGMENTS';
      collectEvidence();
      finalComparisons.push(base);
      continue;
    }

    if (unitEvidenceProblems.length > 0) {
      flushUnitEvidenceProblems();
      base.reasonCode = reasonCode;
      collectEvidence();
      finalComparisons.push(base);
      continue;
    }

    // Check set B (B1): the judged unit must be bound to its pre-registered
    // evidence (both trajectory refs and the expectation profile ref, taken
    // from the plan assignment - the existing fields, referenced not copied).
    const missingRefs = [];
    if (!assignment.candidateTrajectoryRef) missingRefs.push('candidateTrajectoryRef');
    if (!assignment.referenceTrajectoryRef) missingRefs.push('referenceTrajectoryRef');
    if (!assignment.expectationRef) missingRefs.push('expectationRef');
    if (missingRefs.length > 0) {
      flagEvidenceProblem(evidenceProblem(
        'EVIDENCE_BINDING_INCOMPLETE',
        `judged assignment ${assignment.key} is missing pre-registered evidence binding(s): ${missingRefs.join(', ')}`,
        assignment.key,
        { missingRefs },
      ));
    }

    // Records of ONE frozen comparison must share one comparison input.
    // Judgments of the same unit with different comparisonInputDigest values
    // do not belong to the same frozen comparison unless the frozen protocol
    // provides a verifiable display-order-to-digest mapping; no such mapping
    // exists at T4, so differing digests conflict. (Display order itself is
    // carried per record by the blindmap; the digest here is the frozen
    // comparison input identity.)
    const distinctDigests = [...new Set(participating.map((record) => record.comparisonInputDigest))];
    if (distinctDigests.length > 1) {
      flagEvidenceProblem(evidenceProblem(
        'COMPARISON_INPUT_DIGEST_CONFLICT',
        `judged assignment ${assignment.key} has ${distinctDigests.length} distinct comparisonInputDigest values across its judgment records; without a frozen display-order-to-digest mapping they are not one frozen comparison`,
        assignment.key,
        { digests: distinctDigests.slice().sort() },
      ));
    }

    if (unitEvidenceProblems.length > 0) {
      flushUnitEvidenceProblems();
      base.reasonCode = reasonCode;
      collectEvidence();
      finalComparisons.push(base);
      continue;
    }

    // Non-gating duplicate disclosures stay on the record for audit.
    evidenceProblems.push(...unitDupProblems);

    // CONTRACT 5.2 step 2: restore display A/B to candidate/reference. The
    // mapping is per judgment record (SC-09: two exchanges of one unit may
    // be shown in swapped display orders). A missing or conflicting mapping
    // is invalid evidence - never guessed. Duplicates dropped above do not
    // need mappings: they never vote.
    const rolesByRecord = participating.map((record) => blindmapEntries.get(record.judgmentId) ?? null);
    if (rolesByRecord.some((roles) => roles === null)) {
      const missingIds = participating
        .filter((record) => !blindmapEntries.has(record.judgmentId))
        .map((record) => record.judgmentId);
      problems.push(problem('BLINDMAP_MISSING', `no blindmap identity mapping for judgment record(s) ${missingIds.join(', ')} of assignment ${assignment.key}`));
      base.reasonCode = 'BLINDMAP_MISSING';
      finalComparisons.push(base);
      continue;
    }

    const restored = participating.map((record, index) => restoreVerdict(record.displayVerdict, rolesByRecord[index]));
    const allSame = restored.every((verdict) => verdict === restored[0]);

    if (allSame) {
      // CONTRACT 5.2 step 3: all protocol-required judgments agree.
      base.verdict = restored[0];
      base.reasonCode = restored[0] === 'UNKNOWN' ? 'JUDGMENTS_UNKNOWN' : 'CONSISTENT_JUDGMENTS';
      base.resolvedBy = 'CONSISTENT_JUDGMENTS';
      collectEvidence();
      finalComparisons.push(base);
      continue;
    }

    // CONTRACT 5.2 step 4/5: conflict - frozen blind arbitration path. The
    // arbitration must bind every participating record AND their comparison
    // input digests: a later change to any bound record's input invalidates
    // the arbitration (re-verification required), and a unit whose digests
    // never formed one frozen comparison cannot be arbitrated at all.
    const arbitration = arbitrationsByKey.get(assignment.key);
    if (!arbitration) {
      base.reasonCode = 'ARBITRATION_MISSING';
      collectEvidence();
      finalComparisons.push(base);
      continue;
    }
    const boundAll = sortedCopy(arbitration.boundJudgmentIds).join('\u0000')
      === sortedCopy(participating.map((record) => record.judgmentId)).join('\u0000')
      && [...new Set(arbitration.boundComparisonInputDigests)].sort().join('\u0000')
        === [...new Set(participating.map((record) => record.comparisonInputDigest))].sort().join('\u0000');
    if (!boundAll) {
      base.reasonCode = 'ARBITRATION_INCOMPLETE_BINDING';
      collectEvidence();
      finalComparisons.push(base);
      continue;
    }
    if (arbitration.verdict === 'UNKNOWN') {
      base.reasonCode = 'ARBITRATION_UNCERTAIN';
      collectEvidence();
      finalComparisons.push(base);
      continue;
    }
    base.verdict = arbitration.verdict;
    base.reasonCode = 'ARBITRATED';
    base.resolvedBy = 'BLIND_ARBITRATION';
    base.arbitrationRef = arbitration.arbitrationId;
    collectEvidence();
    finalComparisons.push(base);
  }

  return { finalComparisons, problems, evidenceProblems, invalidRecords };
}

// ---------------------------------------------------------------------------
// Two-sided sign threshold k(n, alpha) - CONTRACT section 6.5.
// k is the smallest integer with P(X >= k) <= alpha/2, X ~ Binomial(n, 0.5).
// Exact BigInt tail sums; the double conversion below has relative error
// ~1e-16 while the CONTRACT table margins are >= 1e-4, so comparisons are
// stable for every tabulated (n, alpha) pair.
// ---------------------------------------------------------------------------

function binomialTailAtLeast(n, k) {
  let coefficient = 1n;
  for (let i = 0n; i < BigInt(k); i += 1n) {
    coefficient = (coefficient * (BigInt(n) - i)) / (i + 1n);
  }
  let total = 0n;
  let current = coefficient;
  for (let j = k; j <= n; j += 1) {
    total += current;
    current = (current * BigInt(n - j)) / BigInt(j + 1);
  }
  return total;
}

function twoSidedThreshold(n, alpha) {
  const denominator = 2 ** n;
  const alphaPerDirection = alpha / 2;
  for (let k = 1; k <= n; k += 1) {
    const tail = Number(binomialTailAtLeast(n, k)) / denominator;
    if (tail <= alphaPerDirection) {
      return k;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hierarchy aggregation - CONTRACT sections 6.1/6.2.
// ---------------------------------------------------------------------------

function trialValue(verdict) {
  if (verdict === 'CANDIDATE_BETTER') return 1;
  if (verdict === 'TIE') return 0.5;
  if (verdict === 'REFERENCE_BETTER') return 0;
  return null; // UNKNOWN carries no point value
}

function aggregateChildren(children) {
  // Equal-weight mean at this layer (CONTRACT 6.1); scenario/owner weights
  // are applied by the caller because they come from the plan.
  const lower = children.reduce((sum, node) => sum + node.lower, 0) / children.length;
  const upper = children.reduce((sum, node) => sum + node.upper, 0) / children.length;
  const hasUnknown = children.some((node) => node.hasUnknown);
  const point = hasUnknown ? null : children.reduce((sum, node) => sum + node.point, 0) / children.length;
  return { hasUnknown, point, lower, upper };
}

function buildHierarchy(assignments, verdictByKey, caseToGroup) {
  // trial layer: one node per planned unit, in plan order.
  const trials = assignments.map((assignment) => {
    const comparison = verdictByKey.get(assignment.key);
    const verdict = comparison ? comparison.verdict : 'UNKNOWN'; // missing final stays in the denominator
    const value = trialValue(verdict);
    return {
      assignment,
      verdict,
      isUnknown: value === null,
      node: {
        hasUnknown: value === null,
        point: value === null ? 0 : value,
        lower: value === null ? 0 : value,
        upper: value === null ? 1 : value,
      },
    };
  });

  // opportunity = planned repetitions (and fixed reference combos) of one
  // opportunity of one case; case = planned opportunities; sourceGroup =
  // planned cases of the group; scenario = planned groups of the scenario.
  const opportunityMap = new Map();
  const caseMap = new Map();
  for (const trial of trials) {
    const opportunityKey = `${trial.assignment.caseId}\u0000${trial.assignment.opportunityId}`;
    if (!opportunityMap.has(opportunityKey)) opportunityMap.set(opportunityKey, []);
    opportunityMap.get(opportunityKey).push(trial);
    if (!caseMap.has(trial.assignment.caseId)) caseMap.set(trial.assignment.caseId, []);
    if (!caseMap.get(trial.assignment.caseId).includes(opportunityKey)) {
      caseMap.get(trial.assignment.caseId).push(opportunityKey);
    }
  }
  const opportunityNodes = new Map();
  for (const [opportunityKey, opportunityTrials] of opportunityMap) {
    opportunityNodes.set(opportunityKey, aggregateChildren(opportunityTrials.map((trial) => trial.node)));
  }

  const caseNodes = new Map();
  const caseScenario = new Map();
  for (const [caseId, opportunityKeys] of caseMap) {
    caseNodes.set(caseId, aggregateChildren(opportunityKeys.map((key) => opportunityNodes.get(key))));
    const scenarioId = trials.find((trial) => trial.assignment.caseId === caseId).assignment.scenarioId;
    caseScenario.set(caseId, scenarioId);
  }

  const groupCases = new Map();
  const groupScenario = new Map();
  for (const caseId of caseMap.keys()) {
    const groupId = caseToGroup.get(caseId) ?? null;
    if (!groupCases.has(groupId)) groupCases.set(groupId, []);
    groupCases.get(groupId).push(caseId);
    groupScenario.set(groupId, caseScenario.get(caseId));
  }
  const groupNodes = new Map();
  for (const [groupId, caseIds] of groupCases) {
    groupNodes.set(groupId, {
      groupId,
      scenarioId: groupScenario.get(groupId),
      caseIds,
      containsUnknown: caseIds.some((caseId) => caseNodes.get(caseId).hasUnknown),
      ...aggregateChildren(caseIds.map((caseId) => caseNodes.get(caseId))),
    });
  }

  const scenarioGroups = new Map();
  for (const group of groupNodes.values()) {
    if (!scenarioGroups.has(group.scenarioId)) scenarioGroups.set(group.scenarioId, []);
    scenarioGroups.get(group.scenarioId).push(group);
  }
  const scenarioNodes = new Map();
  for (const [scenarioId, groups] of scenarioGroups) {
    scenarioNodes.set(scenarioId, {
      scenarioId,
      groupIds: groups.map((group) => group.groupId),
      ...aggregateChildren(groups.map((group) => group)),
    });
  }

  return {
    trials,
    opportunityCount: opportunityMap.size,
    caseCount: caseMap.size,
    groups: [...groupNodes.values()],
    scenarioNodes: [...scenarioNodes.values()],
  };
}

function weightedOwnerValue(ownerId, scenarioById, scenarioNodes) {
  let lower = 0;
  let upper = 0;
  let point = 0;
  let hasUnknown = false;
  for (const scenario of scenarioNodes) {
    const declared = scenarioById.get(scenario.scenarioId);
    if (!declared || declared.ownerId !== ownerId) continue;
    lower += declared.weight * scenario.lower;
    upper += declared.weight * scenario.upper;
    if (scenario.hasUnknown) {
      hasUnknown = true;
    } else {
      point += declared.weight * scenario.point;
    }
  }
  return { hasUnknown, point: hasUnknown ? null : point, lower, upper };
}

// ---------------------------------------------------------------------------
// buildAlignmentReport: CONTRACT sections 6.2 + 6.5.
// ---------------------------------------------------------------------------

function validateFinalComparisons(finalComparisons, planInfo, problems) {
  const verdictByKey = new Map();
  let invalidRecords = 0;
  if (!Array.isArray(finalComparisons)) {
    problems.push(problem('INVALID_COMPARISON_RECORD', 'finalComparisons must be an array'));
    return { verdictByKey, invalidRecords: 1 };
  }
  for (const raw of finalComparisons) {
    if (
      !isPlainObject(raw) ||
      !isNonEmptyString(raw.assignmentKey) ||
      !FINAL_VERDICTS.includes(raw.verdict) ||
      !RESOLVED_BY_VALUES.includes(raw.resolvedBy) ||
      !isNonEmptyString(raw.reasonCode) ||
      !isNonEmptyString(raw.judgeProtocolRef)
    ) {
      problems.push(problem('INVALID_COMPARISON_RECORD', `final comparison ${String(raw && raw.assignmentKey)} is malformed`));
      invalidRecords += 1;
      continue;
    }
    if (verdictByKey.has(raw.assignmentKey)) {
      problems.push(problem('DUPLICATE_FINAL_COMPARISON', `duplicate FinalComparison for assignment ${raw.assignmentKey}; refusing to pick either (SC-08)`));
      invalidRecords += 1;
      continue;
    }
    if (planInfo && planInfo.assignments.length > 0) {
      const knownKey = planInfo.assignments.some((assignment) => assignment.key === raw.assignmentKey);
      if (!knownKey) {
        problems.push(problem('EXTRA_COMPARISON_KEY', `FinalComparison references assignment key ${raw.assignmentKey} outside the plan`));
        invalidRecords += 1;
        continue;
      }
    }
    if (planInfo && planInfo.judgeProtocolRef && raw.judgeProtocolRef !== planInfo.judgeProtocolRef) {
      problems.push(problem('WRONG_PROTOCOL_VERSION', `FinalComparison for ${raw.assignmentKey} protocol ${String(raw.judgeProtocolRef)} does not match plan protocol ${planInfo.judgeProtocolRef}`));
      invalidRecords += 1;
      continue;
    }
    verdictByKey.set(raw.assignmentKey, raw);
  }
  return { verdictByKey, invalidRecords };
}

/**
 * Score and decide from FinalComparison records only (CONTRACT 5.2.6).
 *
 * input = { plan, finalComparisons, sourceGroups, problems?, evidenceProblems?, invalidRecords? }
 * returns the CONTRACT 6.2 report extended with the 6.5 decision:
 * { schemaVersion, status, problems, evidenceProblems, pointEstimate,
 *   missingBounds, rankingEligible, rankingQualification, counts,
 *   samplingInterval, bindings, decision }
 *
 * Any structural problem yields status INVALID with numeric fields null;
 * missing plan units stay UNKNOWN (BOUNDED_ONLY) and never shrink the
 * denominator.
 */
export function buildAlignmentReport(input) {
  const problems = [];
  if (!isPlainObject(input)) {
    return {
      schemaVersion: ANALYSIS_VERSION,
      status: 'INVALID',
      problems: [problem('INVALID_REPORT_INPUT', 'buildAlignmentReport input must be an object')],
      evidenceProblems: [],
      pointEstimate: null,
      missingBounds: null,
      rankingEligible: false,
      rankingQualification: {
        eligible: false,
        unmetCriteria: ['REPORT_STATUS_INVALID'],
      },
      counts: null,
      samplingInterval: null,
      bindings: null,
      decision: null,
    };
  }
  if (Array.isArray(input.problems)) {
    for (const entry of input.problems) {
      if (isPlainObject(entry) && isNonEmptyString(entry.code) && isNonEmptyString(entry.message)) {
        problems.push(entry);
      } else {
        problems.push(problem('INVALID_REPORT_INPUT', 'passed-in problems must be {code, message} objects'));
      }
    }
  }
  const externalInvalidRecords = typeof input.invalidRecords === 'number' && Number.isFinite(input.invalidRecords) && input.invalidRecords >= 0
    ? Math.floor(input.invalidRecords)
    : 0;

  // Evidence problems (PR #2696 B1/B2 remediation) are disclosures of
  // unverified evidence; they never invalidate the run, but they must be
  // well-formed so the audit trail stays machine-readable.
  const evidenceProblems = [];
  if (input.evidenceProblems !== undefined) {
    if (!Array.isArray(input.evidenceProblems)) {
      problems.push(problem('INVALID_REPORT_INPUT', 'evidenceProblems must be an array when present'));
    } else {
      for (const entry of input.evidenceProblems) {
        if (isPlainObject(entry) && isNonEmptyString(entry.code) && isNonEmptyString(entry.message)) {
          evidenceProblems.push({
            code: entry.code,
            message: entry.message,
            assignmentKey: isNonEmptyString(entry.assignmentKey) ? entry.assignmentKey : null,
            ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
          });
        } else {
          problems.push(problem('INVALID_REPORT_INPUT', 'passed-in evidenceProblems must be {code, message, assignmentKey?} objects'));
        }
      }
    }
  }

  const validated = validateFullPlan(input.plan, input.sourceGroups);
  problems.push(...validated.problems);
  const structure = validated.structure;
  const planInfo = structure ? structure.planInfo : null;

  const comparisonValidation = validateFinalComparisons(input.finalComparisons, planInfo, problems);
  const invalidRecords = externalInvalidRecords + comparisonValidation.invalidRecords;

  if (problems.length > 0 || !structure || !planInfo || structure.comparisonDesign === null) {
    return invalidReport(problems, invalidRecords, input);
  }

  const hierarchy = buildHierarchy(planInfo.assignments, comparisonValidation.verdictByKey, structure.caseToGroup);

  // Owner layer with plan-frozen weights, then the score.
  const ownerValues = [...structure.ownerWeight.keys()].map((ownerId) => ({
    ownerId,
    weight: structure.ownerWeight.get(ownerId),
    ...weightedOwnerValue(ownerId, structure.scenarioById, hierarchy.scenarioNodes),
  }));
  const hasUnknown = ownerValues.some((owner) => owner.hasUnknown);
  const lower = ownerValues.reduce((sum, owner) => sum + owner.weight * owner.lower, 0);
  const upper = ownerValues.reduce((sum, owner) => sum + owner.weight * owner.upper, 0);
  const point = hasUnknown ? null : ownerValues.reduce((sum, owner) => sum + owner.weight * owner.point, 0);

  const status = hasUnknown ? 'BOUNDED_ONLY' : 'ESTIMABLE';
  // PR #2696 B3 remediation (Owner instruction 2026-11-17): three concepts
  // stay separated. `status`/ESTIMABLE means ONLY that every planned unit
  // has a computable point value. Formal ranking eligibility is judged
  // independently and requires credentials this offline task cannot verify
  // (judge calibration, frozen analysis policy for the clustered bootstrap,
  // preregistered minimumIndependentSourceGroups, cross-version
  // comparability, research admission status, source-group independence
  // evidence). At T4 none of these credentials exist, so rankingEligible is
  // false and every unmet criterion is disclosed honestly in
  // rankingQualification. Nothing here fabricates a passed state. The
  // descriptive CHANGE_VS_BASELINE decision below is independent of this
  // gate; Owner promotion is a governance-gate decision that appears in
  // none of these fields.
  const unmetCriteria = [
    'JUDGE_CALIBRATION_NOT_VERIFIED',
    'ANALYSIS_POLICY_BOOTSTRAP_NOT_FROZEN',
    'MINIMUM_INDEPENDENT_SOURCE_GROUPS_NOT_PREREGISTERED',
    'VERSION_COMPARABILITY_NOT_VERIFIED',
    'RESEARCH_ADMISSION_NOT_VERIFIED',
    'SOURCE_GROUP_INDEPENDENCE_NOT_VERIFIED',
  ];
  // PR #2696 B5 remediation: source-group independence EVIDENCE. The
  // structural validity of the mapping is enforced above (SC-12/SC-19);
  // separately, CONTRACT section 3 requires every published source group to
  // carry its grouping rationale. A missing rationale does not invalidate
  // the offline computation (all synthetic numbers stay computable), but it
  // is disclosed as an unmet formal-qualification criterion with the
  // affected groups named. Per-session independence itself remains the
  // upstream admission responsibility (T7a); at T4 it is always declared
  // unverified via SOURCE_GROUP_INDEPENDENCE_NOT_VERIFIED, and nothing here
  // may re-interpret the frozen groups as additional independent samples.
  const usedGroupIds = [...new Set(structure.caseToGroup.values())].sort();
  const publishedRationales = isPlainObject(input.sourceGroups) && isPlainObject(input.sourceGroups.rationales)
    ? input.sourceGroups.rationales
    : null;
  const rationaleMissingGroups = usedGroupIds.filter((groupId) => !(publishedRationales && isNonEmptyString(publishedRationales[groupId])));
  if (rationaleMissingGroups.length > 0) {
    unmetCriteria.push('SOURCE_GROUP_RATIONALE_MISSING');
  }
  const report = {
    schemaVersion: ANALYSIS_VERSION,
    benchmarkId: isNonEmptyString(input.plan.benchmarkId) ? input.plan.benchmarkId : null,
    benchmarkVersion: isNonEmptyString(input.plan.benchmarkVersion) ? input.plan.benchmarkVersion : null,
    comparisonDesign: structure.comparisonDesign,
    status,
    problems,
    evidenceProblems,
    pointEstimate: point === null ? null : 100 * point,
    missingBounds: { lower: 100 * lower, upper: 100 * upper },
    rankingEligible: false,
    rankingQualification: {
      eligible: false,
      unmetCriteria,
      ...(rationaleMissingGroups.length > 0 ? { rationaleMissingGroups } : {}),
    },
    counts: {
      planned: planInfo.assignments.length,
      resolved: hierarchy.trials.filter((trial) => !trial.isUnknown).length,
      unknown: hierarchy.trials.filter((trial) => trial.isUnknown).length,
      invalidRecords,
      opportunities: hierarchy.opportunityCount,
      cases: hierarchy.caseCount,
      sourceGroups: hierarchy.groups.length,
      scenarios: hierarchy.scenarioNodes.length,
      owners: ownerValues.length,
    },
    // The clustered bootstrap of CONTRACT 6.3 needs a frozen analysis policy
    // (seed, replicates, method, level); it is out of scope for the offline
    // task, so no interval is claimed here.
    samplingInterval: {
      status: 'NOT_ESTIMABLE',
      method: 'CLUSTERED_BOOTSTRAP_SOURCE_GROUPS',
      level: null,
      lower: null,
      upper: null,
      reason: 'ANALYSIS_POLICY_BOOTSTRAP_NOT_FROZEN_OFFLINE',
    },
    bindings: {
      planDigest: digestOf(input.plan),
      comparisonsDigest: digestOf(input.finalComparisons),
      analysisVersion: ANALYSIS_VERSION,
      referenceVersion: isNonEmptyString(input.plan.referenceVersion) ? input.plan.referenceVersion : null,
    },
    decision: null,
  };

  if (structure.comparisonDesign === 'CHANGE_VS_BASELINE') {
    report.decision = buildDecision(structure, hierarchy);
  }
  return report;
}

function invalidReport(problems, invalidRecords, input) {
  return {
    schemaVersion: ANALYSIS_VERSION,
    benchmarkId: isPlainObject(input) && isPlainObject(input.plan) && isNonEmptyString(input.plan.benchmarkId) ? input.plan.benchmarkId : null,
    benchmarkVersion: isPlainObject(input) && isPlainObject(input.plan) && isNonEmptyString(input.plan.benchmarkVersion) ? input.plan.benchmarkVersion : null,
    comparisonDesign: isPlainObject(input) && isPlainObject(input.plan) && COMPARISON_DESIGNS.includes(input.plan.comparisonDesign) ? input.plan.comparisonDesign : null,
    status: 'INVALID',
    problems,
    evidenceProblems: [],
    pointEstimate: null,
    missingBounds: null,
    rankingEligible: false,
    rankingQualification: {
      eligible: false,
      unmetCriteria: ['REPORT_STATUS_INVALID'],
    },
    counts: { invalidRecords },
    samplingInterval: null,
    bindings: null,
    decision: null,
  };
}

function classifyGroup(group) {
  if (group.lower > 0.5) return 'DEFINITE_WIN';
  if (group.upper < 0.5) return 'DEFINITE_LOSS';
  return 'UNDETERMINED';
}

/** CONTRACT section 6.5 decision over planned source groups, equal weight. */
function buildDecision(structure, hierarchy) {
  const alpha = structure.alpha;
  const unitsByGroup = new Map();
  for (const trial of hierarchy.trials) {
    const groupId = structure.caseToGroup.get(trial.assignment.caseId) ?? null;
    if (!unitsByGroup.has(groupId)) unitsByGroup.set(groupId, 0);
    unitsByGroup.set(groupId, unitsByGroup.get(groupId) + 1);
  }
  // PR #2696 B6: `groups` is a DERIVED DIAGNOSTIC detail kept for Owner
  // audit (each group's [lower_g, upper_g], unknown containment and
  // classification). It is fully recomputable from the plan +
  // FinalComparison records via the same 6.1 aggregation; it is NOT an
  // independent statistical result and carries no decision authority of
  // its own - the decision fields above (definiteWins/definiteLosses/
  // undetermined/outcome) are the authoritative counts derived from it.
  const groups = hierarchy.groups.map((group) => ({
    sourceGroupId: group.groupId,
    scenarioId: group.scenarioId,
    plannedUnits: unitsByGroup.get(group.groupId) ?? 0,
    lower: group.lower,
    upper: group.upper,
    containsUnknown: group.containsUnknown,
    classification: classifyGroup(group),
  }));

  const definiteWins = groups.filter((group) => group.classification === 'DEFINITE_WIN').length;
  const definiteLosses = groups.filter((group) => group.classification === 'DEFINITE_LOSS').length;
  const undetermined = groups.filter((group) => group.classification === 'UNDETERMINED').length;
  const n = groups.length;
  const threshold = twoSidedThreshold(n, alpha);

  let outcome = 'INCONCLUSIVE';
  if (threshold !== null) {
    if (definiteWins >= threshold) outcome = 'IMPROVED';
    else if (definiteLosses >= threshold) outcome = 'REGRESSION';
  }

  let unknownsCouldChangeVerdict = null;
  if (outcome === 'INCONCLUSIVE') {
    if (threshold === null) {
      // No k <= n exists at this n and alpha: no resolution of the unknowns
      // can reach significance, so more evidence cannot change the verdict.
      unknownsCouldChangeVerdict = false;
    } else {
      const winsIfAllFavor = definiteWins
        + groups.filter((group) => group.classification === 'UNDETERMINED' && group.containsUnknown && group.upper > 0.5).length;
      const lossesIfAllFavor = definiteLosses
        + groups.filter((group) => group.classification === 'UNDETERMINED' && group.containsUnknown && group.lower < 0.5).length;
      unknownsCouldChangeVerdict = winsIfAllFavor >= threshold || lossesIfAllFavor >= threshold;
    }
  }

  return {
    design: 'CHANGE_VS_BASELINE',
    alpha,
    alphaPerDirection: alpha / 2,
    plannedGroups: n,
    definiteWins,
    definiteLosses,
    undetermined,
    threshold,
    outcome,
    unknownsCouldChangeVerdict,
    guardrailBreaches: structure.guardrailBreaches,
    groups,
  };
}
