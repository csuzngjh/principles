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
  const out = { samples: null, arms: ['v1', 'v2'], smoke: false, maxFormationLoops: 24 };
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

// Shard-scoped manifest FIRST (visibility — a shard that dies later still
// leaves its manifest), then workspaces (per-artifact atomic placement).
const shardId = sha256((args.samples ?? ['ALL']).join(',')).slice(0, 8);
const manifestPath = path.join(dir, `run-manifest.${shardId}.json`);
const manifest = {
  runId: args.runId,
  shard: args.samples ?? 'ALL',
  startedAt: new Date().toISOString(),
  heads: { v1: gitHead(WORKTREES.v1), v2: gitHead(WORKTREES.v2) },
  datasetFile: 'experiment/prompt-v2/dataset/pain-dataset.json',
};
manifest.updatedAt = new Date().toISOString();
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

// Materialize both arm workspaces (containment re-asserted inside).
for (const arm of args.arms) materializeWorkspace(arm);

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
    return { stageArtifacts: arts, candidates: cands, formationTasks, formationArtifacts: formationArts, painDiagnosis: diagRow, runs };
  } finally {
    state.close();
  }
}

async function runSampleArm(sample, arm, rep) {
  const rp = recordPath(sample.experimentPainId, arm);
  const suffix = rep > 0 ? `.rep${rep}` : '';
  const repPath = rep > 0 ? path.join(recordsDir, `${sample.experimentPainId}.${arm}${suffix}.json`) : rp;
  let resumedTaskId = null;
  if (fs.existsSync(repPath)) {
    const prior = JSON.parse(fs.readFileSync(repPath, 'utf8'));
    if (prior.status === 'done' && (prior.finalRouterStatus === 'succeeded' || prior.finalRouterStatus === 'failed')) return prior; // resume: nothing to do
    if (prior.newTaskId) resumedTaskId = prior.newTaskId; // resume: reuse the ingressed task, do NOT re-record the pain
  }
  const record = {
    experimentPainId: sample.experimentPainId, arm, rep,
    originalPainId: sample.originalPainId,
    inputDigest: sample.inputDigest,
    steps: [], status: 'running', startedAt: new Date().toISOString(),
    ...(resumedTaskId ? { resumedFromTaskId: resumedTaskId } : {}),
  };
  const log = (step, data) => { record.steps.push({ step, at: new Date().toISOString(), ...data }); fs.writeFileSync(repPath, JSON.stringify(record, null, 2) + '\n', 'utf8'); };
  try {
    // 1) Ingress — the reason text is the Owner's frozen original words.
    // Session binding follows the CLI's own contract: sentinel/unresolvable
    // sessions (e.g. the literal "cli" session of early manual pains) are
    // refused with session_not_found and the CLI's nextAction is to re-record
    // as an unbound Owner report. We follow that — same mode for BOTH arms,
    // mode recorded per sample, divergence from the historical run disclosed.
    let newTaskId = resumedTaskId;
    if (!newTaskId) {
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
    try {
      const j = JSON.parse(ingress.stdout.slice(ingress.stdout.indexOf('{')));
      newTaskId = j.taskId ?? j.task_id ?? (j.pain ? j.pain.taskId : null) ?? (j.diagnosis ? j.diagnosis.taskId : null);
      record.ingressJson = j;
    } catch { /* keep stdout tail */ }
    if (!newTaskId) throw new Error(`ingress did not yield a taskId (code=${ingress.code})`);
    } else {
      log('ingress', { mode: 'resumed', reusedTaskId: newTaskId });
    }
    record.newTaskId = newTaskId;

    // 2) Diagnosis chain (3 stages × up to 3 attempts × 20-min stage cap on
    // this endpoint ⇒ allow up to 3h for the whole chain child).
    // Lease reaper first: children killed by the harness timeout (or a crash)
    // leave `leased` rows whose lease has EXPIRED but whose status blocks
    // re-acquisition ("is leased, expected pending/retry_wait"). Reap only
    // EXPIRED leases on this chain's tasks — the experiment DB, never
    // production. Fresh tasks are pending and untouched.
    const reapExpiredLeases = () => {
      const sdb = new Database(path.join(EXPERIMENT_ROOT, 'workspaces', arm, '.pd', 'state.db'));
      try {
        const rows = sdb.prepare('SELECT task_id FROM tasks WHERE task_id IN (?,?,?,?) AND status = \'leased\' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?')
          .all(newTaskId, `diag_rootcause-${newTaskId}`, `diag_distiller-${newTaskId}`, `diag_router-${newTaskId}`, new Date().toISOString());
        for (const r of rows) {
          sdb.prepare('UPDATE tasks SET status = \'retry_wait\', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE task_id = ?').run(new Date().toISOString(), r.task_id);
        }
        return rows.map((r) => r.task_id);
      } finally { sdb.close(); }
    };
    const reaped = reapExpiredLeases();
    if (reaped.length > 0) log('lease-reap', { reaped });
    let diag = await runPd(arm, ['diagnose', 'run', '--task-id', newTaskId], { timeoutMs: 3 * 60 * 60_000 });
    if (diag.code !== 0 && /lease_conflict/.test(diag.stdout + diag.stderr)) {
      // Active lease still held (long TTL): wait it out once, re-reap, retry once.
      await new Promise((r2) => setTimeout(r2, 10 * 60_000));
      const reaped2 = reapExpiredLeases();
      log('lease-reap-retry', { reaped: reaped2 });
      diag = await runPd(arm, ['diagnose', 'run', '--task-id', newTaskId], { timeoutMs: 3 * 60 * 60_000 });
    }
    log('diagnose-run', { code: diag.code, stdoutTail: diag.stdout.slice(-6000), stderrTail: diag.stderr.slice(-3000) });

    // 3) Formation loop — run-once repeatedly while internalization work
    // remains or may still appear. Exit condition is DB-derived: the router
    // stage is terminal AND no dreamer/philosopher/scribe task is still
    // pending/leased/running. A bare `no_candidates` from run-once does NOT
    // terminate the loop while the diagnosis chain is still in flight.
    const wsDb = path.join(EXPERIMENT_ROOT, 'workspaces', arm, '.pd', 'state.db');
    const chainState = () => {
      const sdb = new Database(wsDb, { readonly: true });
      try {
        const router = sdb.prepare('SELECT status FROM tasks WHERE task_id = ?').get(`diag_router-${newTaskId}`);
        const live = sdb.prepare("SELECT count(*) AS c FROM tasks WHERE task_kind IN ('dreamer','philosopher','scribe') AND status IN ('pending','leased','running','retry_wait')").get().c;
        const total = sdb.prepare("SELECT count(*) AS c FROM tasks WHERE task_kind IN ('dreamer','philosopher','scribe')").get().c;
        return { router: router?.status ?? 'missing', liveInternalization: live, totalInternalization: total };
      } finally { sdb.close(); }
    };
    const loopLog = [];
    for (let i = 0; i < args.maxFormationLoops; i++) {
      const st = chainState();
      const routerTerminal = st.router === 'succeeded' || st.router === 'failed' || st.router === 'missing';
      if (routerTerminal && st.liveInternalization === 0) {
        loopLog.push({ i, note: 'terminal', chain: st });
        break;
      }
      const once = await runPd(arm, ['runtime', 'internalization', 'run-once'], { timeoutMs: 30 * 60_000 });
      let j = null;
      try { j = JSON.parse(once.stdout.slice(once.stdout.indexOf('{'))); } catch { /* raw */ }
      loopLog.push({ i, code: once.code, decision: j?.decision ?? null, reason: j?.reason ?? null, chain: st, stdoutTail: once.stdout.slice(-1500), stderrTail: once.stderr.slice(-800) });
    }
    log('internalization-loop', { loops: loopLog, finalChain: chainState() });

    // 4) Collect artifacts + derive an honest terminal status.
    record.artifacts = collectArtifacts(arm, newTaskId);
    const chainDb = new Database(path.join(EXPERIMENT_ROOT, 'workspaces', arm, '.pd', 'state.db'), { readonly: true });
    const finalRouter = chainDb.prepare('SELECT status FROM tasks WHERE task_id = ?').get(`diag_router-${newTaskId}`)?.status;
    const liveFormation = chainDb.prepare("SELECT count(*) AS c FROM tasks WHERE task_kind IN ('dreamer','philosopher','scribe') AND status IN ('pending','leased','running','retry_wait')").get().c;
    chainDb.close();
    record.finalRouterStatus = finalRouter;
    record.finalLiveFormation = liveFormation;
    record.status = (finalRouter === 'succeeded' || finalRouter === 'failed') && liveFormation === 0 ? 'done' : 'incomplete';
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
