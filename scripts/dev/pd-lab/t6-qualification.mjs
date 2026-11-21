// PD-Lab v0.3 T7a qualification gate (PRI-1258): the mechanical three-state
// T6 qualification engine of SPEC-PD-LAB-EXPERIMENT-INTEGRATION-001 v0.3
// section 11 (R2) and HANDOFF task T7a items 4-5 / DT-08 / DT-09.
//
//   BLOCKED            authorization or data-integrity unqualified, n = 0,
//                      D2/D5/D6 not approved, evidence missing or
//                      contradicting a claim, a status/count conflict, or
//                      the live judge-model calibration did not run or
//                      failed. T6 must not start.
//   EXPLORATORY_ONLY   authorizations and live calibration passed, but n is
//                      below n_min(alpha) or the preregistered minimum
//                      independent source groups, the precision target is
//                      unmet, or the Owner blind review has not passed.
//                      Exploratory T6 needs an explicit D2 exploratory
//                      approval and can never produce a PROMOTE.
//   CONFIRMATORY_READY everything above passed AND
//                      n >= max(n_min(alpha), minimumIndependentSourceGroups)
//                      and the preregistered precision target is met.
//
// Design rules frozen here:
//   - the verdict is a PURE FUNCTION of the explicit input record plus the
//     resolved evidence documents handed in by the CLI; nothing is inferred,
//     defaulted or read from the environment/filesystem/clock; the full
//     input is echoed in the output so the verdict is mechanically
//     recomputable (acceptance: 三种资格状态可以从原始输入机械复算);
//   - n counts READY INDEPENDENT SOURCE GROUPS for the T6 path — never Pain
//     counts, repetitions or judgment votes (CONTRACT 6.5). When the source
//     groups artifact and the admission report are bound as evidence, n is
//     DERIVED mechanically (every case of a group READY on every T6-required
//     path AND COMPLETE_FOR_ANALYSIS) and compared to the declared count —
//     a mismatch rejects the claim, never trusts the declared number;
//   - k(n, alpha) and n_min(alpha) reuse T4's exact BigInt two-sided
//     threshold (alignment-report.twoSidedThreshold) — one statistical
//     authority; the default 6 is never hardcoded for other alphas;
//   - without D2 the recorded real model call count MUST be 0 and without
//   D5 the Owner blind-review sample count MUST be 0 — a nonzero count is
//     reported as an authorization violation (task stop condition), never
//     silently accepted;
//   - status/count pairs must be internally consistent: PASSED with 0
//     calls/samples is rejected, NOT_RUN with a nonzero count is rejected,
//     FAILED is never treated as passed (failed invocations stay audit
//     evidence, not votes);
//   - approvals are never bare booleans standing in for an approval record:
//     an affirmative D2/D5/D6 claim requires a bound structured approval
//     record ({kind:"owner-decision", approved, decidedBy, decidedAt,
//     scope}) — provenance that local verification cannot authenticate is
//     disclosed as AUTHORITY_PROVENANCE_UNVERIFIED, never silently verified;
//   - alpha, minimumIndependentSourceGroups and the precision target come
//     from the FROZEN preregistration evidence when it is bound; drift
//     between declared and registered values rejects the input;
//   - alpha comes from the D2-frozen analysis policy; changing it is a
//     protocol version change, and the output echoes it so drift is visible.
//
// Exports:
//   QUALIFICATION_STATUSES, CALIBRATION_STATUSES,
//   QUALIFICATION_REASON_CODES, QUALIFICATION_DISCLOSURE_CODES,
//   EVIDENCE_ARTIFACT_KEYS, nMinForAlpha(alpha),
//   validateQualificationInput(input),
//   qualifyT6(input, resolvedEvidence?)

import { twoSidedThreshold } from "./alignment-report.mjs";
import { JUDGE_PROTOCOL_REF, judgeProtocolDigest } from "./judge-protocol.mjs";

export const QUALIFICATION_STATUSES = Object.freeze([
  "BLOCKED",
  "EXPLORATORY_ONLY",
  "CONFIRMATORY_READY",
]);

export const CALIBRATION_STATUSES = Object.freeze([
  "NOT_RUN",
  "PASSED",
  "FAILED",
]);

// The T6 retrospective needs the full trajectory, the expectation basis and
// the behavior branch — a source group is READY only when EVERY case mapped
// to it is READY on every required path AND COMPLETE_FOR_ANALYSIS.
export const T6_REQUIRED_PATHS = Object.freeze([
  "PIPELINE_REPLAY",
  "EXPECTATION_LABELING",
  "BEHAVIOR_BRANCH",
]);

// Evidence artifact keys the input.evidence block may bind (each bound as
// {artifactRef, sha256}). Approvals live one level deeper under
// evidence.approvals.{d2,d5,d6}.
export const EVIDENCE_ARTIFACT_KEYS = Object.freeze([
  "sourceGroups",
  "admissionReport",
  "preregistration",
  "judgeCalibration",
  "ownerBlindReview",
]);
const APPROVAL_KEYS = ["d2", "d5", "d6"];
const EVIDENCE_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

