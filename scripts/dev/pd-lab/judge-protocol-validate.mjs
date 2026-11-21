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
  JUDGE_PROTOCOL,
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
import { mergeJudgments } from "./alignment-report.mjs";

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
  // P1-4: the package must match the FROZEN protocol definition verbatim —
  // recomputing the digest after editing the question/rubric never launders
  // a drifted comparison back into jp-pd-lab@1.
  if (blindPackage.judgeProtocolRef !== JUDGE_PROTOCOL_REF)
    return `blindPackage.judgeProtocolRef must be ${JUDGE_PROTOCOL_REF}`;
  if (blindPackage.rubricVersion !== JUDGE_PROTOCOL.rubricVersion)
    return `blindPackage.rubricVersion must be ${JUDGE_PROTOCOL.rubricVersion}`;
  if (blindPackage.comparisonQuestion !== JUDGE_PROTOCOL.comparisonQuestion)
    return "blindPackage.comparisonQuestion must be the frozen jp-pd-lab@1 question";
  for (const field of ["context", "outputA", "outputB"]) {
    if (blindPackage[field].trim().length === 0) {
      // The builder keeps a raw prefix slice verbatim, so a context whose
      // leading characters are whitespace can legitimately truncate to a
      // whitespace-only package — the truncation fact marks it lossy and an
      // UNKNOWN record bound to it stays valid evidence. Judged OUTPUTS may
      // never go blank: a side with no content cannot be compared.
      const truncationOk =
        field === "context" &&
        Array.isArray(blindPackage.truncation) &&
        blindPackage.truncation.some(
          (t) =>
            isPlainObject(t) &&
            t.truncatedSide === "CONTEXT" &&
            // The builder's own invariant: it only truncates when the
            // budget is a positive integer below the original length, and
            // the kept prefix is exactly truncatedAt chars — anything else
            // is a fabricated truncation fact, not a lossy package.
            Number.isInteger(t.truncatedAt) &&
            t.truncatedAt > 0 &&
            t.truncatedAt === blindPackage.context.length &&
            Number.isInteger(t.originalChars) &&
            t.originalChars > t.truncatedAt,
        );
      if (!truncationOk) return `blindPackage.${field} must be non-empty`;
    }
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
  // Top-level shape checks all precede the --out reservation: an exit-2
  // failure must leave no directory behind (cli-5-failure-no-mutation).
  if (bundle.assignments !== undefined && !Array.isArray(bundle.assignments))
    fail("bundle.assignments must be an array when present", 2);

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
  // P1-6: judgmentId is globally unique at the bundle level — a duplicate
  // marks BOTH occurrences invalid, and derived-record lookup below binds by
  // entry object identity, never by find() on judgmentId and never by a
  // stringified id pair (which can collide).
  const judgmentIdFirstIndex = new Map();
  // Entry-object binding: bundle entry -> its perRecord row (P1-6). No
  // downstream lookup ever scans perRecord with find().
  const derivedByEntry = new Map();

  for (const entry of bundle.entries) {
    const recIndex = perRecord.length;
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
      isPlainObject(entry?.record) &&
      isNonEmptyString(entry.record.judgmentId)
    ) {
      if (judgmentIdFirstIndex.has(entry.record.judgmentId)) {
        note(
          "DUPLICATE_JUDGMENT_ID",
          `judgmentId ${entry.record.judgmentId} appears more than once in the bundle`,
        );
        // The earlier occurrence is equally untrusted: which one was "the
        // original" cannot be proven from the bundle, so neither merges.
        const firstIdx = judgmentIdFirstIndex.get(entry.record.judgmentId);
        const first = perRecord[firstIdx];
        if (first && !first.problemCodes.includes("DUPLICATE_JUDGMENT_ID")) {
          first.problemCodes.push("DUPLICATE_JUDGMENT_ID");
          first.valid = false;
          report({
            packageId: first.packageId,
            judgmentId: first.judgmentId,
            code: "DUPLICATE_JUDGMENT_ID",
            message: `judgmentId ${entry.record.judgmentId} appears more than once in the bundle`,
          });
        }
      } else {
        judgmentIdFirstIndex.set(entry.record.judgmentId, recIndex);
      }
    }

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
      perRecord[recIndex] = {
        judgmentId,
        packageId,
        valid: false,
        problemCodes: recordCodes,
        restoredVerdict: null,
        failed: false,
      };
      derivedByEntry.set(entry, perRecord[recIndex]);
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
    perRecord[recIndex] = {
      judgmentId,
      packageId,
      valid: recordCodes.length === 0,
      problemCodes: recordCodes,
      restoredVerdict,
      failed: isFailed,
      comparisonInputDigest: isNonEmptyString(record.comparisonInputDigest)
        ? record.comparisonInputDigest
        : null,
    };
    derivedByEntry.set(entry, perRecord[recIndex]);
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
    // its own is done — it must not start a second inference. An explicit
    // declaration is never skipped: it must reach the pairing checks so a
    // second claim on an already-bound package reports the conflict.
    if (pairedPackageIds.has(pkgId) && !declared) continue;
    // A position exchange re-judges the SAME frozen comparison in inverted
    // display order, so the partner must share this record's comparison
    // identity (assignmentKey) — counter-image content alone is not enough:
    // a different task reusing the same trajectories is not a position flip.
    const counterKey = (candidate) =>
      candidate &&
      candidate !== entry &&
      isPlainObject(candidate.blindPackage) &&
      String(candidate.record?.assignmentKey) ===
        String(entry.record?.assignmentKey) &&
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
        message: `declared swap partner ${declared} is not the counter-image of the same comparison (assignmentKey and exchanged outputs must both match)`,
      });
      continue;
    }
    const partnerId = String(resolved.blindPackage.packageId);
    const key = [pkgId, partnerId].sort().join("\u0000");
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
      pairReport(entry, resolved, swapProblemCodes, derivedByEntry),
    );
  }

  // Per-assignment merge (P1-1): the SAME T4 mergeJudgments that owns
  // production voting — Slot/Attempt/Digest gates, FAILED preservation,
  // duplicate consolidation and the boundAll arbitration check are never
  // re-implemented in T7a. Only VALID records enter the merge input; an
  // invalid record never votes, swaps, or sits in an arbitration bound set.
  const recordEntries = bundle.entries.filter((entry) =>
    isPlainObject(entry?.record),
  );
  const assignmentMap = new Map();
  const derivedFor = (entry) => derivedByEntry.get(entry) ?? null;
  for (const entry of recordEntries) {
    const key = String(entry.record.assignmentKey ?? "<missing>");
    if (!assignmentMap.has(key)) assignmentMap.set(key, []);
    assignmentMap.get(key).push({ entry, derived: derivedFor(entry) });
  }

  // Structured assignment declarations (optional): the bundle may carry the
  // T4-shaped assignment components for each comparison key it contains. The
  // composed wire key has no escaping — a component containing '+' or '@' can
  // only be attributed through a declaration, never by reverse-splitting.
  const ASSIGNMENT_COMPONENT_FIELDS = [
    "candidateConfigId",
    "caseId",
    "caseVersion",
    "opportunityId",
    "repetitionId",
    "referenceId",
  ];
  const declaredAssignments = new Map();
  if (bundle.assignments !== undefined) {
    for (const a of bundle.assignments) {
      if (
        !isPlainObject(a) ||
        !ASSIGNMENT_COMPONENT_FIELDS.every((f) => isNonEmptyString(a[f]))
      ) {
        report({
          packageId: "<merge>",
          judgmentId: "<merge>",
          code: "INVALID_ASSIGNMENT_DECLARATION",
          message:
            "each bundle.assignments entry needs non-empty candidateConfigId/caseId/caseVersion/opportunityId/repetitionId/referenceId",
        });
        continue;
      }
      const composed = `${a.candidateConfigId}+${a.caseId}@${a.caseVersion}+${a.opportunityId}+${a.repetitionId}+${a.referenceId}`;
      if (declaredAssignments.has(composed)) {
        report({
          packageId: "<merge>",
          judgmentId: "<merge>",
          code: "DUPLICATE_ASSIGNMENT_DECLARATION",
          message: `bundle.assignments declares ${composed} more than once`,
        });
        continue;
      }
      declaredAssignments.set(composed, a);
    }
  }

  // Arbitration structural gate BEFORE the merge: a record that fails the
  // protocol's own shape check is not evidence and never reaches
  // mergeJudgments — the INVALID_ARBITRATION_RECORD problem fails the bundle.
  const validArbitrations = [];
  for (const arbitration of arbitrations) {
    const arbProblem = arbitrationProblem(arbitration);
    if (arbProblem !== null) {
      report({
        packageId: "<arbitration>",
        judgmentId: String(arbitration?.arbitrationId ?? "<missing>"),
        code: "INVALID_ARBITRATION_RECORD",
        message: `arbitration ${arbitration?.arbitrationId ?? "<missing>"}: ${arbProblem}`,
      });
    } else {
      validArbitrations.push(arbitration);
    }
  }
  // Bundle-level arbitrationId uniqueness: per-comparison merges each see
  // only their own arbitration, so the duplicate check T4 runs inside one
  // merge must be reproduced across the bundle. A duplicated id invalidates
  // every arbitration carrying it — none of them is independent evidence.
  const arbitrationIdsSeen = new Map();
  for (const arbitration of validArbitrations)
    arbitrationIdsSeen.set(
      arbitration.arbitrationId,
      (arbitrationIdsSeen.get(arbitration.arbitrationId) ?? 0) + 1,
    );
  for (const [arbitrationId, count] of arbitrationIdsSeen) {
    if (count > 1) {
      report({
        packageId: "<arbitration>",
        judgmentId: arbitrationId,
        code: "DUPLICATE_ARBITRATION",
        message: `arbitrationId ${arbitrationId} appears on ${count} arbitration records in the bundle`,
      });
      for (let i = validArbitrations.length - 1; i >= 0; i -= 1)
        if (validArbitrations[i].arbitrationId === arbitrationId)
          validArbitrations.splice(i, 1);
    }
  }

  // T4 plan assignments are keyed by composed component fields
  // (`cfg+case@ver+opp+rep+ref`). A declared structured assignment is
  // authoritative; the string fallback only applies when every component is
  // separator-free, which is the only unambiguous case.
  const assignmentComponentsFor = (key) => {
    const declared = declaredAssignments.get(key);
    if (declared !== undefined) {
      return {
        candidateConfigId: declared.candidateConfigId,
        caseId: declared.caseId,
        caseVersion: declared.caseVersion,
        opportunityId: declared.opportunityId,
        repetitionId: declared.repetitionId,
        referenceId: declared.referenceId,
        ...(isNonEmptyString(declared.scenarioId)
          ? { scenarioId: declared.scenarioId }
          : {}),
        ...(isNonEmptyString(declared.candidateTrajectoryRef)
          ? { candidateTrajectoryRef: declared.candidateTrajectoryRef }
          : {}),
        ...(isNonEmptyString(declared.referenceTrajectoryRef)
          ? { referenceTrajectoryRef: declared.referenceTrajectoryRef }
          : {}),
        ...(isNonEmptyString(declared.expectationRef)
          ? { expectationRef: declared.expectationRef }
          : {}),
      };
    }
    const parts = String(key).split("+");
    if (parts.length !== 5) return null;
    const caseParts = parts[1].split("@");
    if (caseParts.length !== 2) return null;
    const [caseId, caseVersion] = caseParts;
    for (const part of [
      parts[0],
      caseId,
      caseVersion,
      parts[2],
      parts[3],
      parts[4],
    ]) {
      if (!isNonEmptyString(part)) return null;
    }
    return {
      candidateConfigId: parts[0],
      caseId,
      caseVersion,
      opportunityId: parts[2],
      repetitionId: parts[3],
      referenceId: parts[4],
    };
  };
  const mergeComponentsByKey = new Map();
  // P1-5: the merge plan is the UNION of the keys the bundle DECLARED and
  // the keys the records actually carry. A declared assignment with no
  // judge records is not silently dropped — it enters the merge and the
  // T4 mergeJudgments itself emits its FinalComparison as
  // {verdict: UNKNOWN, reasonCode: MISSING_JUDGMENTS} (a declared plan is
  // never trimmed to the records that happen to exist; records are never
  // fabricated for a declared plan either).
  for (const key of [...new Set([...assignmentMap.keys(), ...declaredAssignments.keys()])].sort()) {
    const components = assignmentComponentsFor(key);
    if (components === null) {
      report({
        packageId: "<merge>",
        judgmentId: "<merge>",
        code: "ASSIGNMENT_KEY_UNDECOMPOSABLE",
        message: `assignment key ${key} has no structured declaration and cannot be decomposed unambiguously into T4 plan components — the merge cannot attribute it`,
      });
      continue;
    }
    mergeComponentsByKey.set(key, {
      // Placeholder bindings for fields the merge gates only on presence
      // (G2): trajectory/expectation binding is owned by the admission
      // layer, not this validator. Declared values override.
      scenarioId: "scn-t7a",
      candidateTrajectoryRef: "t7a-candidate-trajectory",
      referenceTrajectoryRef: "t7a-reference-trajectory",
      expectationRef: "t7a-expectation",
      ...components,
    });
  }
  // Bundle-level case-version consistency (T4's per-plan check, reproduced
  // because the per-comparison merges each see one assignment): one caseId
  // with two different versions across the bundle is a conflict. The check
  // covers declared assignments too — a declared comparison that has not
  // received any judgment yet is still part of the plan.
  const caseVersions = new Map();
  const checkCaseVersion = (key, components) => {
    const previous = caseVersions.get(components.caseId);
    if (previous === undefined) {
      caseVersions.set(components.caseId, components.caseVersion);
    } else if (previous !== components.caseVersion) {
      report({
        packageId: "<merge>",
        judgmentId: "<merge>",
        code: "CASE_VERSION_CONFLICT",
        message: `case ${components.caseId} declared with versions ${previous} and ${components.caseVersion} (key ${key})`,
      });
    }
  };
  for (const [key, components] of mergeComponentsByKey)
    checkCaseVersion(key, components);
  for (const [key, components] of declaredAssignments)
    if (!mergeComponentsByKey.has(key)) checkCaseVersion(key, components);

  // Per-comparison merge: every assignmentKey merges under ITS OWN seat
  // count — a preregistered registry applies to every comparison, otherwise
  // the seats are the slots that actually entered this comparison (a FAILED
  // attempt's seat counts; an invalid record never sits). An unrelated
  // comparison can never inflate or starve this one's requiredJudgments.
  // P1-5: a declared key with NO records merges too — mergeJudgments then
  // emits {verdict: UNKNOWN, reasonCode: MISSING_JUDGMENTS} for it, so the
  // declared plan and the final comparison set stay in 1:1 correspondence.
  const finalComparisons = [];
  for (const key of [...mergeComponentsByKey.keys()].sort()) {
    const groupRecords = [];
    const groupBlind = {};
    for (const { entry, derived } of assignmentMap.get(key) ?? []) {
      if (derived === null || !derived.valid) continue;
      groupRecords.push(entry.record);
      if (isPlainObject(entry.secretBinding?.identityMap))
        groupBlind[entry.record.judgmentId] = entry.secretBinding.identityMap;
    }
    const mergeSlotIds =
      slotRegistry !== null
        ? [...slotRegistry].sort()
        : [
            ...new Set(
              groupRecords
                .map((record) => record.judgeSlotId)
                .filter((id) => isNonEmptyString(id)),
            ),
          ].sort();
    const groupMerged = mergeJudgments({
      plan: {
        schemaVersion: "pd-lab-plan.v1",
        judgeProtocolRef: JUDGE_PROTOCOL_REF,
        judgeProtocol: {
          requiredJudgments: Math.max(mergeSlotIds.length, 1),
          ...(mergeSlotIds.length > 0
            ? {
                judgeSlots: mergeSlotIds.map((judgeSlotId) => ({
                  judgeSlotId,
                })),
              }
            : {}),
        },
        assignments: [mergeComponentsByKey.get(key)],
      },
      judgments: groupRecords,
      arbitrations: validArbitrations.filter(
        (a) => a.assignmentKey === key,
      ),
      blindmap: { map: groupBlind },
    });
    // Every merge problem is audit evidence of this bundle too; merge-side
    // evidence problems/disclosures ride the same report channel.
    for (const mergeProblem of groupMerged.problems) {
      report({
        packageId: "<merge>",
        judgmentId: "<merge>",
        code: mergeProblem.code,
        message: `T4 merge [${key}]: ${mergeProblem.message}`,
      });
    }
    for (const mergeProblem of groupMerged.evidenceProblems) {
      disclosures.push({
        code: mergeProblem.code,
        message: `T4 merge [${key}]: ${mergeProblem.message}`,
      });
    }
    finalComparisons.push(...groupMerged.finalComparisons);
  }

  const finalsByKey = new Map(
    finalComparisons.map((fc) => [fc.assignmentKey, fc]),
  );
  const matchedArbitrations = new Set();
  // P1-5: the per-assignment diagnostics cover the same union as the merge
  // plan — a declared-but-unjudged assignment shows up here too, carrying
  // its MISSING_JUDGMENTS outcome instead of being silently absent.
  const perAssignment = [...new Set([...assignmentMap.keys(), ...declaredAssignments.keys()])].sort().map((key) => {
    const rows = assignmentMap.get(key) ?? [];
    const voting = rows
      .map((row) => row.derived)
      .filter((d) => d && d.valid && !d.failed && d.restoredVerdict !== null);
    const restored = voting.map((d) => d.restoredVerdict);
    const allAgree =
      restored.length > 0 &&
      restored.every((verdict) => verdict === restored[0]);
    const arbitration =
      validArbitrations.find((a) => a.assignmentKey === key) ?? null;
    if (arbitration) matchedArbitrations.add(arbitration);
    const fc = finalsByKey.get(key) ?? null;
    return {
      assignmentKey: key,
      judgmentIds: rows
        .map((row) => String(row.entry.record.judgmentId ?? "<missing>"))
        .sort(),
      // Diagnostics only — the T4 merge decides who actually voted.
      votingJudgments: voting.map((d) => d.judgmentId).sort(),
      restoredVerdicts: restored.sort(),
      conflict: restored.length > 0 && !allAgree,
      arbitrationDeclared: arbitration !== null,
      // A fully bound arbitration stays "binding complete" even when its own
      // verdict is UNKNOWN — binding completeness is about the bound set,
      // not the outcome (T4 reasonCode ARBITRATED | ARBITRATION_UNCERTAIN).
      arbitrationBindingComplete:
        fc !== null &&
        (fc.reasonCode === "ARBITRATED" ||
          fc.reasonCode === "ARBITRATION_UNCERTAIN"),
      resolvedBy: fc !== null ? fc.resolvedBy : "UNRESOLVED",
      outcome: fc !== null ? fc.verdict : "UNKNOWN",
      ...(fc !== null
        ? { reasonCode: fc.reasonCode, arbitrationRef: fc.arbitrationRef }
        : {}),
    };
  });
  // A structurally valid arbitration that binds no assignment in this
  // bundle is not evidence (malformed ones were already rejected above).
  // The binding set is the declared ∪ recorded plan (P1-5) — an arbitration
  // may legitimately bind a declared assignment that has no judgment
  // records yet (the merge keeps that unit UNKNOWN / MISSING_JUDGMENTS and
  // never adopts the arbitration).
  for (const arbitration of validArbitrations) {
    if (!matchedArbitrations.has(arbitration)) {
      report({
        packageId: "<arbitration>",
        judgmentId: String(arbitration?.arbitrationId ?? "<missing>"),
        code: "INVALID_ARBITRATION_RECORD",
        message: `arbitration ${arbitration?.arbitrationId ?? "<missing>"} references assignment ${arbitration?.assignmentKey ?? "<missing>"} which is neither declared in bundle.assignments nor carried by any judgment record in this bundle`,
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
      // P1-5 acceptance surface: the declared plan (∪ recorded keys) and
      // the final comparison set must stay in 1:1 correspondence — an
      // unjudged declared assignment counts here as a MISSING_JUDGMENTS
      // comparison, never as a dropped plan entry.
      declaredAssignments: declaredAssignments.size,
      mergedAssignmentKeys: mergeComponentsByKey.size,
      finalComparisons: finalComparisons.length,
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

function pairReport(entry, partnerEntry, swapProblemCodes, derivedByEntry) {
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
  const findDerived = (e) => derivedByEntry.get(e) ?? null;
  const leftDerived = findDerived(entry);
  const rightDerived = findDerived(partnerEntry);
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
