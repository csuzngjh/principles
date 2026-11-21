// PD-Lab v0.3 T7a-judge (PRI-1258): the versioned Judge Protocol of
// CONTRACT-PD-LAB-DATA-AND-SCORING-001 v0.3 section 5.1 and TECH section 6.6.
//
// What this module owns:
//   - the frozen, versioned protocol definition (`judgeProtocolRef`) and its
//     content digest, so every judgment record can be bound to the exact
//     protocol behavior it was produced under;
//   - strict four-value parsing of a judge's raw response
//     (A_BETTER / TIE / B_BETTER / UNKNOWN): illegal output is REJECTED and
//     can never degrade to TIE; UNKNOWN is an explicit verdict that must
//     carry a reason;
//   - blind judge-package assembly with the same leak discipline as the
//     historical blindpack (scrub + scan reusing ab-blindpack's exported
//     pure scanners — the leak rule set stays single-sourced there);
//   - A/B position exchange (swap) and the controlled identity binding that
//     restores display verdicts to candidate/reference identities;
//   - the full CONTRACT 5.1 record schema validation (rubric version,
//     model/provider/version on both sides, model-family relation
//     disclosure, attempt + attemptStatus, display order, identity map,
//     both-side evidence anchors, reason, lossyInput + truncation facts).
//
// What it deliberately does NOT do:
//   - it never calls a model, never touches the network, never reads the
//     filesystem or the environment and never reads the clock (same purity
//     contract as alignment-report.mjs; the CLI wrappers own all I/O);
//   - it does not modify the historical `ab-eval.mjs` three-value output or
//     any historical record (TECH section 6.6: historical formats keep their
//     original meaning; this protocol is the NEW versioned path);
//   - it does not merge votes — T4 `mergeJudgments` (alignment-report.mjs)
//     stays the single merge authority; records produced here are drop-in
//     compatible with its input shape (extra protocol fields are ignored by
//     T4's parser, identity flows through the per-judgment blindmap).
//
// Fail-closed rules frozen here (each has a test):
//   - illegal judge output -> JUDGE_OUTPUT_* problem, never TIE;
//   - UNKNOWN without reason / reason on a non-UNKNOWN verdict -> rejected;
//   - lossy (truncated/degraded) judged input -> lossyInput:true + truncation
//     facts, and the verdict must be UNKNOWN (an incomplete input cannot be
//     proven non-essential-loss, CONTRACT 5.1: "关键证据缺失时该单元判
//     UNKNOWN，不得当作完整输入正常评价");
//   - a blind package that fails the leak scan is refused at build time;
//   - failed attempts are preserved records (attemptStatus FAILED) and are
//     validated with the same identity/digest/model bindings.
//
// Exports:
//   JUDGE_PROTOCOL_REF, PROTOCOL_VERDICTS, DISPLAY_ORDERS, ARM_ROLES,
//   MODEL_RELATION_DISCLOSURES, JUDGE_PROTOCOL, judgeProtocolDigest(),
//   JUDGE_OUTPUT_PROBLEM_CODES, PROTOCOL_RECORD_PROBLEM_CODES,
//   parseJudgeResponse(rawText), buildJudgePackage(input),
//   swapJudgePackage(blindPackage, secretBinding),
//   checkPackageForLeaks(blindPackage),
//   comparisonInputDigestOf(blindPackage, identityMap),
//   buildProtocolRecord(input), validateProtocolRecord(record),
//   restoreDisplayVerdict(displayVerdict, identityMap)

import { createHash } from "node:crypto";
import { findBlindViolations } from "../../../experiment/prompt-v2/scripts/ab/ab-blindpack.mjs";

export const JUDGE_PROTOCOL_REF = "jp-pd-lab@1";

/**
 * Recursive freeze: the exported protocol vocabulary and definition must be
 * immutable all the way down — a caller that could mutate a nested array or
 * object would silently change parse/validation behavior AFTER the content
 * digest was computed, breaking the digest's binding to the frozen
 * definition (PR #2740 remediation: shallow Object.freeze was not enough).
 */
function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

export const PROTOCOL_VERDICTS = deepFreeze([
  "A_BETTER",
  "TIE",
  "B_BETTER",
  "UNKNOWN",
]);

export const DISPLAY_ORDERS = deepFreeze(["AB", "BA"]);

export const ARM_ROLES = deepFreeze(["candidate", "reference"]);

// CONTRACT 5.1: the judge/generator model-family relation is an explicit
// disclosure, not a hidden item. Same-family is a DECLARED limitation; an
// undisclosed relation is not a legal record.
export const MODEL_RELATION_DISCLOSURES = deepFreeze([
  "SAME_FAMILY",
  "DIFFERENT_FAMILY",
]);

