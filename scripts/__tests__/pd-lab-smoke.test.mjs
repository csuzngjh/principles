// PD-Lab v0.3 T5 (PRI-1256) — hermetic mechanical smoke over the REAL entries.
//
// Proves the A/B harness command/record/recovery/offline-analysis WIRING by
// driving the real CLI entries as child processes against a fully isolated
// synthetic environment (constructed by helpers/pd-lab-t5-env.mjs):
//
//   lab:preflight (ab-preflight.mjs)
//     → lab:run (ab-grid.mjs spawns ab-run.mjs per shard)
//       → every sample × every arm through the FIXTURE pd-cli
//         (real pain-record / diagnose-run / internalization-run-once
//         parameter+JSON contract, SQLite created by the REAL schema modules
//         of each arm's own built dist, stage payloads that pass the REAL
//         TypeBox output schemas ab-run validates)
//     → lab:metrics → lab:blindpack → synthetic Judge Protocol judgments
//     → lab:summary → lab:card (build-decision-input)
//
// plus the mandated negative controls (CF-16 second preflight, CF-04
// expectedHead, CF-11 blob manifest/blob, CF-14 preregistration digest,
// CF-15 experimentId binding) and the resume/idempotency checks (RF-05,
// HT-04): completed units are never re-executed, the failed unit resumes
// with its attempt history retained, and a current config cannot forge the
// identity of an existing run.
//
// Hermeticity: no real model, no network, no real credentials (modelEnv is
// a test sentinel whose presence only is checked), no production data — the
// experimentRoot lives under the OS temp dir, the synthetic arm worktrees
// live under the checkout's gitignored `.tmp/` (so the fixture CLI resolves
// better-sqlite3/typebox from the checkout's own node_modules), and every
// write stays inside the synthetic tree. `lab:eval` is deliberately NOT
// executed (no judge model).
//
// BOUNDARY (HANDOFF T5): this suite proves harness mechanics only. It does
// NOT prove that the real PD runtime improves host behavior — that remains
// NOT PROVEN and belongs to the authorized pilots (T6/T7a).
//
// NOTE — file format: `.test.mjs` (the sibling T3b suites established this
// for suites that drive child processes; vitest's include collects it).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BASELINE_ARM, CANDIDATE_ARM, EXPERIMENT_ID, REPO_ROOT, RUN_ID, SENTINEL_ENV, SENTINEL_VALUE,
  buildSmokeEnvironment, sha256Buf,
} from './helpers/pd-lab-t5-env.mjs';

const COMPLETED_TERMINAL_STATUSES = ['done', 'done-admission-refused', 'done-no-candidate', 'done-deferred'];
const Database = createRequire(import.meta.url)('better-sqlite3');

const sha256Text = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

let env = null; // { envRoot, repoTmp, expRoot, snapDir, configPath, preregPath, armHeads, fixtureLogPath, dispose }
let expRoot = null;
let snapDir = null;
let configPath = null;
let preregPath = null;
let fixtureLogPath = null;

function runEntry(entryRel, args, { timeoutMs = 300_000 } = {}) {
  return spawnSync(process.execPath, [path.join(REPO_ROOT, entryRel), ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, [SENTINEL_ENV]: SENTINEL_VALUE },
  });
}

