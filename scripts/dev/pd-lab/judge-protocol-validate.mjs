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
} from "./judge-protocol.mjs";

const USAGE = [
  "usage: judge-protocol-validate.mjs \\",
  "  --bundle <judge-protocol-bundle.json> --out <dir>",
].join("\n");

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
    const note = (code, message) =>
      report({ packageId, judgmentId, code, message });

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
        restoredVerdict: null,
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
    //    presentation binding, checked for consistency in step 5).
    const digest = comparisonInputDigestOf(
      blindPackage,
      secretBinding.identityMap,
    );
    if (record.comparisonInputDigest !== digest) {
      note(
        "COMPARISON_INPUT_DIGEST_MISMATCH",
        `record digest ${record.comparisonInputDigest} != recomputed ${digest}`,
      );
    }

    // 4. Leak scan.
    const violations = checkPackageForLeaks(blindPackage);
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
      valid: true,
      restoredVerdict,
      failed: isFailed,
    });
  }

  // Swap pairs: mechanically detected counterpart packages (same content,
  // exchanged positions) plus declared swapOf references. Position flips are
  // a CALIBRATION METRIC (the D5 flip rate), reported as data, never a
  // validation failure.
  const swapPairs = [];
  const seenSwap = new Set();
  for (const entry of bundle.entries) {
    if (!isPlainObject(entry?.blindPackage)) continue;
    const pkg = entry.blindPackage;
    const declared = isNonEmptyString(entry.swapOf) ? entry.swapOf : null;
    const partner = declared ? packagesById.get(declared) : null;
    if (declared && !partner) {
      report({
        packageId: String(pkg.packageId),
        judgmentId: String(entry.record?.judgmentId ?? "<missing>"),
        code: "SWAP_PARTNER_MISSING",
        message: `swapOf ${declared} does not resolve to a bundle package`,
      });
      continue;
    }
    const counterKey = (candidate) =>
      candidate &&
      candidate.blindPackage.outputA === pkg.outputB &&
      candidate.blindPackage.outputB === pkg.outputA &&
      candidate.blindPackage.context === pkg.context;
    if (!partner) {
      // Undeclared counterpart: scan mechanically (deterministic order).
      const found = bundle.entries.find(
        (candidate) => candidate !== entry && counterKey(candidate),
      );
      if (!found) continue;
      const key = [String(pkg.packageId), String(found.blindPackage.packageId)]
        .sort()
        .join("\u0000");
      if (seenSwap.has(key)) continue;
      seenSwap.add(key);
      swapPairs.push(pairReport(pkg, entry, found.blindPackage, found.record));
      continue;
    }
    if (!counterKey(partner)) {
      report({
        packageId: String(pkg.packageId),
        judgmentId: String(entry.record?.judgmentId ?? "<missing>"),
        code: "SWAP_CONTENT_MISMATCH",
        message: `declared swap partner ${declared} does not carry the exchanged outputs`,
      });
      continue;
    }
    const key = [String(pkg.packageId), String(declared)].sort().join("\u0000");
    if (seenSwap.has(key)) continue;
    seenSwap.add(key);
    swapPairs.push(
      pairReport(pkg, entry, partner.blindPackage, partner.record),
    );
  }

  // Per-assignment conflict / arbitration summary (CONTRACT 5.2 steps 3-5).
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
      const boundIds = Array.isArray(arbitration.boundJudgmentIds)
        ? [...arbitration.boundJudgmentIds].sort()
        : [];
      const votingIds = voting.map((d) => d.judgmentId).sort();
      arbitrationComplete =
        JSON.stringify(boundIds) === JSON.stringify(votingIds) &&
        ["CANDIDATE_BETTER", "TIE", "REFERENCE_BETTER", "UNKNOWN"].includes(
          arbitration.verdict,
        );
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
    positionExchange: {
      pairs: swapPairs,
      consistent: swapPairs.filter((p) => p.restoredAgrees).length,
      flipped: swapPairs.filter((p) => !p.restoredAgrees).length,
      note: "position flips are the D5 calibration metric (flip rate), reported as data — they never invalidate an entry",
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

function pairReport(pkg, entry, partnerPackage, partnerRecord) {
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
  return {
    packageIds: [
      String(pkg.packageId),
      String(partnerPackage.packageId),
    ].sort(),
    restoredVerdicts: [left, right],
    restoredAgrees: left !== null && left === right,
  };
}

main();