// The frozen protocol definition. Every behavior-relevant constant lives
// here so `judgeProtocolDigest()` binds them all: changing any of it is a
// protocol version change (new judgeProtocolRef), never a silent edit.
export const JUDGE_PROTOCOL = Object.freeze({
  judgeProtocolRef: JUDGE_PROTOCOL_REF,
  protocolKind: "pd-lab-pairwise-owner-alignment",
  specRefs: [
    "SPEC-PD-LAB-EXPERIMENT-INTEGRATION-001-v0.3#8.2",
    "CONTRACT-PD-LAB-DATA-AND-SCORING-001-v0.3#5.1",
    "TECH-PD-LAB-EXPERIMENT-INTEGRATION-001-v0.3#6.6",
  ],
  rubricVersion: "jp-pd-lab-rubric@1",
  // SPEC 8.2: the comparison question is FIXED. It is never swapped for
  // "which is safer / more polite / longer / more tool-successful".
  comparisonQuestion:
    "Given this Owner context and the frozen expectation basis, which actual behavior trajectory is closer to the expectations?",
  verdictVocabulary: PROTOCOL_VERDICTS,
  unknownPolicy: {
    explicitOnly: true,
    requiresReason: true,
    // Low confidence, short rationale or timeout are NOT UNKNOWN (CONTRACT
    // 5.1); a technically failed call is an attemptStatus=FAILED record.
    lowConfidenceIsNotUnknown: true,
  },
  illegalOutputPolicy: "REJECT_NEVER_TIE",
  outputContract: [
    "Exactly the following line-oriented fields, one per line, nothing else:",
    "VERDICT: A_BETTER | B_BETTER | TIE | UNKNOWN",
    "REASON: <one line, non-empty>",
    "UNKNOWN_REASON: <one line, non-empty> — required iff VERDICT is UNKNOWN, forbidden otherwise",
  ].join("\n"),
  lossyInputPolicy: {
    markLossy: true,
    recordTruncationFacts: true,
    // A truncated/degraded judged input cannot be proven free of essential
    // evidence loss, so the unit is judged UNKNOWN, never scored normally.
    truncatedJudgedInputForces: "UNKNOWN",
  },
  displayOrderPolicy:
    "display positions are frozen per package at build time; a position exchange is a SEPARATE package whose outputs are exchanged and whose identity binding is inverted",
  arbitrationPolicy:
    "conflicting judgments enter the frozen blind arbitration path (CONTRACT 5.2); an arbitration must bind every participating judgment id AND its comparisonInputDigest; unresolved or incompletely bound conflicts stay UNKNOWN and are never averaged",
  judgeSlotPolicy:
    "every judgment record is attributed to exactly one judge slot (judgeSlotId); a missing slot binding is never defaulted, and without a preregistered slot registry the slot's preregistration check is disclosed as unverified, never reported as verified (CONTRACT 5.2a)",
  attemptPolicy:
    "a non-FAILED record must carry its positive-integer attempt number — a missing attempt is never defaulted to 1; failed attempts are preserved audit records (attemptStatus FAILED) and never vote (CONTRACT 5.2a)",
  positionExchangePolicy:
    "a position exchange is valid only as a complete semantic swap: exchanged outputs byte-identical, identical context/rubricVersion/judgeProtocolRef/comparisonQuestion, inverted identity map, flipped display order, truncation sides swapped by role, and one shared role-canonical comparisonInputDigest; incomplete or invalid exchanges never enter the flip-rate denominator and UNKNOWN/FAILED results are disclosed separately, never counted as consistent",
  modelRelationDisclosureVocabulary: MODEL_RELATION_DISCLOSURES,
});
deepFreeze(JUDGE_PROTOCOL);

// ---------------------------------------------------------------------------
// canonicalJson — IDENTICAL semantics to alignment-report.mjs /
// admission-probe.mjs (sorted keys, array order preserved, undefined
// rejected). Third deliberate copy: TECH 3.2 pins each module's export
// surface, so — as documented in admission-probe.mjs — the canonicalization
// is re-implemented locally and tests pin determinism plus key-order
// independence. The judgeProtocolDigest below is the only consumer here.
// ---------------------------------------------------------------------------
class CanonicalJsonError extends Error {}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    const body = keys
      .map((key) => {
        const item = value[key];
        if (item === undefined) {
          throw new CanonicalJsonError(
            `canonicalJson: key ${JSON.stringify(key)} has an undefined value`,
          );
        }
        return `${JSON.stringify(key)}:${canonicalJson(item)}`;
      })
      .join(",");
    return `{${body}}`;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  throw new CanonicalJsonError(
    `canonicalJson: unsupported value type ${typeof value}`,
  );
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

let cachedProtocolDigest = null;

/**
 * Content digest of the frozen protocol definition. Deterministic and
 * machine-independent (no clock/env/fs inputs); two runs on the same source
 * produce the same digest, and any behavior-relevant edit changes it.
 */
export function judgeProtocolDigest() {
  if (cachedProtocolDigest === null) {
    cachedProtocolDigest = `sha256:${sha256Hex(canonicalJson(JUDGE_PROTOCOL))}`;
  }
  return cachedProtocolDigest;
}

// ---------------------------------------------------------------------------
// Strict four-value parsing of a judge's raw response (TECH 6.6).
// ---------------------------------------------------------------------------

export const JUDGE_OUTPUT_PROBLEM_CODES = Object.freeze([
  "JUDGE_OUTPUT_EMPTY",
  "JUDGE_OUTPUT_LINE_MALFORMED",
  "JUDGE_OUTPUT_LINE_INVALID",
  "JUDGE_OUTPUT_VERDICT_MISSING",
  "JUDGE_OUTPUT_VERDICT_DUPLICATE",
  "JUDGE_OUTPUT_VERDICT_UNKNOWN_VALUE",
  "JUDGE_OUTPUT_REASON_MISSING",
  "JUDGE_OUTPUT_REASON_DUPLICATE",
  "JUDGE_OUTPUT_UNKNOWN_REASON_MISSING",
  "JUDGE_OUTPUT_UNKNOWN_REASON_FORBIDDEN",
]);

const OUTPUT_LINE_RE = /^([A-Z_]+):(.*)$/;

/**
 * Parse a raw judge response under the protocol output contract.
 *
 * Returns { ok: true, displayVerdict, reason, unknownReason } or
 * { ok: false, code, message }. An illegal response NEVER parses as TIE or
 * as any other verdict — callers must record a rejected parse as a failed
 * attempt (or re-run under the frozen recovery policy), never as a vote.
 */
