#!/usr/bin/env node
/**
 * PRI-773: telemetry event union <-> emit-site two-way guard (ERR-060).
 *
 * ERR-060: an event name emitted through StoreEventEmitter that is not
 * registered in the TelemetryEventType union (packages/principles-core/src/
 * telemetry-event.ts) is SILENTLY rewritten to `degradation_triggered`
 * (store/event-emitter.ts) — the signal is dropped and nothing reports it.
 * This guard keeps the union and the real emit sites in two-way sync.
 *
 * Modes:
 *   (default)   advisory report to stdout (+ $GITHUB_STEP_SUMMARY when run
 *               in CI); always exits 0
 *   --strict    exit 1 on any drift (used by verify:merge once the baseline
 *               catches up)
 *   --json      machine-readable { missingRegistered, deadMembers } for
 *               catch-up tooling; exits 0
 *
 * Scope: packages/principles-core/src only. host-runtime / codex-adapter /
 * openclaw-plugin event-log use DIFFERENT event pipelines that never pass
 * through validateTelemetryEvent, so their emit sites are out of scope.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
// pd-cli/src is in scope: `pd diagnose` emits runtime_adapter_selected
// through a StoreEventEmitter directly (TELE-01). host-runtime has no
// direct literal emitTelemetry sites (typed passthrough only).
const SCAN_ROOTS = ['packages/principles-core/src', 'packages/pd-cli/src'];
const UNION_FILE = 'packages/principles-core/src/telemetry-event.ts';
const ARTIFACT_SUMMARY_FILE =
  'packages/principles-core/src/runtime-v2/internalization/artifact-summary.ts';

// PainSignalBridge emits ad-hoc names that are deliberately NOT registered:
// pain-signal-runtime-factory.ts:518-530 keeps them dormant (forwarding them
// as degradation_triggered would mislabel routine admission decisions and
// change flag-off behavior, PRI-638 contract). The two pain_diagnosis_persist_*
// names are mapped onto degradation_triggered and never reach the union path.
const DORMANT_ALLOWLIST = [
  'candidate_admission_decision',
  'candidate_dreamer_task_seeded',
  'candidate_dreamer_task_seed_failed',
  'candidate_not_internalizable',
  'pain_diagnosis_persist_skipped',
  'pain_diagnosis_persist_failed',
];

function isExcluded(relPath) {
  return relPath.endsWith('.cjs') || /(^|[/\\])(__tests__|fixtures)([/\\]|$)/.test(relPath) || /\.test\.ts$/.test(relPath);
}

function listTsFiles() {
  const files = [];
  for (const root of SCAN_ROOTS) {
    const absRoot = path.join(ROOT, root);
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(abs);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const rel = path.relative(ROOT, abs).split(path.sep).join('/');
        if (!isExcluded(rel)) files.push(rel);
      }
    })(absRoot);
  }
  return files;
}

function extractUnionNames() {
  const src = fs.readFileSync(path.join(ROOT, UNION_FILE), 'utf-8');
  const names = new Set();
  for (const m of src.matchAll(/Type\.Literal\('([a-zA-Z0-9_]+)'\)/g)) {
    names.add(m[1]);
  }
  return names;
}

function collectRunnerNames(sources) {
  const names = new Set();
  for (const { rel, src } of sources) {
    for (const m of src.matchAll(/runnerName:\s*'([a-z_]+)'/g)) {
      names.add(m[1]);
    }
  }
  return [...names];
}

// Per-file runner identity: each *-runner.ts declares exactly one
// `runnerName: '<x>'`. base-peer-runner.ts hosts the SHARED lifecycle emits
// (run_started/task_leased/mark_* ...) that every runner instances, so its
// suffixes compose with ALL runner names. Files without a declaration are
// treated the same way (conservative over-approximation).
function runnerNamesForFile(rel, fileRunnerNames, allRunnerNames) {
  return fileRunnerNames.length > 0 ? fileRunnerNames : allRunnerNames;
}

function collectEmittedNames(sources, runnerNames) {
  const emitted = new Map(); // name -> first site (rel:line)
  const note = (name, rel, line) => {
    if (!emitted.has(name)) emitted.set(name, `${rel}:${line}`);
  };
  for (const { rel, src } of sources) {
    const lines = src.split('\n');
    const fileRunnerNames = [...src.matchAll(/runnerName:\s*'([a-z_]+)'/g)].map((m) => m[1]);
    const composeWith = runnerNamesForFile(rel, fileRunnerNames, runnerNames);
    // Pattern A: this.emitEvent('<suffix>') — runtime-composed as
    // `${runnerName}_${suffix}` (base-peer-runner.ts:447-457).
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(/this\.emitEvent\('([a-z0-9_]+)'/g)) {
        for (const runner of composeWith) note(`${runner}_${m[1]}`, rel, i + 1);
      }
      // Pattern B: full-name typed wrapper (rollout reviewer).
      for (const m of lines[i].matchAll(/emitRolloutReviewerEvent\('([a-z0-9_]+)'/g)) {
        note(m[1], rel, i + 1);
      }
      // Pattern C: direct eventType literal.
      for (const m of lines[i].matchAll(/eventType:\s*'([a-z0-9_]+)'/g)) {
        note(m[1], rel, i + 1);
      }
      // Pattern C-ternary: eventType: cond ? 'a' : 'b' (pi-ai-runtime-adapter.ts:1234).
      for (const m of lines[i].matchAll(/eventType:\s*[\w.]+\s*\?\s*'([a-z0-9_]+)'\s*:\s*'([a-z0-9_]+)'/g)) {
        note(m[1], rel, i + 1);
        note(m[2], rel, i + 1);
      }
    }
  }
  // Dynamic site 1: base-peer-runner attachSummaryEnvelope re-emits
  // artifact-summary envelope types with a runner prefix
  // (artifact-summary.ts:47-49 closed union × every known runner).
  const summarySrc = fs.readFileSync(path.join(ROOT, ARTIFACT_SUMMARY_FILE), 'utf-8');
  const summarySuffixes = [...summarySrc.matchAll(/readonly type: '([a-z0-9_]+)'/g)].map((m) => m[1]);
  for (const runner of runnerNames) {
    for (const suffix of summarySuffixes) note(`${runner}_${suffix}`, ARTIFACT_SUMMARY_FILE, 0);
  }
  // Dynamic site 2: openclaw-cli-runtime-adapter mapCliResultToTelemetry
  // returns exactly these two literals (:590-610).
  note('runtime_invocation_failed', 'openclaw-cli-runtime-adapter.ts (closed map)', 0);
  note('runtime_invocation_succeeded', 'openclaw-cli-runtime-adapter.ts (closed map)', 0);
  return emitted;
}

function main() {
  const strict = process.argv.includes('--strict');
  const json = process.argv.includes('--json');
  const unionNames = extractUnionNames();
  const sources = listTsFiles().map((rel) => ({
    rel,
    src: fs.readFileSync(path.join(ROOT, rel), 'utf-8'),
  }));
  const runnerNames = collectRunnerNames(sources);
  const emitted = collectEmittedNames(sources, runnerNames);

  const allowlisted = [];
  const missingRegistered = [...emitted.keys()]
    .filter((name) => !unionNames.has(name))
    .sort();
  for (const name of [...missingRegistered]) {
    if (DORMANT_ALLOWLIST.includes(name)) {
      allowlisted.push(name);
      missingRegistered.splice(missingRegistered.indexOf(name), 1);
    }
  }
  const deadMembers = [...unionNames].filter((name) => !emitted.has(name)).sort();

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          unionSize: unionNames.size,
          emittedSize: emitted.size,
          runnerNames,
          allowlisted,
          missingRegistered,
          deadMembers,
        },
        null,
        2,
      )}\n`,
    );
    process.exit(0);
  }

  const drift = missingRegistered.length + deadMembers.length;
  const lines = [
    `[check:telemetry-events] union=${unionNames.size} emitted=${emitted.size} runners=${runnerNames.length} drift=${drift} allowlisted=${allowlisted.length}`,
  ];
  if (missingRegistered.length > 0) {
    lines.push(`  NOT registered (silently dropped today, ERR-060): ${missingRegistered.join(', ')}`);
  }
  if (deadMembers.length > 0) {
    lines.push(`  dead union members (no emit site): ${deadMembers.join(', ')}`);
  }
  if (allowlisted.length > 0) {
    lines.push(`  allowlisted (dormant by design, pain-signal-runtime-factory.ts:518-530): ${allowlisted.join(', ')}`);
  }
  lines.push(
    drift === 0
      ? '[check:telemetry-events] OK: union and emit sites are in two-way sync.'
      : '[check:telemetry-events] DRIFT: register missing names / prune dead members (update telemetry-event.ts with a PRI tag).',
  );

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    fs.appendFileSync(
      summaryPath,
      ['### PRI-773 telemetry union guard', ...lines, ''].join('\n'),
    );
  }

  if (strict && drift > 0) {
    for (const line of lines) process.stderr.write(`${line}\n`);
    process.stderr.write('[check:telemetry-events] STRICT: drift detected, failing.\n');
    process.exit(1);
  }
  for (const line of lines) console.log(line);
  if (strict) {
    console.log('[check:telemetry-events] STRICT: OK.');
  } else {
    console.log('[check:telemetry-events] advisory mode: report only (use --strict to fail).');
  }
  process.exit(0);
}

main();
