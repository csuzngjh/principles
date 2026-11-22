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
//                      unmet, the Owner blind review has not passed, OR the
//                      preregistration itself is marked exploratory (that
//                      marker is a permanent cap — no later evidence ever
//                      upgrades it). Exploratory T6 needs an explicit D2
//                      exploratory approval and can never produce a PROMOTE.
//   CONFIRMATORY_READY everything above passed AND the preregistration is
//                      NOT exploratory AND
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
import { sourceGroupsDigestOf } from "./admission-probe.mjs";
import {
  JUDGE_PROTOCOL_REF,
  judgeProtocolDigest,
  restoreDisplayVerdict,
  DISPLAY_ORDERS,
  PROTOCOL_VERDICTS,
} from "./judge-protocol.mjs";

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

// Producer reports use bare lowercase SHA-256 hex while evidence bindings
// use the canonical `sha256:<hex>` form. Compare their digest bytes, not the
// transport prefix; malformed values remain non-matching.
function sha256HexOf(value) {
  if (typeof value !== "string") return null;
  const match = /^(?:sha256:)?([0-9a-f]{64})$/.exec(value);
  return match?.[1] ?? null;
}

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
  // D5 cannot be satisfied when no determinate position-exchange outcome
  // exists from which to recompute the flip-rate denominator.
  "POSITION_FLIP_RATE_UNMEASURED",
  // Authorization violations (task stop conditions, fail-loud disclosures).
  "UNAUTHORIZED_MODEL_CALLS_RECORDED",
  "UNAUTHORIZED_OWNER_BLIND_REVIEW_RECORDED",
  // Statistical boundary: n_min(alpha) search exhausted before any k <= n.
  "N_MIN_ALPHA_SEARCH_EXHAUSTED",
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
  // An exploratory-marked preregistration can never satisfy the
  // confirmatory criteria — no amount of later evidence upgrades it (P1-1).
  "PREREGISTRATION_EXPLORATORY_CAP",
  // Approval-parameter binding (P1-3): a granted D2/D5/D6 decision whose
  // parameters contradict the frozen experiment evidence.
  "APPROVAL_PARAMETER_MISMATCH",
]);