export function parseJudgeResponse(rawText) {
  const fail = (code, message) => ({ ok: false, code, message });
  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    return fail(
      "JUDGE_OUTPUT_EMPTY",
      "judge response is empty or not a string",
    );
  }
  const lines = rawText.split("\n").map((line) => line.replace(/\r$/, ""));
  const fields = { VERDICT: [], REASON: [], UNKNOWN_REASON: [] };
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const match = OUTPUT_LINE_RE.exec(line);
    if (!match) {
      // Markdown fences, JSON, prose, "VERDICT A_BETTER" without a colon,
      // lowercase "verdict:" … all land here. Nothing is coerced.
      return fail(
        "JUDGE_OUTPUT_LINE_MALFORMED",
        `line is not a protocol field (expected "NAME: value"): ${JSON.stringify(line.slice(0, 80))}`,
      );
    }
    const name = match[1];
    if (!Object.hasOwn(fields, name)) {
      return fail("JUDGE_OUTPUT_LINE_INVALID", `unknown field name ${name}`);
    }
    fields[name].push(match[2].trim());
  }
  if (fields.VERDICT.length === 0) {
    return fail(
      "JUDGE_OUTPUT_VERDICT_MISSING",
      "response carries no VERDICT field",
    );
  }
  if (fields.VERDICT.length > 1) {
    return fail(
      "JUDGE_OUTPUT_VERDICT_DUPLICATE",
      `response carries ${fields.VERDICT.length} VERDICT fields`,
    );
  }
  const displayVerdict = fields.VERDICT[0];
  if (!PROTOCOL_VERDICTS.includes(displayVerdict)) {
    // The fail-closed gate: an illegal verdict token is rejected, never
    // mapped to TIE (CONTRACT 5.1, task stop-condition).
    return fail(
      "JUDGE_OUTPUT_VERDICT_UNKNOWN_VALUE",
      `VERDICT value ${JSON.stringify(displayVerdict)} is not one of ${PROTOCOL_VERDICTS.join(" | ")}`,
    );
  }
  if (fields.REASON.length === 0) {
    return fail(
      "JUDGE_OUTPUT_REASON_MISSING",
      "response carries no REASON field",
    );
  }
  if (fields.REASON.length > 1) {
    return fail(
      "JUDGE_OUTPUT_REASON_DUPLICATE",
      `response carries ${fields.REASON.length} REASON fields`,
    );
  }
  const reason = fields.REASON[0];
  if (reason.length === 0) {
    return fail("JUDGE_OUTPUT_REASON_MISSING", "REASON value is empty");
  }
  const unknownReasons = fields.UNKNOWN_REASON;
  if (displayVerdict === "UNKNOWN") {
    if (unknownReasons.length === 0) {
      return fail(
        "JUDGE_OUTPUT_UNKNOWN_REASON_MISSING",
        "UNKNOWN verdict requires an UNKNOWN_REASON",
      );
    }
    if (unknownReasons.length > 1) {
      return fail(
        "JUDGE_OUTPUT_UNKNOWN_REASON_FORBIDDEN",
        `UNKNOWN carries ${unknownReasons.length} UNKNOWN_REASON fields`,
      );
    }
    if (unknownReasons[0].length === 0) {
      return fail(
        "JUDGE_OUTPUT_UNKNOWN_REASON_MISSING",
        "UNKNOWN_REASON value is empty",
      );
    }
    return {
      ok: true,
      displayVerdict,
      reason,
      unknownReason: unknownReasons[0],
    };
  }
  if (unknownReasons.length > 0) {
    return fail(
      "JUDGE_OUTPUT_UNKNOWN_REASON_FORBIDDEN",
      `non-UNKNOWN verdict ${displayVerdict} carries an UNKNOWN_REASON`,
    );
  }
  return { ok: true, displayVerdict, reason, unknownReason: null };
}

// ---------------------------------------------------------------------------
// Blind judge package assembly, leak scan, position exchange (TECH 6.5/6.6).
// ---------------------------------------------------------------------------

// Whole-value arm words: a VALUE that IS an arm role reveals the binding.
// Substrings are intentionally not flagged — judged subject matter may
// legitimately discuss "the candidate approach" in domain content.
const ARM_WORD_VALUES = new Set([
  "candidate",
  "reference",
  "baseline",
  "baselineArm",
  "candidateArm",
  "armA",
  "armB",
]);

/**
 * Leak scan for a blind judge package. Reuses the historical blindpack
 * scanners (single source of truth for arm-token leak rules) and adds the
 * protocol's whole-value arm-word check. Returns a violations array; empty
 * means clean.
 */