function expectOk(res, label) {
  if (res.status !== 0) {
    throw new Error(`${label} exited ${res.status}\n--- stdout ---\n${res.stdout ?? ''}\n--- stderr ---\n${res.stderr ?? ''}`);
  }
  return res;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Parse the fixture CLI invocation log: [{cmd, ws, args, at}] in exec order. */
function readFixtureLog() {
  return fs.readFileSync(fixtureLogPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function fixtureLogBytes() {
  return fs.readFileSync(fixtureLogPath);
}

function armOfLogLine(line) {
  return String(line.ws ?? '').split('-')[0];
}

function markerOfLogLine(line) {
  const i = line.args.indexOf('--reason');
  const reason = i >= 0 ? String(line.args[i + 1] ?? '') : '';
  const m = reason.match(/smoke-s\d+/);
  return m ? m[0] : null;
}

/** Independent recomputation of ab-lib armOrderFor (GLOBAL sample index). */
function expectedArmOrder(runId, globalSampleIndex) {
  const h = parseInt(sha256Text(runId).slice(0, 8), 16);
  const flip = (h + globalSampleIndex) % 2;
  return flip === 0 ? [BASELINE_ARM, CANDIDATE_ARM] : [CANDIDATE_ARM, BASELINE_ARM];
}

function recordPath(sampleId, arm) {
  return path.join(expRoot, 'runs', RUN_ID, 'records', `${sampleId}.${arm}.json`);
}

beforeAll(async () => {
  env = await buildSmokeEnvironment();
  expRoot = env.expRoot;
  snapDir = env.snapDir;
  configPath = env.configPath;
  preregPath = env.preregPath;
  fixtureLogPath = env.fixtureLogPath;
}, 300_000);

afterAll(() => {
  if (env) env.dispose();
});

describe('PD-Lab v0.3 T5 hermetic mechanical smoke (PRI-1256)', () => {
  it('lab:preflight passes on the synthetic environment (loader + generic checks)', () => {
    const res = expectOk(runEntry('experiment/prompt-v2/scripts/ab/ab-preflight.mjs', ['--config', configPath]), 'lab:preflight');
    const report = JSON.parse(res.stdout);
    expect(report.ok).toBe(true);
    expect(report.experimentId).toBe(EXPERIMENT_ID);
    expect(report.preregistrationStatus).toBe('VERIFIED');
    expect(report.configSha256).toBe(sha256Buf(fs.readFileSync(configPath)));
    const failedChecks = report.checks.filter((c) => !c.ok);
    expect(failedChecks).toEqual([]);
  }, 180_000);

  it('lab:run drives the real ab-grid → ab-run orchestration over both arms × both samples', () => {
    // Deterministic failure injection + no-candidate terminal (control file
    // next to the workspaces — read by the fixture CLI, not the harness).
    writeJson(path.join(expRoot, 'workspaces', 't5-fixture-control.json'), {
      failDiagnoseOnce: [{ marker: 'smoke-s2', arm: CANDIDATE_ARM }],
      noCandidateArms: [{ marker: 'smoke-s2', arm: BASELINE_ARM }],
    });

    const res = expectOk(runEntry('experiment/prompt-v2/scripts/ab/ab-grid.mjs',
      ['--config', configPath, '--run-id', RUN_ID, '--parallel', '1']), 'lab:run');
    expect(res.stdout).toContain('GRID OK');

    const runDir = path.join(expRoot, 'runs', RUN_ID);
    const configSha = sha256Buf(fs.readFileSync(configPath));
    const config = readJson(configPath);

    // grid-manifest identity (TECH §7 digest set).
    const grid = readJson(path.join(runDir, 'grid-manifest.json'));
    expect(grid.runId).toBe(RUN_ID);
    expect(grid.ok).toBe(true);
    expect(grid.arms).toEqual([BASELINE_ARM, CANDIDATE_ARM]);
    expect(grid.roles).toEqual({ baseline: BASELINE_ARM, candidate: CANDIDATE_ARM });
    expect(grid.experimentId).toBe(EXPERIMENT_ID);
    expect(grid.configSha256).toBe(configSha);
    expect(grid.preregistrationStatus).toBe('VERIFIED');
    expect(grid.preregistrationSha256).toBe(config.preregistration.sha256);
    expect(grid.armsHeads[BASELINE_ARM]).toBe(env.armHeads[BASELINE_ARM]);
    expect(grid.armsHeads[CANDIDATE_ARM]).toBe(env.armHeads[CANDIDATE_ARM]);

    // run-manifest: per-arm heads + derived-config digests recorded.
    const manifestFiles = fs.readdirSync(runDir).filter((f) => f.startsWith('run-manifest.'));
    expect(manifestFiles).toHaveLength(1);
    const manifest = readJson(path.join(runDir, manifestFiles[0]));
    expect(manifest.experimentId).toBe(EXPERIMENT_ID);
    expect(manifest.configSha256).toBe(configSha);
    expect(manifest.roles).toEqual({ baseline: BASELINE_ARM, candidate: CANDIDATE_ARM });
    for (const arm of [BASELINE_ARM, CANDIDATE_ARM]) {
      expect(manifest.arms[arm].head).toBe(env.armHeads[arm]);
      expect(manifest.arms[arm].expectedHead).toBe(env.armHeads[arm]);
      expect(manifest.arms[arm].derivedConfigSha256).toMatch(/^[0-9a-f]{64}$/);
    }

    // Terminal statuses: the closed set through the REAL orchestration —
    // s1 both arms done; s2 base done-no-candidate (control); s2 cand failed
    // (injected first diagnose failure — recovered in the next test).
    const s1Base = readJson(recordPath('smoke-s1', BASELINE_ARM));
    const s1Cand = readJson(recordPath('smoke-s1', CANDIDATE_ARM));
    const s2Base = readJson(recordPath('smoke-s2', BASELINE_ARM));
    const s2Cand = readJson(recordPath('smoke-s2', CANDIDATE_ARM));
    expect(s1Base.status).toBe('done');
    expect(s1Cand.status).toBe('done');
    expect(s2Base.status).toBe('done-no-candidate');
    expect(s2Cand.status).toBe('failed');
    expect(s2Cand.errorCategory).toBe('diagnose_failed');
    expect(COMPLETED_TERMINAL_STATUSES).toContain(s1Base.status);
    expect(s1Base.verification.ok).toBe(true);
    expect(s2Base.verification.legitimateTerminal).toBe('no-candidate');
    // The failed unit carries NO verified-ok block (a refusal is not a
    // success — rc-9: the failure is named by status + errorCategory).
    expect(s2Cand.verification?.ok ?? false).toBe(false);

    // Ingress contract evidence recorded per sample.
    expect(s1Base.ingress.ingressMode).toBe('unbound');
    expect(s1Base.ingress.inputArgsSummary.host).toBeNull();
    expect(s1Base.ingress.inputArgsSummary.hasSession).toBe(false);
    expect(s2Cand.ingress.ingressMode).toBe('bound');
    expect(s2Cand.ingress.inputArgsSummary.host).toBe('openclaw');
    expect(s2Cand.ingress.inputArgsSummary.hasSession).toBe(true);
    for (const rec of [s1Base, s1Cand, s2Base, s2Cand]) {
      expect(rec.ingress.reasonTruncated).toBe(false);
      expect(rec.inputDigest).toMatch(/^[0-9a-f]{64}$/);
    }

    // fixture CLI actually invoked, with the EXACT contract argument vector.
    const log = readFixtureLog();
    const painLines = log.filter((l) => l.cmd === 'pain record');
    expect(painLines).toHaveLength(4); // one per sample × arm
    for (const line of painLines) {
      const marker = markerOfLogLine(line);
      expect(['smoke-s1', 'smoke-s2']).toContain(marker);
      const i = line.args.indexOf('--reason');
      expect(line.args[i + 1].length).toBeLessThanOrEqual(500);
      expect(line.args).toContain('--score');
      const hasSession = line.args.includes('--session');
      if (marker === 'smoke-s1') {
        expect(hasSession).toBe(false);
        expect(line.args).not.toContain('--host');
        expect(line.args[line.args.indexOf('--score') + 1]).toBe('4');
        expect(line.args[line.args.indexOf('--source') + 1]).toBe('manual');
      } else {
        expect(hasSession).toBe(true);
        expect(line.args[line.args.indexOf('--session') + 1]).toBe('sess-smoke-0002');
        expect(line.args[line.args.indexOf('--host') + 1]).toBe('openclaw');
        expect(line.args[line.args.indexOf('--score') + 1]).toBe('3');
      }
    }

    // Global sample index decides the arm order (CF-12): the FIRST pain
    // record per sample follows expectedArmOrder(runId, globalIndex).
    const firstArmByMarker = {};
    for (const line of painLines) {
      const marker = markerOfLogLine(line);
      if (!(marker in firstArmByMarker)) firstArmByMarker[marker] = armOfLogLine(line);
    }
    expect(firstArmByMarker['smoke-s1']).toBe(expectedArmOrder(RUN_ID, 0)[0]);
    expect(firstArmByMarker['smoke-s2']).toBe(expectedArmOrder(RUN_ID, 1)[0]);

    // Data integrity: pain_events in the arm workspace carries the bound
    // attribution for s2 (score from painEvent.score, host by host_kind).
    const trajDb = new Database(path.join(expRoot, 'workspaces', `${CANDIDATE_ARM}-s0`, '.state', 'trajectory.db'), { readonly: true });
    try {
      const row = trajDb.prepare('SELECT session_id, source, score, reason, host_kind FROM pain_events WHERE reason LIKE \'%smoke-s2%\'').get();
      expect(row.session_id).toBe('sess-smoke-0002');
      expect(row.host_kind).toBe('openclaw');
      expect(row.score).toBe(3);
    } finally { trajDb.close(); }

    // Attempt history after the injected failure: exactly ONE failed attempt
    // for the s2 candidate unit (no succeeded diagnose run yet).
    const stateDb = new Database(path.join(expRoot, 'workspaces', `${CANDIDATE_ARM}-s0`, '.pd', 'state.db'), { readonly: true });
    try {
      const taskId = s2Cand.newTaskId;
      const runs = stateDb.prepare('SELECT execution_status, attempt_number FROM runs WHERE task_id = ? ORDER BY attempt_number').all(taskId);
      expect(runs).toEqual([{ execution_status: 'failed', attempt_number: 1 }]);
    } finally { stateDb.close(); }
  }, 600_000);

  it('recovery: completed units are not re-executed; the failed unit resumes with attempt history retained', () => {
    const runDir = path.join(expRoot, 'runs', RUN_ID);
    const completedBefore = {
      'smoke-s1.base': fs.readFileSync(recordPath('smoke-s1', BASELINE_ARM)),
      'smoke-s1.cand': fs.readFileSync(recordPath('smoke-s1', CANDIDATE_ARM)),
      'smoke-s2.base': fs.readFileSync(recordPath('smoke-s2', BASELINE_ARM)),
    };
    const logBefore = readFixtureLog();
    const priorFailed = readJson(recordPath('smoke-s2', CANDIDATE_ARM));

    fs.rmSync(path.join(expRoot, 'workspaces', 't5-fixture-control.json'));
    const res = expectOk(runEntry('experiment/prompt-v2/scripts/ab/ab-grid.mjs',
      ['--config', configPath, '--run-id', RUN_ID, '--parallel', '1']), 'lab:run (recovery)');
    expect(res.stdout).toContain('GRID OK');

    // Completed units: byte-identical records, zero fixture calls.
    for (const [name, before] of Object.entries(completedBefore)) {
      const [sampleId, arm] = name.split('.');
      expect(fs.readFileSync(recordPath(sampleId, arm))).toEqual(before);
    }
    const logAfter = readFixtureLog();
    const delta = logAfter.slice(logBefore.length);
    expect(delta.some((l) => l.cmd === 'pain record')).toBe(false);

    // The failed unit resumed its ORIGINAL task (no unbound re-record).
    const resumed = readJson(recordPath('smoke-s2', CANDIDATE_ARM));
    expect(resumed.status).toBe('done');
    expect(resumed.verification.ok).toBe(true);
    expect(resumed.resumedFromTaskId).toBe(priorFailed.newTaskId);
    expect(resumed.newTaskId).toBe(priorFailed.newTaskId);

    // Fixture call delta: exactly one diagnose re-attempt + the formation
    // loop's three run-once calls for the resumed unit — nothing else.
    const resumedTaskDiagnose = delta.filter((l) => l.cmd === 'diagnose run'
      && l.args.includes('--task-id') && l.args[l.args.indexOf('--task-id') + 1] === resumed.newTaskId);
    expect(resumedTaskDiagnose).toHaveLength(1);
    expect(delta.filter((l) => l.cmd === 'runtime internalization' && armOfLogLine(l) === CANDIDATE_ARM)).toHaveLength(3);
    expect(delta.filter((l) => l.cmd === 'diagnose run' && armOfLogLine(l) === BASELINE_ARM)).toHaveLength(0);

    // Attempt history retained (HT-04): failed attempt 1 + succeeded
    // attempt 2 for the resumed task; tasks.attempt_count = 2.
    const stateDb = new Database(path.join(expRoot, 'workspaces', `${CANDIDATE_ARM}-s0`, '.pd', 'state.db'), { readonly: true });
    try {
      const runs = stateDb.prepare('SELECT execution_status, attempt_number, error_category FROM runs WHERE task_id = ? ORDER BY attempt_number').all(resumed.newTaskId);
      expect(runs).toEqual([
        { execution_status: 'failed', attempt_number: 1, error_category: 'synthetic_injected' },
        { execution_status: 'succeeded', attempt_number: 2, error_category: null },
      ]);
      const task = stateDb.prepare('SELECT status, attempt_count FROM tasks WHERE task_id = ?').get(resumed.newTaskId);
      expect(task.status).toBe('succeeded');
      // attempt_count counts every mutation bump (creation + both diagnose
      // attempts); the AUTHORITATIVE attempt history is the runs table above.
      expect(task.attempt_count).toBeGreaterThanOrEqual(2);
    } finally { stateDb.close(); }

    // The re-run's grid manifest reports a fully successful grid.
    const grid = readJson(path.join(runDir, 'grid-manifest.json'));
    expect(grid.ok).toBe(true);
  }, 600_000);

  it('lab:metrics produces layer-1 metrics for the real run', () => {
    const res = expectOk(runEntry('experiment/prompt-v2/scripts/ab/ab-metrics.mjs',
      ['--config', configPath, '--run-id', RUN_ID]), 'lab:metrics');
    expect(res.stdout).toContain('layer1-metrics.json');
    const metrics = readJson(path.join(expRoot, 'runs', RUN_ID, 'layer1-metrics.json'));
    expect(metrics.arms).toEqual({ baseline: BASELINE_ARM, candidate: CANDIDATE_ARM });
    for (const arm of [BASELINE_ARM, CANDIDATE_ARM]) {
      expect(metrics.full[arm].samples).toBe(2);
      expect(metrics.full[arm].pipelineCompletionRate).toEqual({ numerator: 2, denominator: 2, value: 1 });
      expect(metrics.full[arm].invalidFileCount).toBe(0);
    }
    expect(metrics.pairs.fullChain.recordPairs).toBe(2);
  }, 180_000);

  it('lab:blindpack builds blinded packages from the real records', () => {
    const res = expectOk(runEntry('experiment/prompt-v2/scripts/ab/ab-blindpack.mjs',
      ['--config', configPath, '--run-id', RUN_ID]), 'lab:blindpack');
    expect(res.stdout).toMatch(/packages=\d+/);
    const packDir = path.join(expRoot, 'runs', RUN_ID, 'blindpack');
    const pack = readJson(path.join(packDir, 'packages.json'));
    const blindMap = readJson(path.join(packDir, 'blindmap.json'));
    expect(pack.runId).toBe(RUN_ID);
    expect(pack.count).toBe(pack.packages.length);
    expect(Object.keys(blindMap.map)).toHaveLength(pack.packages.length);
    // The three diagnosis stages pair both samples in both arms; the no-
    // candidate control removes only the formation stages of s2's baseline.
    const byStagePair = {};
    for (const p of pack.packages) byStagePair[`${p.stage}/${p.source}/${p.sid}`] = true;
    for (const stage of ['rootcause', 'distiller', 'router']) {
      expect(byStagePair[`${stage}/full-chain/smoke-s1`]).toBe(true);
      expect(byStagePair[`${stage}/full-chain/smoke-s2`]).toBe(true);
    }
    expect(byStagePair['dreamer/full-chain/smoke-s1']).toBe(true);
    expect(byStagePair['dreamer/full-chain/smoke-s2']).toBeUndefined();
  }, 180_000);

  it('synthetic Judge Protocol judgments complete the offline chain: lab:summary + lab:card', () => {
    const runDir = path.join(expRoot, 'runs', RUN_ID);
    const blindMap = readJson(path.join(runDir, 'blindpack', 'blindmap.json')).map;
    const pack = readJson(path.join(runDir, 'blindpack', 'packages.json'));

    // Judge the router-stage packages: smoke-s1 → candidate better,
    // smoke-s2 → reference better (both traceable below in the card).
    const routerPackages = pack.packages.filter((p) => p.stage === 'router' && p.source === 'full-chain');
    expect(routerPackages).toHaveLength(2);
    const evalsDir = path.join(runDir, 'evals');
    fs.mkdirSync(evalsDir, { recursive: true });
    const judgments = [];
    const decisionBlindMap = {};
    for (const pkg of routerPackages) {
      const bm = blindMap[pkg.evalId];
      const candidateIsA = bm.armA === CANDIDATE_ARM;
      // smoke-s1 → CANDIDATE_BETTER, smoke-s2 → REFERENCE_BETTER.
      const candidateWins = pkg.sid === 'smoke-s1';
      const displayVerdict = candidateWins
        ? (candidateIsA ? 'A_BETTER' : 'B_BETTER')
        : (candidateIsA ? 'B_BETTER' : 'A_BETTER');
      writeJson(path.join(evalsDir, `${pkg.evalId}.json`), {
        evalId: pkg.evalId, stage: pkg.stage, source: pkg.source, sid: pkg.sid,
        verdict: {
          A: { weightedTotal: (displayVerdict === 'A_BETTER' ? 4.5 : 3.5), veto: false },
          B: { weightedTotal: (displayVerdict === 'B_BETTER' ? 4.5 : 3.5), veto: false },
          pairwise: { preferred: displayVerdict === 'A_BETTER' ? 'A' : 'B', confidence: 0.8, reason: 'synthetic judge protocol record (T5 smoke)' },
        },
      });
      judgments.push({
        judgmentId: `j-${pkg.evalId}`,
        assignmentKey: `cfg-candidate+${pkg.sid}@v1+opp-1+rep-1+ref-1`,
        judgeProtocolRef: 'jp-t5@1',
        comparisonInputDigest: `sha256:${sha256Text(pkg.outputA + '\n' + pkg.outputB)}`,
        displayVerdict,
        attempt: 1,
        judgeSlotId: `slot-${pkg.sid}`,
      });
      decisionBlindMap[`j-${pkg.evalId}`] = candidateIsA
        ? { A: 'candidate', B: 'reference' }
        : { A: 'reference', B: 'candidate' };
    }
    const judgmentsPath = path.join(env.envRoot, 'judgments.json');
    writeJson(judgmentsPath, judgments);
    const decisionBlindMapPath = path.join(env.envRoot, 'decision-blindmap.json');
    writeJson(decisionBlindMapPath, { map: decisionBlindMap });

    // lab:summary over the synthetic judgments.
    expectOk(runEntry('experiment/prompt-v2/scripts/ab/ab-blind-summary.mjs',
      ['--config', configPath, '--run-id', RUN_ID]), 'lab:summary');
    const summaryDoc = readJson(path.join(runDir, 'blind-summary.json'));
    expect(summaryDoc.summary.packages).toBe(2);
    expect(summaryDoc.summary.roles).toEqual({ [BASELINE_ARM]: 'baseline', [CANDIDATE_ARM]: 'candidate' });
    expect(summaryDoc.summary.pairwise.decided).toBe(2);
    expect(summaryDoc.summary.pairwise.tie).toBe(0);
    expect(summaryDoc.summary.pairwise[`${CANDIDATE_ARM}Preferred`]).toBe(1);
    expect(summaryDoc.summary.pairwise[`${BASELINE_ARM}Preferred`]).toBe(1);

    // lab:card (build-decision-input) → decision-input.json.
    const sourceGroups = readJson(path.join(env.envRoot, 'source-groups.json'));
    const outDir = path.join(env.envRoot, 'decision');
    const cardRes = expectOk(runEntry('scripts/dev/pd-lab/build-decision-input.mjs', [
      '--plan', path.join(env.envRoot, 'plan.json'),
      '--judgments', judgmentsPath,
      '--blindmap', decisionBlindMapPath,
      '--source-groups', path.join(env.envRoot, 'source-groups.json'),
      '--out-dir', outDir,
    ]), 'lab:card');
    expect(cardRes.stdout).toContain('status=ESTIMABLE');

    const decision = readJson(path.join(outDir, 'decision-input.json'));
    expect(decision.status).toBe('ESTIMABLE');
    expect(decision.counts.planned).toBe(2);
    expect(decision.counts.resolved).toBe(2);
    expect(decision.counts.unknown).toBe(0);
    // Traceable: one candidate win + one reference win → 50.
    expect(decision.pointEstimate).toBe(50);
    expect(decision.missingBounds).toEqual({ lower: 50, upper: 50 });
    // plannedGroups equals the synthetic source-group count (HANDOFF T5).
    expect(decision.decision.plannedGroups).toBe(Object.keys(sourceGroups.groups).length);
    expect(decision.decision.plannedGroups).toBe(2);
    expect(decision.decision.definiteWins).toBe(1);
    expect(decision.decision.definiteLosses).toBe(1);
    expect(decision.decision.outcome).toBe('INCONCLUSIVE'); // n=2 < 6: no rejection possible at α=0.05
    expect(decision.decision.unknownsCouldChangeVerdict).toBe(false);

    const comparisons = readJson(path.join(outDir, 'final-comparisons.json'));
    expect(comparisons).toHaveLength(2);
    const verdictByCase = Object.fromEntries(comparisons.map((fc) => [fc.assignmentKey.split('+')[1].split('@')[0], fc.verdict]));
    expect(verdictByCase['smoke-s1']).toBe('CANDIDATE_BETTER');
    expect(verdictByCase['smoke-s2']).toBe('REFERENCE_BETTER');
  }, 180_000);

  it('CF-16: lab:run re-preflights from the CURRENT files and refuses before ANY side effect', () => {
    const freshRunId = 'smoke-run-cf16';
    const logBefore = fixtureLogBytes();
    const runsRoot = path.join(expRoot, 'runs');
    const runsBefore = fs.readdirSync(runsRoot).sort();

    // Variant A — preregistration tampered after lab:preflight, config SHA
    // unchanged: the second preflight (inside lab:run) must refuse.
    const preregBefore = fs.readFileSync(preregPath);
    fs.appendFileSync(preregPath, '\n<!-- tampered after preflight (CF-16) -->\n');
    const resA = runEntry('experiment/prompt-v2/scripts/ab/ab-grid.mjs',
      ['--config', configPath, '--run-id', freshRunId, '--parallel', '1']);
    expect(resA.status).not.toBe(0);
    expect(resA.stderr).toContain('digest_mismatch');
    expect(resA.stderr).toContain('preregistration');
    fs.writeFileSync(preregPath, preregBefore);

    // Variant B — the config itself made invalid: refusal at load, before
    // anything else.
    const configBefore = fs.readFileSync(configPath);
    fs.writeFileSync(configPath, '{ this is not json');
    const resB = runEntry('experiment/prompt-v2/scripts/ab/ab-grid.mjs',
      ['--config', configPath, '--run-id', freshRunId, '--parallel', '1']);
    expect(resB.status).not.toBe(0);
    expect(resB.stderr).toContain('not valid JSON');
    fs.writeFileSync(configPath, configBefore);

    // Zero side effects: no run directory, no grid manifest, and the fixture
    // CLI was never invoked (byte-identical log).
    expect(fs.existsSync(path.join(runsRoot, freshRunId))).toBe(false);
    expect(fs.readdirSync(runsRoot).sort()).toEqual(runsBefore);
    expect(fixtureLogBytes()).toEqual(logBefore);

    // The refusal was purely file-state-driven: restored bytes pass again.
    expectOk(runEntry('experiment/prompt-v2/scripts/ab/ab-preflight.mjs', ['--config', configPath]), 'lab:preflight after CF-16 restore');
  }, 300_000);

  it('CF-04: a wrong expectedHead fails preflight without creating tasks', () => {
    const configBefore = fs.readFileSync(configPath);
    const config = readJson(configPath);
    config.arms[CANDIDATE_ARM].expectedHead = 'b'.repeat(40);
    writeJson(configPath, config);
    const res = runEntry('experiment/prompt-v2/scripts/ab/ab-preflight.mjs', ['--config', configPath]);
    expect(res.status).toBe(1);
    const report = JSON.parse(res.stdout);
    expect(report.ok).toBe(false);
    const headCheck = report.checks.find((c) => c.name === `arm-head-matches-expected:${CANDIDATE_ARM}`);
    expect(headCheck.ok).toBe(false);
    // Refusal stage: the run scene is untouched (no new run directory).
    const runsRoot = path.join(expRoot, 'runs');
    expect(fs.readdirSync(runsRoot).sort()).toEqual(['smoke-run-1']);
    fs.writeFileSync(configPath, configBefore);
  }, 180_000);

  it('CF-11: blob manifest digest mismatch AND corrupted blob content each fail closed', () => {
    const manifestPath = path.join(snapDir, 'blob-manifest.json');
    const manifestBefore = fs.readFileSync(manifestPath);
    const blobPath = path.join(snapDir, 'blobs', 'blob-smoke-1');
    const blobBefore = fs.readFileSync(blobPath);

    // Variant A — manifest bytes change without updating the pinned digest.
    fs.appendFileSync(manifestPath, ' ');
    const resA = runEntry('experiment/prompt-v2/scripts/ab/ab-preflight.mjs', ['--config', configPath]);
    expect(resA.status).toBe(1);
    expect(resA.stderr).toContain('snapshot.sha256.blobManifest');
    expect(resA.stderr).toContain('digest_mismatch');
    fs.writeFileSync(manifestPath, manifestBefore);

    // Variant B — manifest digest matches but a referenced blob's content
    // does not match the manifest entry.
    fs.writeFileSync(blobPath, 'corrupted blob content (CF-11)');
    const resB = runEntry('experiment/prompt-v2/scripts/ab/ab-preflight.mjs', ['--config', configPath]);
    expect(resB.status).toBe(1);
    expect(resB.stderr).toContain('snapshot.blobManifest.files[0]');
    expect(resB.stderr).toContain('digest_mismatch');
    fs.writeFileSync(blobPath, blobBefore);

    // Restored snapshot passes again (refusal was content-driven).
    expectOk(runEntry('experiment/prompt-v2/scripts/ab/ab-preflight.mjs', ['--config', configPath]), 'lab:preflight after CF-11 restore');
  }, 300_000);

  it('CF-14/CF-15: preregistration digest mismatch, missing file, and experimentId mismatch each fail closed', () => {
    const configBefore = fs.readFileSync(configPath);
    const preregBefore = fs.readFileSync(preregPath);

    // CF-14a — declared digest does not match the file's raw bytes.
    const config = readJson(configPath);
    config.preregistration.sha256 = 'f'.repeat(64);
    writeJson(configPath, config);
    const resA = runEntry('experiment/prompt-v2/scripts/ab/ab-preflight.mjs', ['--config', configPath]);
    expect(resA.status).toBe(1);
    expect(resA.stderr).toContain('[preregistration]');
    expect(resA.stderr).toContain('digest_mismatch');
    fs.writeFileSync(configPath, configBefore);

    // CF-14b — the preregistration file is missing entirely.
    const preregMoved = `${preregPath}.moved`;
    fs.renameSync(preregPath, preregMoved);
    const resB = runEntry('experiment/prompt-v2/scripts/ab/ab-preflight.mjs', ['--config', configPath]);
    expect(resB.status).toBe(1);
    expect(resB.stderr).toContain('file_missing');
    fs.renameSync(preregMoved, preregPath);

    // CF-15 — front-matter experimentId differs from the config (digest
    // recomputed so ONLY the binding check can fail).
    const config2 = readJson(configPath);
    fs.writeFileSync(preregPath, preregBefore.toString('utf8').replace(`experimentId: ${EXPERIMENT_ID}`, 'experimentId: pri1256-t5-wrong'));
    config2.preregistration.sha256 = sha256Buf(fs.readFileSync(preregPath));
    writeJson(configPath, config2);
    const resC = runEntry('experiment/prompt-v2/scripts/ab/ab-preflight.mjs', ['--config', configPath]);
    expect(resC.status).toBe(1);
    expect(resC.stderr).toContain('experiment_id_mismatch');

    fs.writeFileSync(preregPath, preregBefore);
    fs.writeFileSync(configPath, configBefore);
    expectOk(runEntry('experiment/prompt-v2/scripts/ab/ab-preflight.mjs', ['--config', configPath]), 'lab:preflight after CF-14/15 restore');
  }, 300_000);

  it('a current config cannot forge the identity of an existing run (manifest identity gate)', () => {
    const gridPath = path.join(expRoot, 'runs', RUN_ID, 'grid-manifest.json');
    const gridBefore = fs.readFileSync(gridPath);
    const grid = readJson(gridPath);
    grid.configSha256 = '0'.repeat(64);
    writeJson(gridPath, grid);
    const res = runEntry('experiment/prompt-v2/scripts/ab/ab-metrics.mjs', ['--config', configPath, '--run-id', RUN_ID]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('configSha256');
    fs.writeFileSync(gridPath, gridBefore);
    expectOk(runEntry('experiment/prompt-v2/scripts/ab/ab-metrics.mjs', ['--config', configPath, '--run-id', RUN_ID]), 'lab:metrics after identity restore');
  }, 180_000);
});
