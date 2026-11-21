#!/usr/bin/env node
// PD-Lab v0.3 T7a-judge (PRI-1258): synthetic protocol validation CLI.
//
// Validates a judge-protocol bundle (blind packages + secret bindings + raw
// judge responses + CONTRACT 5.1 records [+ optional arbitration records])
// against the versioned Judge Protocol and writes a deterministic
// protocol-validation.json. This is the mechanical re-verification surface:
// every judgment can be re-derived from its raw response, every record's
// digest recomputed from its package, every package re-scanned for leaks,
// swap counterparts re-checked and position-exchange consistency reported.
//
// The CLI never calls a model and never reads real full-fidelity data — the
// live judge-model calibration requires Owner decision D2 and stays NOT_RUN
// without it; this tool only proves protocol determinism on synthetic
// fixtures (HANDOFF T7a item 3, layer 1).
//
// Usage:
//   node scripts/dev/pd-lab/judge-protocol-validate.mjs \
//     --bundle <bundle.json> --out <dir>
//
// Exit codes:
//   0  all entries valid (report still discloses flips/conflicts as data)
//   1  validation problems (invalid entries; report written for inspection)
//   2  usage error or unreadable/unparseable input (nothing written)

import fs from "node:fs";
import path from "node:path";
import {
  JUDGE_PROTOCOL_REF,
  judgeProtocolDigest,
  parseJudgeResponse,
  validateProtocolRecord,
  checkPackageForLeaks,
  comparisonInputDigestOf,
  restoreDisplayVerdict,
  identityMapProblem,
  DISPLAY_ORDERS,
} from "./judge-protocol.mjs";

const USAGE = [
  "usage: judge-protocol-validate.mjs \\",
  "  --bundle <judge-protocol-bundle.json> --out <dir>",
].join("\n");

const ARBITRATION_VERDICTS = [
  "CANDIDATE_BETTER",
  "TIE",
  "REFERENCE_BETTER",
  "UNKNOWN",
];
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const TRUNCATION_SIDES = ["A", "B", "CONTEXT"];

