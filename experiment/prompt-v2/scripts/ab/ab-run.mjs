/**
 * PD-SPEC-001 A/B executor — remediated (Owner directive Phase 4).
 *
 * Drives the REAL production chain per arm per shard:
 *   pd pain record (ingress; session binding follows the CLI's own nextAction)
 *   → pd diagnose run (Stage A/B/C + candidate intake + dreamer seeding)
 *   → pd runtime internalization run-once --runner dreamer|philosopher|scribe
 *     (run-once dispatches ONE runner kind per invocation — default 'dreamer'
 *     only, which dead-locked grid-1's philosopher/scribe; the loop now
 *     round-robins all three runner kinds until none has ready work)
 *   → pd runtime internalization enqueue-successors is NOT needed: run-once
 *     auto-enqueues successors by default (opts.enqueueNext !== false).
 *
 * Isolation: per-shard arm workspaces (workspaces/<arm>-s<shardId>) — shards
 * never share a database. Lease recovery is a single conditional UPDATE (CAS)
 * on expired leases only. Terminal 'done' REQUIRES: child exit 0 + target task
 * succeeded + succeeded run + schema-valid artifacts (TypeBox via the arm's
 * own dist) — anything else is 'failed'/'incomplete' with an error category.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  WORKTREES, EXPERIMENT_ROOT, runPd, loadDataset, runDir, armOrderFor,
  materializeWorkspace, gitHead, childEnv, sha256, sha256File, armWorkspaceDir,
} from './ab-lib.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// TypeBox validation from the V2 arm's own dist (artifact schema gates).
const { Value } = require('@sinclair/typebox/value');
const coreDist = (p) => 'file://' + path.join(WORKTREES.v2, 'packages/principles-core/dist', p).replace(/\\/g, '/');
const schemas = {
  rootcause: (await import(coreDist('runtime/diagnostician/diag-rootcause-output.js'))).DiagRootCauseOutputV1Schema,
  distiller: (await import(coreDist('runtime/diagnostician/diag-distiller-output.js'))).DiagDistillerOutputV1Schema,
  routerEnvelope: null, // resolved below with the envelope reader
};
const diagOutputMod = await import(coreDist('runtime/diagnostician-output.js'));
schemas.routerEnvelope = diagOutputMod.readDiagnosticianOutputFromEnvelope;

function parseArgs(argv) {
  const out = { samples: null, arms: ['v1', 'v2'], shardId: 'solo', maxFormationLoops: 24 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run-id') out.runId = argv[++i];
    else if (a === '--samples') out.samples = argv[++i].split(',');
    else if (a === '--arms') out.arms = argv[++i].split(',');
    else if (a === '--shard-id') out.shardId = argv[++i];
    else if (a === '--max-formation-loops') out.maxFormationLoops = Number(argv[++i]);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!out.runId) throw new Error('--run-id is required');
  return out;
}

const args = parseArgs(process.argv);
const dataset = loadDataset(); // fail-closed: full fidelity or nothing
const dir = runDir(args.runId);
const recordsDir = path.join(dir, 'records');
fs.mkdirSync(recordsDir, { recursive: true });

// Manifest FIRST (visibility), then workspaces (per-artifact atomic placement).
const shardId = sha256((args.samples ?? ['ALL']).join(',') + '|' + args.shardId).slice(0, 8);
const manifestPath = path.join(dir, `run-manifest.${shardId}.json`);
const manifest = {
  runId: args.runId,
  shard: args.samples ?? 'ALL',
  shardId: args.shardId,
  startedAt: new Date().toISOString(),
  heads: { v1: gitHead(WORKTREES.v1), v2: gitHead(WORKTREES.v2) },
  datasetFile: 'local full-fidelity copy (.tmp/prompt-v2-inventory/pain-dataset.full.json)',
  datasetSha256: sha256File(path.join(WORKTREES.v2, '.tmp/prompt-v2-inventory/pain-dataset.full.json')),
};
manifest.updatedAt = new Date().toISOString();
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

// Materialize this shard's OWN arm workspaces (never shared across shards).
for (const arm of args.arms) materializeWorkspace(arm, { shardId: args.shardId });

const samples = dataset.samples.filter((s) => (args.samples ? args.samples.includes(s.experimentPainId) : true));

function recordPath(sampleId, arm, rep) {
  const suffix = rep > 0 ? `.rep${rep}` : '';
  return path.join(recordsDir, `${sampleId}.${arm}${suffix}.json`);
}

/** Single conditional UPDATE (CAS) — only EXPIRED leases of THIS chain's tasks. */
function reapExpiredLeases(arm, shardId, taskId, nowIso) {
  const db = new Database(armWorkspaceDir(arm, shardId) + '/.pd/state.db');
  try {
    const info = db.prepare(
      `UPDATE tasks SET status = 'retry_wait', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE task_id IN (?,?,?,?) AND status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
    ).run(nowIso, taskId, `diag_rootcause-${taskId}`, `diag_distiller-${taskId}`, `diag_router-${taskId}`, nowIso);
    return info.changes;
  } finally { db.close(); }
}

function collectArtifacts(arm, shardId, taskId) {
  const ws = armWorkspaceDir(arm, shardId);
  const state = new Database(path.join(ws, '.pd', 'state.db'), { readonly: true, fileMustExist: true });
  try {
    const stageIds = [taskId, `diag_rootcause-${taskId}`, `diag_distiller-${taskId}`, `diag_router-${taskId}`];
    const arts = state.prepare('SELECT artifact_id, artifact_kind, source_task_id, content_json, created_at FROM pi_artifacts WHERE source_task_id IN (?,?,?,?) ORDER BY created_at').all(...stageIds);
    const base = taskId.replace(/^diagnosis_/, '');
    const cands = state.prepare('SELECT candidate_id, task_id, status, recommendation_kind, abstracted_principle, title FROM principle_candidates WHERE task_id IN (?,?,?,?)').all(...stageIds);
    // Formation tasks are keyed by CANDIDATE uuid (dreamer-<candidateId>-<channel>),
    // NOT by pain id — join through this run's candidate ids. Per-shard workspaces
    // make this join unambiguous (no other run's candidates exist in this DB).
    const candIds = cands.map((c) => c.candidate_id);
    let formationTasks = [];
    if (candIds.length > 0) {
      const like = candIds.map(() => 'task_id LIKE ?').join(' OR ');
      formationTasks = state.prepare(`SELECT task_id, task_kind, status, attempt_count, last_error, created_at FROM tasks WHERE task_kind IN ('dreamer','philosopher','scribe') AND (${like}) ORDER BY created_at`).all(...candIds.map((id) => `%${id}%`));
    }
    const formationArtStmt = state.prepare('SELECT artifact_id, artifact_kind, source_task_id, content_json, created_at FROM pi_artifacts WHERE source_task_id IN (' + formationTasks.map(() => '?').join(',') + ') ORDER BY created_at');
    const formationArts = formationTasks.length > 0 ? formationArtStmt.all(...formationTasks.map((t) => t.task_id)) : [];
    const diagRow = state.prepare('SELECT pain_id, task_id, category, confidence FROM pain_diagnoses WHERE task_id = ?').get(taskId) ?? null;
    const runs = state.prepare('SELECT task_id, execution_status, attempt_number, error_category, started_at, ended_at, LENGTH(output_payload) AS out_len FROM runs WHERE task_id IN (?,?,?,?) ORDER BY task_id, attempt_number').all(...stageIds);
    return { stageArtifacts: arts, candidates: cands, formationTasks, formationArtifacts: formationArts, painDiagnosis: diagRow, runs };
  } finally { state.close(); }
}

/** Schema-validate the terminal artifact of each stage (arm's own dist gates). */
function validateStageArtifacts(artifacts, taskId) {
  const errors = [];
  const byStage = { rootcause: [], distiller: [], router: [] };
  for (const a of artifacts.stageArtifacts ?? []) {
    for (const stage of ['rootcause', 'distiller', 'router']) {
      if (a.source_task_id.startsWith(`diag_${stage}-`)) byStage[stage].push(a);
    }
  }
  for (const [stage, arts] of Object.entries(byStage)) {
    const last = arts[arts.length - 1];
    if (!last) { errors.push(`${stage}: no artifact`); continue; }
    let parsed;
    try { parsed = JSON.parse(last.content_json); } catch (e) { errors.push(`${stage}: artifact JSON unparseable`); continue; }
    if (stage === 'router') {
      const out = schemas.routerEnvelope(parsed);
      if (!out) errors.push('router: artifact failed envelope schema validation');
    } else {
      const schema = schemas[stage];
      if (!Value.Check(schema, parsed)) {
        const msgs = [...Value.Errors(schema, parsed)].slice(0, 3).map((e) => `${e.path}: ${e.message}`);
        errors.push(`${stage}: schema invalid — ${msgs.join('; ')}`);
      }
    }
    last.schemaValidated = true;
  }
  return { ok: errors.length === 0, errors };
}

async function runSampleArm(sample, arm, rep) {
  const repPath = recordPath(sample.experimentPainId, arm, rep);
  let resumedTaskId = null;
  // CodeQL js/file-system-race: stat once instead of existsSync-then-read.
  const priorExists = (() => { try { fs.statSync(repPath); return true; } catch { return false; } })();
  if (priorExists) {
    const prior = JSON.parse(fs.readFileSync(repPath, 'utf8'));
    if (prior.status === 'done' && prior.verification?.ok === true) return prior; // resume only terminal VERIFIED done
    if (prior.newTaskId) resumedTaskId = prior.newTaskId;
  }
  const record = {
    experimentPainId: sample.experimentPainId, arm, rep, shardId: args.shardId,
    originalPainId: sample.originalPainId,
    inputDigest: sample.inputDigest,
    steps: [], status: 'running', startedAt: new Date().toISOString(),
    ...(resumedTaskId ? { resumedFromTaskId: resumedTaskId } : {}),
  };
  const log = (step, data) => { record.steps.push({ step, at: new Date().toISOString(), ...data }); fs.writeFileSync(repPath, JSON.stringify(record, null, 2) + '\n', 'utf8'); };
  const fail = (category, message, extra = {}) => {
    record.status = record.status === 'incomplete' ? 'incomplete' : 'failed';
    record.errorCategory = category;
    record.error = message;
    record.finishedAt = new Date().toISOString();
    fs.writeFileSync(repPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
    return record;
  };
  try {
    // 1) Ingress (resume reuses the ingressed task — never re-records the pain).
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
      let ingress = await runPd(arm, recArgs, { shardId: args.shardId });
      let ingressMode = painEvent.session_id ? 'bound' : 'unbound';
      if (ingress.code !== 0 && /session_not_found|sentinel/i.test(ingress.stdout + ingress.stderr)) {
        const unboundArgs = recArgs.filter((a, i, arr) => a !== '--session' && a !== '--host' && arr[i - 1] !== '--session' && arr[i - 1] !== '--host');
        ingress = await runPd(arm, unboundArgs, { shardId: args.shardId });
        ingressMode = 'unbound-fallback';
      }
      record.ingressMode = ingressMode;
      log('ingress', { mode: ingressMode, code: ingress.code, stdoutTail: ingress.stdout.slice(-3000), stderrTail: ingress.stderr.slice(-1500) });
      try {
        const j = JSON.parse(ingress.stdout.slice(ingress.stdout.indexOf('{')));
        newTaskId = j.taskId ?? j.task_id ?? (j.pain ? j.pain.taskId : null) ?? (j.diagnosis ? j.diagnosis.taskId : null);
        record.ingressJson = j;
      } catch { /* stdout tail retained in log */ }
      if (ingress.code !== 0 || !newTaskId) return fail('ingress_failed', `ingress exit=${ingress.code}, taskId=${newTaskId ?? 'none'}`);
    } else {
      log('ingress', { mode: 'resumed', reusedTaskId: newTaskId });
    }
    record.newTaskId = newTaskId;

    // 2) Diagnosis chain with lease-reaper CAS + one lease_conflict retry.
    const reapNow = () => reapExpiredLeases(arm, args.shardId, newTaskId, new Date().toISOString());
    const reaped = reapNow();
    if (reaped > 0) log('lease-reap', { reaped });
    let diag = await runPd(arm, ['diagnose', 'run', '--task-id', newTaskId], { timeoutMs: 3 * 60 * 60_000, shardId: args.shardId });
    if (diag.code !== 0 && /lease_conflict/.test(diag.stdout + diag.stderr)) {
      await new Promise((r2) => setTimeout(r2, 10 * 60_000));
      const reaped2 = reapNow();
      log('lease-reap-retry', { reaped: reaped2 });
      diag = await runPd(arm, ['diagnose', 'run', '--task-id', newTaskId], { timeoutMs: 3 * 60 * 60_000, shardId: args.shardId });
    }
    log('diagnose-run', { code: diag.code, stdoutTail: diag.stdout.slice(-5000), stderrTail: diag.stderr.slice(-2000) });
    if (diag.code !== 0) {
      let category = 'diagnose_failed';
      if (/rate_limit/i.test(diag.stdout + diag.stderr)) category = 'provider_rate_limited';
      else if (/timed out|timeout/i.test(diag.stdout + diag.stderr)) category = 'provider_timeout';
      else if (/lease_conflict/i.test(diag.stdout + diag.stderr)) category = 'lease_conflict';
      return fail(category, `diagnose run exit=${diag.code}`);
    }

    // 3) Formation: round-robin ALL THREE runner kinds (run-once dispatches
    // exactly one kind per invocation — the grid-1 dead-lock root cause).
    const wsDb = path.join(armWorkspaceDir(arm, args.shardId), '.pd', 'state.db');
    const chainState = () => {
      const sdb = new Database(wsDb, { readonly: true });
      try {
        const router = sdb.prepare('SELECT status FROM tasks WHERE task_id = ?').get(`diag_router-${newTaskId}`);
        const live = sdb.prepare("SELECT count(*) AS c FROM tasks WHERE task_kind IN ('dreamer','philosopher','scribe') AND status IN ('pending','leased','running','retry_wait')").get().c;
        const byKind = sdb.prepare("SELECT task_kind, status, count(*) AS c FROM tasks WHERE task_kind IN ('dreamer','philosopher','scribe') GROUP BY task_kind, status").all();
        return { router: router?.status ?? 'missing', liveInternalization: live, byKind };
      } finally { sdb.close(); }
    };
    const loopLog = [];
    for (let i = 0; i < args.maxFormationLoops; i++) {
      const st = chainState();
      if ((st.router === 'succeeded' || st.router === 'failed') && st.liveInternalization === 0) {
        loopLog.push({ i, note: 'terminal', chain: st });
        break;
      }
      let ranWork = false;
      for (const runner of ['dreamer', 'philosopher', 'scribe']) {
        const once = await runPd(arm, ['runtime', 'internalization', 'run-once', '--runner', runner], { timeoutMs: 30 * 60_000, shardId: args.shardId });
        let j = null;
        try { j = JSON.parse(once.stdout.slice(once.stdout.indexOf('{'))); } catch { /* raw */ }
        const decision = j?.decision ?? 'unknown';
        loopLog.push({ i, runner, code: once.code, decision, reason: j?.reason ?? null });
        if (decision === 'leased' || decision === 'would_lease') ranWork = true;
      }
      if (!ranWork) {
        // No runner had work this round; loop again (successors may appear
        // asynchronously via auto-enqueue) until the terminal check above or
        // the loop budget ends.
      }
    }
    log('internalization-loop', { rounds: loopLog.length, finalChain: chainState(), tail: loopLog.slice(-8) });

    // 4) Collect + STRICT terminal verification.
    record.artifacts = collectArtifacts(arm, args.shardId, newTaskId);
    const chainDb = new Database(wsDb, { readonly: true });
    const finalRouter = chainDb.prepare('SELECT status FROM tasks WHERE task_id = ?').get(`diag_router-${newTaskId}`)?.status;
    const routerRun = chainDb.prepare("SELECT execution_status FROM runs WHERE task_id = ? AND execution_status = 'succeeded' LIMIT 1").get(`diag_router-${newTaskId}`);
    chainDb.close();
    record.finalRouterStatus = finalRouter;
    const verification = { checks: {}, ok: false };
    // CLI exit semantics: `pd diagnose run` exits 1 when candidate intake was
    // (partially) refused — the DIAGNOSIS itself may be fully succeeded (the
    // DB is the authority). Admission-gate refusals are a LEGITIMATE terminal
    // state (SPEC §4.4: the original gate is never bypassed): a diagnosis whose
    // candidates were all refused (e.g. confidence_below_threshold) is a
    // CORRECT pipeline outcome — recorded explicitly, formation never runs.
    const intake = (() => { try { return JSON.parse(diag.stdout).intake; } catch { return null; } })();
    const intakeCandidates = intake?.candidates ?? [];
    const allRefused = intakeCandidates.length > 0 && intakeCandidates.every((c) => c.status === 'intake_failed');
    record.admissionRefused = allRefused ? intakeCandidates.map((c) => ({ candidateId: c.candidateId, error: c.error })) : null;
    verification.admissionRefused = record.admissionRefused;
    const diagnoseStatusSucceeded = /"status":\s*"succeeded"/.test(diag.stdout);
    verification.checks.diagnoseOk = diag.code === 0 || diagnoseStatusSucceeded || allRefused;
    verification.checks.routerTaskSucceeded = finalRouter === 'succeeded';
    verification.checks.routerRunSucceeded = Boolean(routerRun);
    const schemaCheck = validateStageArtifacts(record.artifacts, newTaskId);
    verification.checks.stageArtifactsSchemaValid = schemaCheck.ok;
    verification.checks.candidatesPresent = (record.artifacts.candidates?.length ?? 0) > 0;
    verification.errors = schemaCheck.errors;
    verification.ok = Object.values(verification.checks).every(Boolean);
    record.verification = verification;
    record.artifactsSha256 = sha256(JSON.stringify({
      stageArtifacts: (record.artifacts.stageArtifacts ?? []).map((a) => a.artifact_id),
      candidates: (record.artifacts.candidates ?? []).map((c) => c.candidate_id),
      formationArtifacts: (record.artifacts.formationArtifacts ?? []).map((a) => a.artifact_id),
    }));
    record.status = verification.ok ? (record.admissionRefused ? 'done-admission-refused' : 'done') : (finalRouter === 'succeeded' ? 'incomplete' : 'failed');
    record.finishedAt = new Date().toISOString();
    fs.writeFileSync(repPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
    return record;
  } catch (err) {
    record.status = 'failed';
    record.errorCategory = 'harness_exception';
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
        console.log(`[${new Date().toISOString()}] ${sample.experimentPainId} rep${rep} ${arm} (shard ${args.shardId}) …`);
        const r = await runSampleArm(sample, arm, rep);
        console.log(`  -> ${r.status}${r.errorCategory ? ' (' + r.errorCategory + ')' : ''}`);
      }
    }
  }
  manifest.updatedAt = new Date().toISOString();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log('run complete ->', dir);
})();
