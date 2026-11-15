/**
 * PD-SPEC-001 Phase 6 — layer-1 metrics contract tests.
 *
 * Fixtures: temporary directory with synthetic CANARY run records
 * (2 samples × 2 arms × rep0/rep1 + a v1-only sample + invalid files) and
 * minimal per-arm state.db files (only the column set the metrics code
 * reads), built with better-sqlite3. All inserts are parameterized; no real
 * pain text anywhere.
 *
 * Verified remediation contract (Owner directive 2026-11-15):
 *  - record filenames parse with ^([^.]+)\.(v1|v2)(?:\.rep(\d+))?\.json$ —
 *    repeat rounds are no longer dropped by an endsWith('.<arm>.json') filter;
 *  - pairs are counted on the real Pair primary key (experimentPainId, stage,
 *    rep, arm); a missing side is reported in `missing`, never inferred as
 *    files.length / 2;
 *  - repeat runs aggregate per sample (one primary record + rep variance),
 *    never as independent samples;
 *  - invalid/unreadable records are collected observably instead of crashing.
 *
 * Run: cd experiment/prompt-v2/scripts && npx vitest run __tests__/pdspec001-ab-metrics.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  aggregateBySample,
  buildFullChainPairing,
  buildPerAgentPairing,
  collectArm,
  collectPerAgentArm,
  computeMetrics,
  layer1,
  parsePerAgentFileName,
  parseRecordFileName,
} from '../ab/ab-metrics.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// ---------------------------------------------------------------------------
// Fixture builders (CANARY data only)
// ---------------------------------------------------------------------------

const RUN_ID = 'run-canary';
let tmpRoot: string | null = null;

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdspec001-metrics-'));
  for (const arm of ['v1', 'v2']) {
    fs.mkdirSync(path.join(root, 'workspaces', arm, '.pd'), { recursive: true });
  }
  fs.mkdirSync(path.join(root, 'runs', RUN_ID, 'records'), { recursive: true });
  fs.mkdirSync(path.join(root, 'runs', RUN_ID, 'records-pa'), { recursive: true });
  return root;
}

function recordsDir(root: string): string {
  return path.join(root, 'runs', RUN_ID, 'records');
}

function paDir(root: string): string {
  return path.join(root, 'runs', RUN_ID, 'records-pa');
}

interface StageSpec { status: string; attempts: number }

interface RecordSpec {
  sid: string; arm: string; rep: number;
  rc: StageSpec; dist: StageSpec; router: StageSpec;
  candCount: number;
  stageArts?: string[];       // stage segments present in the RECORD's artifacts
  extraRuns?: Array<{ task: string; exec: string; attempt: number }>;
}

const OK: StageSpec = { status: 'succeeded', attempts: 1 };
const FAIL: StageSpec = { status: 'failed', attempts: 2 };
const ALL_DIAG = ['rootcause', 'distiller', 'router'];

function taskIdOf(spec: RecordSpec): string {
  return `task-${spec.sid}-${spec.arm}-r${spec.rep}`;
}

function diagId(spec: RecordSpec, stage: string): string {
  return `diag_${stage}-${taskIdOf(spec)}`;
}

function fakeRecord(spec: RecordSpec): string {
  const taskId = taskIdOf(spec);
  const stageArts = spec.stageArts ?? ALL_DIAG;
  return JSON.stringify({
    experimentPainId: spec.sid,
    arm: spec.arm,
    rep: spec.rep,
    status: 'incomplete',
    ingressMode: 'bound',
    newTaskId: taskId,
    artifacts: {
      runs: [],
      stageArtifacts: stageArts.filter((s) => s !== 'dreamer').map((stage, i) => ({
        artifact_id: `pi-art-${diagId(spec, stage)}-${i}`,
        artifact_kind: 'principle',
        source_task_id: diagId(spec, stage),
        content_json: JSON.stringify({ CANARY_MARKER: `${spec.sid}-${spec.arm}-r${spec.rep}-${stage}` }),
        created_at: '2026-11-15T00:00:00Z',
      })),
      formationArtifacts: stageArts.includes('dreamer')
        ? [{
            artifact_id: `pi-art-dreamer-${taskIdOf(spec)}`,
            artifact_kind: 'principle',
            source_task_id: `dreamer-${taskIdOf(spec)}-prompt`,
            content_json: JSON.stringify({ candidates: [{ CANARY: 'a' }, { CANARY: 'b' }] }),
            created_at: '2026-11-15T00:00:00Z',
          }]
        : [],
      candidates: [],
    },
  });
}

/** Minimal schema: exactly the columns the metrics code reads (parameterized inserts). */
function seedArmDb(dbPath: string, specs: Array<RecordSpec>): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE tasks (task_id TEXT PRIMARY KEY, task_kind TEXT, status TEXT, attempt_count INTEGER, last_error TEXT);
    CREATE TABLE runs (run_id TEXT PRIMARY KEY, task_id TEXT, execution_status TEXT, attempt_number INTEGER, error_category TEXT, started_at TEXT, ended_at TEXT, output_payload TEXT);
    CREATE TABLE principle_candidates (candidate_id TEXT PRIMARY KEY, task_id TEXT);
    CREATE TABLE pi_artifacts (artifact_id TEXT PRIMARY KEY, source_task_id TEXT, lineage_artifact_ids TEXT);
  `);
  const insTask = db.prepare('INSERT INTO tasks (task_id, task_kind, status, attempt_count, last_error) VALUES (?, ?, ?, ?, ?)');
  const insRun = db.prepare('INSERT INTO runs (run_id, task_id, execution_status, attempt_number, error_category, started_at, ended_at, output_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insCand = db.prepare('INSERT INTO principle_candidates (candidate_id, task_id) VALUES (?, ?)');
  const insArt = db.prepare('INSERT INTO pi_artifacts (artifact_id, source_task_id, lineage_artifact_ids) VALUES (?, ?, ?)');
  for (const spec of specs) {
    const taskId = taskIdOf(spec);
    const stages: Record<string, StageSpec> = { rootcause: spec.rc, distiller: spec.dist, router: spec.router };
    for (const [stage, st] of Object.entries(stages)) {
      insTask.run(diagId(spec, stage), null, st.status, st.attempts, st.status === 'succeeded' ? null : 'CANARY-ERROR');
      insRun.run(
        `run_${stage}-${taskId}`,
        diagId(spec, stage),
        st.status === 'succeeded' ? 'succeeded' : 'failed',
        st.attempts,
        st.status === 'succeeded' ? null : 'validation',
        '2026-11-15T00:00:00.000Z',
        '2026-11-15T00:05:00.000Z',   // exactly 300 s per run
        'CANARY-OUTPUT-PAYLOAD',
      );
      insArt.run(`pi-art-diag_${stage}-${taskId}`, diagId(spec, stage), null);
    }
    insTask.run(taskId, null, 'succeeded', 1, null);
    insRun.run(`run_main-${taskId}`, taskId, 'succeeded', 1, null, '2026-11-15T00:00:00.000Z', '2026-11-15T00:05:00.000Z', 'CANARY');
    for (let i = 0; i < spec.candCount; i += 1) insCand.run(`cand-${taskId}-${i}`, diagId(spec, 'router'));
    for (const extra of spec.extraRuns ?? []) {
      insRun.run(`run_${extra.task}-${taskId}-${extra.attempt}`, extra.task === 'main' ? taskId : diagId(spec, extra.task), extra.exec, extra.attempt, extra.exec === 'failed' ? 'validation' : null, '2026-11-15T00:00:00.000Z', '2026-11-15T00:05:00.000Z', 'CANARY');
    }
  }
  // workspace-level formation tasks (counted once per arm by readFormationTasks)
  insTask.run('task-formation-dreamer-canary', 'dreamer', 'succeeded', 1, null);
  insTask.run('task-formation-philosopher-canary', 'philosopher', 'succeeded', 1, null);
  insTask.run('task-formation-scribe-canary', 'scribe', 'missing', 0, null); // excluded by status != 'missing'
  db.close();
}

/**
 * Scenario:
 *  - S1 rep0: all diag stages succeeded (3 router candidates), artifacts for
 *    all diag stages + dreamer — on BOTH arms;
 *  - S1 rep1: router FAILED (repeat round), v1 record carries only a
 *    rootcause artifact, v2 record carries none;
 *  - S2 rep0: all succeeded on both arms (1 candidate);
 *  - S5 rep0: v1-only sample (v2 record missing entirely) → record-missing;
 *  - S3 rep0: v1 file is corrupt JSON (invalid);
 *  - S4 rep0: v1 record without newTaskId (invalid);
 *  - a run-manifest file that must NOT match the record grammar.
 *
 * v1 valid records: S1r0, S1r1, S2, S5 → 3 samples (S1, S2, S5), 4 records.
 * v2 valid records: S1r0, S1r1, S2 → 2 samples, 3 records.
 */
const V1_SPECS: Array<RecordSpec> = [
  { sid: 'S1', arm: 'v1', rep: 0, rc: OK, dist: OK, router: OK, candCount: 3, stageArts: [...ALL_DIAG, 'dreamer'] },
  { sid: 'S1', arm: 'v1', rep: 1, rc: OK, dist: OK, router: FAIL, candCount: 0, stageArts: ['rootcause'] },
  { sid: 'S2', arm: 'v1', rep: 0, rc: OK, dist: OK, router: OK, candCount: 1 },
  { sid: 'S5', arm: 'v1', rep: 0, rc: OK, dist: OK, router: OK, candCount: 2 },
];
const V2_SPECS: Array<RecordSpec> = [
  { sid: 'S1', arm: 'v2', rep: 0, rc: OK, dist: OK, router: OK, candCount: 2 },
  { sid: 'S1', arm: 'v2', rep: 1, rc: OK, dist: OK, router: OK, candCount: 1, stageArts: [] },
  { sid: 'S2', arm: 'v2', rep: 0, rc: OK, dist: OK, router: OK, candCount: 1 },
];

function seedScenario(root: string): void {
  seedArmDb(path.join(root, 'workspaces', 'v1', '.pd', 'state.db'), V1_SPECS);
  seedArmDb(path.join(root, 'workspaces', 'v2', '.pd', 'state.db'), V2_SPECS);
  for (const spec of [...V1_SPECS, ...V2_SPECS]) {
    const suffix = spec.rep === 0 ? '' : `.rep${spec.rep}`;
    fs.writeFileSync(path.join(recordsDir(root), `${spec.sid}.${spec.arm}${suffix}.json`), fakeRecord(spec));
  }
  fs.writeFileSync(path.join(recordsDir(root), 'S3.v1.json'), '{ this is not json');
  fs.writeFileSync(path.join(recordsDir(root), 'S4.v1.json'), JSON.stringify({ experimentPainId: 'S4', status: 'incomplete' }));
  fs.writeFileSync(path.join(recordsDir(root), 'run-manifest.deadbeef.json'), '{"not":"a record"}');

  // per-agent: one real pair + one v1-only stage record
  const paSpecV1: RecordSpec = { sid: 'S1', arm: 'v1', rep: 0, rc: OK, dist: OK, router: OK, candCount: 0 };
  const paSpecV2: RecordSpec = { sid: 'S1', arm: 'v2', rep: 0, rc: OK, dist: OK, router: OK, candCount: 0 };
  fs.writeFileSync(path.join(paDir(root), 'S1.distiller.v1.json'), JSON.stringify({ result: { artifacts: [{ artifact_id: 'pa-1', source_task_id: diagId(paSpecV1, 'distiller'), content_json: '{"CANARY":"pa-v1"}' }] } }));
  fs.writeFileSync(path.join(paDir(root), 'S1.distiller.v2.json'), JSON.stringify({ result: { artifacts: [{ artifact_id: 'pa-2', source_task_id: diagId(paSpecV2, 'distiller'), content_json: '{"CANARY":"pa-v2"}' }] } }));
  fs.writeFileSync(path.join(paDir(root), 'S2.router.v1.json'), JSON.stringify({ result: { artifacts: [{ artifact_id: 'pa-3', source_task_id: diagId({ sid: 'S2', arm: 'v1', rep: 0, rc: OK, dist: OK, router: OK, candCount: 0 }, 'router'), content_json: '{"CANARY":"pa-v1-router"}' }] } }));
}

afterEach(() => {
  if (tmpRoot) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  }
});

// ---------------------------------------------------------------------------
// Filename grammar
// ---------------------------------------------------------------------------

describe('record filename parsing', () => {
  it('parses sampleId/arm/rep including repeat rounds (repN)', () => {
    expect(parseRecordFileName('S01.v1.json')).toEqual({ sid: 'S01', arm: 'v1', rep: 0 });
    expect(parseRecordFileName('S02.v2.rep1.json')).toEqual({ sid: 'S02', arm: 'v2', rep: 1 });
    expect(parseRecordFileName('S12.v1.rep2.json')).toEqual({ sid: 'S12', arm: 'v1', rep: 2 });
  });

  it('rejects files that are not A/B records (manifests, unknown arms, per-agent files)', () => {
    expect(parseRecordFileName('run-manifest.1db0368a.json')).toBeNull();
    expect(parseRecordFileName('S01.v3.json')).toBeNull();
    expect(parseRecordFileName('S01.distiller.v1.json')).toBeNull();
  });

  it('parses per-agent stage records with optional rep', () => {
    expect(parsePerAgentFileName('S1.distiller.v1.json')).toEqual({ sid: 'S1', stage: 'distiller', arm: 'v1', rep: 0 });
    expect(parsePerAgentFileName('S1.distiller.v2.rep1.json')).toEqual({ sid: 'S1', stage: 'distiller', arm: 'v2', rep: 1 });
    expect(parsePerAgentFileName('S1.rootcause.v1.json')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// collectArm: rep-aware files, DB reads, invalid records observable
// ---------------------------------------------------------------------------

describe('collectArm', () => {
  it('matches repeat files, counts invalid files observably, ignores run-manifests', () => {
    tmpRoot = makeRoot();
    seedScenario(tmpRoot);
    const v1 = collectArm('v1', recordsDir(tmpRoot), { experimentRoot: tmpRoot });
    // S1, S1.rep1, S2, S5, S3 (corrupt), S4 (no-task-id) — run-manifest NOT matched
    expect(v1.filesMatched).toBe(6);
    expect(v1.entries).toHaveLength(4);
    expect(v1.entries.map((e) => `${e.experimentPainId}|r${e.rep}`).sort()).toEqual(['S1|r0', 'S1|r1', 'S2|r0', 'S5|r0']);
    expect(v1.invalidFiles).toHaveLength(2);
    const reasons = v1.invalidFiles.map((i) => `${i.file}: ${i.reason}`).sort();
    expect(reasons[0]).toContain('S3.v1.json');
    expect(reasons[0]).toContain('record-unreadable');
    expect(reasons[1]).toContain('S4.v1.json');
    expect(reasons[1]).toContain('no-task-id');

    const v2 = collectArm('v2', recordsDir(tmpRoot), { experimentRoot: tmpRoot });
    expect(v2.filesMatched).toBe(3);
    expect(v2.entries).toHaveLength(3);
    expect(v2.invalidFiles).toHaveLength(0);
  });

  it('reads stage status, runs, candidate counts and artifacts from the arm state.db', () => {
    tmpRoot = makeRoot();
    seedScenario(tmpRoot);
    const v1 = collectArm('v1', recordsDir(tmpRoot), { experimentRoot: tmpRoot });
    const s1r0 = v1.entries.find((e) => e.experimentPainId === 'S1' && e.rep === 0)!;
    expect(s1r0.stages.router).toMatchObject({ status: 'succeeded', attempt_count: 1 });
    expect(s1r0.candidates).toBe(3);
    expect(s1r0.stageArtifacts.length).toBeGreaterThanOrEqual(3);
    expect(s1r0.runs.length).toBeGreaterThanOrEqual(4);
    expect(s1r0.stagePresence).toEqual({ rootcause: true, distiller: true, router: true, dreamer: true, philosopher: false, scribe: false });
    const s1r1 = v1.entries.find((e) => e.experimentPainId === 'S1' && e.rep === 1)!;
    expect(s1r1.stages.router).toMatchObject({ status: 'failed', attempt_count: 2 });
  });

  it('reports a missing workspace db per file instead of crashing', () => {
    tmpRoot = makeRoot();
    fs.writeFileSync(path.join(recordsDir(tmpRoot), 'S1.v1.json'), fakeRecord(V1_SPECS[0]));
    const v1 = collectArm('v1', recordsDir(tmpRoot), { experimentRoot: tmpRoot });
    expect(v1.entries).toHaveLength(0);
    expect(v1.invalidFiles).toHaveLength(1);
    expect(v1.invalidFiles[0].reason).toContain('workspace-db-missing');
  });
});

// ---------------------------------------------------------------------------
// Rep aggregation: one row per sample, reps as variance
// ---------------------------------------------------------------------------

describe('aggregateBySample', () => {
  it('aggregates reps into ONE primary record per sample with rep variance kept', () => {
    tmpRoot = makeRoot();
    seedScenario(tmpRoot);
    const v1 = collectArm('v1', recordsDir(tmpRoot), { experimentRoot: tmpRoot });
    const samples = aggregateBySample(v1.entries);
    expect(samples).toHaveLength(3); // S1, S2, S5 — rep files are NOT independent samples
    const s1 = samples.find((s) => s.experimentPainId === 'S1')!;
    expect(s1.primaryRep).toBe(0);
    expect(s1.records).toEqual(['S1.v1.json', 'S1.v1.rep1.json']);
    expect(s1.reps.map((r) => r.rep)).toEqual([0, 1]);
    expect(s1.reps.map((r) => r.routerStatus)).toEqual(['succeeded', 'failed']);
    // stage failures are summed ACROSS reps (rep1 router failed once)
    expect(s1.stageFailureCounts.router).toBe(1);
    expect(s1.totalAttempts.router).toBe(OK.attempts + FAIL.attempts);
    expect(s1.repSummary).toEqual({ repRecords: 2, repRouterSucceeded: 1, routerStatusAgreement: false });
  });
});

// ---------------------------------------------------------------------------
// layer1: per-sample completion rate + rep summary
// ---------------------------------------------------------------------------

describe('layer1', () => {
  it('computes completion rate per SAMPLE (primary rep) and run stats across all reps', () => {
    tmpRoot = makeRoot();
    seedScenario(tmpRoot);
    const v1 = collectArm('v1', recordsDir(tmpRoot), { experimentRoot: tmpRoot });
    const metrics = layer1(aggregateBySample(v1.entries));
    expect(metrics.samples).toBe(3);
    // all three samples completed the router stage on their primary rep → 3/3
    expect(metrics.pipelineCompletionRate).toEqual({ numerator: 3, denominator: 3, value: 1 });
    // succeeded runs: S1r0 (main+3 diag), S1r1 (main+rc+dist), S2 (main+3 diag), S5 (main+3 diag) = 15
    expect(metrics.runOutcomes.succeeded).toBe(15);
    expect(metrics.runOutcomes.failed).toBe(1); // S1r1 router
    // every succeeded run is exactly 300 s → latency aggregate stays per-run
    expect(metrics.avgStageLatencySec).toBe(300);
    expect(metrics.repSummary).toMatchObject({ samplesWithRepeats: 1, repRecords: 4, repRouterSucceeded: 3 });
    expect(metrics.repSummary.routerStatusAgreement).toBe(0); // S1 disagrees, only repeated sample
  });

  it('returns null rates for an empty collection instead of NaN', () => {
    const metrics = layer1([]);
    expect(metrics.samples).toBe(0);
    expect(metrics.pipelineCompletionRate.value).toBeNull();
    expect(metrics.schemaPassRate.value).toBeNull();
    expect(metrics.avgStageLatencySec).toBeNull();
    expect(metrics.repSummary.routerStatusAgreement).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pairing on (experimentPainId, stage, rep, arm)
// ---------------------------------------------------------------------------

describe('pairing by (sample, stage, rep, arm)', () => {
  it('counts full-chain pairs per stage and reports missing sides explicitly', () => {
    tmpRoot = makeRoot();
    seedScenario(tmpRoot);
    const byArm = {
      v1: collectArm('v1', recordsDir(tmpRoot), { experimentRoot: tmpRoot }).entries,
      v2: collectArm('v2', recordsDir(tmpRoot), { experimentRoot: tmpRoot }).entries,
    };
    const pairing = buildFullChainPairing(byArm);
    // record-level pairs: S1 rep0, S1 rep1, S2 rep0
    expect(pairing.recordPairs).toBe(3);
    // S5 rep0 has only a v1 record → reported with the missing arm, not dropped
    expect(pairing.recordMissing).toEqual([{ sid: 'S5', stage: null, rep: 0, missingArm: 'v2', reason: 'record-missing' }]);
    // stage pairs need BOTH arms to carry artifacts for that stage:
    //   rootcause: S1r0 + S2 → 2 pairs; missing: S1r1 (v2 has no artifacts), S5 (v2 record missing)
    expect(pairing.byStage.rootcause).toEqual({ pairs: 2, missing: 2 });
    expect(pairing.byStage.distiller).toEqual({ pairs: 2, missing: 2 });
    expect(pairing.byStage.router).toEqual({ pairs: 2, missing: 2 });
    // dreamer: only v1 S1r0 carries a dreamer artifact → 0 pairs, 4 missing
    expect(pairing.byStage.dreamer).toEqual({ pairs: 0, missing: 4 });
    expect(pairing.missing.filter((m) => m.stage === 'dreamer' && m.missingArm === 'v2')).toHaveLength(2);
    expect(pairing.missing.filter((m) => m.stage === 'dreamer' && m.missingArm === 'both')).toHaveLength(2);
    expect(pairing.missing.filter((m) => m.stage === 'philosopher' && m.missingArm === 'v2')).toHaveLength(1);
  });

  it('counts per-agent pairs on (sample, stage, rep) instead of files.length / 2', () => {
    tmpRoot = makeRoot();
    seedScenario(tmpRoot);
    const byArm = {
      v1: collectPerAgentArm('v1', paDir(tmpRoot)).entries,
      v2: collectPerAgentArm('v2', paDir(tmpRoot)).entries,
    };
    const pairing = buildPerAgentPairing(byArm);
    expect(pairing.recordsPerArm).toEqual({ v1: 2, v2: 1 });
    expect(pairing.pairs).toBe(1); // S1.distiller — NOT files.length / 2 heuristics
    expect(pairing.byStage.distiller).toMatchObject({ pairs: 1, missing: 0 });
    expect(pairing.byStage.router).toMatchObject({ pairs: 0, missing: 1 });
    expect(pairing.missing).toEqual([{ sid: 'S2', stage: 'router', rep: 0, missingArm: 'v2', reason: 'record-missing' }]);
  });
});

// ---------------------------------------------------------------------------
// computeMetrics end-to-end over the fixture root
// ---------------------------------------------------------------------------

describe('computeMetrics', () => {
  it('produces the full metrics document from the fixture (no crash on invalid records)', () => {
    tmpRoot = makeRoot();
    seedScenario(tmpRoot);
    const out = computeMetrics({ runId: RUN_ID, experimentRoot: tmpRoot });
    expect(out.runId).toBe(RUN_ID);
    expect(out.full.v1.samples).toBe(3);
    expect(out.full.v2.samples).toBe(2); // S1 (rep0+rep1) + S2
    expect(out.full.v1.pipelineCompletionRate).toEqual({ numerator: 3, denominator: 3, value: 1 });
    expect(out.full.v2.pipelineCompletionRate).toEqual({ numerator: 2, denominator: 2, value: 1 });
    // per-sample rows carry rep variance
    const s1v1 = out.full.v1.perSample.find((p) => p.id === 'S1')!;
    expect(s1v1.reps.map((r) => r.rep)).toEqual([0, 1]);
    expect(s1v1.reps.map((r) => r.ro)).toEqual(['succeeded', 'failed']);
    expect(s1v1.records).toEqual(['S1.v1.json', 'S1.v1.rep1.json']);
    // invalid records observable, workspace-level formation count present
    expect(out.invalidFiles.v1).toHaveLength(2);
    expect(out.full.v1.invalidFileCount).toBe(2);
    expect(out.full.v1.formationTasks).toEqual({ total: 2, byKind: { dreamer: 1, philosopher: 1 } });
    // pairing blocks present
    expect(out.pairs.fullChain.recordPairs).toBe(3);
    expect(out.pairs.perAgent.pairs).toBe(1);
    // metrics doc carries statuses/counts, never CANARY payload content
    expect(JSON.stringify(out)).not.toContain('CANARY-OUTPUT-PAYLOAD');
    expect(JSON.stringify(out)).not.toContain('CANARY_MARKER');
  });

  it('supports --experiment per-agent (skips the full-chain block)', () => {
    tmpRoot = makeRoot();
    seedScenario(tmpRoot);
    const out = computeMetrics({ runId: RUN_ID, experimentRoot: tmpRoot, experiment: 'per-agent' });
    expect(out.full).toEqual({});
    expect(out.pairs.perAgent.pairs).toBe(1);
  });
});
