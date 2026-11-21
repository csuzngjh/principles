#!/usr/bin/env node
// PD-Lab v0.3 T7a qualification CLI (PRI-1258): reads an explicit
// qualification-input.json (READY independent source groups for the T6
// path, the D2-frozen analysis policy, authorization/calibration facts with
// their evidence references) and writes a deterministic qualification.json
// carrying the BLOCKED / EXPLORATORY_ONLY / CONFIRMATORY_READY verdict.
//
// The verdict is a pure function of the input record plus the resolved
// evidence documents (see t6-qualification.mjs): every governance fact is
// an explicit boolean/status — unproven facts are recorded as false/NOT_RUN
// by the input author, never inferred here. When input.evidence binds an
// artifact ({artifactRef, sha256}), this CLI reads the file, recomputes its
// SHA-256 from the actual bytes and rejects on mismatch — the declared
// digest is never trusted. A BLOCKED verdict is a VALID computed outcome
// (exit 0), not a CLI failure.
//
// Usage:
//   node scripts/dev/pd-lab/t6-qualify.mjs --input <qualification-input.json> --out <dir>
//
// Exit codes:
//   0  qualification computed (any status, BLOCKED included)
//   1  structurally invalid input OR evidence verification failure
//       (artifact unreadable / digest mismatch / unparseable — a structured
//       evidence-verification.json is written for audit)
//   2  usage error or unreadable/unparseable input (nothing written)

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { qualifyT6 } from "./t6-qualification.mjs";

const USAGE = [
  "usage: t6-qualify.mjs \\",
  "  --input <qualification-input.json> --out <dir>",
].join("\n");

const EVIDENCE_KEYS = [
  "sourceGroups",
  "admissionReport",
  "preregistration",
  "judgeCalibration",
  "ownerBlindReview",
];
const APPROVAL_KEYS = ["d2", "d5", "d6"];

function fail(message, code) {
  process.stderr.write(`t6-qualify: ${message}\n${USAGE}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const required = ["input", "out"];
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

// Resolve one bound evidence artifact: read bytes, recompute the digest from
// those bytes, compare to the declared sha256, parse the JSON document. A
// mismatch or unreadable artifact is a verification failure, never a skip.
function resolveArtifact(binding, baseDir) {
  const artifactRef = binding.artifactRef;
  const resolved = {
    artifactRef,
    sha256: binding.sha256,
    verified: false,
  };
  const filePath = path.resolve(baseDir, artifactRef);
  let bytes;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (error) {
    resolved.problem = `artifact unreadable: ${error.message}`;
    return { resolved, document: null };
  }
  const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  resolved.actualSha256 = actual;
  if (actual !== binding.sha256) {
    resolved.problem = `digest mismatch: declared ${binding.sha256} != recomputed ${actual}`;
    return { resolved, document: null };
  }
  try {
    resolved.document = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    resolved.problem = `artifact is not parseable JSON: ${error.message}`;
    return { resolved, document: null };
  }
  resolved.verified = true;
  return { resolved, document: resolved.document };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  let input;
  try {
    input = JSON.parse(fs.readFileSync(options.input, "utf8"));
  } catch (error) {
    fail(`cannot read/parse input ${options.input}: ${error.message}`, 2);
  }
  if (!isPlainObject(input)) {
    fail("input must be a JSON object", 2);
  }

  // ── Evidence resolution (P0-1): every bound artifactRef is read, its
  //    SHA-256 recomputed from the actual bytes and compared to the declared
  //    digest — before the engine ever sees the document. ─────────────────
  const baseDir = path.dirname(path.resolve(options.input));
  const resolvedEvidence = {};
  const verification = { ok: true, artifacts: {} };
  const evidence = isPlainObject(input.evidence) ? input.evidence : null;
  if (evidence !== null) {
    for (const key of EVIDENCE_KEYS) {
      if (isPlainObject(evidence[key]) && evidence[key].artifactRef) {
        const { resolved, document } = resolveArtifact(evidence[key], baseDir);
        verification.artifacts[key] = {
          artifactRef: resolved.artifactRef,
          declaredSha256: resolved.sha256,
          actualSha256: resolved.actualSha256 ?? null,
          verified: resolved.verified,
          ...(resolved.problem ? { problem: resolved.problem } : {}),
        };
        if (resolved.verified) {
          resolvedEvidence[key] = {
            artifactRef: resolved.artifactRef,
            sha256: resolved.sha256,
            document,
          };
        } else {
          verification.ok = false;
        }
      }
    }
    if (isPlainObject(evidence.approvals)) {
      for (const key of APPROVAL_KEYS) {
        if (isPlainObject(evidence.approvals[key]) && evidence.approvals[key].artifactRef) {
          if (!isPlainObject(resolvedEvidence.approvals))
            resolvedEvidence.approvals = {};
          const { resolved, document } = resolveArtifact(
            evidence.approvals[key],
            baseDir,
          );
          verification.artifacts[`approvals.${key}`] = {
            artifactRef: resolved.artifactRef,
            declaredSha256: resolved.sha256,
            actualSha256: resolved.actualSha256 ?? null,
            verified: resolved.verified,
            ...(resolved.problem ? { problem: resolved.problem } : {}),
          };
          if (resolved.verified) {
            resolvedEvidence.approvals[key] = {
              artifactRef: resolved.artifactRef,
              sha256: resolved.sha256,
              document,
            };
          } else {
            verification.ok = false;
          }
        }
      }
    }
  }

  let result;
  try {
    result = qualifyT6(input, verification.ok ? resolvedEvidence : null);
  } catch (error) {
    fail(`qualification engine threw: ${error.message}`, 1);
  }

  // Write-once --out (plain mkdir as the concurrency gate, admission-probe
  // precedent): a qualification report directory is never silently replaced.
  const outDir = path.resolve(options.out);
  try {
    fs.mkdirSync(outDir);
  } catch (error) {
    fail(`cannot create output directory ${outDir}: ${error.message}`, 2);
  }

  if (!result.ok) {
    process.stderr.write(
      `t6-qualify: structurally invalid qualification input:\n  - ${result.inputProblems.join("\n  - ")}\n`,
    );
    process.exit(1);
  }
  // Evidence verification failure: structured audit report, exit 1. A
  // tampered artifact never produces a verdict.
  fs.writeFileSync(
    path.join(outDir, "evidence-verification.json"),
    `${JSON.stringify(verification, null, 2)}\n`,
    "utf8",
  );
  if (!verification.ok) {
    process.stderr.write(
      `t6-qualify: evidence verification failed:\n  - ${Object.entries(verification.artifacts)
        .filter(([, a]) => !a.verified)
        .map(([k, a]) => `${k}: ${a.problem}`)
        .join("\n  - ")}\n`,
    );
    process.exit(1);
  }
  const outPath = path.join(outDir, "qualification.json");
  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      status: result.status,
      blockedReasons: result.blockedReasons,
      unmetCriteria: result.unmetCriteria,
      disclosures: result.disclosures,
      readyIndependentSourceGroups:
        result.thresholds.readyIndependentSourceGroups,
      alpha: result.thresholds.alpha,
      nMinAlpha: result.thresholds.nMinAlpha,
      kAtReadyN: result.thresholds.kAtReadyN,
      judgeProtocolRef: result.judgeProtocol.judgeProtocolRef,
      judgeProtocolDigest: result.judgeProtocol.judgeProtocolDigest,
      t6Permissions: result.t6Permissions,
    })}\n`,
  );
}

main();
