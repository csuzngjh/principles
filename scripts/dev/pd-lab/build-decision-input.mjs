#!/usr/bin/env node
// PD-Lab v0.3 T4 (PRI-1255): offline CLI that turns a frozen benchmark plan,
// raw judge records, arbitration records, the blind identity map and the
// dataset source-group mapping into the FinalComparison[] list and the
// decision-input.json of CONTRACT-PD-LAB-DATA-AND-SCORING-001 v0.3
// (sections 5.2, 6.2, 6.5). All computation lives in the pure module
// alignment-report.mjs; this wrapper only parses arguments, reads input
// files and writes deterministic output files (no timestamps).
//
// Usage:
//   node scripts/dev/pd-lab/build-decision-input.mjs \
//     --plan <plan.json> \
//     --judgments <judgments.json> \
//     --arbitrations <arbitrations.json>   (optional, default [])
//     --blindmap <blindmap.json> \
//     --source-groups <source-groups.json> \
//     --out-dir <dir>
//
// Exit codes:
//   0  report produced (status ESTIMABLE or BOUNDED_ONLY; missing plan-internal
//      reviews stay UNKNOWN in the denominator)
//   1  status INVALID - structural problems (extra keys, duplicate finals,
//      missing blindmap mapping, over-voting, INVALID_PLAN, ...); outputs are
//      still written with status INVALID and the problem list for inspection
//   2  usage error or unreadable/unparseable input (nothing written)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAlignmentReport, mergeJudgments } from './alignment-report.mjs';

const USAGE = [
  'usage: build-decision-input.mjs \\',
  '  --plan <plan.json> --judgments <judgments.json> [--arbitrations <arbitrations.json>] \\',
  '  --blindmap <blindmap.json> --source-groups <source-groups.json> --out-dir <dir>',
].join('\n');

function fail(message, code) {
  process.stderr.write(`build-decision-input: ${message}\n${USAGE}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const required = ['plan', 'judgments', 'blindmap', 'source-groups', 'out-dir'];
  const optional = ['arbitrations'];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      fail(`unexpected argument ${token}`, 2);
    }
    const name = token.slice(2);
    if (![...required, ...optional].includes(name)) {
      fail(`unknown option --${name}`, 2);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      fail(`option --${name} requires a value`, 2);
    }
    options[name] = value;
    i += 1;
  }
  for (const name of required) {
    if (options[name] === undefined) {
      fail(`missing required option --${name}`, 2);
    }
  }
  return options;
}

function readJsonFile(label, file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    fail(`cannot read ${label} file ${file}: ${error.message}`, 2);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${label} file ${file} is not valid JSON: ${error.message}`, 2);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const plan = readJsonFile('plan', options.plan);
  const judgments = readJsonFile('judgments', options.judgments);
  const arbitrations = options.arbitrations === undefined
    ? []
    : readJsonFile('arbitrations', options.arbitrations);
  const blindmap = readJsonFile('blindmap', options.blindmap);
  const sourceGroups = readJsonFile('source-groups', options['source-groups']);

  const merged = mergeJudgments({ plan, judgments, arbitrations, blindmap });
  const report = buildAlignmentReport({
    plan,
    finalComparisons: merged.finalComparisons,
    sourceGroups,
    problems: merged.problems,
    invalidRecords: merged.invalidRecords,
  });

  const outDir = options['out-dir'];
  fs.mkdirSync(outDir, { recursive: true });
  const comparisonsFile = path.join(outDir, 'final-comparisons.json');
  const decisionFile = path.join(outDir, 'decision-input.json');
  fs.writeFileSync(comparisonsFile, `${JSON.stringify(merged.finalComparisons, null, 2)}\n`, 'utf8');
  fs.writeFileSync(decisionFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const outcome = report.decision && report.decision.outcome ? report.decision.outcome : 'N/A';
  if (report.status === 'INVALID') {
    process.stdout.write(
      `status=INVALID problems=${report.problems.length} planned=${report.counts && report.counts.planned !== undefined ? report.counts.planned : 'N/A'} `
      + `nextAction=fix input data per decision-input.json problems, then rerun\n`,
    );
    process.stderr.write(
      `problems:\n${report.problems.map((entry) => `  [${entry.code}] ${entry.message}`).join('\n')}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `status=${report.status} pointEstimate=${report.pointEstimate === null ? 'null' : report.pointEstimate.toFixed(1)} `
    + `missingBounds=[${report.missingBounds.lower.toFixed(1)}, ${report.missingBounds.upper.toFixed(1)}] `
    + `planned=${report.counts.planned} resolved=${report.counts.resolved} unknown=${report.counts.unknown} outcome=${outcome}\n`,
  );
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