function fail(message, code) {
  process.stderr.write(`judge-protocol-validate: ${message}\n${USAGE}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const required = ["bundle", "out"];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) fail(`unexpected argument ${token}`, 2);
    const name = token.slice(2);
    if (!required.includes(name)) fail(`unknown option --${name}`, 2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--"))
      fail(`option --${name} requires a value`, 2);
    options[name] = value;
    i += 1;
  }
  for (const name of required) {
    if (options[name] === undefined)
      fail(`missing required option --${name}`, 2);
  }
  return options;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function canonicalJson(value) {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// Structural pre-checks before any digest computation — a malformed package
// or binding must produce a named problem, never an unhandled throw
// (P1-4: exception safety, closed problem codes only).
function packageProblem(blindPackage) {
  if (!isPlainObject(blindPackage)) return "blindPackage must be an object";
  if (!isNonEmptyString(blindPackage.packageId))
    return "blindPackage.packageId must be a non-empty string";
  for (const field of [
    "judgeProtocolRef",
    "rubricVersion",
    "comparisonQuestion",
    "context",
    "outputA",
    "outputB",
  ]) {
    if (typeof blindPackage[field] !== "string")
      return `blindPackage.${field} must be a string`;
  }
  if (blindPackage.truncation !== undefined) {
    if (!Array.isArray(blindPackage.truncation))
      return "blindPackage.truncation must be an array when present";
    for (const entry of blindPackage.truncation) {
      if (!isPlainObject(entry))
        return "each truncation entry must be an object";
      if (!TRUNCATION_SIDES.includes(entry.truncatedSide))
        return "truncation entry truncatedSide must be A, B or CONTEXT";
      if (
        !Number.isInteger(entry.truncatedAt) ||
        entry.truncatedAt <= 0 ||
        !Number.isInteger(entry.originalChars) ||
        entry.originalChars <= 0
      )
        return "truncation entry truncatedAt/originalChars must be positive integers";
    }
  }
  return null;
}

function bindingProblem(secretBinding) {
  if (!isPlainObject(secretBinding)) return "secretBinding must be an object";
  if (!DISPLAY_ORDERS.includes(secretBinding.displayOrder))
    return `secretBinding.displayOrder must be one of ${DISPLAY_ORDERS.join(" | ")}`;
  const mapError = identityMapProblem(secretBinding.identityMap);
  if (mapError) return `secretBinding.identityMap: ${mapError}`;
  return null;
}

// Role-canonical truncation facts (candidate/reference/context), identical
// normalization to comparisonInputDigestOf — used to verify that a swap
// exchanged the truncation sides by arm role, never by display letter.
function truncationRoleCanonical(blindPackage, identityMap) {
  if (
    !Array.isArray(blindPackage.truncation) ||
    blindPackage.truncation.length === 0
  )
    return null;
  const byRole = {};
  for (const entry of blindPackage.truncation) {
    const role =
      entry.truncatedSide === "CONTEXT"
        ? "context"
        : entry.truncatedSide === "A"
          ? identityMap.A
          : identityMap.B;
    byRole[role] = {
      originalChars: entry.originalChars,
      truncatedAt: entry.truncatedAt,
    };
  }
  return byRole;
}

/**
 * A position exchange is only valid as a COMPLETE semantic swap (P0-2):
 * exchanged outputs byte-identical, identical context/rubric/protocol ref/
 * comparison question, the identity map truly inverted, the display order
 * flipped, truncation sides swapped by role, and one shared role-canonical
 * comparison input digest. Returns the list of violated check codes.
 */
function verifySwapPair(pkgA, bindingA, pkgB, bindingB) {
  const codes = [];
  if (
    !(
      pkgB.outputA === pkgA.outputB &&
      pkgB.outputB === pkgA.outputA &&
      pkgB.context === pkgA.context &&
      pkgB.rubricVersion === pkgA.rubricVersion &&
      pkgB.judgeProtocolRef === pkgA.judgeProtocolRef &&
      pkgB.comparisonQuestion === pkgA.comparisonQuestion
    )
  )
    codes.push("SWAP_CONTENT_MISMATCH");
  if (
    !(
      bindingB.identityMap.A === bindingA.identityMap.B &&
      bindingB.identityMap.B === bindingA.identityMap.A
    )
  )
    codes.push("SWAP_IDENTITY_NOT_INVERTED");
  if (
    bindingA.displayOrder === bindingB.displayOrder ||
    !DISPLAY_ORDERS.includes(bindingA.displayOrder) ||
    !DISPLAY_ORDERS.includes(bindingB.displayOrder)
  )
    codes.push("SWAP_DISPLAY_ORDER_MISMATCH");
  if (
    canonicalJson(
      truncationRoleCanonical(pkgA, bindingA.identityMap),
    ) !== canonicalJson(truncationRoleCanonical(pkgB, bindingB.identityMap))
  )
    codes.push("SWAP_TRUNCATION_MISMATCH");
  try {
    if (
      comparisonInputDigestOf(pkgA, bindingA.identityMap) !==
      comparisonInputDigestOf(pkgB, bindingB.identityMap)
    )
      codes.push("SWAP_DIGEST_MISMATCH");
  } catch {
    codes.push("SWAP_DIGEST_MISMATCH");
  }
  return codes;
}

// One arbitration record, structural gate mirroring T4's
// parseArbitrationRecords (arbitrationId + assignmentKey + bound judgment
// ids + bound comparison input digests + a final-verdict verdict).
function arbitrationProblem(arbitration) {
  if (!isPlainObject(arbitration))
    return "arbitration record must be an object";
  if (!isNonEmptyString(arbitration.arbitrationId))
    return "arbitration.arbitrationId must be a non-empty string";
  if (!isNonEmptyString(arbitration.assignmentKey))
    return "arbitration.assignmentKey must be a non-empty string";
  if (
    !Array.isArray(arbitration.boundJudgmentIds) ||
    arbitration.boundJudgmentIds.length === 0 ||
    !arbitration.boundJudgmentIds.every(isNonEmptyString)
  )
    return "arbitration.boundJudgmentIds must be a non-empty array of judgment ids";
  if (
    !Array.isArray(arbitration.boundComparisonInputDigests) ||
    arbitration.boundComparisonInputDigests.length === 0 ||
    !arbitration.boundComparisonInputDigests.every((d) => DIGEST_RE.test(d))
  )
    return "arbitration.boundComparisonInputDigests must be a non-empty array of sha256:<hex> digests";
  if (!ARBITRATION_VERDICTS.includes(arbitration.verdict))
    return `arbitration.verdict must be one of ${ARBITRATION_VERDICTS.join(" | ")}`;
  return null;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  let bundle;
  try {
    bundle = JSON.parse(fs.readFileSync(options.bundle, "utf8"));
  } catch (error) {
    fail(`cannot read/parse bundle ${options.bundle}: ${error.message}`, 2);
  }
  if (
    !isPlainObject(bundle) ||
    bundle.schema !== "pd-lab-judge-protocol-bundle.v1" ||
    !Array.isArray(bundle.entries)
  ) {
    fail(
      'bundle must be an object with schema "pd-lab-judge-protocol-bundle.v1" and an entries array',
      2,
    );
  }
  const arbitrations = Array.isArray(bundle.arbitrations)
    ? bundle.arbitrations
    : [];

  // Optional preregistered judge-slot registry (T4 parity). When the bundle
  // carries one, every record's judgeSlotId must be in it; when it does
  // not, the slot check is disclosed as unverified — never silently verified.
  const disclosures = [];
  let slotRegistry = null;
  if (bundle.judgeSlots !== undefined) {
    if (
      !Array.isArray(bundle.judgeSlots) ||
      !bundle.judgeSlots.every(
        (slot) =>
          isNonEmptyString(slot) ||
          (isPlainObject(slot) &&
            (isNonEmptyString(slot.judgeSlotId) ||
              isNonEmptyString(slot.slotId))),
      )
    ) {
      fail(
        "bundle.judgeSlots must be an array of slot ids or slot objects when present",
        2,
      );
    }
    slotRegistry = new Set(
      bundle.judgeSlots.map((slot) =>
        isNonEmptyString(slot) ? slot : (slot.judgeSlotId ?? slot.slotId),
      ),
    );
  }
  if (slotRegistry === null) {
    disclosures.push({
      code: "JUDGE_SLOT_REGISTRATION_UNVERIFIED",
      message:
        "the bundle carries no preregistered judge-slot registry; slot preregistration is unverified, not verified",
    });
  }

  // Write-once --out (plain mkdir as the concurrency gate, admission-probe
  // precedent): a validation report directory is never silently replaced.
  const outDir = path.resolve(options.out);
  try {
    fs.mkdirSync(outDir);
  } catch (error) {
    fail(`cannot create output directory ${outDir}: ${error.message}`, 2);
  }

  const problems = [];
  const report = (problem) => problems.push(problem);
  const packagesById = new Map();
  for (const entry of bundle.entries) {
    if (
      isPlainObject(entry?.blindPackage) &&
      isNonEmptyString(entry.blindPackage.packageId)
    ) {
      packagesById.set(entry.blindPackage.packageId, entry);
    }
  }

  const failedAttemptsPreserved = [];
  const perRecord = [];

  for (const entry of bundle.entries) {
    const packageId = isPlainObject(entry?.blindPackage)
      ? String(entry.blindPackage.packageId)
      : "<missing>";
    const judgmentId = isPlainObject(entry?.record)
      ? String(entry.record.judgmentId ?? "<missing>")
      : "<missing>";
    // Every problem raised for this entry also marks the record invalid —
    // record validity is the aggregation of ALL per-entry checks (P1-1).
    const recordCodes = [];
    const note = (code, message) => {
      report({ packageId, judgmentId, code, message });
      recordCodes.push(code);
    };

    if (
      !isPlainObject(entry) ||
      !isPlainObject(entry.blindPackage) ||
      !isPlainObject(entry.secretBinding) ||
      !isPlainObject(entry.record)
    ) {
      note(
        "ENTRY_INVALID",
        "each bundle entry needs blindPackage, secretBinding and record objects",
      );
      perRecord.push({
        judgmentId,
        packageId,
        valid: false,
        problemCodes: recordCodes,
        restoredVerdict: null,
        failed: false,
      });
      continue;
    }
    const { blindPackage, secretBinding, record, rawResponse } = entry;
    if (
      blindPackage.judgeProtocolRef !== undefined &&
      blindPackage.judgeProtocolRef !== JUDGE_PROTOCOL_REF
    ) {
      note(
        "PROTOCOL_REF_MISMATCH",
        `package ${packageId} declares protocol ${blindPackage.judgeProtocolRef}, expected ${JUDGE_PROTOCOL_REF}`,
      );
    }

    // 0. Structural gates BEFORE any digest computation (P1-4): malformed
    //    package/binding shapes are named problems, never unhandled throws.
    const pkgProblem = packageProblem(blindPackage);
    if (pkgProblem) note("PACKAGE_INVALID", pkgProblem);
    const bindProblem = bindingProblem(secretBinding);
    if (bindProblem) note("BINDING_INVALID", bindProblem);

    // 1. CONTRACT 5.1 record schema.
    const schema = validateProtocolRecord(record);
    for (const problem of schema.problems) note(problem.code, problem.message);

    // 2. Raw response derivation: a verdict that cannot be re-derived from
    //    the raw judge output is not evidence. FAILED attempts may carry no
    //    output at all (preserved audit, never a vote).
    const isFailed = record.attemptStatus === "FAILED";
    if (typeof rawResponse !== "string") {
      if (!isFailed)
        note(
          "RAW_RESPONSE_MISSING",
          "a non-FAILED record must carry the raw judge response it derives from",
        );
    } else {
      const parsed = parseJudgeResponse(rawResponse);
      if (!parsed.ok) {
        if (record.displayVerdict !== undefined) {
          note(
            parsed.code,
            `record carries a verdict but its raw response is illegal: ${parsed.message}`,
          );
        } else if (!isFailed) {
          note(parsed.code, parsed.message);
        }
      } else if (record.displayVerdict !== undefined) {
        if (record.displayVerdict !== parsed.displayVerdict) {
          note(
            "RAW_RESPONSE_MISMATCH",
            `record verdict ${record.displayVerdict} differs from parsed raw verdict ${parsed.displayVerdict}`,
          );
        }
        if ((record.reason ?? null) !== parsed.reason) {
          note(
            "RAW_RESPONSE_MISMATCH",
            "record reason differs from the parsed REASON field",
          );
        }
        if (
          (record.unknownReason ?? null) !==
          (parsed.displayVerdict === "UNKNOWN" ? parsed.unknownReason : null)
        ) {
          note(
            "RAW_RESPONSE_MISMATCH",
            "record unknownReason differs from the parsed UNKNOWN_REASON field",
          );
        }
      }
    }

    // 3. Digest: recomputed from the package the judge saw, in the
    //    role-canonical form (identity map from the SECRET binding — the
    //    presentation binding, checked for consistency in step 5). Only
    //    attempted once the binding is structurally sound (step 0).
    let digest = null;
    if (pkgProblem === null && bindProblem === null) {
      try {
        digest = comparisonInputDigestOf(
          blindPackage,
          secretBinding.identityMap,
        );
      } catch (error) {
        note(
          "DIGEST_COMPUTATION_FAILED",
          `comparison input digest could not be computed: ${error.message}`,
        );
      }
    }
    if (
      digest !== null &&
      record.comparisonInputDigest !== digest &&
      !schema.problems.some(
        (p) => p.code === "DIGEST_INVALID" || p.code === "FIELD_MISSING",
      )
    ) {
      note(
        "COMPARISON_INPUT_DIGEST_MISMATCH",
        `record digest ${record.comparisonInputDigest} != recomputed ${digest}`,
      );
    }

    // 4. Leak scan.
    const violations =
      pkgProblem === null ? checkPackageForLeaks(blindPackage) : [];
    if (violations.length > 0) {
      note(
        "BLIND_PACKAGE_LEAK",
        `package fails the leak scan: ${violations.map((v) => `${v.path}(${v.reason})`).join("; ")}`,
      );
    }

    // 5. Binding consistency: display order + identity map come from the
    //    secret binding, and lossy marking follows the package facts.
    if (record.displayOrder !== secretBinding.displayOrder) {
      note(
        "BINDING_MISMATCH",
        "record displayOrder does not match the secret binding",
      );
    }
    if (
      canonicalJson(record.identityMap) !==
      canonicalJson(secretBinding.identityMap)
    ) {
      note(
        "BINDING_MISMATCH",
        "record identityMap does not match the secret binding",
      );
    }
    const packageTruncated =
      Array.isArray(blindPackage.truncation) &&
      blindPackage.truncation.length > 0;
    if (record.lossyInput !== packageTruncated) {
      note(
        "LOSSY_MARKING_MISMATCH",
        `package truncation presence (${packageTruncated}) does not match record lossyInput (${record.lossyInput})`,
      );
    }

    // 6. Judge-slot preregistration (CONTRACT 5.2a / T4 parity): the binding
    //    itself is required by the record schema; when a registry is bound
    //    into the bundle, membership is verified — never defaulted.
    if (
      slotRegistry !== null &&
      isNonEmptyString(record.judgeSlotId) &&
      !slotRegistry.has(record.judgeSlotId)
    ) {
      note(
        "JUDGE_SLOT_NOT_PREREGISTERED",
        `judgeSlotId ${record.judgeSlotId} is not in the bundle's preregistered slot registry`,
      );
    }

    if (isFailed) failedAttemptsPreserved.push(record.judgmentId);
    const restoredVerdict =
      record.displayVerdict !== undefined
        ? restoreDisplayVerdict(record.displayVerdict, record.identityMap)
        : null;
    if (record.displayVerdict !== undefined && restoredVerdict === null) {
      note(
        "IDENTITY_RESTORE_FAILED",
        "display verdict could not be restored through the identity map",
      );
    }
    perRecord.push({
      judgmentId,
      packageId,
      valid: recordCodes.length === 0,
      problemCodes: recordCodes,
      restoredVerdict,
      failed: isFailed,
      comparisonInputDigest: isNonEmptyString(record.comparisonInputDigest)
        ? record.comparisonInputDigest
        : null,
    });
  }

  // Swap pairs: mechanically detected counterpart packages plus declared
  // swapOf references. A pair only counts as a position exchange when the
  // swap is COMPLETE semantically (verifySwapPair): exchanged content,
  // inverted identity map, flipped display order, unchanged context/rubric/
  // protocol/question, role-swapped truncation, one shared digest. Position
  // flips are a CALIBRATION METRIC (the D5 flip rate), reported as data;
  // swap INTEGRITY defects are validation problems, never silently dropped.
  const swapPairs = [];
  const seenSwap = new Set();
  const pairedPackageIds = new Set();
  // Register every explicit swap relationship before inference: a package
  // that declared its partner, or was declared as a target, is reserved and
  // must never be silently inferred as someone else's counterpart.
  const declaringIds = new Set();
  const declaredTargetIds = new Set();
  for (const e of bundle.entries) {
    if (!isPlainObject(e?.blindPackage) || !isNonEmptyString(e.swapOf))
      continue;
    declaringIds.add(String(e.blindPackage.packageId));
    declaredTargetIds.add(e.swapOf);
  }
  for (const entry of bundle.entries) {
    if (!isPlainObject(entry?.blindPackage)) continue;
    const pkg = entry.blindPackage;
    const pkgId = String(pkg.packageId);
    const judgmentId = String(entry.record?.judgmentId ?? "<missing>");
    if (entry.swapOf !== undefined && !isNonEmptyString(entry.swapOf)) {
      report({
        packageId: pkgId,
        judgmentId,
        code: "SWAP_OF_INVALID",
        message: "swapOf must be a non-empty package id when present",
      });
      continue;
    }
    const declared = isNonEmptyString(entry.swapOf) ? entry.swapOf : null;
    const partner = declared ? packagesById.get(declared) : null;
    if (declared && !partner) {
      report({
        packageId: pkgId,
        judgmentId,
        code: "SWAP_PARTNER_MISSING",
        message: `swapOf ${declared} does not resolve to a bundle package`,
      });
      continue;
    }
    // A package already bound as a partner and carrying no declaration of
    // its own is done — it must not start a second inference.
    if (pairedPackageIds.has(pkgId)) continue;
    const counterKey = (candidate) =>
      candidate &&
      candidate !== entry &&
      isPlainObject(candidate.blindPackage) &&
      candidate.blindPackage.outputA === pkg.outputB &&
      candidate.blindPackage.outputB === pkg.outputA &&
      candidate.blindPackage.context === pkg.context;
    let resolved = partner;
    if (!resolved) {
      // Inference only among packages that are unpaired, undeclaring and
      // unclaimed; ambiguity must be declared, not silently picked.
      const candidates = bundle.entries.filter((candidate) => {
        if (!counterKey(candidate)) return false;
        const cid = String(candidate.blindPackage.packageId);
        return (
          !pairedPackageIds.has(cid) &&
          !declaringIds.has(cid) &&
          !declaredTargetIds.has(cid)
        );
      });
      if (candidates.length === 0) continue;
      if (candidates.length > 1) {
        report({
          packageId: pkgId,
          judgmentId,
          code: "SWAP_OF_INVALID",
          message: `${candidates.length} unpaired counter-image candidates for ${pkgId} — declare swapOf explicitly`,
        });
        continue;
      }
      resolved = candidates[0];
    } else if (!counterKey(partner)) {
      report({
        packageId: pkgId,
        judgmentId,
        code: "SWAP_CONTENT_MISMATCH",
        message: `declared swap partner ${declared} does not carry the exchanged outputs`,
      });
      continue;
    }
    const partnerId = String(resolved.blindPackage.packageId);
    const key = [pkgId, partnerId].sort().join(" ");
    if (seenSwap.has(key)) continue;
    seenSwap.add(key);
    if (pairedPackageIds.has(pkgId) || pairedPackageIds.has(partnerId)) {
      report({
        packageId: pkgId,
        judgmentId,
        code: "SWAP_DUPLICATE_PAIRING",
        message: `package ${pkgId} or ${partnerId} is already bound to another position exchange — one package must not be paired twice`,
      });
      continue;
    }
    pairedPackageIds.add(pkgId);
    pairedPackageIds.add(partnerId);

    // Full semantic swap verification (P0-2). A pairing problem is a bundle
    // integrity defect, not a per-record one — it excludes the pair from
    // the exchange statistics without invalidating the records themselves.
    const swapProblemCodes = [];
    if (
      !isPlainObject(resolved.secretBinding) ||
      !isPlainObject(resolved.record)
    ) {
      swapProblemCodes.push("SWAP_PARTNER_INVALID");
      report({
        packageId: pkgId,
        judgmentId,
        code: "SWAP_PARTNER_INVALID",
        message: `swap partner ${partnerId} lacks a complete secretBinding/record pair`,
      });
    } else if (
      !isPlainObject(entry.secretBinding) ||
      bindingProblem(entry.secretBinding) !== null ||
      bindingProblem(resolved.secretBinding) !== null ||
      packageProblem(pkg) !== null ||
      packageProblem(resolved.blindPackage) !== null
    ) {
      swapProblemCodes.push("SWAP_PARTNER_INVALID");
      report({
        packageId: pkgId,
        judgmentId,
        code: "SWAP_PARTNER_INVALID",
        message: `position exchange ${pkgId} <-> ${partnerId} has a malformed package or binding`,
      });
    } else {
      for (const code of verifySwapPair(
        pkg,
        entry.secretBinding,
        resolved.blindPackage,
        resolved.secretBinding,
      )) {
        swapProblemCodes.push(code);
        report({
          packageId: pkgId,
          judgmentId,
          code,
          message: `position exchange ${pkgId} <-> ${partnerId} fails the semantic swap check ${code}`,
        });
      }
    }
    swapPairs.push(
      pairReport(entry, resolved, swapProblemCodes, perRecord),
    );
  }

  // Per-assignment conflict / arbitration summary (CONTRACT 5.2 steps 3-5).
  // Only VALID, non-FAILED records vote — an invalid record never enters
  // the judgment set, the exchange stats, or the arbitration bound set.
  const recordEntries = bundle.entries.filter((entry) =>
    isPlainObject(entry?.record),
  );
  const assignmentMap = new Map();
  for (const entry of recordEntries) {
    const key = String(entry.record.assignmentKey ?? "<missing>");
    if (!assignmentMap.has(key)) assignmentMap.set(key, []);
    const derived =
      perRecord.find(
        (r) =>
          r.judgmentId === String(entry.record.judgmentId) &&
          r.packageId === String(entry.blindPackage?.packageId ?? "<missing>"),
      ) ?? null;
    assignmentMap.get(key).push({ entry, derived });
  }
  const matchedArbitrations = new Set();
  const perAssignment = [...assignmentMap.keys()].sort().map((key) => {
    const rows = assignmentMap.get(key);
    const voting = rows
      .map((row) => row.derived)
      .filter((d) => d && d.valid && !d.failed && d.restoredVerdict !== null);
    const restored = voting.map((d) => d.restoredVerdict);
    const allAgree =
      restored.length > 0 &&
      restored.every((verdict) => verdict === restored[0]);
    const arbitration =
      arbitrations.find((a) => isPlainObject(a) && a.assignmentKey === key) ??
      null;
    let arbitrationComplete = false;
    if (arbitration) {
      matchedArbitrations.add(arbitration);
      const structuralProblem = arbitrationProblem(arbitration);
      if (structuralProblem !== null) {
        report({
          packageId: "<arbitration>",
          judgmentId: String(arbitration?.arbitrationId ?? "<missing>"),
          code: "INVALID_ARBITRATION_RECORD",
          message: `arbitration for ${key}: ${structuralProblem}`,
        });
      } else {
        // T4 boundAll parity (alignment-report.mjs): the arbitration must
        // bind the FULL participating judgment id set AND the full
        // participating comparisonInputDigest set — ids and digests are
        // compared separately, both sorted/unique.
        const boundIds = [...arbitration.boundJudgmentIds]
          .sort()
          .join(" ");
        const votingIds = voting
          .map((d) => d.judgmentId)
          .sort()
          .join(" ");
        const boundDigests = [
          ...new Set(arbitration.boundComparisonInputDigests),
        ]
          .sort()
          .join(" ");
        const participatingDigests = [
          ...new Set(
            voting
              .map((d) => d.comparisonInputDigest)
              .filter((d) => d !== null),
          ),
        ]
          .sort()
          .join(" ");
        arbitrationComplete =
          boundIds === votingIds && boundDigests === participatingDigests;
      }
    }
    const conflict = restored.length > 0 && !allAgree;
    const outcome =
      restored.length === 0
        ? "UNKNOWN"
        : allAgree
          ? restored[0]
          : arbitrationComplete && arbitration.verdict !== "UNKNOWN"
            ? arbitration.verdict
            : "UNKNOWN";
    return {
      assignmentKey: key,
      judgmentIds: rows
        .map((row) => String(row.entry.record.judgmentId ?? "<missing>"))
        .sort(),
      votingJudgments: voting.map((d) => d.judgmentId).sort(),
      restoredVerdicts: restored.sort(),
      conflict,
      arbitrationDeclared: arbitration !== null,
      arbitrationBindingComplete: arbitrationComplete,
      resolvedBy: allAgree
        ? "CONSISTENT_JUDGMENTS"
        : arbitrationComplete && arbitration.verdict !== "UNKNOWN"
          ? "BLIND_ARBITRATION"
          : "UNRESOLVED",
      outcome,
    };
  });
  // An arbitration that binds no assignment in this bundle is not evidence.
  for (const arbitration of arbitrations) {
    if (!matchedArbitrations.has(arbitration)) {
      report({
        packageId: "<arbitration>",
        judgmentId: String(arbitration?.arbitrationId ?? "<missing>"),
        code: "INVALID_ARBITRATION_RECORD",
        message: `arbitration ${arbitration?.arbitrationId ?? "<missing>"} references assignment ${arbitration?.assignmentKey ?? "<missing>"} which has no judgment records in this bundle`,
      });
    }
  }

  const valid = problems.length === 0;
  const out = {
    schema: "pd-lab-judge-protocol-validation.v1",
    judgeProtocolRef: JUDGE_PROTOCOL_REF,
    judgeProtocolDigest: judgeProtocolDigest(),
    totals: {
      entries: bundle.entries.length,
      validEntries: perRecord.filter((r) => r.valid).length,
      failedAttemptsPreserved: failedAttemptsPreserved.sort(),
      problemCount: problems.length,
    },
    problems,
    disclosures,
    perRecord,
    positionExchange: {
      pairs: swapPairs,
      evaluatedPairs: swapPairs.filter((p) => p.valid).length,
      consistent: swapPairs.filter((p) => p.result === "consistent").length,
      flipped: swapPairs.filter((p) => p.result === "flipped").length,
      undetermined: swapPairs.filter((p) => p.result === "undetermined")
        .length,
      invalidPairs: swapPairs.filter((p) => !p.valid).length,
      note: "position flips are the D5 calibration metric (flip rate), reported as data — only complete, valid semantic swaps enter the denominator; UNKNOWN/FAILED records are disclosed as undetermined, never counted as consistent; swap integrity defects are validation problems",
    },
    perAssignment,
  };
  const outPath = path.join(outDir, "protocol-validation.json");
  fs.writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify({ ok: valid, judgeProtocolRef: JUDGE_PROTOCOL_REF, judgeProtocolDigest: judgeProtocolDigest(), entries: bundle.entries.length, problems: problems.length, swaps: swapPairs.length })}\n`,
  );
  process.exitCode = valid ? 0 : 1;
}

function pairReport(entry, partnerEntry, swapProblemCodes, perRecord) {
  const pkg = entry.blindPackage;
  const partnerPackage = partnerEntry.blindPackage;
  const partnerRecord = partnerEntry.record;
  const left =
    entry.record?.displayVerdict !== undefined
      ? restoreDisplayVerdict(
          entry.record.displayVerdict,
          entry.record.identityMap,
        )
      : null;
  const right =
    partnerRecord?.displayVerdict !== undefined
      ? restoreDisplayVerdict(
          partnerRecord.displayVerdict,
          partnerRecord.identityMap,
        )
      : null;
  const findDerived = (record, packageId) =>
    perRecord.find(
      (r) =>
        r.judgmentId === String(record?.judgmentId ?? "<missing>") &&
        r.packageId === packageId,
    ) ?? null;
  const leftDerived = findDerived(entry.record, String(pkg.packageId));
  const rightDerived = findDerived(partnerRecord, String(partnerPackage.packageId));
  const recordsValid =
    leftDerived !== null &&
    leftDerived.valid &&
    rightDerived !== null &&
    rightDerived.valid;
  const pairValid = swapProblemCodes.length === 0 && recordsValid;
  // consistent only when BOTH restored verdicts are determinate and equal —
  // UNKNOWN/FAILED/missing results are disclosed as undetermined, never
  // counted as consistent (P0-2); only valid pairs enter the denominator.
  let result = null;
  if (pairValid) {
    const determinate = (v) =>
      v === "CANDIDATE_BETTER" || v === "TIE" || v === "REFERENCE_BETTER";
    result =
      determinate(left) && determinate(right)
        ? left === right
          ? "consistent"
          : "flipped"
        : "undetermined";
  }
  return {
    packageIds: [String(pkg.packageId), String(partnerPackage.packageId)].sort(),
    valid: pairValid,
    problemCodes: swapProblemCodes,
    restoredVerdicts: [left, right],
    result,
  };
}

main();