// Closed reason-code set (ERR-146: every code is triggerable in tests, no
// unlisted code is ever emitted).
export const QUALIFICATION_REASON_CODES = Object.freeze([
  // BLOCKED reasons (any one blocks T6).
  "DATA_PATH_AUTHORIZATION_INVALID",
  "DATA_INTEGRITY_UNPROVEN",
  "NO_READY_SOURCE_GROUPS",
  "D2_NOT_APPROVED",
  "D5_NOT_APPROVED",
  "D6_NOT_APPROVED",
  "MODEL_CALIBRATION_NOT_RUN",
  "MODEL_CALIBRATION_FAILED",
  // Authorization violations (task stop conditions, fail-loud disclosures).
  "UNAUTHORIZED_MODEL_CALLS_RECORDED",
  "UNAUTHORIZED_OWNER_BLIND_REVIEW_RECORDED",
  // Status/count consistency (an illegal pair is a rejected claim, not a
  // runtime failure).
  "CALIBRATION_STATUS_COUNT_CONFLICT",
  "OWNER_REVIEW_STATUS_COUNT_CONFLICT",
  // Evidence binding (an affirmative claim must be backed by a bound,
  // verified artifact whose derived fact matches the declared one).
  "EVIDENCE_MISSING_FOR_CLAIM",
  "EVIDENCE_ARTIFACT_INVALID",
  "EVIDENCE_CLAIM_MISMATCH",
  "PREREGISTRATION_DRIFT",
  // EXPLORATORY_ONLY unmet confirmatory criteria.
  "BELOW_N_MIN_ALPHA",
  "BELOW_PREREGISTERED_MIN_SOURCE_GROUPS",
  "PRECISION_TARGET_NOT_MET",
  "OWNER_BLIND_REVIEW_NOT_PASSED",
]);

// Non-blocking disclosure codes — an approval record verified byte-exact
// against its declared digest proves LOCAL integrity, never the external
// approver's authenticity; that provenance limit is disclosed honestly.
export const QUALIFICATION_DISCLOSURE_CODES = Object.freeze([
  "AUTHORITY_PROVENANCE_UNVERIFIED",
]);

// 2^-n underflows below every practical alpha/2 long before this bound; the
// cap only exists so a bogus alpha cannot loop forever.
const N_MIN_SEARCH_CAP = 1024;

/**
 * n_min(alpha): the smallest number of independent source groups at which
 * the two-sided sign test is first REACHABLE (k(n, alpha) exists with
 * k <= n), derived from the CONTRACT 6.5 formula — never hardcoded. At the
 * default alpha = 0.05 this is 6 (all six groups must be definite wins).
 */
