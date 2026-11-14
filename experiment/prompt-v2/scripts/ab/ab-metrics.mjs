/**
 * PD-SPEC-001 Phase 5 layer-1 collector — pipeline-run quality metrics
 * (SPEC §6.1) computed from the A/B run records + arm state DBs, per arm.
 *
 * Usage: node ab-metrics.mjs --run-id <id> [--experiment full|per-agent]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { EXPERIMENT_ROOT } from './ab-lib.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
const getOpt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const runId = getOpt('--run-id', null);
if (!runId) throw new Error('--run-id required');

const dir = path.join(EXPERIMENT_ROOT, 'runs', runId);

function collectArm(arm, recordsDir, filter) {
  const ws = path.join(EXPERIMENT_ROOT, 'workspaces', arm);
  const files = fs.existsSync(recordsDir) ? fs.readdirSync(recordsDir).filter((f) => f.endsWith(`.${arm}.json`) && filter(f)) : [];
  const perSample = [];
  for (const f of files) {
    const r = JSON.parse(fs.readFileSync(path.join(recordsDir, f), 'utf8'));
    if (!r.newTaskId && !r.targetTaskId) continue;
    const taskId = r.newTaskId ?? r.targetTaskId;
    const db = new Database(path.join(ws, '.pd', 'state.db'), { readonly: true });
    try {
      const stages = {};
      for (const [k, id] of [['rootcause', `diag_rootcause-${taskId}`], ['distiller', `diag_distiller-${taskId}`], ['router', `diag_router-${taskId}`]]) {
        stages[k] = db.prepare('SELECT status, attempt_count, last_error FROM tasks WHERE task_id = ?').get(id) ?? null;
      }
      const runs = db.prepare('SELECT task_id, execution_status, attempt_number, error_category, started_at, ended_at, LENGTH(output_payload) AS out_len FROM runs WHERE task_id IN (?,?,?,?) ORDER BY task_id, attempt_number').all(taskId, `diag_rootcause-${taskId}`, `diag_distiller-${taskId}`, `diag_router-${taskId}`);
      const cands = db.prepare('SELECT count(*) AS c FROM principle_candidates WHERE task_id = ?').get(`diag_router-${taskId}`)?.c ?? 0;
      const formation = db.prepare("SELECT task_kind, status, attempt_count FROM tasks WHERE task_kind IN ('dreamer','philosopher','scribe') AND status != 'missing'").all().length; // workspace-level, refined below
      const arts = db.prepare('SELECT artifact_id, source_task_id, lineage_artifact_ids FROM pi_artifacts WHERE source_task_id IN (?,?,?)').all(`diag_rootcause-${taskId}`, `diag_distiller-${taskId}`, `diag_router-${taskId}`);
      perSample.push({
        record: f, experimentPainId: r.experimentPainId, rep: r.rep ?? 0, ingressMode: r.ingressMode ?? null,
        status: r.status, stages, runs, candidates: cands, stageArtifacts: arts.map((a) => ({ id: a.artifact_id, src: a.source_task_id, lineage: a.lineage_artifact_ids })),
      });
    } finally { db.close(); }
  }
  return perSample;
}

function layer1(samples) {
  const total = samples.length;
  const completedDiag = samples.filter((s) => s.stages.router?.status === 'succeeded').length;
  const stageFailures = { rootcause: 0, distiller: 0, router: 0 };
  const attempts = { rootcause: 0, distiller: 0, router: 0 };
  const runOutcomes = { succeeded: 0, failed: 0, other: 0 };
  let latencyMs = 0;
  let latencyPairs = 0;
  let outputChars = 0;
  for (const s of samples) {
    for (const k of ['rootcause', 'distiller', 'router']) {
      const st = s.stages[k];
      if (!st) continue;
      attempts[k] += st.attempt_count ?? 1;
      if (st.status === 'failed') stageFailures[k] += 1;
    }
    for (const run of s.runs) {
      if (run.execution_status === 'succeeded') runOutcomes.succeeded += 1;
      else if (run.execution_status === 'failed') runOutcomes.failed += 1;
      else runOutcomes.other += 1;
      if (run.started_at && run.ended_at && run.execution_status === 'succeeded') {
        latencyMs += new Date(run.ended_at) - new Date(run.started_at);
        latencyPairs += 1;
      }
      outputChars += run.out_len ?? 0;
    }
  }
  const totalRuns = runOutcomes.succeeded + runOutcomes.failed + runOutcomes.other;
  return {
    samples: total,
    pipelineCompletionRate: { numerator: completedDiag, denominator: total, value: total ? +(completedDiag / total).toFixed(3) : null },
    schemaPassRate: { numerator: runOutcomes.succeeded, denominator: runOutcomes.succeeded + runOutcomes.failed, value: (runOutcomes.succeeded + runOutcomes.failed) ? +(runOutcomes.succeeded / (runOutcomes.succeeded + runOutcomes.failed)).toFixed(3) : null },
    stageFailures, totalAttempts: attempts, runOutcomes,
    avgStageLatencySec: latencyPairs ? +(latencyMs / latencyPairs / 1000).toFixed(1) : null,
    totalOutputChars: outputChars,
  };
}

const out = { runId, generatedAt: new Date().toISOString(), full: {}, perAgent: {} };
for (const arm of ['v1', 'v2']) {
  const fullDir = path.join(dir, 'records');
  const paDir = path.join(dir, 'records-pa');
  const fullSamples = collectArm(arm, fullDir, () => true);
  out.full[arm] = layer1(fullSamples);
  out.full[arm].perSample = fullSamples.map((s) => ({ id: s.experimentPainId, rep: s.rep, rc: s.stages.rootcause?.status, di: s.stages.distiller?.status, ro: s.stages.router?.status, cands: s.candidates, recordStatus: s.status }));
  const pa = {};
  for (const stage of ['distiller', 'router', 'dreamer', 'philosopher', 'scribe']) {
    const files = fs.existsSync(paDir) ? fs.readdirSync(paDir).filter((f) => f.includes(`.${stage}.${arm}.json`)) : [];
    pa[stage] = { pairs: files.length / 2 };
  }
  out.perAgent[arm] = pa;
}
fs.writeFileSync(path.join(dir, 'layer1-metrics.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ v1: out.full.v1, v2: out.full.v2 }, (k, v) => (k === 'perSample' ? undefined : v), 1));
console.log('->', path.join(dir, 'layer1-metrics.json'));
