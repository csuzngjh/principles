/**
 * PD-SPEC-001 A/B executor — drives the REAL production chain per arm:
 *   pd pain record (ingress, session-validated evidence)
 *   → pd diagnose run (Stage A/B/C + candidate intake + dreamer seeding)
 *   → pd runtime internalization run-once (dreamer → philosopher → scribe)
 * Resumable per (sample, arm); A/B order interleaved deterministically.
 *
 * Usage:
 *   node experiment/prompt-v2/scripts/ab/ab-run.mjs --run-id <id> [--samples S01,S07] [--arms v1,v2] [--smoke]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  WORKTREES, EXPERIMENT_ROOT, runPd, loadDataset, runDir, armOrderFor,
  materializeWorkspace, gitHead, childEnv, sha256,
} from './ab-lib.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

function parseArgs(argv) {
  const out = { samples: null, arms: ['v1', 'v2'], smoke: false, maxFormationLoops: 8 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run-id') out.runId = argv[++i];
    else if (a === '--samples') out.samples = argv[++i].split(',');
    else if (a === '--arms') out.arms = argv[++i].split(',');
    else if (a === '--smoke') out.smoke = true;
    else if (a === '--max-formation-loops') out.maxFormationLoops = Number(argv[++i]);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!out.runId) throw new Error('--run-id is required');
  return out;
}

const args = parseArgs(process.argv);
const dataset = loadDataset();
const dir = runDir(args.runId);
const recordsDir = path.join(dir, 'records');
fs.mkdirSync(recordsDir, { recursive: true });

// Materialize both arm workspaces (containment re-asserted inside).
for (const arm of args.arms) materializeWorkspace(arm);

const manifestPath = path.join(dir, 'run-manifest.json');
const manifest = fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  : {
    runId: args.runId,
    startedAt: new Date().toISOString(),
    heads: { v1: gitHead(WORKTREES.v1), v2: gitHead(WORKTREES.v2) },
    datasetFile: 'experiment/prompt-v2/dataset/pain-dataset.json',
    samples: [],
  };
manifest.updatedAt = new Date().toISOString();
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

const samples = dataset.samples.filter((s) => (args.samples ? args.samples.includes(s.experimentPainId) : true));

function recordPath(sampleId, arm) {
  return path.join(recordsDir, `${sampleId}.${arm}.json`);
}

function collectArtifacts(arm, taskId) {
  const ws = path.join(EXPERIMENT_ROOT, 'workspaces', arm);
  const state = new Database(path.join(ws, '.pd', 'state.db'), { readonly: true, fileMustExist: true });
  try {
    const base = taskId.replace(/^diagnosis_/, '');
    const stageIds = [taskId, `diag_rootcause-${taskId}`, `diag_distiller-${taskId}`, `diag_router-${taskId}`];
    const arts = state.prepare('SELECT artifact_id, artifact_kind, source_task_id, content_json, created_at FROM pi_artifacts WHERE source_task_id IN (?,?,?,?) ORDER BY created_at').all(...stageIds);
    const cands = state.prepare("SELECT candidate_id, task_id, status, recommendation_kind, abstracted_principle, title FROM principle_candidates WHERE task_id LIKE ? OR task_id LIKE ?").all(`%${base}%`, taskId).filter((c) => stageIds.includes(c.task_id));
    const formationTasks = state.prepare("SELECT task_id, task_kind, status, attempt_count, last_error, created_at FROM tasks WHERE task_id LIKE ? ORDER BY created_at").all(`%${base}%`).filter((t) => ['dreamer', 'philosopher', 'scribe'].includes(t.task_kind));
    // formation artifacts keyed by candidate uuid in task ids
    const candIds = cands.map((c) => c.candidate_id);
    const formationArts = [];
    const formationArtStmt = state.prepare("SELECT artifact_id, artifact_kind, source_task_id, content_json, created_at FROM pi_artifacts WHERE source_task_id LIKE ? ORDER BY created_at");
    for (const cid of candIds) {
      formationArts.push(...formationArtStmt.all(`%${cid}%`));
    }
    const diagRow = state.prepare('SELECT pain_id, task_id, category, root_cause, confidence FROM pain_diagnoses WHERE task_id = ?').get(taskId) ?? null;
    const runs = state.prepare("SELECT task_id, execution_status, attempt_number, reason, error_category, LENGTH(output_payload) AS out_len FROM runs WHERE task_id IN (?,?,?,?) ORDER BY task_id, attempt_number").all(...stageIds);
    return { stageArtifacts: arts, candidates: cands, formationTasks, formationArtifacts, painDiagnosis: diagRow, runs };
  } finally {
    state.close();
  }
}

async function runSampleArm(sample, arm, rep) {
  const rp = recordPath(sample.experimentPainId, arm);
  if (rep === 0 && fs.existsSync(rp)) {
    const prior = JSON.parse(fs.readFileSync(rp, 'utf8'));
    if (prior.status === 'done') return prior; // resume
  }
  const suffix = rep > 0 ? `.rep${rep}` : '';
  const repPath = rep > 0 ? path.join(recordsDir, `${sample.experimentPainId}.${arm}${suffix}.json`) : rp;
  const record = {
    experimentPainId: sample.experimentPainId, arm, rep,
    originalPainId: sample.originalPainId,
    inputDigest: sample.inputDigest,
    steps: [], status: 'running', startedAt: new Date().toISOString(),
  };
  const log = (step, data) => { record.steps.push({ step, at: new Date().toISOString(), ...data }); fs.writeFileSync(repPath, JSON.stringify(record, null, 2) + '\n', 'utf8'); };
  try {
    // 1) Ingress — the reason text is the Owner's frozen original words.
    // Session binding follows the CLI's own contract: sentinel/unresolvable
    // sessions (e.g. the literal "cli" session of early manual pains) are
    // refused with session_not_found and the CLI's nextAction is to re-record
    // as an unbound Owner report. We follow that — same mode for BOTH arms,
    // mode recorded per sample, divergence from the historical run disclosed.
    const painEvent = sample.painEvent;
    const recArgs = ['pain', 'record',
      '--reason', String(painEvent.reason ?? painEvent.text ?? '').slice(0, 4000),
      '--source', String(painEvent.source ?? 'manual'),
      '--host', 'openclaw',
    ];
    if (typeof painEvent.confidence === 'number') recArgs.push('--score', String(painEvent.confidence));
    if (painEvent.session_id) recArgs.push('--session', String(painEvent.session_id));
    let ingress = await runPd(arm, recArgs);
    let ingressMode = painEvent.session_id ? 'bound' : 'unbound';
    if (ingress.code !== 0 && /session_not_found|sentinel/i.test(ingress.stdout + ingress.stderr)) {
      const unboundArgs = recArgs.filter((a, i, arr) => a !== '--session' && a !== '--host' && arr[i - 1] !== '--session' && arr[i - 1] !== '--host');
      ingress = await runPd(arm, unboundArgs);
      ingressMode = 'unbound-fallback';
    }
    record.ingressMode = ingressMode;
    log('ingress', { mode: ingressMode, code: ingress.code, stdoutTail: ingress.stdout.slice(-4000), stderrTail: ingress.stderr.slice(-2000) });
    let newTaskId = null;
    try {
      const j = JSON.parse(ingress.stdout.slice(ingress.stdout.indexOf('{')));
      newTaskId = j.taskId ?? j.task_id ?? (j.pain ? j.pain.taskId : null) ?? (j.diagnosis ? j.diagnosis.taskId : null);
      record.ingressJson = j;
    } catch { /* keep stdout tail */ }
    if (!newTaskId) throw new Error(`ingress did not yield a taskId (code=${ingress.code})`);
    record.newTaskId = newTaskId;

    // 2) Diagnosis chain.
    const diag = await runPd(arm, ['diagnose', 'run', '--task-id', newTaskId]);
    log('diagnose-run', { code: diag.code, stdoutTail: diag.stdout.slice(-6000), stderrTail: diag.stderr.slice(-3000) });

    // 3) Formation loop — run-once repeatedly until no pending internalization work.
    const loopLog = [];
    for (let i = 0; i < args.maxFormationLoops; i++) {
      const once = await runPd(arm, ['runtime', 'internalization', 'run-once']);
      let j = null;
      try { j = JSON.parse(once.stdout.slice(once.stdout.indexOf('{'))); } catch { /* raw */ }
      loopLog.push({ i, code: once.code, stdoutTail: once.stdout.slice(-2500), stderrTail: once.stderr.slice(-1500) });
      const ranNothing = j && (j.ran === 0 || j.executed === 0 || j.noop === true || /no (ready|runnable|pending)/i.test(once.stdout));
      if (once.code !== 0 && !ranNothing) continue; // transient errors: keep looping while budget lasts
      if (ranNothing) break;
    }
    log('internalization-loop', { loops: loopLog });

    // 4) Collect artifacts.
    record.artifacts = collectArtifacts(arm, newTaskId);
    record.status = 'done';
    record.finishedAt = new Date().toISOString();
    fs.writeFileSync(repPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
    return record;
  } catch (err) {
    record.status = 'error';
    record.error = String(err?.message ?? err);
    record.finishedAt = new Date().toISOString();
    fs.writeFileSync(repPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
    return record;
  }
}

const repeatPicks = dataset.repeatRunPicks ?? [];
const repsFor = (sid) => (repeatPicks.includes(sid) ? [0, 1, 2] : [0]);

(async () => {
  for (let si = 0; si < samples.length; si++) {
    const sample = samples[si];
    const order = armOrderFor(args.runId, si);
    for (const rep of repsFor(sample.experimentPainId)) {
      for (const arm of order) {
        if (!args.arms.includes(arm)) continue;
        console.log(`[${new Date().toISOString()}] ${sample.experimentPainId} rep${rep} ${arm} …`);
        const r = await runSampleArm(sample, arm, rep);
        console.log(`  -> ${r.status}${r.error ? ' (' + r.error.slice(0, 120) + ')' : ''}`);
      }
    }
  }
  manifest.updatedAt = new Date().toISOString();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log('run complete ->', dir);
})();
