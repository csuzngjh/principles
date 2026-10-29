#!/usr/bin/env node
// SPEC-PD-EXAMINER-001 v0.4 §6.4/§7.2 — PRI-1038 Stage R F2 real-host
// execution driver (CEB-001, OpenClaw wiring).
//
// What it does:
//   1. verifies the canonical study's run-authorization.json is an APPROVED
//      F2-real-host record bound to the freshly recomputed frozen suite
//      (read-only);
//   2. prepares a FRESH study copy under .tmp/pri1038-f2/<ts>/ and copies the
//      archived PASSED PRI-1037 probe record into it at
//      isolation-probes/PRI-1037.json (the authorization's evidenceRef — the
//      frozen canonical study never gains run records);
//   3. invokes run-challenge-study.mjs --execution-mode F2-real-host (the
//      gate, not this driver, remains the authorization authority — dry-run
//      first with the actual plan, then the real run with the actual system
//      clock, re-verified PER UNIT);
//   4. after the run: derives the formal realHostBaseline (OpenClaw
//      exec-state corroboration) and prints the budget accounting.
//
// Stop conditions are machine-enforced downstream (unknown-streak 3,
// capacity-streak 3, per-attempt request cap, authorization window per unit);
// this driver adds no budget or plan of its own.
//
//   node run-stage-r-f2.mjs --openclaw-bin "C:/.../openclaw.mjs" \
//        --probe-work-root "<pri1037 probe workRoot>" [--dry-run] [--units <n>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const labRoot = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const openclawBin = arg('--openclaw-bin');
if (!openclawBin) {
  console.error('run-stage-r-f2: --openclaw-bin <path> required (openclaw.mjs or a spawnable openclaw bin)');
  process.exit(1);
}
const probeWorkRoot = path.resolve(process.cwd(), arg('--probe-work-root', ''));
const dryRun = process.argv.includes('--dry-run');
const unitsArg = arg('--units', '36');
const canonical = path.join(labRoot, 'challenge-studies', 'CEB-001');
const probeRecordSource = path.resolve(labRoot, '..', '..', '..', 'docs', 'research', 'pri1037-probe-attempts', 'attempt-4-PRI-1037.json');
const f2AuthorizationSource = path.resolve(labRoot, '..', '..', '..', 'docs', 'research', 'pri1038-f2', 'F2-RUN-AUTHORIZATION.json');

for (const p of [canonical, probeRecordSource, f2AuthorizationSource]) {
  if (!fs.existsSync(p)) {
    console.error(`run-stage-r-f2: required path missing: ${p}`);
    process.exit(1);
  }
}
const probeControlledRoot = path.join(probeWorkRoot, 'rounds');
if (!fs.existsSync(probeControlledRoot)) {
  console.error(`run-stage-r-f2: probe controlled root does not exist: ${probeControlledRoot} (pass --probe-work-root pointing at the PRI-1037 attempt-4 workRoot)`);
  process.exit(1);
}

// Authorization sanity (read-only): the ARCHIVED Owner record must be
// APPROVED F2 bound to the frozen suite; the canonical study directory keeps
// its NOT_AUTHORIZED placeholder untouched (execution state lives in the
// copy). The full gate re-verifies inside the runner.
const auth = JSON.parse(fs.readFileSync(f2AuthorizationSource, 'utf8'));
if (auth.status !== 'APPROVED' || auth.executionMode !== 'F2-real-host') {
  console.error(`run-stage-r-f2: archived F2 authorization is ${auth.status}/${auth.executionMode} — not an APPROVED F2 record; refusing`);
  process.exit(1);
}

