#!/usr/bin/env node
// PD-Lab v0.3 T7a qualification CLI (PRI-1258): reads an explicit
// qualification-input.json (READY independent source groups for the T6
// path, the D2-frozen analysis policy, authorization/calibration facts with
// their evidence references) and writes a deterministic qualification.json
// carrying the BLOCKED / EXPLORATORY_ONLY / CONFIRMATORY_READY verdict.
//
// The verdict is a pure function of the input record (see t6-qualification.mjs):
// every governance fact is an explicit boolean/status — unproven facts are
// recorded as false/NOT_RUN by the input author, never inferred here. A
// BLOCKED verdict is a VALID computed outcome (exit 0), not a CLI failure.
//
// Usage:
//   node scripts/dev/pd-lab/t6-qualify.mjs --input <qualification-input.json> --out <dir>
//
// Exit codes:
//   0  qualification computed (any status, BLOCKED included)
//   1  structurally invalid input (nothing written)
//   2  usage error or unreadable/unparseable input (nothing written)

import fs from "node:fs";
import path from "node:path";
import { qualifyT6 } from "./t6-qualification.mjs";

const USAGE = [
  "usage: t6-qualify.mjs \\",
  "  --input <qualification-input.json> --out <dir>",
].join("\n");

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

function main() {
  const options = parseArgs(process.argv.slice(2));
  let input;
  try {
    input = JSON.parse(fs.readFileSync(options.input, "utf8"));
  } catch (error) {
    fail(`cannot read/parse input ${options.input}: ${error.message}`, 2);
  }
  const result = qualifyT6(input);
  if (!result.ok) {
    process.stderr.write(
      `t6-qualify: structurally invalid qualification input:\n  - ${result.inputProblems.join("\n  - ")}\n`,
    );
    process.exit(1);
  }
  // Write-once --out (plain mkdir as the concurrency gate, admission-probe
  // precedent): a qualification report directory is never silently replaced.
  const outDir = path.resolve(options.out);
  try {
    fs.mkdirSync(outDir);
  } catch (error) {
    fail(`cannot create output directory ${outDir}: ${error.message}`, 2);
  }
  const outPath = path.join(outDir, "qualification.json");
  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      status: result.status,
      blockedReasons: result.blockedReasons,
      unmetCriteria: result.unmetCriteria,
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