// Non-blocking disclosure codes — an approval record verified byte-exact
// against its declared digest proves LOCAL integrity, never the external
// approver's authenticity; that provenance limit is disclosed honestly.
export const QUALIFICATION_DISCLOSURE_CODES = Object.freeze([
  "AUTHORITY_PROVENANCE_UNVERIFIED",
  // CR10: a granted D2 that does not name the preregistration it froze
  // cannot cryptographically bind this qualification to one registration
  // file — a numerically identical registration with a flipped exploratory
  // marker would pass the numeric checks. Disclosed so the Owner can
  // require the digest binding in future decisions.
  "PREREGISTRATION_IDENTITY_UNBOUND",
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
    if (calibration.auditCallCount !== undefined) {
      complain(
        "judgeModelCalibration.auditCallCount is derived from the bound calibration evidence and must not be supplied as input",
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

// A judge/generator model block as frozen by the judge protocol
// ({provider, modelId, version} — all non-empty strings; same shape as the
// protocol record's judgeModel).
function modelBlockOf(document, label) {
  if (
    !isPlainObject(document) ||
    !isNonEmptyString(document.provider) ||
    !isNonEmptyString(document.modelId) ||
    !isNonEmptyString(document.version)
  )
    return { valid: false, label };
  return {
    valid: true,
    label,
    provider: document.provider,
    modelId: document.modelId,
    version: document.version,
  };
}

function modelsEqual(a, b) {
  return (
    a.provider === b.provider && a.modelId === b.modelId && a.version === b.version
  );
}

function isUnitIntervalRate(value) {
  return (
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
  );
}

const DATASET_SHA256_RE = /^[0-9a-f]{64}$/;

// P1-3: an affirmative D2/D5/D6 decision must carry the experiment
// parameters it froze (HANDOFF decision table — no thresholds are invented
// here). Missing or malformed parameters make the record non-interpretable
// for a granted decision; a rejection (approved: false) needs none.
function approvalParameters(document, scope) {
  if (document.approved !== true) return { valid: true, parameters: null };
  const p = document.parameters;
  if (!isPlainObject(p)) return { valid: false, problem: "parameters object missing on a granted decision" };
  if (scope === "d2") {
    const model = modelBlockOf(p.model, "d2.parameters.model");
    if (!model.valid)
      return { valid: false, problem: "d2.parameters.model needs {provider, modelId, version}" };
    if (
      typeof p.alpha !== "number" ||
      !Number.isFinite(p.alpha) ||
      p.alpha <= 0 ||
      p.alpha >= 1
    )
      return { valid: false, problem: "d2.parameters.alpha must be a finite number in (0,1)" };
    if (!isPositiveInteger(p.minimumIndependentSourceGroups))
      return { valid: false, problem: "d2.parameters.minimumIndependentSourceGroups must be an integer >= 1" };
    if (!isUnitIntervalRate(p.precisionTarget) || p.precisionTarget <= 0)
      return { valid: false, problem: "d2.parameters.precisionTarget must be a rate in (0,1]" };
    if (!isPositiveInteger(p.callBudget))
      return { valid: false, problem: "d2.parameters.callBudget must be an integer >= 1" };
    if (!isPositiveInteger(p.repetitions))
      return { valid: false, problem: "d2.parameters.repetitions must be an integer >= 1" };
    if (!isNonEmptyString(p.licenseConditions))
      return { valid: false, problem: "d2.parameters.licenseConditions must be a non-empty string" };
    // Optional preregistration identity binding (CR10): an Owner decision
    // may freeze WHICH preregistration file it authorizes (content digest);
    // the engine then rejects a swapped registration with identical numbers
    // but a different exploratory marker. Absent binding is disclosed, not
    // assumed.
    if (
      p.preregistrationSha256 !== undefined &&
      (typeof p.preregistrationSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(p.preregistrationSha256))
    )
      return {
        valid: false,
        problem:
          "d2.parameters.preregistrationSha256 must be a 64-char lowercase hex digest when present",
      };
    return {
      valid: true,
      parameters: {
        model,
        alpha: p.alpha,
        minimumIndependentSourceGroups: p.minimumIndependentSourceGroups,
        precisionTarget: p.precisionTarget,
        callBudget: p.callBudget,
        repetitions: p.repetitions,
        licenseConditions: p.licenseConditions,
        ...(p.preregistrationSha256 !== undefined
          ? { preregistrationSha256: p.preregistrationSha256 }
          : {}),
      },
    };
  }
  if (scope === "d5") {
    if (!isPositiveInteger(p.samplePairs))
      return { valid: false, problem: "d5.parameters.samplePairs must be an integer >= 1" };
    if (!isUnitIntervalRate(p.agreementRateThreshold) || p.agreementRateThreshold <= 0)
      return { valid: false, problem: "d5.parameters.agreementRateThreshold must be a rate in (0,1]" };
    if (!isUnitIntervalRate(p.maxPositionFlipRate) || p.maxPositionFlipRate >= 1)
      return { valid: false, problem: "d5.parameters.maxPositionFlipRate must be a rate in [0,1)" };
    if (!isNonEmptyString(p.reviewScope))
      return { valid: false, problem: "d5.parameters.reviewScope must be a non-empty string" };
    return {
      valid: true,
      parameters: {
        samplePairs: p.samplePairs,
        agreementRateThreshold: p.agreementRateThreshold,
        maxPositionFlipRate: p.maxPositionFlipRate,
        reviewScope: p.reviewScope,
        recheckRequired: p.recheckRequired === true,
      },
    };
  }
  // scope === "d6"
  if (
    typeof p.datasetSha256 !== "string" ||
    !DATASET_SHA256_RE.test(p.datasetSha256)
  )
    return { valid: false, problem: "d6.parameters.datasetSha256 must be a 64-char lowercase hex digest" };
  if (!isNonEmptyString(p.sampleRange))
    return { valid: false, problem: "d6.parameters.sampleRange must be a non-empty string" };
  if (!isNonEmptyString(p.storageScope))
    return { valid: false, problem: "d6.parameters.storageScope must be a non-empty string" };
  if (!isNonEmptyString(p.dataSource))
    return { valid: false, problem: "d6.parameters.dataSource must be a non-empty string" };
  if (!isPositiveInteger(p.retentionDays))
    return { valid: false, problem: "d6.parameters.retentionDays must be an integer >= 1" };
  // Optional snapshot binding (DV8): a D6 decision may pin the exact
  // trajectory.db bytes the authorized probe must read — without it the
  // probe's own report still echoes the snapshot digests it actually read
  // (admission report snapshot block), and the operator-side dataset
  // binding is the enforced floor.
  if (
    p.trajectoryDbSha256 !== undefined &&
    (typeof p.trajectoryDbSha256 !== "string" ||
      !DATASET_SHA256_RE.test(p.trajectoryDbSha256))
  )
    return {
      valid: false,
      problem: "d6.parameters.trajectoryDbSha256 must be 64-char lowercase hex when present",
    };
  return {
    valid: true,
    parameters: {
      datasetSha256: p.datasetSha256,
      sampleRange: p.sampleRange,
      storageScope: p.storageScope,
      dataSource: p.dataSource,
      retentionDays: p.retentionDays,
      ...(p.trajectoryDbSha256 !== undefined
        ? { trajectoryDbSha256: p.trajectoryDbSha256 }
        : {}),
    },
  };
}

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
  // P1-3: a granted decision must bind the experiment parameters it froze.
  const parameters = approvalParameters(document, expectedScope);
  if (!parameters.valid)
    return { interpretable: false, approved: false, parameterProblem: parameters.problem };
  return {
    interpretable: true,
    approved: document.approved,
    // An exploratory T6 run needs an explicit exploratory grant on the D2
    // decision record — a plain approval never covers it.
    exploratory: document.exploratory === true,
    parameters: parameters.parameters,
  };
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
  // The declared digest is recomputed from the artifact's OWN contents via
  // the admission probe's canonical sourceGroupsDigestOf — a tampered
  // groups/rationales map that kept its old digest is artifact-invalid, and
  // a mapping the admission run never recorded is rejected below too.
  let recomputed;
  try {
    recomputed = sourceGroupsDigestOf(
      sourceGroupsDoc.groups,
      sourceGroupsDoc.rationales ?? {},
    );
  } catch {
    return { interpretable: false, digestRecomputeFailed: true };
  }
  if (
    !isNonEmptyString(sourceGroupsDoc.digest) ||
    recomputed !== sourceGroupsDoc.digest
  )
    return { interpretable: false, contentDigestMismatch: true };
  // The mapping must also be the grouping the admission run actually
  // recorded — two well-formed files for the same dataset can still carry
  // different merge decisions, and both layers of the binding must hold.
  if (
    !isNonEmptyString(admissionDoc.sourceGroups?.digest) ||
    sourceGroupsDoc.digest !== admissionDoc.sourceGroups.digest
  )
    return { interpretable: false, groupingBindingMismatch: true };
  // P1-4: a duplicate caseId is invalid evidence, full stop — the later
  // record must never overwrite the earlier one (a READY re-record could
  // bury an INCOMPLETE probe result and inflate the READY count).
  const perSample = new Map();
  const seenCaseIds = new Set();
  for (const entry of admissionDoc.perSample) {
    if (!isPlainObject(entry) || !isNonEmptyString(entry.caseId))
      return { interpretable: false, malformedPerSampleEntry: true };
    if (seenCaseIds.has(entry.caseId))
      return { interpretable: false, duplicateCase: entry.caseId };
    seenCaseIds.add(entry.caseId);
    perSample.set(entry.caseId, entry);
  }
  // Count consistency (P1-4): the per-sample records and the report's own
  // counts must agree — any divergence means the report was edited or
  // truncated after the probe ran.
  if (
    admissionDoc.counts?.caseCount !== undefined &&
    admissionDoc.counts.caseCount !== perSample.size
  )
    return { interpretable: false, countMismatch: "counts.caseCount" };
  if (
    admissionDoc.dataset?.sampleCount !== undefined &&
    admissionDoc.dataset.sampleCount !== perSample.size
  )
    return { interpretable: false, countMismatch: "dataset.sampleCount" };
  // Case-mapping completeness is bidirectional: every case the admission
  // report probed must be mapped, and the mapping may not name cases the
  // report never saw.
  for (const caseId of perSample.keys()) {
    if (!(caseId in sourceGroupsDoc.groups))
      return { interpretable: false, unmappedCase: caseId };
  }
  const groupCases = new Map();
  for (const [caseId, groupId] of Object.entries(sourceGroupsDoc.groups)) {
    if (!isNonEmptyString(groupId) || !isNonEmptyString(caseId)) return fail;
    if (!perSample.has(caseId))
      return { interpretable: false, unknownCase: caseId };
    if (!groupCases.has(groupId)) groupCases.set(groupId, []);
    groupCases.get(groupId).push(caseId);
  }
  // Mapping cardinality (P1-4): after the bidirectional completeness check,
  // the mapping must cover exactly the probed cases — no extra keys either.
  if (Object.keys(sourceGroupsDoc.groups).length !== perSample.size)
    return { interpretable: false, countMismatch: "sourceGroups.groups" };
  // One session is one source group: the producer keys groups by sessionId
  // (merges aside), so cases sharing a sessionId spanning multiple groupIds
  // means the session was split to inflate the independent-group count.
  // A case WITHOUT a session anchor has no provable common origin with any
  // other case: the producer's mechanical rule gives it a single-case
  // group, so a shared group containing a session-less case can never be
  // counted as independent evidence (P1-4: no silent skip — the schema
  // allows an empty sessionId, and the substitute identity rule is the
  // caseId singleton itself).
  const sessionGroups = new Map();
  for (const entry of perSample.values()) {
    if (!isNonEmptyString(entry.sessionId)) {
      const singletonGroupId = sourceGroupsDoc.groups[entry.caseId];
      if (groupCases.get(singletonGroupId)?.length > 1)
        return { interpretable: false, sessionAnchorMissingSharedGroup: entry.caseId };
      continue;
    }
    const groupId = sourceGroupsDoc.groups[entry.caseId];
    if (
      sessionGroups.has(entry.sessionId) &&
      sessionGroups.get(entry.sessionId) !== groupId
    )
      return { interpretable: false, sessionSplit: entry.sessionId };
    sessionGroups.set(entry.sessionId, groupId);
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

// Live calibration report (P1-2): the status is only the headline — the
// engine re-derives every governed fact from the raw invocation records:
//   - the report must be bound to the CURRENT judge protocol
//     (judgeProtocolRef + judgeProtocolDigest — a calibration run against a
//     different protocol version says nothing about this one);
//   - every invocation carries the model that actually served it, and a
//     SUCCEEDED invocation must have run the report-level judgeModel (a
//     report claiming model A on evidence produced by model B is invalid);
//   - precisionTargetMet is RECOMPUTED from the raw per-invocation verdicts
//     against their reference verdicts — the report's own boolean is a
//     claim the engine compares against, never a fact it adopts;
//   - position-exchange evidence must exist for every SUCCEEDED call (the
//     flip rate is a D5 calibration metric derived from it).
function deriveCalibrationFacts(document) {
  const fail = { interpretable: false };
  if (
    !isPlainObject(document) ||
    document.schema !== "pd-lab-judge-calibration.v1" ||
    !CALIBRATION_STATUSES.includes(document.status) ||
    !Array.isArray(document.invocations)
  )
    return fail;
  if (
    document.judgeProtocolRef !== JUDGE_PROTOCOL_REF ||
    typeof document.judgeProtocolDigest !== "string" ||
    document.judgeProtocolDigest !== judgeProtocolDigest()
  )
    return { interpretable: false, protocolBindingMismatch: true };
  const judgeModel = modelBlockOf(document.judgeModel, "judgeCalibration.judgeModel");
  if (!judgeModel.valid) return { interpretable: false, judgeModelMissing: true };
  if (
    typeof document.precisionTarget !== "number" ||
    !Number.isFinite(document.precisionTarget) ||
    document.precisionTarget <= 0 ||
    document.precisionTarget > 1
  )
    return { interpretable: false, precisionTargetMissing: true };
  if (typeof document.precisionTargetMet !== "boolean")
    return { interpretable: false, precisionTargetMetMissing: true };
  // Raw invocation records: unique ids, an explicit status, the serving
  // model, both verdicts (judge vs reference, display-frame four-value)
  // and a position-exchange outcome per SUCCEEDED call.
  const seenInvocationIds = new Set();
  let succeeded = 0;
  let failed = 0;
  let agreed = 0;
  let positionExchanged = 0;
  let positionFlipped = 0;
  for (const invocation of document.invocations) {
    if (
      !isPlainObject(invocation) ||
      !isNonEmptyString(invocation.invocationId) ||
      (invocation.status !== "SUCCEEDED" && invocation.status !== "FAILED")
    )
      return { interpretable: false, malformedInvocation: true };
    if (seenInvocationIds.has(invocation.invocationId))
      return { interpretable: false, duplicateInvocation: invocation.invocationId };
    seenInvocationIds.add(invocation.invocationId);
    const invocationModel = modelBlockOf(invocation.model, "invocation.model");
    if (!invocationModel.valid)
      return { interpretable: false, invocationModelMissing: invocation.invocationId };
    if (invocation.status === "FAILED") {
      // A FAILED call was still a REAL model invocation (D2 froze the model
      // for the calls that are made, not only the ones that succeed) — its
      // serving model must match the report-level judgeModel too (DV6).
      if (!modelsEqual(invocationModel, judgeModel))
        return {
          interpretable: false,
          invocationModelMismatch: invocation.invocationId,
        };
      failed += 1;
      continue;
    }
    // A SUCCEEDED call must have been served by the report-level judgeModel
    // — the calibration claim is about THAT model.
    if (!modelsEqual(invocationModel, judgeModel))
      return {
        interpretable: false,
        invocationModelMismatch: invocation.invocationId,
      };
    if (!PROTOCOL_VERDICTS.includes(invocation.judgeVerdict) ||
        !PROTOCOL_VERDICTS.includes(invocation.referenceVerdict))
      return { interpretable: false, invocationVerdictMissing: invocation.invocationId };
    if (typeof invocation.positionExchangeConsistent !== "boolean")
      return { interpretable: false, positionExchangeMissing: invocation.invocationId };
    succeeded += 1;
    if (invocation.judgeVerdict === invocation.referenceVerdict) agreed += 1;
    // Position-flip denominator: only DETERMINATE judge verdicts count
    // (judge-protocol semantics: UNKNOWN/failed outcomes are undetermined,
    // never dilute the flip rate) — DV3.
    if (invocation.judgeVerdict !== "UNKNOWN") {
      positionExchanged += 1;
      if (!invocation.positionExchangeConsistent) positionFlipped += 1;
    }
  }
  // precisionTargetMet recomputed from the raw evidence — never the
  // report's own boolean (a zero-denominator calibration claims nothing).
  const derivedPrecisionTargetMet =
    succeeded > 0 ? agreed / succeeded >= document.precisionTarget : false;
  return {
    interpretable: true,
    status: document.status,
    modelCallCount: succeeded,
    auditCallCount: succeeded + failed,
    failedCallCount: failed,
    judgeModel,
    precisionTarget: document.precisionTarget,
    declaredPrecisionTargetMet: document.precisionTargetMet,
    // The recomputed fact — the engine's authority.
    precisionTargetMet: derivedPrecisionTargetMet,
    agreementRate: succeeded > 0 ? agreed / succeeded : null,
    positionFlipRate: positionExchanged > 0 ? positionFlipped / positionExchanged : null,
  };
}

// Owner blind-review report (P1-2): a sampleId alone proves nothing. Every
// sample must carry the actual blind-review record — the Owner's verdict,
// the judge's display-frame verdict, the A/B position and identity map the
// Owner saw, the restored candidate-frame verdict (which the engine
// re-derives with the protocol's own restoreDisplayVerdict to prove the
// blinding was honest), a disagreement classification and the recheck
// stability. The agreement rate and per-type disagreement counts are
// RECOMPUTED from those records.
const REVIEW_DISAGREEMENT_TYPES = ["VERDICT_CONFLICT", "TIE_VS_WIN", "REASON_CONFLICT"];
const RECHECK_STABILITIES = ["STABLE", "UNSTABLE", "NOT_RECHECKED"];

function deriveOwnerReviewFacts(document) {
  const fail = { interpretable: false };
  if (
    !isPlainObject(document) ||
    document.schema !== "pd-lab-owner-blind-review.v1" ||
    !CALIBRATION_STATUSES.includes(document.status) ||
    !Array.isArray(document.samples)
  )
    return fail;
  const seenSampleIds = new Set();
  const seenReviewUnits = new Set();
  let agreeing = 0;
  const disagreements = { VERDICT_CONFLICT: 0, TIE_VS_WIN: 0, REASON_CONFLICT: 0 };
  let rechecked = 0;
  let recheckStable = 0;
  for (const sample of document.samples) {
    if (
      !isPlainObject(sample) ||
      !isNonEmptyString(sample.sampleId) ||
      !isNonEmptyString(sample.packageId) ||
      !DISPLAY_ORDERS.includes(sample.displayOrder) ||
      !PROTOCOL_VERDICTS.includes(sample.ownerVerdict) ||
      !PROTOCOL_VERDICTS.includes(sample.judgeVerdict)
    )
      return { interpretable: false, malformedSample: true };
    // Duplicate sampleIds would double-count one review (P1-2 negative).
    if (seenSampleIds.has(sample.sampleId))
      return { interpretable: false, duplicateSample: sample.sampleId };
    seenSampleIds.add(sample.sampleId);
    // D5 authorizes blind-review SAMPLE PAIRS — one review unit is one
    // package in one display order (a legitimate position exchange reviews
    // the counter-package in the other order, a DIFFERENT unit). Reviewing
    // the same package in the same order twice under fresh sampleIds does
    // not add independent evidence — it is invalid, never recounted
    // (DV4/CR7).
    const reviewUnit = `${sample.packageId}\u0000${sample.displayOrder}`;
    if (seenReviewUnits.has(reviewUnit))
      return { interpretable: false, duplicateReviewUnit: sample.packageId };
    seenReviewUnits.add(reviewUnit);
    // The identity map is the secret-side binding the Owner's display
    // verdicts were formed against; the restored verdict must be exactly
    // what the protocol's own restoration produces — a mismatch means the
    // recorded blinding does not explain the recorded verdict.
    const restored = restoreDisplayVerdict(sample.judgeVerdict, sample.identityMap);
    if (restored === null || restored !== sample.judgeRestoredVerdict)
      return { interpretable: false, identityBindingInvalid: sample.sampleId };
    if (!RECHECK_STABILITIES.includes(sample.recheckStability))
      return { interpretable: false, recheckStabilityMissing: sample.sampleId };
    if (sample.ownerVerdict === sample.judgeVerdict) {
      agreeing += 1;
      if (sample.disagreementType !== null && sample.disagreementType !== undefined)
        return { interpretable: false, disagreementTypeInvalid: sample.sampleId };
    } else {
      if (!REVIEW_DISAGREEMENT_TYPES.includes(sample.disagreementType))
        return { interpretable: false, disagreementTypeInvalid: sample.sampleId };
      disagreements[sample.disagreementType] += 1;
    }
    if (sample.recheckStability !== "NOT_RECHECKED") {
      rechecked += 1;
      if (sample.recheckStability === "STABLE") recheckStable += 1;
    }
  }
  const sampleCount = seenSampleIds.size;
  return {
    interpretable: true,
    status: document.status,
    sampleCount,
    agreementRate: sampleCount > 0 ? agreeing / sampleCount : null,
    disagreementCounts: disagreements,
    recheckedCount: rechecked,
    recheckStableCount: recheckStable,
    // D5 stability gate: EVERY sample must be STABLE on recheck — a mere
    // recheck count ignores UNSTABLE outcomes (DV2/CR8); NOT_RECHECKED
    // samples fail the gate too.
    allRecheckStable: sampleCount > 0 && recheckStable === sampleCount,
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
// a D6-authorized run; it can never be claimed by a fixture run). P1-6: the
// probe's positive state must ALSO cite the dataset digest the D6 decision
// authorized — a RAN_WITH_D6 report over a different dataset than the one
// D6 froze is not authorized data access. DV5/CR9: the probe must moreover
// have run under the SAME decision record this input binds — the probe's
// echoed d6Decision.sha256 (the decision file's byte digest) must equal the
// verified digest of the bound artifact, so a newer decision for the same
// dataset can't silently back an older probe run.
function deriveDataPathAuthorization(
  d6Approved,
  admissionDoc,
  d6Parameters,
  d6BindingSha256,
) {
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
  if (admissionDoc.realDataProbe.status !== "RAN_WITH_D6") return false;
  // The dataset the probe actually ran over must be the dataset the D6
  // decision authorized (digest equality on the probe's own echo AND the
  // report's dataset block — CR9: read the probeScope echo, not a caller
  // field).
  const probedDataset =
    admissionDoc.realDataProbe.probeScope?.datasetSha256 ??
    admissionDoc.dataset?.sha256 ??
    null;
  if (
    d6Parameters === null ||
    d6Parameters.datasetSha256 !== probedDataset ||
    admissionDoc.dataset?.sha256 !== d6Parameters.datasetSha256
  )
    return false;
  // Decision-record identity: the probe's echoed decision digest must match
  // the bound D6 artifact's verified digest.
  const echoedDecisionSha = sha256HexOf(
    admissionDoc.realDataProbe.d6Decision?.sha256,
  );
  const boundDecisionSha = sha256HexOf(d6BindingSha256);
  return (
    echoedDecisionSha !== null &&
    boundDecisionSha !== null &&
    echoedDecisionSha === boundDecisionSha
  );
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
        // rc-9: a granted decision whose parameters cannot be interpreted
        // names the exact structural problem, never fails silently.
        ...(approval.parameterProblem
          ? { parameterProblem: approval.parameterProblem }
          : {}),
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
          d6Approval !== null &&
            d6Approval.interpretable &&
            d6Approval.approved &&
            d6Approval.parameters !== null
            ? d6Approval.parameters
            : null,
          boundApproval("d6") !== null ? boundApproval("d6").sha256 : null,
        )
      : null;

  // ── P1-3: approval parameters vs the frozen experiment evidence ────────
  // Every cross-check runs only when BOTH sides are available and
  // interpretable (a missing side is already blocked as missing evidence);
  // a check that runs and fails is APPROVAL_PARAMETER_MISMATCH — the
  // authorization never covered the experiment that was actually run.
  const parameterFindings = [];
  const parameterMismatch = (message) => {
    parameterFindings.push(message);
  };
  const d2Params =
    d2Approval !== null && d2Approval.interpretable && d2Approval.approved
      ? d2Approval.parameters
      : null;
  const d5Params =
    d5Approval !== null && d5Approval.interpretable && d5Approval.approved
      ? d5Approval.parameters
      : null;
  const d6Params =
    d6Approval !== null && d6Approval.interpretable && d6Approval.approved
      ? d6Approval.parameters
      : null;
  // D2 <-> frozen preregistration (alpha / minimum groups / precision target)
  if (d2Params !== null && preregFacts !== null && preregFacts.interpretable) {
    if (d2Params.alpha !== preregFacts.alpha)
      parameterMismatch(
        `D2 froze alpha=${d2Params.alpha} but the preregistration froze ${preregFacts.alpha}`,
      );
    if (
      d2Params.minimumIndependentSourceGroups !==
      preregFacts.minimumIndependentSourceGroups
    )
      parameterMismatch(
        `D2 froze minimumIndependentSourceGroups=${d2Params.minimumIndependentSourceGroups} but the preregistration froze ${preregFacts.minimumIndependentSourceGroups}`,
      );
    if (
      preregFacts.precisionTarget !== null &&
      d2Params.precisionTarget !== preregFacts.precisionTarget
    )
      parameterMismatch(
        `D2 froze precisionTarget=${d2Params.precisionTarget} but the preregistration froze ${preregFacts.precisionTarget}`,
      );
  }
  // D2 <-> the calibration that actually ran (model + precision target + budget)
  if (d2Params !== null && calibrationFacts !== null && calibrationFacts.interpretable) {
    if (!modelsEqual(d2Params.model, calibrationFacts.judgeModel))
      parameterMismatch(
        `D2 authorized model ${d2Params.model.provider}/${d2Params.model.modelId}/${d2Params.model.version} but the calibration ran ${calibrationFacts.judgeModel.provider}/${calibrationFacts.judgeModel.modelId}/${calibrationFacts.judgeModel.version}`,
      );
    if (d2Params.precisionTarget !== calibrationFacts.precisionTarget)
      parameterMismatch(
        `D2 froze precisionTarget=${d2Params.precisionTarget} but the calibration targeted ${calibrationFacts.precisionTarget}`,
      );
    if (calibrationFacts.auditCallCount > d2Params.callBudget)
      parameterMismatch(
        `D2 authorized a call budget of ${d2Params.callBudget} but the calibration records ${calibrationFacts.auditCallCount} calls`,
      );
  }
  // D2 <-> the preregistration identity (CR10): when the decision froze the
  // registration file's digest, the bound artifact must be exactly that
  // file; without the binding the limitation is disclosed.
  if (d2Params !== null) {
    const preregDigest = sha256HexOf(
      evidenceBindings.preregistration?.sha256 ?? null,
    );
    if (d2Params.preregistrationSha256 !== undefined) {
      const frozenPreregDigest = sha256HexOf(
        d2Params.preregistrationSha256,
      );
      if (
        preregDigest === null ||
        frozenPreregDigest === null ||
        preregDigest !== frozenPreregDigest
      )
        parameterMismatch(
          `D2 froze preregistration ${d2Params.preregistrationSha256} but the bound registration is ${preregDigest ?? "absent"}`,
        );
    } else {
      disclosures.push({
        code: "PREREGISTRATION_IDENTITY_UNBOUND",
        message:
          "the granted D2 decision does not name the preregistration file it froze (preregistrationSha256 absent) — the numeric checks hold, but a swapped registration with a flipped exploratory marker cannot be cryptographically excluded; require the digest binding in future decisions",
      });
    }
  }
  // D5 <-> the Owner blind review that actually ran (sample floor + thresholds).
  // The floor/threshold checks apply to a COMPLETED (PASSED) review claim —
  // a NOT_RUN review is an honest "not finished yet" (handled as an
  // unmet criterion), never an authorization mismatch; a PASSED claim with
  // too few samples or a sub-threshold agreement rate IS one.
  if (d5Params !== null && reviewFacts !== null && reviewFacts.interpretable) {
    if (
      reviewFacts.status === "PASSED" &&
      reviewFacts.sampleCount < d5Params.samplePairs
    )
      parameterMismatch(
        `D5 approved ${d5Params.samplePairs} blind-review sample pairs but only ${reviewFacts.sampleCount} were actually reviewed`,
      );
    if (
      reviewFacts.status === "PASSED" &&
      reviewFacts.agreementRate !== null &&
      reviewFacts.agreementRate < d5Params.agreementRateThreshold
    )
      parameterMismatch(
        `D5 required an agreement rate >= ${d5Params.agreementRateThreshold} but the review records ${reviewFacts.agreementRate}`,
      );
    if (
      d5Params.recheckRequired &&
      reviewFacts.status === "PASSED" &&
      !reviewFacts.allRecheckStable
    )
      parameterMismatch(
        "D5 required recheck stability but the blind-review samples are not all STABLE on recheck",
      );
  }
  // D5 <-> the judge calibration's position-flip metric (the D5 gate on the
  // judge side of the calibration). A PASSED report with no determinate
  // exchange outcomes has no denominator, so the approved threshold was not
  // actually measured and cannot be treated as satisfied.
  if (
    d5Params !== null &&
    calibrationFacts !== null &&
    calibrationFacts.interpretable &&
    calibrationFacts.status === "PASSED" &&
    calibrationFacts.positionFlipRate === null
  )
    addBlocked("POSITION_FLIP_RATE_UNMEASURED");
  if (
    d5Params !== null &&
    calibrationFacts !== null &&
    calibrationFacts.interpretable &&
    calibrationFacts.positionFlipRate !== null &&
    calibrationFacts.positionFlipRate > d5Params.maxPositionFlipRate
  )
    parameterMismatch(
      `D5 allowed a position-flip rate <= ${d5Params.maxPositionFlipRate} but the calibration records ${calibrationFacts.positionFlipRate}`,
    );
  // D6 <-> the dataset that was actually probed (three-way digest equality:
  // decision <-> admission report <-> source-groups mapping). DV7: the
  // parameter checks only run on plain-object documents — a bound artifact
  // whose bytes parse to a JSON null/scalar must degrade to artifact-invalid
  // checks elsewhere, never throw.
  if (
    d6Params !== null &&
    admission !== null &&
    sourceGroups !== null &&
    isPlainObject(admission.document) &&
    isPlainObject(sourceGroups.document)
  ) {
    if (
      isNonEmptyString(admission.document.dataset?.sha256) &&
      admission.document.dataset.sha256 !== d6Params.datasetSha256
    )
      parameterMismatch(
        `D6 authorized dataset ${d6Params.datasetSha256} but the admission report probed ${admission.document.dataset.sha256}`,
      );
    if (
      isNonEmptyString(sourceGroups.document.datasetSha256) &&
      sourceGroups.document.datasetSha256 !== d6Params.datasetSha256
    )
      parameterMismatch(
        `D6 authorized dataset ${d6Params.datasetSha256} but the source-groups mapping is bound to ${sourceGroups.document.datasetSha256}`,
      );
    // DV8: a snapshot-pinned decision must match the snapshot the report
    // actually read (the admission report's trajectory-db digest).
    if (
      d6Params.trajectoryDbSha256 !== undefined &&
      isNonEmptyString(admission.document.snapshot?.trajectoryDb?.sha256) &&
      admission.document.snapshot.trajectoryDb.sha256 !==
        d6Params.trajectoryDbSha256
    )
      parameterMismatch(
        `D6 pinned trajectory snapshot ${d6Params.trajectoryDbSha256} but the probe read ${admission.document.snapshot.trajectoryDb.sha256}`,
      );
  }
  if (parameterFindings.length > 0) addBlocked("APPROVAL_PARAMETER_MISMATCH");
  evidenceCheck.approvalParameterBinding = {
    checked: [
      "d2.alpha <-> preregistration",
      "d2.minimumIndependentSourceGroups <-> preregistration",
      "d2.precisionTarget <-> preregistration <-> calibration",
      "d2.model <-> calibration judgeModel",
      "d2.callBudget <-> calibration audit call count",
      "d5.samplePairs <-> blind-review sample count (floor)",
      "d5.agreementRateThreshold <-> recomputed review agreement rate",
      "d5.maxPositionFlipRate <-> recomputed calibration flip rate",
      "d5.recheckRequired <-> recomputed recheck stability",
      "d6.datasetSha256 <-> admission report <-> source-groups mapping",
    ],
    findings: parameterFindings,
  };

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
  const checkClaim = (
    label,
    entryKey,
    declared,
    facts,
    pickStatus,
    pickDeclaredCount,
    pickDerivedCount = pickDeclaredCount,
  ) => {
    const declaredCount = pickDeclaredCount(declared);
    const boundEntry = bound(entryKey);
    if (evidenceBindings[entryKey] === undefined) {
      const affirmative =
        pickStatus(declared) !== "NOT_RUN" || declaredCount > 0;
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
    const derivedCount = pickDerivedCount(facts);
    const statusCheck = compare(
      label,
      pickStatus(declared),
      pickStatus(facts),
      true,
    );
    const countCheck = compare(
      label,
      declaredCount,
      derivedCount,
      true,
    );
    if (statusCheck.verdict === "mismatch" || countCheck.verdict === "mismatch")
      addBlocked("EVIDENCE_CLAIM_MISMATCH");
    evidenceCheck.artifacts[label] = {
      bound: true,
      declaredStatus: pickStatus(declared),
      derivedStatus: pickStatus(facts),
      declaredCount,
      derivedCount,
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
    // CR6: the declared count is modelCallCount from the input contract;
    // the derived total is recomputed from raw succeeded + failed invocations.
    // A caller-supplied auditCallCount is rejected during input validation.
    (c) => c.modelCallCount,
    (f) => f.auditCallCount,
  );
  checkClaim(
    "ownerBlindReview",
    "ownerBlindReview",
    review,
    reviewFacts,
    (r) => r.status,
    (r) => r.sampleCount,
  );

  // ── Precision target: RECOMPUTED from the calibration's raw evidence ────
  let precisionEffective = policy.precisionTargetMet;
  if (evidenceBindings.judgeCalibration !== undefined && calibrationDoc !== null) {
    if (!calibrationFacts.interpretable) {
      // EVIDENCE_ARTIFACT_INVALID already added by checkClaim.
      precisionEffective = false;
    } else {
      // Three-way agreement (P1-2): the input claim, the report's own
      // boolean, and the boolean RECOMPUTED from the raw per-invocation
      // verdicts must all be the same value — the recomputed one wins as
      // the effective fact.
      if (calibrationFacts.declaredPrecisionTargetMet !== policy.precisionTargetMet)
        addBlocked("EVIDENCE_CLAIM_MISMATCH");
      if (
        calibrationFacts.precisionTargetMet !==
        calibrationFacts.declaredPrecisionTargetMet
      )
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
    reportClaimed:
      calibrationFacts && calibrationFacts.interpretable
        ? calibrationFacts.declaredPrecisionTargetMet
        : null,
    recomputed:
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
        contentDigestMismatch: groupFacts.contentDigestMismatch === true,
        digestRecomputeFailed: groupFacts.digestRecomputeFailed === true,
        malformedPerSampleEntry: groupFacts.malformedPerSampleEntry === true,
        duplicateCase: groupFacts.duplicateCase ?? null,
        countMismatch: groupFacts.countMismatch ?? null,
        unmappedCase: groupFacts.unmappedCase ?? null,
        unknownCase: groupFacts.unknownCase ?? null,
        sessionSplit: groupFacts.sessionSplit ?? null,
        sessionAnchorMissingSharedGroup: groupFacts.sessionAnchorMissingSharedGroup ?? null,
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
  // Fail-closed: an exhausted search is a BLOCKED verdict, never a null that
  // Math.max or >= would silently coerce to 0 (P2-1) — every comparison
  // against nMinAlpha below is guarded by an explicit null check.
  if (nMinAlpha === null) addBlocked("N_MIN_ALPHA_SEARCH_EXHAUSTED");
  const requiredGroups = nMinAlpha !== null ? Math.max(nMinAlpha, minimumGroups) : minimumGroups;
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

  const preregExploratory =
    preregFacts !== null && preregFacts.interpretable === true && preregFacts.exploratory === true;

  const unmetCriteria = [];
  if (blockedReasons.length === 0) {
    if (nMinAlpha !== null && nEffective < nMinAlpha)
      unmetCriteria.push("BELOW_N_MIN_ALPHA");
    if (nEffective < minimumGroups)
      unmetCriteria.push("BELOW_PREREGISTERED_MIN_SOURCE_GROUPS");
    if (!precisionEffective) unmetCriteria.push("PRECISION_TARGET_NOT_MET");
    if (revStatus !== "PASSED")
      unmetCriteria.push("OWNER_BLIND_REVIEW_NOT_PASSED");
    // P1-1: an exploratory-marked preregistration can NEVER satisfy the
    // confirmatory criteria — no sample size, precision or later evidence
    // upgrades an exploratory registration to CONFIRMATORY_READY. Only a
    // fresh confirmatory preregistration (a new experiment) can.
    if (preregExploratory) unmetCriteria.push("PREREGISTRATION_EXPLORATORY_CAP");
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
      // P2-1: explicit null guard — a null nMinAlpha must never be silently
      // coerced to 0 by JavaScript's relational comparison rules.
      nMeetsNMinAlpha: nMinAlpha !== null && nEffective >= nMinAlpha,
      nMeetsPreregisteredMinimum: nEffective >= minimumGroups,
      precisionTargetMet: precisionEffective,
      preregistrationExploratory: preregExploratory,
    },
    t6Permissions: {
      confirmatoryT6Allowed: status === "CONFIRMATORY_READY",
      // SPEC 11 / HANDOFF T7a item 4 (P1-1): exploratory T6 execution is
      // granted ONLY when ALL of the following hold simultaneously —
      //   * the verdict is EXPLORATORY_ONLY (every authorization, integrity
      //     and calibration gate passed; the shortfall is statistical);
      //   * D2 is a bound, interpretable, APPROVED owner-decision;
      //   * that D2 record EXPLICITLY grants exploratory;
      //   * the FROZEN preregistration is marked exploratory;
      //   * D5 is approved (checked again here — never assumed from the
      //     status alone);
      //   * the Owner blind review actually ran, PASSED, and its recomputed
      //     sample count meets the D5-approved floor.
      // No single input boolean can satisfy this on its own.
      exploratoryT6Allowed: !(
        status !== "EXPLORATORY_ONLY" ||
        d2Approval === null ||
        !d2Approval.interpretable ||
        !d2Approval.approved ||
        !d2Approval.exploratory ||
        !preregExploratory ||
        !d5Effective ||
        revStatus !== "PASSED" ||
        reviewFacts === null ||
        !reviewFacts.interpretable ||
        d5Params === null ||
        reviewFacts.sampleCount < d5Params.samplePairs
      ),
      // Exploratory results can NEVER produce PROMOTE; only a
      // CONFIRMATORY_READY qualification over a NON-exploratory
      // preregistration may ever carry a promote recommendation (P1-1:
      // bound by BOTH the status and the registration type), and even
      // there governance decides (SPEC section 10).
      promotePossible: status === "CONFIRMATORY_READY" && !preregExploratory,
    },
  };
}