// Resume support: --resume <studyCopy> continues an existing copy (the
// runner skips already-settled units by the ledger; reservations and
// records stay intact). Fresh copies are prepared otherwise.
const resumeCopy = arg('--resume');
let studyCopy;
let runRoot;
if (resumeCopy !== undefined) {
  studyCopy = path.resolve(process.cwd(), resumeCopy);
  runRoot = path.dirname(studyCopy);
  if (!fs.existsSync(path.join(studyCopy, 'suite-manifest.json'))) {
    console.error(`run-stage-r-f2: --resume copy is not a study directory: ${studyCopy}`);
    process.exit(1);
  }
  console.log(`run-stage-r-f2: resuming existing study copy — ${studyCopy}`);
} else {
  runRoot = path.resolve(labRoot, '..', '..', '..', '.tmp', 'pri1038-f2', String(Date.now()));
  studyCopy = path.join(runRoot, 'study');
  if (fs.existsSync(runRoot)) {
    console.error(`run-stage-r-f2: run root already exists: ${runRoot} — refusing to reuse`);
    process.exit(1);
  }
  fs.cpSync(canonical, studyCopy, { recursive: true });
  fs.copyFileSync(f2AuthorizationSource, path.join(studyCopy, 'run-authorization.json'));
  fs.mkdirSync(path.join(studyCopy, 'isolation-probes'), { recursive: true });
  fs.copyFileSync(probeRecordSource, path.join(studyCopy, 'isolation-probes', 'PRI-1037.json'));
  console.log(`run-stage-r-f2: study copy ready — ${studyCopy}`);
}
console.log(`run-stage-r-f2: study copy ready — ${studyCopy}`);
console.log(`run-stage-r-f2: probe record copied — isolation-probes/PRI-1037.json (PASSED, ${auth.isolationAcceptance.realHostProbe.executedAt})`);

// 3. The single runner invocation (the CLI is the production entry: gate
// before factory, per-unit clock, request budget ledger). The plan is the
// FULL authorized matrix; the runner's automatic stops handle failures.
const cliPath = path.join(labRoot, 'run-challenge-study.mjs');
const args = [
  cliPath,
  '--study-dir', studyCopy,
  '--execution-mode', 'F2-real-host',
  '--arms', auth.arms.join(','),
  '--repetitions', auth.repetitions.join(','),
  '--max-attempts', String(auth.attemptCap),
  '--request-timeout-ms', String(auth.requestTimeoutMs),
  '--max-requests-per-attempt', String(auth.maxRequestsPerAttempt),
  '--openclaw-bin', openclawBin,
  '--probe-controlled-root', probeControlledRoot,
  '--owner', 'pri-1038-f2-driver',
];
if (dryRun) {
  // The CLI requires a labeled SIMULATED clock for --dry-run (the real run
  // always uses the actual system clock, re-verified per unit).
  args.push('--dry-run', '--now', new Date().toISOString());
}
console.log(`run-stage-r-f2: invoking runner (${dryRun ? 'DRY-RUN' : 'REAL'} — the gate re-verifies the authorization per unit)`);
const res = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: labRoot });
if (res.status !== 0) {
  console.error(`run-stage-r-f2: runner exited ${res.status} — see output above`);
  process.exit(res.status ?? 1);
}

// 4. Post-run: formal baseline derivation + budget accounting (read-only).
console.log('\nrun-stage-r-f2: === post-run gates ===');
const baseline = spawnSync(process.execPath, ['-e', `
import('./lib/challenge-baseline.mjs').then(async (m) => {
  const v = m.deriveRealHostBaselineFromStudy(${JSON.stringify(studyCopy)}, {});
  console.log('realHostBaseline: ' + v.status);
  for (const r of v.reasons.slice(0, 10)) console.log('  - ' + r.slice(0, 300));
});
`], { stdio: 'inherit', cwd: labRoot });
const ledger = spawnSync(process.execPath, ['-e', `
import('./lib/challenge-ledger.mjs').then(async (m) => {
  const ledger = m.createChallengeLedger(${JSON.stringify(studyCopy)});
  const b = ledger.budgetEntries();
  console.log('budget RESERVE=' + b.filter(e => e.type === 'RESERVE').length + ' REQUEST_RESERVE=' + b.filter(e => e.type === 'REQUEST_RESERVE').length + ' REQUEST_REFUSED=' + b.filter(e => e.type === 'REQUEST_REFUSED').length);
});
`], { stdio: 'inherit', cwd: labRoot });
console.log(`run-stage-r-f2: DONE (${baseline.status === 0 && ledger.status === 0 ? 'post-run gates completed' : 'post-run gates PARTIAL — inspect output above'}); study copy: ${studyCopy}`);