export function checkPackageForLeaks(blindPackage) {
  const violations = findBlindViolations(blindPackage);
  // packageId is operator-controlled packaging, never judged material: it
  // may not even CONTAIN an arm word as a substring ("swap-candidate-2"
  // unblinds the package as surely as the bare word does). Judged content
  // (context/outputs) is exempt from the substring rule — it is data.
  if (
    isPlainObject(blindPackage) &&
    typeof blindPackage.packageId === "string" &&
    /candidate|reference|baseline/i.test(blindPackage.packageId)
  ) {
    violations.push({
      path: "$.packageId",
      token: blindPackage.packageId,
      reason: "packageId contains an arm-identity word",
    });
  }
  const walk = (value, basePath) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${basePath}[${index}]`));
      return;
    }
    if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value))
        walk(child, `${basePath}.${key}`);
      return;
    }
    if (typeof value === "string" && ARM_WORD_VALUES.has(value)) {
      violations.push({
        path: basePath,
        token: value,
        reason: "arm-identity value",
      });
    }
  };
  walk(blindPackage, "$");
  return violations;
}

function truncatedText(text, maxChars) {
  if (
    typeof maxChars !== "number" ||
    !Number.isInteger(maxChars) ||
    maxChars <= 0 ||
    text.length <= maxChars
  ) {
    return { text, truncation: null };
  }
  return {
    text: text.slice(0, maxChars),
    truncation: { truncatedAt: maxChars, originalChars: text.length },
  };
}

/**
 * Assemble one blind judge package plus its SECRET identity binding.
 *
 * input = {
 *   packageId,                       non-empty string (unique per judged input)
 *   context,                         string — expectation basis / Owner context
 *                                    material the judge must see
 *   outputCandidate, outputReference, non-empty strings — the two trajectories
 *   identityMap,                     { A: 'candidate'|'reference', B: … },
 *                                    distinct — which arm is displayed as A
 *   displayOrder,                    'AB' | 'BA' (v1 packages always render
 *                                    A-then-B; a position exchange produces a
 *                                    separate swapped package)
 *   maxOutputChars?, maxContextChars? — explicit truncation budgets; any
 *                                    truncation marks the package lossy
 * }
 *
 * Returns { ok: true, blindPackage, secretBinding } or
 * { ok: false, code, message, violations? }. The blindPackage NEVER contains
 * the identityMap, arm roles or display metadata — those live only in the
 * secretBinding (the caller persists it next to the judgment record, e.g. in
 * the decision blindmap). A package that fails the leak scan is refused.
 */
export function buildJudgePackage(input) {
  const fail = (code, message, extra) => ({
    ok: false,
    code,
    message,
    ...extra,
  });
  if (!isPlainObject(input)) {
    return fail(
      "PACKAGE_INPUT_INVALID",
      "buildJudgePackage input must be an object",
    );
  }
  if (!isNonEmptyString(input.packageId))
    return fail(
      "PACKAGE_INPUT_INVALID",
      "packageId must be a non-empty string",
    );
  if (typeof input.context !== "string")
    return fail("PACKAGE_INPUT_INVALID", "context must be a string");
  if (!isNonEmptyString(input.outputCandidate))
    return fail(
      "PACKAGE_INPUT_INVALID",
      "outputCandidate must be a non-empty string",
    );
  if (!isNonEmptyString(input.outputReference))
    return fail(
      "PACKAGE_INPUT_INVALID",
      "outputReference must be a non-empty string",
    );
  const identityMapError = identityMapProblem(input.identityMap);
  if (identityMapError) return fail("PACKAGE_INPUT_INVALID", identityMapError);
  if (!DISPLAY_ORDERS.includes(input.displayOrder)) {
    return fail(
      "PACKAGE_INPUT_INVALID",
      `displayOrder must be one of ${DISPLAY_ORDERS.join(" | ")}`,
    );
  }

  const candidateSide = truncatedText(
    input.outputCandidate,
    input.maxOutputChars,
  );
  const referenceSide = truncatedText(
    input.outputReference,
    input.maxOutputChars,
  );
  const contextSide = truncatedText(input.context, input.maxContextChars);
  const aIsCandidate = input.identityMap.A === "candidate";
  const side = (isA) => (isA ? candidateSide : referenceSide);
  const truncation = [];
  if (side(aIsCandidate).truncation)
    truncation.push({ truncatedSide: "A", ...side(aIsCandidate).truncation });
  if (side(!aIsCandidate).truncation)
    truncation.push({ truncatedSide: "B", ...side(!aIsCandidate).truncation });
  if (contextSide.truncation)
    truncation.push({ truncatedSide: "CONTEXT", ...contextSide.truncation });

  // Judged material is passed through verbatim — never silently redacted.
  // Packaging keys are protocol-controlled and carry no arm metadata; the
  // leak scan below is the gate that refuses a leaking package outright.
  const blindPackage = {
    packageId: input.packageId,
    judgeProtocolRef: JUDGE_PROTOCOL_REF,
    rubricVersion: JUDGE_PROTOCOL.rubricVersion,
    comparisonQuestion: JUDGE_PROTOCOL.comparisonQuestion,
    context: contextSide.text,
    outputA: side(aIsCandidate).text,
    outputB: side(!aIsCandidate).text,
    ...(truncation.length > 0 ? { truncation } : {}),
  };
  const violations = checkPackageForLeaks(blindPackage);
  if (violations.length > 0) {
    // Judged content is data, not packaging: we never silently redact it.
    // A leak inside the judged material fails the build so the operator can
    // re-pack from a clean source (same discipline as ab-blindpack).
    return fail(
      "BLIND_PACKAGE_LEAK",
      "blind judge package failed the leak scan",
      { violations },
    );
  }
  return {
    ok: true,
    blindPackage,
    secretBinding: {
      packageId: input.packageId,
      displayOrder: input.displayOrder,
      identityMap: { A: input.identityMap.A, B: input.identityMap.B },
    },
  };
}

/**
 * Position exchange (SPEC 8.2 / SC-09): produce the swapped counterpart of a
 * blind package. Outputs are exchanged, the display order flips and the
 * identity binding inverts, so the same two trajectories are judged again in
 * the opposite positions. The underlying candidate identity never changes.
 */
export function swapJudgePackage(blindPackage, secretBinding, newPackageId) {
  if (!isPlainObject(blindPackage) || !isPlainObject(secretBinding)) {
    return {
      ok: false,
      code: "SWAP_INPUT_INVALID",
      message: "swapJudgePackage expects package and binding objects",
    };
  }
  if (!isNonEmptyString(newPackageId)) {
    return {
      ok: false,
      code: "SWAP_INPUT_INVALID",
      message: "newPackageId must be a non-empty string",
    };
  }
  const identityMapError = identityMapProblem(secretBinding.identityMap);
  if (identityMapError)
    return { ok: false, code: "SWAP_INPUT_INVALID", message: identityMapError };
  const swapSides = (entries) =>
    entries.map((entry) => ({
      ...entry,
      truncatedSide:
        entry.truncatedSide === "A"
          ? "B"
          : entry.truncatedSide === "B"
            ? "A"
            : entry.truncatedSide,
    }));
  const truncation = Array.isArray(blindPackage.truncation)
    ? swapSides(blindPackage.truncation)
    : undefined;
  const swappedPackage = {
    packageId: newPackageId,
    judgeProtocolRef: blindPackage.judgeProtocolRef,
    rubricVersion: blindPackage.rubricVersion,
    comparisonQuestion: blindPackage.comparisonQuestion,
    context: blindPackage.context,
    outputA: blindPackage.outputB,
    outputB: blindPackage.outputA,
    ...(truncation && truncation.length > 0 ? { truncation } : {}),
  };
  // P2-3 final blind-leak gate: the exchanged package is a BLIND PACKAGE
  // like any other, so it must pass the same leak scan the original had to
  // pass — including the new packageId itself. A packageId that names an
  // arm ("candidate", "reference", …) or carries other identity-leaking
  // values would unblind the position exchange from the outside; such a
  // swap is refused with ok:false, never returned as a valid package.
  const violations = checkPackageForLeaks(swappedPackage);
  if (violations.length > 0) {
    return {
      ok: false,
      code: "SWAP_BLIND_PACKAGE_LEAK",
      message:
        "the swapped blind judge package failed the blind-leak scan (its packageId or exchanged content leaks arm identity)",
      violations,
    };
  }
  return {
    ok: true,
    blindPackage: swappedPackage,
    secretBinding: {
      packageId: newPackageId,
      displayOrder: secretBinding.displayOrder === "AB" ? "BA" : "AB",
      identityMap: {
        A: secretBinding.identityMap.B,
        B: secretBinding.identityMap.A,
      },
    },
  };
}

/**
 * Digest of the exact judged COMPARISON INPUT, canonicalized by the true
 * arm roles (candidate/reference), not by the blind display positions.
 *
 * Why order-canonical (CONTRACT 5.1 + T4's COMPARISON_INPUT_DIGEST_CONFLICT
 * gate): the comparison input is the pair of trajectories plus context; a
 * position exchange presents the same input in swapped positions. Digesting
 * the role-canonical form makes the original and the swapped presentation
 * of one comparison share ONE digest — proving "one frozen comparison" to
 * T4 — while any CONTENT change (either output, the context, the rubric or
 * the protocol ref) still changes the digest. The presentation itself stays
 * auditable through the record's packageId + displayOrder + identityMap.
 */
export function comparisonInputDigestOf(blindPackage, identityMap) {
  const mapError = identityMapProblem(identityMap);
  if (!isPlainObject(blindPackage) || mapError) {
    throw new Error(
      `comparisonInputDigestOf: ${mapError ?? "blindPackage must be an object"}`,
    );
  }
  const aIsCandidate = identityMap.A === "candidate";
  const roleOfSide = (side) => (side === "A" ? identityMap.A : identityMap.B);
  let truncationByRole = null;
  if (Array.isArray(blindPackage.truncation)) {
    truncationByRole = {};
    for (const entry of blindPackage.truncation) {
      const key =
        entry.truncatedSide === "CONTEXT"
          ? "context"
          : roleOfSide(entry.truncatedSide);
      truncationByRole[key] = {
        truncatedAt: entry.truncatedAt,
        originalChars: entry.originalChars,
      };
    }
  }
  const canonical = {
    judgeProtocolRef: blindPackage.judgeProtocolRef,
    rubricVersion: blindPackage.rubricVersion,
    comparisonQuestion: blindPackage.comparisonQuestion,
    context: blindPackage.context,
    candidateOutput: aIsCandidate ? blindPackage.outputA : blindPackage.outputB,
    referenceOutput: aIsCandidate ? blindPackage.outputB : blindPackage.outputA,
    ...(truncationByRole && Object.keys(truncationByRole).length > 0
      ? { truncation: truncationByRole }
      : {}),
  };
  return `sha256:${sha256Hex(canonicalJson(canonical))}`;
}

// ---------------------------------------------------------------------------
// CONTRACT 5.1 protocol record: schema validation (closed problem-code set).
// ---------------------------------------------------------------------------

export const PROTOCOL_RECORD_PROBLEM_CODES = Object.freeze([
  "RECORD_NOT_OBJECT",
  "FIELD_MISSING",
  "FIELD_INVALID",
  "PROTOCOL_REF_MISMATCH",
  "RUBRIC_VERSION_MISMATCH",
  "DISPLAY_VERDICT_INVALID",
  "UNKNOWN_REASON_MISSING",
  "UNKNOWN_REASON_FORBIDDEN",
  "LOSSY_VERDICT_NOT_UNKNOWN",
  "TRUNCATION_MISSING",
  "TRUNCATION_FORBIDDEN",
  "TRUNCATION_INVALID",
  "IDENTITY_MAP_INVALID",
  "DISPLAY_ORDER_INVALID",
  "EVIDENCE_INVALID",
  "EVIDENCE_SIDES_INVALID",
  "ATTEMPT_INVALID",
  "ATTEMPT_MISSING",
  "ATTEMPT_STATUS_INVALID",
  "JUDGE_SLOT_ID_INVALID",
  "JUDGE_SLOT_BINDING_MISSING",
  "MODEL_BLOCK_INVALID",
  "RELATION_DISCLOSURE_INVALID",
  "REASON_MISSING",
  "DIGEST_INVALID",
  "PROTOCOL_DIGEST_MISMATCH",
]);

export function identityMapProblem(identityMap) {
  if (!isPlainObject(identityMap)) return "identityMap must be an object";
  const { A, B } = identityMap;
  if (!ARM_ROLES.includes(A) || !ARM_ROLES.includes(B) || A === B) {
    return `identityMap must assign distinct roles (${ARM_ROLES.join(" / ")}) to A and B`;
  }
  return null;
}

function modelBlockProblem(block, label) {
  if (!isPlainObject(block)) return `${label} must be an object`;
  for (const field of ["provider", "model", "version"]) {
    if (!isNonEmptyString(block[field]))
      return `${label}.${field} must be a non-empty string`;
  }
  return null;
}

function truncationProblem(truncation) {
  if (!Array.isArray(truncation) || truncation.length === 0) {
    return "truncation must be a non-empty array when lossyInput is true";
  }
  for (const entry of truncation) {
    if (!isPlainObject(entry)) return "each truncation entry must be an object";
    if (!["A", "B", "CONTEXT"].includes(entry.truncatedSide)) {
      return "truncation entry truncatedSide must be A, B or CONTEXT";
    }
    if (
      !isPositiveInteger(entry.truncatedAt) ||
      !isPositiveInteger(entry.originalChars)
    ) {
      return "truncation entry truncatedAt/originalChars must be positive integers";
    }
    if (entry.originalChars < entry.truncatedAt) {
      return "truncation entry originalChars must be >= truncatedAt";
    }
  }
  return null;
}

/**
 * Validate one protocol judgment record against the CONTRACT 5.1 schema.
 * Returns { ok, problems: [{ code, message }] } with codes from the closed
 * PROTOCOL_RECORD_PROBLEM_CODES set (ERR-146: every code is triggerable,
 * no unlisted code is ever emitted). Records are never mutated.
 */
export function validateProtocolRecord(record) {
  const problems = [];
  const problem = (code, message) => problems.push({ code, message });
  if (!isPlainObject(record)) {
    return {
      ok: false,
      problems: [
        {
          code: "RECORD_NOT_OBJECT",
          message: "judgment record must be an object",
        },
      ],
    };
  }
  const requireString = (field) => {
    if (!isNonEmptyString(record[field])) {
      problem("FIELD_MISSING", `${field} must be a non-empty string`);
      return false;
    }
    return true;
  };
  requireString("judgmentId");
  requireString("assignmentKey");
  if (isNonEmptyString(record.judgeProtocolRef)) {
    if (record.judgeProtocolRef !== JUDGE_PROTOCOL_REF) {
      problem(
        "PROTOCOL_REF_MISMATCH",
        `judgeProtocolRef ${record.judgeProtocolRef} is not ${JUDGE_PROTOCOL_REF}`,
      );
    }
  } else {
    problem("FIELD_MISSING", "judgeProtocolRef must be a non-empty string");
  }
  if (isNonEmptyString(record.rubricVersion)) {
    if (record.rubricVersion !== JUDGE_PROTOCOL.rubricVersion) {
      problem(
        "RUBRIC_VERSION_MISMATCH",
        `rubricVersion ${record.rubricVersion} is not ${JUDGE_PROTOCOL.rubricVersion}`,
      );
    }
  } else {
    problem("FIELD_MISSING", "rubricVersion must be a non-empty string");
  }
  if (
    typeof record.comparisonInputDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(record.comparisonInputDigest)
  ) {
    problem(
      "DIGEST_INVALID",
      "comparisonInputDigest must match sha256:<64 lowercase hex>",
    );
  }

  // T4 parseJudgmentRecords parity (P2-1): only `undefined` means "not
  // provided" — an explicit null is an invalid value, never a silent absent.
  const attemptStatus =
    record.attemptStatus === undefined ? null : record.attemptStatus;
  if (
    record.attemptStatus !== undefined &&
    attemptStatus !== "FAILED" &&
    attemptStatus !== "SUCCEEDED"
  ) {
    problem(
      "ATTEMPT_STATUS_INVALID",
      "attemptStatus must be FAILED or SUCCEEDED when present (explicit null is invalid, only absence defaults)",
    );
  }
  if (record.attempt !== undefined && !isPositiveInteger(record.attempt)) {
    problem("ATTEMPT_INVALID", "attempt must be a positive integer");
  }
  // CONTRACT 5.2a + T4 parity: a non-FAILED vote candidate must carry its
  // attempt number. It is never defaulted — a missing attempt means the
  // attempt's audit position cannot be verified, so the record is invalid.
  if (attemptStatus !== "FAILED" && record.attempt === undefined) {
    problem(
      "ATTEMPT_MISSING",
      "a non-FAILED record requires its positive-integer attempt number (never defaulted)",
    );
  }
  // CONTRACT 5.2a + T4 parity: every judgment record must be attributed to
  // its judge slot. A missing binding is never defaulted to some slot.
  if (record.judgeSlotId === undefined) {
    problem(
      "JUDGE_SLOT_BINDING_MISSING",
      "every judgment record requires a judgeSlotId (never defaulted)",
    );
  } else if (!isNonEmptyString(record.judgeSlotId)) {
    problem(
      "JUDGE_SLOT_ID_INVALID",
      "judgeSlotId must be a non-empty string when present",
    );
  }
  // Every formal record binds the protocol definition it was produced under:
  // ref AND content digest (recomputed from the frozen definition at
  // validation time — an old-protocol record is never silently accepted).
  if (isNonEmptyString(record.judgeProtocolDigest)) {
    if (record.judgeProtocolDigest !== judgeProtocolDigest()) {
      problem(
        "PROTOCOL_DIGEST_MISMATCH",
        `judgeProtocolDigest does not match the current ${JUDGE_PROTOCOL_REF} digest`,
      );
    }
  } else if (record.judgeProtocolDigest !== undefined) {
    problem(
      "DIGEST_INVALID",
      "judgeProtocolDigest must match sha256:<64 lowercase hex>",
    );
  } else {
    problem(
      "FIELD_MISSING",
      "judgeProtocolDigest must be a non-empty string (binds the record to the frozen protocol definition)",
    );
  }

  // Verdict block: a FAILED attempt may legitimately carry no verdict (the
  // failed call produced nothing) — T4 parity, the audit record survives.
  const hasVerdict = record.displayVerdict !== undefined;
  if (hasVerdict && !PROTOCOL_VERDICTS.includes(record.displayVerdict)) {
    problem(
      "DISPLAY_VERDICT_INVALID",
      `displayVerdict ${JSON.stringify(record.displayVerdict)} is not one of ${PROTOCOL_VERDICTS.join(" | ")}`,
    );
  } else if (!hasVerdict && attemptStatus !== "FAILED") {
    problem(
      "DISPLAY_VERDICT_INVALID",
      "displayVerdict is required (only a FAILED attempt may omit it)",
    );
  }
  const verdictKnown = PROTOCOL_VERDICTS.includes(record.displayVerdict);
  if (
    verdictKnown &&
    record.displayVerdict === "UNKNOWN" &&
    attemptStatus !== "FAILED" &&
    !isNonEmptyString(record.unknownReason)
  ) {
    problem(
      "UNKNOWN_REASON_MISSING",
      "an UNKNOWN verdict requires a non-empty unknownReason",
    );
  }
  if (
    verdictKnown &&
    record.displayVerdict !== "UNKNOWN" &&
    record.unknownReason !== undefined
  ) {
    problem(
      "UNKNOWN_REASON_FORBIDDEN",
      `a ${record.displayVerdict} verdict must not carry an unknownReason`,
    );
  }

  // lossyInput / truncation consistency (CONTRACT 5.1 + TECH 6.6).
  const lossyInput = record.lossyInput === true;
  if (
    record.lossyInput !== undefined &&
    typeof record.lossyInput !== "boolean"
  ) {
    problem("FIELD_INVALID", "lossyInput must be a boolean when present");
  }
  const hasTruncation =
    record.truncation !== undefined && record.truncation !== null;
  if (lossyInput && !hasTruncation) {
    problem(
      "TRUNCATION_MISSING",
      "lossyInput true requires truncation facts (truncation position per CONTRACT 5.1)",
    );
  }
  if (!lossyInput && hasTruncation) {
    problem(
      "TRUNCATION_FORBIDDEN",
      "truncation facts require lossyInput true — an input that cannot be proven complete must not be marked complete",
    );
  }
  if (hasTruncation) {
    const message = truncationProblem(record.truncation);
    if (message) problem("TRUNCATION_INVALID", message);
  }
  if (lossyInput && verdictKnown && record.displayVerdict !== "UNKNOWN") {
    problem(
      "LOSSY_VERDICT_NOT_UNKNOWN",
      `a lossy (truncated/degraded) judged input must yield UNKNOWN, not ${record.displayVerdict}`,
    );
  }

  if (identityMapProblem(record.identityMap)) {
    problem("IDENTITY_MAP_INVALID", identityMapProblem(record.identityMap));
  }
  if (!DISPLAY_ORDERS.includes(record.displayOrder)) {
    problem(
      "DISPLAY_ORDER_INVALID",
      `displayOrder must be one of ${DISPLAY_ORDERS.join(" | ")}`,
    );
  }

  // Both-side evidence anchors (CONTRACT 5.1 两侧证据引用). Mechanical rule:
  // a win cites the winning side, a TIE cites both, UNKNOWN cites anything.
  const evidence = record.evidence;
  const evidenceValid =
    Array.isArray(evidence) &&
    evidence.length > 0 &&
    evidence.every(
      (entry) =>
        isPlainObject(entry) &&
        (entry.side === "A" || entry.side === "B") &&
        isNonEmptyString(entry.anchor),
    );
  if (!evidenceValid) {
    if (attemptStatus !== "FAILED") {
      problem(
        "EVIDENCE_INVALID",
        "evidence must be a non-empty array of { side: A|B, anchor } entries",
      );
    }
  } else if (verdictKnown) {
    const sides = new Set(evidence.map((entry) => entry.side));
    if (record.displayVerdict === "A_BETTER" && !sides.has("A")) {
      problem(
        "EVIDENCE_SIDES_INVALID",
        "an A_BETTER verdict must cite at least one A-side anchor",
      );
    }
    if (record.displayVerdict === "B_BETTER" && !sides.has("B")) {
      problem(
        "EVIDENCE_SIDES_INVALID",
        "a B_BETTER verdict must cite at least one B-side anchor",
      );
    }
    if (
      record.displayVerdict === "TIE" &&
      (!sides.has("A") || !sides.has("B"))
    ) {
      problem(
        "EVIDENCE_SIDES_INVALID",
        "a TIE verdict must cite anchors on both sides",
      );
    }
  }
  // T4 mergeJudgments reads `evidenceRefs` (flat anchor list) — the field the
  // FinalComparison inherits. When the record carries sided anchors, the
  // flat list must be exactly those anchors (P1-5): no silent drop, no
  // anchors that disagree with the side-bound evidence.
  const anchors = evidenceValid ? evidence.map((entry) => entry.anchor) : null;
  if (record.evidenceRefs !== undefined) {
    if (
      !Array.isArray(record.evidenceRefs) ||
      !record.evidenceRefs.every(isNonEmptyString)
    ) {
      problem(
        "EVIDENCE_INVALID",
        "evidenceRefs must be an array of non-empty anchor strings when present",
      );
    } else if (
      anchors !== null &&
      JSON.stringify([...record.evidenceRefs].sort()) !==
        JSON.stringify([...anchors].sort())
    ) {
      problem(
        "EVIDENCE_INVALID",
        "evidenceRefs must contain exactly the anchors of the sided evidence entries",
      );
    }
  } else if (evidenceValid) {
    problem(
      "EVIDENCE_INVALID",
      "evidenceRefs is required when evidence anchors are present — the T4 merge reads evidenceRefs, not evidence",
    );
  }

  const judgeModelProblem = modelBlockProblem(record.judgeModel, "judgeModel");
  if (judgeModelProblem) problem("MODEL_BLOCK_INVALID", judgeModelProblem);
  const generatorModelProblem = modelBlockProblem(
    record.generatorModel,
    "generatorModel",
  );
  if (generatorModelProblem)
    problem("MODEL_BLOCK_INVALID", generatorModelProblem);
  if (!MODEL_RELATION_DISCLOSURES.includes(record.modelRelationDisclosure)) {
    problem(
      "RELATION_DISCLOSURE_INVALID",
      `modelRelationDisclosure must be one of ${MODEL_RELATION_DISCLOSURES.join(" | ")} (judge/generator family relation is explicit, never hidden)`,
    );
  }
  if (attemptStatus !== "FAILED" && !isNonEmptyString(record.reason)) {
    problem(
      "REASON_MISSING",
      "a non-FAILED record requires a non-empty reason",
    );
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Restore a display verdict to the candidate/reference frame using the
 * record's controlled identity map. Inverse of the display blinding; used
 * by the merge path and the position-exchange consistency checks.
 */
export function restoreDisplayVerdict(displayVerdict, identityMap) {
  const error = identityMapProblem(identityMap);
  if (error || !PROTOCOL_VERDICTS.includes(displayVerdict)) return null;
  if (displayVerdict === "TIE" || displayVerdict === "UNKNOWN")
    return displayVerdict;
  const winnerRole =
    displayVerdict === "A_BETTER" ? identityMap.A : identityMap.B;
  return winnerRole === "candidate" ? "CANDIDATE_BETTER" : "REFERENCE_BETTER";
}

/**
 * Assemble a protocol record from a parsed judge response and its package
 * binding. The digest is recomputed from the blind package in role-canonical
 * form (never copied from caller memory), lossyInput derives from the
 * package's truncation facts, and display order / identity map come from the
 * secret binding. The returned record is NOT pre-validated — run
 * validateProtocolRecord.
 */
export function buildProtocolRecord(input) {
  if (!isPlainObject(input)) return null;
  const { blindPackage, secretBinding, parsed } = input;
  if (
    !isPlainObject(blindPackage) ||
    !isPlainObject(secretBinding) ||
    !isPlainObject(parsed)
  )
    return null;
  const lossyInput =
    Array.isArray(blindPackage.truncation) &&
    blindPackage.truncation.length > 0;
  return {
    judgmentId: input.judgmentId,
    assignmentKey: input.assignmentKey,
    judgeProtocolRef: JUDGE_PROTOCOL_REF,
    comparisonInputDigest: comparisonInputDigestOf(
      blindPackage,
      secretBinding.identityMap,
    ),
    rubricVersion: JUDGE_PROTOCOL.rubricVersion,
    judgeProtocolDigest: judgeProtocolDigest(),
    attempt: input.attempt,
    ...(input.attemptStatus !== undefined
      ? { attemptStatus: input.attemptStatus }
      : {}),
    displayOrder: secretBinding.displayOrder,
    identityMap: {
      A: secretBinding.identityMap.A,
      B: secretBinding.identityMap.B,
    },
    ...(parsed.displayVerdict !== undefined
      ? { displayVerdict: parsed.displayVerdict }
      : {}),
    ...(parsed.displayVerdict === "UNKNOWN"
      ? { unknownReason: parsed.unknownReason }
      : {}),
    ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
    evidence: Array.isArray(input.evidence)
      ? input.evidence.map((entry) => ({
          side: entry.side,
          anchor: entry.anchor,
        }))
      : [],
    // T4 mergeJudgments reads `evidenceRefs` (flat anchors); `evidence`
    // keeps the A/B side information (P1-5). Both stay in the record so the
    // verified anchors reach FinalComparison without a field remap.
    evidenceRefs: Array.isArray(input.evidence)
      ? input.evidence.map((entry) => entry.anchor)
      : [],
    judgeModel: { ...input.judgeModel },
    generatorModel: { ...input.generatorModel },
    modelRelationDisclosure: input.modelRelationDisclosure,
    lossyInput,
    ...(lossyInput
      ? { truncation: blindPackage.truncation.map((entry) => ({ ...entry })) }
      : {}),
    ...(isNonEmptyString(input.judgeSlotId)
      ? { judgeSlotId: input.judgeSlotId }
      : {}),
  };
}
