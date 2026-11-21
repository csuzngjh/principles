// PD-Lab v0.3 T7a qualification gate (PRI-1258): the mechanical three-state
// T6 qualification engine of SPEC-PD-LAB-EXPERIMENT-INTEGRATION-001 v0.3
// section 11 (R2) and HANDOFF task T7a items 4-5 / DT-08 / DT-09.
//
//   BLOCKED            authorization or data-integrity unqualified, n = 0,
//                      D2/D5 not approved, or the live judge-model
//                      calibration did not run or failed. T6 must not start.
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
//   - the verdict is a PURE FUNCTION of the explicit input record; nothing
//     is inferred, defaulted or read from the environment/filesystem/clock;
//     the full input is echoed in the output so the verdict is mechanically
//     recomputable (acceptance: 三种资格状态可以从原始输入机械复算);
//   - n counts READY INDEPENDENT SOURCE GROUPS for the T6 path — never Pain
//     counts, repetitions or judgment votes (CONTRACT 6.5);
//   - k(n, alpha) and n_min(alpha) reuse T4's exact BigInt two-sided
//     threshold (alignment-report.twoSidedThreshold) — one statistical
//     authority; the default 6 is never hardcoded for other alphas;
//   - without D2 the recorded real model call count MUST be 0 and without
//   D5 the Owner blind-review sample count MUST be 0 — a nonzero count is
//     reported as an authorization violation (task stop condition), never
//     silently accepted;
//   - alpha comes from the D2-frozen analysis policy; changing it is a
//     protocol version change, and the output echoes it so drift is visible.
//
// Exports:
//   QUALIFICATION_STATUSES, QUALIFICATION_REASON_CODES, nMinForAlpha(alpha),
//   validateQualificationInput(input), qualifyT6(input)

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

// Closed reason-code set (ERR-146: every code is triggerable in tests, no
// unlisted code is ever emitted).
export const QUALIFICATION_REASON_CODES = Object.freeze([
  // BLOCKED reasons (any one blocks T6).
  "DATA_PATH_AUTHORIZATION_INVALID",
  "DATA_INTEGRITY_UNPROVEN",
  "NO_READY_SOURCE_GROUPS",
  "D2_NOT_APPROVED",
  "D5_NOT_APPROVED",
  "MODEL_CALIBRATION_NOT_RUN",
  "MODEL_CALIBRATION_FAILED",
  // Authorization violations (task stop conditions, fail-loud disclosures).
  "UNAUTHORIZED_MODEL_CALLS_RECORDED",
  "UNAUTHORIZED_OWNER_BLIND_REVIEW_RECORDED",
  // EXPLORATORY_ONLY unmet confirmatory criteria.
  "BELOW_N_MIN_ALPHA",
  "BELOW_PREREGISTERED_MIN_SOURCE_GROUPS",
  "PRECISION_TARGET_NOT_MET",
  "OWNER_BLIND_REVIEW_NOT_PASSED",
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

function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
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
  return { ok: problems.length === 0, problems };
}

/**
 * Compute the T6 qualification verdict. Pure: same input object -> same
 * output object. The output embeds the validated input, the derived
 * thresholds and every fired reason code, so the verdict can be recomputed
 * mechanically from the raw qualification input alone.
 */
export function qualifyT6(input) {
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
  const n = input.readyIndependentSourceGroups;
  const alpha = policy.alpha;
  const nMinAlpha = nMinForAlpha(alpha);
  const requiredGroups = Math.max(
    nMinAlpha,
    policy.minimumIndependentSourceGroups,
  );
  const kAtN = twoSidedThreshold(n, alpha);

  const blockedReasons = [];
  const addBlocked = (code) => blockedReasons.push(code);
  // Task stop conditions first: recorded activity without the authorization
  // that permits it is a violation that must be reported loudly.
  if (!authorization.d2Approved && calibration.modelCallCount > 0) {
    addBlocked("UNAUTHORIZED_MODEL_CALLS_RECORDED");
  }
  if (!authorization.d5Approved && review.sampleCount > 0) {
    addBlocked("UNAUTHORIZED_OWNER_BLIND_REVIEW_RECORDED");
  }
  if (!authorization.dataPathAuthorizationValid)
    addBlocked("DATA_PATH_AUTHORIZATION_INVALID");
  if (!authorization.dataIntegrityValid) addBlocked("DATA_INTEGRITY_UNPROVEN");
  if (n === 0) addBlocked("NO_READY_SOURCE_GROUPS");
  if (!authorization.d2Approved) addBlocked("D2_NOT_APPROVED");
  if (!authorization.d5Approved) addBlocked("D5_NOT_APPROVED");
  if (calibration.status === "NOT_RUN") addBlocked("MODEL_CALIBRATION_NOT_RUN");
  if (calibration.status === "FAILED") addBlocked("MODEL_CALIBRATION_FAILED");

  const unmetCriteria = [];
  if (blockedReasons.length === 0) {
    if (n < nMinAlpha) unmetCriteria.push("BELOW_N_MIN_ALPHA");
    if (n < policy.minimumIndependentSourceGroups)
      unmetCriteria.push("BELOW_PREREGISTERED_MIN_SOURCE_GROUPS");
    if (!policy.precisionTargetMet)
      unmetCriteria.push("PRECISION_TARGET_NOT_MET");
    if (review.status !== "PASSED")
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
    thresholds: {
      alpha,
      alphaPerDirection: alpha / 2,
      nMinAlpha,
      minimumIndependentSourceGroups: policy.minimumIndependentSourceGroups,
      requiredIndependentSourceGroups: requiredGroups,
      readyIndependentSourceGroups: n,
      kAtReadyN: kAtN,
      thresholdAuthority:
        "CONTRACT-PD-LAB-DATA-AND-SCORING-001 v0.3 section 6.5 (exact BigInt two-sided binomial tail via alignment-report.twoSidedThreshold); n_min(alpha) is derived, never hardcoded",
    },
    judgeProtocol: {
      judgeProtocolRef: JUDGE_PROTOCOL_REF,
      judgeProtocolDigest: judgeProtocolDigest(),
    },
    checks: {
      dataPathAuthorizationValid: authorization.dataPathAuthorizationValid,
      dataIntegrityValid: authorization.dataIntegrityValid,
      d2Approved: authorization.d2Approved,
      d5Approved: authorization.d5Approved,
      modelCalibrationPassed: calibration.status === "PASSED",
      ownerBlindReviewPassed: review.status === "PASSED",
      nMeetsNMinAlpha: n >= nMinAlpha,
      nMeetsPreregisteredMinimum: n >= policy.minimumIndependentSourceGroups,
      precisionTargetMet: policy.precisionTargetMet,
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