export function nMinForAlpha(alpha) {
  if (
    typeof alpha !== "number" ||
    !Number.isFinite(alpha) ||
    alpha <= 0 ||
    alpha >= 1
  ) {
    throw new Error(
      `nMinForAlpha: alpha must be a finite number in (0,1), got ${String(alpha)}`,
    );
  }
  for (let n = 1; n <= N_MIN_SEARCH_CAP; n += 1) {
    if (twoSidedThreshold(n, alpha) !== null) return n;
  }
  return null; // unreachable for valid alpha; kept for closed-set honesty
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoolean(value) {
  return typeof value === "boolean";
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function evidenceEntryProblem(entry, label) {
  if (!isPlainObject(entry)) return `${label} must be an object`;
  if (!isNonEmptyString(entry.artifactRef))
    return `${label}.artifactRef must be a non-empty string`;
  if (
    typeof entry.sha256 !== "string" ||
    !EVIDENCE_DIGEST_RE.test(entry.sha256)
  )
    return `${label}.sha256 must match sha256:<64 lowercase hex> — the declared digest is verified against the artifact's actual bytes, never trusted`;
  return null;
}

/**
 * Structural validation of the qualification input record. Every field is
 * explicit — the engine never guesses a default for a governance fact.
 * Returns { ok, problems: [string] }.
 */
export function validateQualificationInput(input) {
  const problems = [];
  const complain = (message) => problems.push(message);
  if (!isPlainObject(input)) {
    return { ok: false, problems: ["input must be an object"] };
  }
  if (!isNonNegativeInteger(input.readyIndependentSourceGroups)) {
    complain(
      "readyIndependentSourceGroups must be an integer >= 0 (READY independent source groups for the T6 path — never Pain counts or votes)",
    );
  }
  const policy = input.analysisPolicy;
  if (!isPlainObject(policy)) {
    complain("analysisPolicy must be an object");
  } else {
    if (
      typeof policy.alpha !== "number" ||
      !Number.isFinite(policy.alpha) ||
      policy.alpha <= 0 ||
      policy.alpha >= 1
    ) {
      complain(
        "analysisPolicy.alpha must be a finite number in (0,1) — the D2-frozen two-sided significance level, no default is applied",
      );
    }
    if (!isPositiveInteger(policy.minimumIndependentSourceGroups)) {
      complain(
        "analysisPolicy.minimumIndependentSourceGroups must be an integer >= 1 (the D2-frozen preregistered minimum)",
      );
    }
    if (!isBoolean(policy.precisionTargetMet)) {
      complain(
        "analysisPolicy.precisionTargetMet must be an explicit boolean — an unproven precision target is recorded as false, never assumed",
      );
    }
  }
  const authorization = input.authorization;
  if (!isPlainObject(authorization)) {
    complain("authorization must be an object");
  } else {
    for (const field of [
      "dataPathAuthorizationValid",
      "dataIntegrityValid",
      "d2Approved",
      "d5Approved",
    ]) {
      if (!isBoolean(authorization[field])) {
        complain(
          `authorization.${field} must be an explicit boolean (unproven authorization facts are recorded as false, never assumed)`,
        );
      }
    }
    if (
      authorization.d6Approved !== undefined &&
      !isBoolean(authorization.d6Approved)
    ) {
      complain("authorization.d6Approved must be a boolean when present");
    }
  }
  const calibration = input.judgeModelCalibration;
  if (!isPlainObject(calibration)) {
    complain("judgeModelCalibration must be an object");
  } else {
    if (!CALIBRATION_STATUSES.includes(calibration.status)) {
      complain(
        `judgeModelCalibration.status must be one of ${CALIBRATION_STATUSES.join(" | ")}`,
      );
    }
    if (!isNonNegativeInteger(calibration.modelCallCount)) {
      complain(
        "judgeModelCalibration.modelCallCount must be an integer >= 0 (the ACTUAL real model call count; 0 without D2)",
      );
    }
  }
  const review = input.ownerBlindReview;
  if (!isPlainObject(review)) {
    complain("ownerBlindReview must be an object");
  } else {
    if (!CALIBRATION_STATUSES.includes(review.status)) {
      complain(
        `ownerBlindReview.status must be one of ${CALIBRATION_STATUSES.join(" | ")}`,
      );
    }
    if (!isNonNegativeInteger(review.sampleCount)) {
      complain(
        "ownerBlindReview.sampleCount must be an integer >= 0 (the ACTUAL Owner blind-review count; 0 without D5)",
      );
    }
  }
  if (
    input.d2ExploratoryApproval !== undefined &&
    !isBoolean(input.d2ExploratoryApproval)
  ) {
    complain("d2ExploratoryApproval must be a boolean when present");
  }
  // Optional evidence bindings: every governed fact may carry the artifact
  // it is derived from ({artifactRef, sha256}). The declared sha256 is
  // verified against the artifact's actual bytes by the CLI — a declared
  // digest is never trusted on its own.
  if (input.evidence !== undefined) {
    if (!isPlainObject(input.evidence)) {
      complain("evidence must be an object when present");
    } else {
      for (const key of EVIDENCE_ARTIFACT_KEYS) {
        if (input.evidence[key] !== undefined) {
          const problem = evidenceEntryProblem(
            input.evidence[key],
            `evidence.${key}`,
          );
          if (problem) complain(problem);
        }
      }
      if (input.evidence.approvals !== undefined) {
        if (!isPlainObject(input.evidence.approvals)) {
          complain("evidence.approvals must be an object");
        } else {
          for (const key of APPROVAL_KEYS) {
            if (input.evidence.approvals[key] !== undefined) {
              const problem = evidenceEntryProblem(
                input.evidence.approvals[key],
                `evidence.approvals.${key}`,
              );
              if (problem) complain(problem);
            }
          }
        }
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

// ─── Evidence derivations (pure: documents -> facts) ────────────────────────

// A structured approval record — never a bare boolean (P0-1 §3.2.6). The
// shape follows the established owner-decision.json precedent.
function approvalFromRecord(document, expectedScope) {
  if (!isPlainObject(document) || document.kind !== "owner-decision")
    return { interpretable: false, approved: false };
  // The decision's scope must match the evidence slot it is bound to — a
  // D5 approval record cannot be re-read as a D2 authorization.
  if (
    typeof document.approved !== "boolean" ||
    !isNonEmptyString(document.decidedBy) ||
    !isNonEmptyString(document.decidedAt) ||
    !isNonEmptyString(document.scope) ||
    document.scope !== expectedScope
  )
    return { interpretable: false, approved: false };
  return { interpretable: true, approved: document.approved };
}

// n derived mechanically from the bound source-groups artifact cross-checked
// against the bound admission report: a group is READY iff every case mapped
// to it is READY on every T6-required path AND COMPLETE_FOR_ANALYSIS. The
// mapping must be bound to the probed dataset (datasetSha256).
function deriveReadySourceGroups(sourceGroupsDoc, admissionDoc) {
  const fail = { interpretable: false };
  if (
    !isPlainObject(sourceGroupsDoc) ||
    sourceGroupsDoc.schema !== "pd-lab-source-groups.v1" ||
    !isPlainObject(sourceGroupsDoc.groups)
  )
    return fail;
  if (
    !isPlainObject(admissionDoc) ||
    admissionDoc.schema !== "pd-lab-admission-report.v1" ||
    !Array.isArray(admissionDoc.perSample)
  )
    return fail;
  if (
    !isNonEmptyString(sourceGroupsDoc.datasetSha256) ||
    sourceGroupsDoc.datasetSha256 !== admissionDoc.dataset?.sha256
  )
    return { interpretable: false, datasetBindingMismatch: true };
  // The mapping must also be the grouping the admission run actually
  // recorded — two well-formed files for the same dataset can still carry
  // different merge decisions, and both layers of the binding must hold.
  if (
    !isNonEmptyString(sourceGroupsDoc.digest) ||
    !isNonEmptyString(admissionDoc.sourceGroups?.digest) ||
    sourceGroupsDoc.digest !== admissionDoc.sourceGroups.digest
  )
    return { interpretable: false, groupingBindingMismatch: true };
  const perSample = new Map();
  for (const entry of admissionDoc.perSample) {
    if (isPlainObject(entry) && isNonEmptyString(entry.caseId))
      perSample.set(entry.caseId, entry);
  }
  const groupCases = new Map();
  for (const [caseId, groupId] of Object.entries(sourceGroupsDoc.groups)) {
    if (!isNonEmptyString(groupId) || !isNonEmptyString(caseId)) return fail;
    if (!groupCases.has(groupId)) groupCases.set(groupId, []);
    groupCases.get(groupId).push(caseId);
  }
  const groupIds = [...groupCases.keys()].sort();
  const readyGroups = [];
  for (const groupId of groupIds) {
    const ready = groupCases.get(groupId).every((caseId) => {
      const entry = perSample.get(caseId);
      return (
        entry !== undefined &&
        entry.completeness === "COMPLETE_FOR_ANALYSIS" &&
        isPlainObject(entry.pathReadiness) &&
        T6_REQUIRED_PATHS.every((p) => entry.pathReadiness[p] === "READY")
      );
    });
    if (ready) readyGroups.push(groupId);
  }
  return {
    interpretable: true,
    count: readyGroups.length,
    readyGroupIds: readyGroups,
    totalGroupIds: groupIds,
  };
}

// Live calibration report: status + the ACTUAL invocation count (failed
// invocations stay in the audit count — they happened).
function deriveCalibrationFacts(document) {
  if (
    !isPlainObject(document) ||
    document.schema !== "pd-lab-judge-calibration.v1" ||
    !CALIBRATION_STATUSES.includes(document.status) ||
    !Array.isArray(document.invocations)
  )
    return { interpretable: false };
  // Calibration evidence = unique SUCCEEDED invocations. Failed calls stay
  // in auditCallCount — they happened and are auditable, but they are not
  // calibration success evidence: PASSED requires real successful calls.
  const succeededIds = new Set();
  let invocationCount = 0;
  for (const invocation of document.invocations) {
    if (
      isPlainObject(invocation) &&
      isNonEmptyString(invocation.invocationId) &&
      invocation.status === "SUCCEEDED"
    )
      succeededIds.add(invocation.invocationId);
    invocationCount += 1;
  }
  return {
    interpretable: true,
    status: document.status,
    modelCallCount: succeededIds.size,
    auditCallCount: invocationCount,
    precisionTarget:
      typeof document.precisionTarget === "number" &&
      Number.isFinite(document.precisionTarget)
        ? document.precisionTarget
        : null,
    precisionTargetMet:
      typeof document.precisionTargetMet === "boolean"
        ? document.precisionTargetMet
        : null,
  };
}

// Owner blind-review report: status + deduped valid sample count.
function deriveOwnerReviewFacts(document) {
  if (
    !isPlainObject(document) ||
    document.schema !== "pd-lab-owner-blind-review.v1" ||
    !CALIBRATION_STATUSES.includes(document.status) ||
    !Array.isArray(document.samples)
  )
    return { interpretable: false };
  const sampleIds = new Set();
  for (const sample of document.samples) {
    if (isPlainObject(sample) && isNonEmptyString(sample.sampleId))
      sampleIds.add(sample.sampleId);
  }
  return {
    interpretable: true,
    status: document.status,
    sampleCount: sampleIds.size,
  };
}

// Frozen preregistration: the D2-registered analysis parameters — alpha, the
// minimum independent source groups, and the exploratory marker.
function derivePreregistrationFacts(document) {
  if (
    !isPlainObject(document) ||
    document.schema !== "pd-lab-t6-preregistration.v1" ||
    !isPlainObject(document.analysisPolicy)
  )
    return { interpretable: false };
  const policy = document.analysisPolicy;
  if (
    typeof policy.alpha !== "number" ||
    !Number.isFinite(policy.alpha) ||
    policy.alpha <= 0 ||
    policy.alpha >= 1 ||
    !isPositiveInteger(policy.minimumIndependentSourceGroups)
  )
    return { interpretable: false };
  return {
    interpretable: true,
    alpha: policy.alpha,
    minimumIndependentSourceGroups: policy.minimumIndependentSourceGroups,
    exploratory: document.exploratory === true,
    precisionTarget:
      typeof policy.precisionTarget === "number" &&
      Number.isFinite(policy.precisionTarget)
        ? policy.precisionTarget
        : null,
  };
}

// Data-path authorization derives from the D6 approval AND an admission
// report that actually ran over real data (realDataProbe is flipped only by
// a D6-authorized run; it can never be claimed by a fixture run).
function deriveDataPathAuthorization(d6Approved, admissionDoc) {
  if (!d6Approved) return false;
  if (
    !isPlainObject(admissionDoc) ||
    admissionDoc.schema !== "pd-lab-admission-report.v1" ||
    !isPlainObject(admissionDoc.realDataProbe) ||
    !isNonEmptyString(admissionDoc.realDataProbe.status)
  )
    return false;
  // Fail-closed on the agreed positive state only — NOT_RUN_WITHOUT_D6 is
  // rejected, and so is any other value the producer never agreed to emit.
  return admissionDoc.realDataProbe.status === "RAN_WITH_D6";
}

// Data integrity is proven only by a verified admission report whose
// snapshot consistency holds within the declared window and whose
// scoring-plan validation produced no invalidPlan reasons.
function deriveDataIntegrity(admissionDoc) {
  if (
    !isPlainObject(admissionDoc) ||
    admissionDoc.schema !== "pd-lab-admission-report.v1"
  )
    return false;
  return (
    admissionDoc.ok === true &&
    admissionDoc.snapshot?.consistencyStatus === "CONSISTENT_WITHIN_WINDOW" &&
    Array.isArray(admissionDoc.invalidPlan) &&
    admissionDoc.invalidPlan.length === 0
  );
}

function boundArtifact(resolvedEvidence, key) {
  const entry = resolvedEvidence?.[key];
  return isPlainObject(entry) && "document" in entry ? entry : null;
}

/**
 * Compute the T6 qualification verdict. Pure: same inputs -> same output.
 * `resolvedEvidence` (optional) carries the evidence documents the CLI has
 * already fetched and byte-verified against their declared digests:
 *   { [key]: { artifactRef, sha256, document }, approvals: { d2, d5, d6 } }
 * An affirmative claim without a bound, verified artifact is never trusted.
 */
export function qualifyT6(input, resolvedEvidence = null) {
  const validation = validateQualificationInput(input);
  if (!validation.ok) {
    return {
      ok: false,
      status: null,
      inputProblems: validation.problems,
      message:
        "qualification input is structurally invalid — the engine never guesses governance facts; fix the input record",
    };
  }
  const policy = input.analysisPolicy;
  const authorization = input.authorization;
  const calibration = input.judgeModelCalibration;
  const review = input.ownerBlindReview;
  const declaredN = input.readyIndependentSourceGroups;
  const evidenceBindings = isPlainObject(input.evidence) ? input.evidence : {};
  const approvalBindings = isPlainObject(evidenceBindings.approvals)
    ? evidenceBindings.approvals
    : {};

  const blockedReasons = [];
  const addBlocked = (code) => {
    if (!blockedReasons.includes(code)) blockedReasons.push(code);
  };
  const disclosures = [];
  const evidenceCheck = {
    rule: "every affirmative claim must be backed by a bound artifact whose bytes hash to the declared sha256 and whose content derives the claimed fact",
    artifacts: {},
    approvalArtifacts: {},
  };

  // ── Derived evidence facts ───────────────────────────────────────────────
  const bound = (key) =>
    evidenceBindings[key] !== undefined ? boundArtifact(resolvedEvidence, key) : null;
  const boundApproval = (key) =>
    approvalBindings[key] !== undefined
      ? boundArtifact(resolvedEvidence?.approvals, key)
      : null;

  const d2Approval = boundApproval("d2")
    ? approvalFromRecord(boundApproval("d2").document, "d2")
    : null;
  const d5Approval = boundApproval("d5")
    ? approvalFromRecord(boundApproval("d5").document, "d5")
    : null;
  const d6Approval = boundApproval("d6")
    ? approvalFromRecord(boundApproval("d6").document, "d6")
    : null;
  const admission = bound("admissionReport");
  const sourceGroups = bound("sourceGroups");
  const calibrationDoc = bound("judgeCalibration");
  const reviewDoc = bound("ownerBlindReview");
  const preregistration = bound("preregistration");

  const calibrationFacts = calibrationDoc
    ? deriveCalibrationFacts(calibrationDoc.document)
    : null;
  const reviewFacts = reviewDoc ? deriveOwnerReviewFacts(reviewDoc.document) : null;
  const preregFacts = preregistration
    ? derivePreregistrationFacts(preregistration.document)
    : null;
  const groupFacts =
    sourceGroups && admission
      ? deriveReadySourceGroups(sourceGroups.document, admission.document)
      : null;
  const derivedIntegrity = admission
    ? deriveDataIntegrity(admission.document)
    : null;

  const compare = (label, declared, derived, interpretable) => {
    const check = { declared, derived, interpretable, verdict: "not_bound" };
    if (derived === undefined || derived === null) {
      check.verdict = interpretable === false ? "artifact_invalid" : "not_bound";
      return check;
    }
    if (interpretable === false) {
      check.verdict = "artifact_invalid";
      return check;
    }
    check.verdict = declared === derived ? "match" : "mismatch";
    return check;
  };

  // ── D2 / D5 / D6 approvals: structured records, never bare booleans ─────
  const approvalEffective = (key, declaredValue, approval) => {
    const boundEntry = boundApproval(key);
    if (approvalBindings[key] === undefined) {
      if (declaredValue === true) addBlocked("EVIDENCE_MISSING_FOR_CLAIM");
      evidenceCheck.approvalArtifacts[key] = {
        declared: declaredValue === true,
        bound: false,
        verdict: "not_bound",
      };
      return declaredValue === true ? false : declaredValue;
    }
    if (boundEntry === null) {
      addBlocked("EVIDENCE_MISSING_FOR_CLAIM");
      evidenceCheck.approvalArtifacts[key] = {
        declared: declaredValue === true,
        bound: true,
        verdict: "missing",
      };
      return false;
    }
    if (!approval.interpretable) {
      addBlocked("EVIDENCE_ARTIFACT_INVALID");
      evidenceCheck.approvalArtifacts[key] = {
        declared: declaredValue === true,
        bound: true,
        verdict: "artifact_invalid",
      };
      return false;
    }
    if (approval.approved) {
      disclosures.push({
        code: "AUTHORITY_PROVENANCE_UNVERIFIED",
        message: `the ${key.toUpperCase()} approval record is byte-verified against its declared digest, but local verification cannot authenticate the external approver — provenance stays disclosed, never silently verified`,
      });
    }
    if (approval.approved !== (declaredValue === true))
      addBlocked("EVIDENCE_CLAIM_MISMATCH");
    evidenceCheck.approvalArtifacts[key] = {
      declared: declaredValue === true,
      bound: true,
      derived: approval.approved,
      verdict: approval.approved === (declaredValue === true) ? "match" : "mismatch",
    };
    return approval.approved;
  };

  const d2Effective = approvalEffective("d2", authorization.d2Approved, d2Approval);
  const d5Effective = approvalEffective("d5", authorization.d5Approved, d5Approval);
  const d6ApprovedEffective = approvalEffective(
    "d6",
    authorization.d6Approved === true,
    d6Approval,
  );
  // The data-path gate derives from the D6 approval AND an admission report
  // that actually ran over real data — bound evidence only.
  const derivedDataPath =
    admission !== null || evidenceBindings.approvals?.d6 !== undefined
      ? deriveDataPathAuthorization(
          d6ApprovedEffective,
          admission ? admission.document : null,
        )
      : null;

  // ── Status/count internal consistency (state table, P0-1) ────────────────
  const calStatus =
    calibrationFacts && calibrationFacts.interpretable
      ? calibrationFacts.status
      : calibration.status;
  // The unauthorized-call check runs on the audit total: even an all-failed
  // calibration made real model calls that required D2.
  const calCount =
    calibrationFacts && calibrationFacts.interpretable
      ? calibrationFacts.auditCallCount
      : calibration.modelCallCount;
  const revStatus =
    reviewFacts && reviewFacts.interpretable
      ? reviewFacts.status
      : review.status;
  const revCount =
    reviewFacts && reviewFacts.interpretable
      ? reviewFacts.sampleCount
      : review.sampleCount;
  if (
    (calibration.status === "PASSED" && calibration.modelCallCount === 0) ||
    (calibration.status === "NOT_RUN" && calibration.modelCallCount > 0)
  )
    addBlocked("CALIBRATION_STATUS_COUNT_CONFLICT");
  if (
    (review.status === "PASSED" && review.sampleCount === 0) ||
    (review.status === "NOT_RUN" && review.sampleCount > 0)
  )
    addBlocked("OWNER_REVIEW_STATUS_COUNT_CONFLICT");

  // ── Evidence-vs-claim checks for the report-bearing facts ────────────────
  const checkClaim = (label, entryKey, declared, facts, pickStatus, pickCount) => {
    const boundEntry = bound(entryKey);
    if (evidenceBindings[entryKey] === undefined) {
      const affirmative =
        pickStatus(declared) !== "NOT_RUN" || pickCount(declared) > 0;
      if (affirmative) addBlocked("EVIDENCE_MISSING_FOR_CLAIM");
      evidenceCheck.artifacts[label] = { bound: false, verdict: "not_bound" };
      return;
    }
    if (boundEntry === null) {
      addBlocked("EVIDENCE_MISSING_FOR_CLAIM");
      evidenceCheck.artifacts[label] = { bound: true, verdict: "missing" };
      return;
    }
    if (!facts.interpretable) {
      addBlocked("EVIDENCE_ARTIFACT_INVALID");
      evidenceCheck.artifacts[label] = { bound: true, verdict: "artifact_invalid" };
      return;
    }
    const statusCheck = compare(
      label,
      pickStatus(declared),
      pickStatus(facts),
      true,
    );
    const countCheck = compare(
      label,
      pickCount(declared),
      pickCount(facts),
      true,
    );
    if (statusCheck.verdict === "mismatch" || countCheck.verdict === "mismatch")
      addBlocked("EVIDENCE_CLAIM_MISMATCH");
    evidenceCheck.artifacts[label] = {
      bound: true,
      declaredStatus: pickStatus(declared),
      derivedStatus: pickStatus(facts),
      declaredCount: pickCount(declared),
      derivedCount: pickCount(facts),
      verdict:
        statusCheck.verdict === "mismatch" || countCheck.verdict === "mismatch"
          ? "mismatch"
          : "match",
    };
  };
  checkClaim(
    "judgeCalibration",
    "judgeCalibration",
    calibration,
    calibrationFacts,
    (c) => c.status,
    (c) => c.modelCallCount,
  );
  checkClaim(
    "ownerBlindReview",
    "ownerBlindReview",
    review,
    reviewFacts,
    (r) => r.status,
    (r) => r.sampleCount,
  );

  // ── Precision target: derived from the bound calibration report ─────────
  let precisionEffective = policy.precisionTargetMet;
  if (evidenceBindings.judgeCalibration !== undefined && calibrationDoc !== null) {
    if (!calibrationFacts.interpretable) {
      // EVIDENCE_ARTIFACT_INVALID already added by checkClaim.
      precisionEffective = false;
    } else if (calibrationFacts.precisionTargetMet === null) {
      addBlocked("EVIDENCE_ARTIFACT_INVALID");
      precisionEffective = false;
    } else {
      if (calibrationFacts.precisionTargetMet !== policy.precisionTargetMet)
        addBlocked("EVIDENCE_CLAIM_MISMATCH");
      // A met-precision claim must be anchored to the FROZEN preregistered
      // target — a bare boolean proves nothing about which target was met.
      if (calibrationFacts.precisionTargetMet === true) {
        if (
          calibrationFacts.precisionTarget === null ||
          !preregFacts ||
          !preregFacts.interpretable ||
          preregFacts.precisionTarget === null
        ) {
          addBlocked("EVIDENCE_ARTIFACT_INVALID");
        } else if (
          calibrationFacts.precisionTarget !== preregFacts.precisionTarget
        ) {
          addBlocked("EVIDENCE_CLAIM_MISMATCH");
        }
      }
      precisionEffective = calibrationFacts.precisionTargetMet;
    }
  } else if (policy.precisionTargetMet === true) {
    addBlocked("EVIDENCE_MISSING_FOR_CLAIM");
    precisionEffective = false;
  }
  evidenceCheck.artifacts.precisionTarget = {
    declared: policy.precisionTargetMet,
    derived:
      calibrationFacts && calibrationFacts.interpretable
        ? calibrationFacts.precisionTargetMet
        : null,
    bound: calibrationDoc !== null,
  };

  // ── READY independent source groups: mechanically derived, never trusted ─
  let nEffective = declaredN;
  const sourceGroupsBound =
    evidenceBindings.sourceGroups !== undefined &&
    evidenceBindings.admissionReport !== undefined;
  if (
    (evidenceBindings.sourceGroups !== undefined) !==
    (evidenceBindings.admissionReport !== undefined)
  ) {
    // The count can only be derived from BOTH artifacts together — binding
    // only one makes the count unverifiable.
    addBlocked("EVIDENCE_ARTIFACT_INVALID");
  }
  if (declaredN > 0 && !sourceGroupsBound) {
    addBlocked("EVIDENCE_MISSING_FOR_CLAIM");
    nEffective = 0;
  } else if (sourceGroupsBound) {
    if (sourceGroups === null || admission === null) {
      addBlocked("EVIDENCE_MISSING_FOR_CLAIM");
      nEffective = 0;
      evidenceCheck.artifacts.readySourceGroups = {
        bound: true,
        verdict: "missing",
      };
    } else if (!groupFacts.interpretable) {
      addBlocked("EVIDENCE_ARTIFACT_INVALID");
      nEffective = 0;
      evidenceCheck.artifacts.readySourceGroups = {
        bound: true,
        verdict: "artifact_invalid",
        datasetBindingMismatch: groupFacts.datasetBindingMismatch === true,
        groupingBindingMismatch: groupFacts.groupingBindingMismatch === true,
      };
    } else {
      if (groupFacts.count !== declaredN) addBlocked("EVIDENCE_CLAIM_MISMATCH");
      evidenceCheck.artifacts.readySourceGroups = {
        bound: true,
        declared: declaredN,
        derived: groupFacts.count,
        readyGroupIds: groupFacts.readyGroupIds,
        totalGroupIds: groupFacts.totalGroupIds,
        verdict: groupFacts.count === declaredN ? "match" : "mismatch",
      };
      nEffective = groupFacts.count;
    }
  } else {
    evidenceCheck.artifacts.readySourceGroups = {
      bound: false,
      declared: declaredN,
      verdict: "not_bound",
    };
  }

  // ── Preregistration drift: alpha / minimum groups must equal the frozen
  //    registration when it is bound ───────────────────────────────────────
  let alpha = policy.alpha;
  let minimumGroups = policy.minimumIndependentSourceGroups;
  if (evidenceBindings.preregistration !== undefined) {
    if (preregistration === null) {
      addBlocked("EVIDENCE_MISSING_FOR_CLAIM");
      evidenceCheck.artifacts.preregistration = { bound: true, verdict: "missing" };
    } else if (!preregFacts.interpretable) {
      addBlocked("EVIDENCE_ARTIFACT_INVALID");
      evidenceCheck.artifacts.preregistration = { bound: true, verdict: "artifact_invalid" };
    } else {
      const drift =
        preregFacts.alpha !== policy.alpha ||
        preregFacts.minimumIndependentSourceGroups !==
          policy.minimumIndependentSourceGroups;
      if (drift) addBlocked("PREREGISTRATION_DRIFT");
      evidenceCheck.artifacts.preregistration = {
        bound: true,
        declared: {
          alpha: policy.alpha,
          minimumIndependentSourceGroups: policy.minimumIndependentSourceGroups,
        },
        derived: {
          alpha: preregFacts.alpha,
          minimumIndependentSourceGroups:
            preregFacts.minimumIndependentSourceGroups,
        },
        verdict: drift ? "mismatch" : "match",
      };
      // The FROZEN values are the authority for the threshold computation.
      alpha = preregFacts.alpha;
      minimumGroups = preregFacts.minimumIndependentSourceGroups;
    }
  } else {
    // The declared alpha / minimum-group policy is an affirmative claim: a
    // confirmatory qualification must never run on unverified parameters.
    addBlocked("EVIDENCE_MISSING_FOR_CLAIM");
    evidenceCheck.artifacts.preregistration = {
      bound: false,
      verdict: "not_bound",
    };
  }

  // ── Data-path authorization / data integrity ─────────────────────────────
  const checkDerivedBoolean = (label, declaredValue, derivedValue, bound2) => {
    if (!bound2) {
      if (declaredValue === true) addBlocked("EVIDENCE_MISSING_FOR_CLAIM");
      evidenceCheck.artifacts[label] = {
        declared: declaredValue,
        bound: false,
        verdict: "not_bound",
      };
      return declaredValue === true ? false : declaredValue;
    }
    if (derivedValue !== declaredValue) addBlocked("EVIDENCE_CLAIM_MISMATCH");
    evidenceCheck.artifacts[label] = {
      declared: declaredValue,
      derived: derivedValue,
      bound: true,
      verdict: derivedValue === declaredValue ? "match" : "mismatch",
    };
    return derivedValue;
  };
  const dataPathEffective = checkDerivedBoolean(
    "dataPathAuthorization",
    authorization.dataPathAuthorizationValid,
    derivedDataPath,
    derivedDataPath !== null,
  );
  const integrityEffective = checkDerivedBoolean(
    "dataIntegrity",
    authorization.dataIntegrityValid,
    derivedIntegrity,
    derivedIntegrity !== null,
  );

  // ── Gate evaluation ──────────────────────────────────────────────────────
  const nMinAlpha = nMinForAlpha(alpha);
  const requiredGroups = Math.max(nMinAlpha, minimumGroups);
  const kAtN = twoSidedThreshold(nEffective, alpha);

  // Task stop conditions first: recorded activity without the authorization
  // that permits it is a violation that must be reported loudly.
  if (!d2Effective && calCount > 0) {
    addBlocked("UNAUTHORIZED_MODEL_CALLS_RECORDED");
  }
  if (!d5Effective && revCount > 0) {
    addBlocked("UNAUTHORIZED_OWNER_BLIND_REVIEW_RECORDED");
  }
  if (!dataPathEffective) addBlocked("DATA_PATH_AUTHORIZATION_INVALID");
  if (!integrityEffective) addBlocked("DATA_INTEGRITY_UNPROVEN");
  if (nEffective === 0) addBlocked("NO_READY_SOURCE_GROUPS");
  if (!d2Effective) addBlocked("D2_NOT_APPROVED");
  if (!d5Effective) addBlocked("D5_NOT_APPROVED");
  if (!d6ApprovedEffective) addBlocked("D6_NOT_APPROVED");
  if (calStatus === "NOT_RUN") addBlocked("MODEL_CALIBRATION_NOT_RUN");
  if (calStatus === "FAILED") addBlocked("MODEL_CALIBRATION_FAILED");

  const unmetCriteria = [];
  if (blockedReasons.length === 0) {
    if (nEffective < nMinAlpha) unmetCriteria.push("BELOW_N_MIN_ALPHA");
    if (nEffective < minimumGroups)
      unmetCriteria.push("BELOW_PREREGISTERED_MIN_SOURCE_GROUPS");
    if (!precisionEffective) unmetCriteria.push("PRECISION_TARGET_NOT_MET");
    if (revStatus !== "PASSED")
      unmetCriteria.push("OWNER_BLIND_REVIEW_NOT_PASSED");
  }

  const status =
    blockedReasons.length > 0
      ? "BLOCKED"
      : unmetCriteria.length > 0
        ? "EXPLORATORY_ONLY"
        : "CONFIRMATORY_READY";

  return {
    ok: true,
    status,
    // Echoed verbatim for mechanical recomputability.
    inputs: JSON.parse(JSON.stringify(input)),
    blockedReasons,
    unmetCriteria,
    disclosures,
    evidenceCheck,
    thresholds: {
      alpha,
      alphaPerDirection: alpha / 2,
      nMinAlpha,
      minimumIndependentSourceGroups: minimumGroups,
      requiredIndependentSourceGroups: requiredGroups,
      readyIndependentSourceGroups: nEffective,
      kAtReadyN: kAtN,
      thresholdAuthority:
        "CONTRACT-PD-LAB-DATA-AND-SCORING-001 v0.3 section 6.5 (exact BigInt two-sided binomial tail via alignment-report.twoSidedThreshold); n_min(alpha) is derived, never hardcoded",
    },
    judgeProtocol: {
      judgeProtocolRef: JUDGE_PROTOCOL_REF,
      judgeProtocolDigest: judgeProtocolDigest(),
    },
    checks: {
      dataPathAuthorizationValid: dataPathEffective,
      dataIntegrityValid: integrityEffective,
      d2Approved: d2Effective,
      d5Approved: d5Effective,
      d6Approved: d6ApprovedEffective,
      modelCalibrationPassed: calStatus === "PASSED",
      ownerBlindReviewPassed: revStatus === "PASSED",
      nMeetsNMinAlpha: nEffective >= nMinAlpha,
      nMeetsPreregisteredMinimum: nEffective >= minimumGroups,
      precisionTargetMet: precisionEffective,
    },
    t6Permissions: {
      confirmatoryT6Allowed: status === "CONFIRMATORY_READY",
      // SPEC 11 / HANDOFF T7a: exploratory T6 only with an explicit D2
      // exploratory approval AND a preregistration marked exploratory (the
      // preregistration marker is enforced at T6 preflight; this flag is the
      // D2 side of that pair).
      exploratoryT6Allowed:
        status === "EXPLORATORY_ONLY" && input.d2ExploratoryApproval === true,
      // Exploratory results can NEVER produce PROMOTE; only a
      // CONFIRMATORY_READY qualification may ever carry a promote
      // recommendation, and even there governance decides (SPEC section 10).
      promotePossible: status === "CONFIRMATORY_READY",
    },
  };
}
