/**
 * PD-SPEC-001 round 2 — Experiment A: Dreamer standalone PAIRED A/B (SPEC §7.2).
 *
 * Design: the ONLY experiment variable is the Dreamer systemPrompt (V2 control
 * vs V2.1 treatment). Everything upstream of Dreamer must therefore be
 * BYTE-IDENTICAL across arms:
 *
 *   upstream phase (control arm dist, v2c — diagnostician prompts are identical
 *   in both arms by fingerprint proof):
 *     per sample: fresh workspace → pd pain record → pd diagnose run
 *     (Stage A/B/C + intake). If the admission gate refuses all candidates,
 *     the sample has NO Dreamer input → recorded as not-applicable (SPEC §4.4
 *     legitimate terminal state; never fabricated, never replaced with
 *     synthetic input).
 *
 *   paired phase (per sample × rep × arm):
 *     restore the post-diagnosis upstream workspace (state.db + wal/shm +
 *     trajectory + memory; config re-derived for the new path) into a
 *     per-(sample, rep, arm) workspace → run the formation loop (dreamer →
 *     philosopher → scribe round-robin) with the ARM's own dist → strict
 *     terminal verification (all formation tasks succeeded + Dreamer artifact
 *     passes DreamerOutputV1Schema from the arm's own dist + chain quiescent).
 *
 * Because the clone starts from the SAME post-diagnosis state, Dreamer's
 * predecessorOutput/contextRefs/taskId set is identical across arms per
 * (sample, rep); the candidate uuids are identical too, so per-chain pairing
 * is exact (sid, rep, candidateId).
 *
 * Reps: dataset.repeatRunPicks (5 representative samples) run 3 reps; every
 * other Dreamer-capable sample runs rep0 only. Reps observe stability — they
 * are NOT independent pain samples.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  bootstrapConfigContext, configArms, armRoles, armWorktree, baselineArmId, candidateArmId, datasetFile as datasetFileRef,
  experimentRoot, runPd, loadDataset, runDir, armOrderFor,
  materializeWorkspace, materializeWorkspaceFiles, gitHead, childEnv, sha256, sha256File, armWorkspaceDir,
  deriveExperimentConfig, buildIngressArgs, preflightChecks, validateRunId,
} from './ab-lib.mjs';
import { writeFileIfAbsent } from './atomic-file.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { Value } = require('@sinclair/typebox/value');

// Formation output schemas are validated from EACH ARM'S OWN dist — the arm
// gates its own artifacts (same pattern as round-1 ab-run).
async function loadArmSchemas(worktree) {
  const coreDist = (p) => 'file://' + path.join(worktree, 'packages/principles-core/dist', p).replace(/\\/g, '/');
  const [dreamer, philosopher, scribe] = await Promise.all([
    import(coreDist('runtime/internalization/dreamer-output.js')),
    import(coreDist('runtime/internalization/philosopher-output.js')),
    import(coreDist('runtime/internalization/scribe-output.js')),
  ]);
  return {
    dreamer: dreamer.DreamerOutputV1Schema,
    philosopher: philosopher.PhilosopherOutputV1Schema,
    scribe: scribe.ScribeOutputV1Schema,
  };
}

function parseArgs(argv) {
  const out = { arms: null, maxFormationLoops: 24, samples: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run-id') out.runId = argv[++i];
    else if (a === '--arms') out.arms = argv[++i].split(',');
    else if (a === '--samples') out.samples = argv[++i].split(',');
    else if (a === '--max-formation-loops') out.maxFormationLoops = Number(argv[++i]);
    else if (a === '--config') { ++i; /* consumed by bootstrapConfigContext */ }
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!out.runId) throw new Error('--run-id is required');
  return out;
}

bootstrapConfigContext(process.argv, 'usage: node ab-dreamer-paired.mjs --config <experiment-config.json> --run-id <id> [--samples S1,S2] [--arms <armA>,<armB>] [--max-formation-loops N]');
const args = parseArgs(process.argv);
{
  const configured = configArms();
  if (args.arms && ([...args.arms].sort().join(',') !== [...configured].sort().join(',') || args.arms.length !== 2)) {
    throw new Error(`--arms must be exactly the configured arm pair (${configured.join(',')} in any order)`);
  }
  args.arms = args.arms ?? configured;
}
const baselineArm = baselineArmId();
const candidateArm = candidateArmId();
// PRI-1254 r2 (review 0005): the paired entry drives REAL child processes
// (upstream diagnosis + per-arm formation) — the full generic preflight must
// pass BEFORE any workspace materialization, record write or child spawn.
{
  const pre = preflightChecks();
  if (!pre.ok) {
    console.error('paired preflight failed BEFORE any side effect:');
    for (const c of pre.checks.filter((x) => !x.ok)) console.error(`  - ${c.name}: ${JSON.stringify(c.detail).slice(0, 400)}`);
    process.exit(1);
  }
}
const dataset = loadDataset();
const dir = runDir(args.runId); // validateRunId + create (TECH §4.5)
const recordsDir = path.join(dir, 'records');
fs.mkdirSync(recordsDir, { recursive: true });

const armSchemas = {};
for (const arm of args.arms) armSchemas[arm] = await loadArmSchemas(armWorktree(arm));

const manifestPath = path.join(dir, 'paired-manifest.json');
const manifest = {
  runId: args.runId,
  experiment: 'PD-SPEC-001 round 2 — Experiment A (Dreamer standalone paired A/B)',
  startedAt: new Date().toISOString(),
  roles: armRoles(),
  arms: Object.fromEntries(configArms().map((armId) => [
    armId,
    { role: armId === baselineArm ? 'baseline' : 'candidate', head: gitHead(armWorktree(armId)), worktree: armWorktree(armId) },
  ])),
  pairing: 'upstream diagnosis runs ONCE per sample in the control arm dist; the post-diagnosis workspace is cloned per (sample, rep, arm) so predecessorOutput/contextRefs/candidate uuids are identical across arms',
  datasetSha256: sha256File(datasetFileRef()),
  upstream: {}, // sid -> { taskId, intakeSummary, predecessorArtifactsSha }
};
manifest.updatedAt = new Date().toISOString();
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

// ---------------------------------------------------------------------------
// workspace helpers
// ---------------------------------------------------------------------------

const upShard = (sid) => `up-${sid}`;
const cloneShard = (sid, rep, arm) => `${arm}-p${sid}-r${rep}`;
const DB_FILES = ['state.db', 'state.db-wal', 'state.db-shm'];

function snapshotUpstream(sid) {
  const src = armWorkspaceDir(baselineArm, upShard(sid));
  const stage = path.join(experimentRoot(), 'upstream-snapshots', args.runId, sid);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, '.pd'), { recursive: true });
  fs.mkdirSync(path.join(stage, '.state'), { recursive: true });
  for (const f of DB_FILES) {
    const p = path.join(src, '.pd', f);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(stage, '.pd', f));
  }
  for (const f of DB_FILES) {
    const p = path.join(src, '.state', f);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(stage, '.state', f));
  }
  const memSrc = path.join(src, 'memory');
  if (fs.existsSync(memSrc)) fs.cpSync(memSrc, path.join(stage, 'memory'), { recursive: true });
  // Digest of the upstream diagnosis artifacts (pairing evidence).
  const db = new Database(path.join(stage, '.pd', 'state.db'), { readonly: true });
  try {
    const arts = db.prepare("SELECT artifact_id, source_task_id, artifact_kind FROM pi_artifacts WHERE source_task_id LIKE 'diag_%' ORDER BY artifact_id").all();
    return { stage, artifactsSha: sha256(JSON.stringify(arts)), artifactCount: arts.length };
  } finally { db.close(); }
}

function restoreClone(stage, arm, sid, rep) {
  const ws = armWorkspaceDir(arm, cloneShard(sid, rep, arm));
  fs.rmSync(ws, { recursive: true, force: true });
  fs.mkdirSync(path.join(ws, '.pd'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.state'), { recursive: true });
  for (const f of DB_FILES) {
    const p = path.join(stage, '.pd', f);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(ws, '.pd', f));
  }
  for (const f of DB_FILES) {
    const p = path.join(stage, '.state', f);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(ws, '.state', f));
  }
  const memSrc = path.join(stage, 'memory');
  if (fs.existsSync(memSrc)) fs.cpSync(memSrc, path.join(ws, 'memory'), { recursive: true });
  // PRI-1254 r2 (review 0004): the clone must ALSO install the arm's declared
  // workspaceFiles — a clone that skips them silently drops the declared
  // intervention inputs (same digest/escape/symlink fences as materialize).
  materializeWorkspaceFiles(arm, ws);
  // Config MUST be re-derived for the new workspace path (workspace.default) —
  // done by the caller via deriveConfigFor(ws) after restore.
  return ws;
}

// ---------------------------------------------------------------------------
// upstream phase
// ---------------------------------------------------------------------------

function reapExpiredLeases(ws, taskId, nowIso) {
  const db = new Database(path.join(ws, '.pd', 'state.db'));
  try {
    const info = db.prepare(
      `UPDATE tasks SET status = 'retry_wait', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE task_id IN (?,?,?,?) AND status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
    ).run(nowIso, taskId, `diag_rootcause-${taskId}`, `diag_distiller-${taskId}`, `diag_router-${taskId}`, nowIso);
    return info.changes;
  } finally { db.close(); }
}

async function runUpstream(sample) {
  const sid = sample.experimentPainId;
  const upPath = path.join(recordsDir, `${sid}.upstream.json`);
  const prior = (() => { try { return JSON.parse(fs.readFileSync(upPath, 'utf8')); } catch { return null; } })();
  if (prior && prior.status && prior.status !== 'running') return prior;

  // Fresh upstream workspace per sample (fail on collision — shard isolation).
  // The upstream phase runs in the BASELINE arm's dist (roles from config).
  const ws = armWorkspaceDir(baselineArm, upShard(sid));
  fs.rmSync(ws, { recursive: true, force: true });
  materializeWorkspace(baselineArm, { shardId: upShard(sid) });

  const record = { experimentPainId: sid, status: 'running', steps: [], startedAt: new Date().toISOString() };
  const save = () => fs.writeFileSync(upPath, JSON.stringify(record, null, 2) + '\n', 'utf8');

  const painEvent = sample.painEvent;
  // TECH §7 ingress contract (shared buildIngressArgs): score not confidence,
  // reason<=500 with truncation recorded, host by host_kind evidence, and a
  // session binding failure is a SAMPLE failure — never an auto-unbound
  // re-record (input category must not change).
  const { argv: recArgs, evidence } = buildIngressArgs(painEvent);
  record.ingress = evidence;
  // PRI-1254 r2 (review P1-02): session-bound + unexpressible host → refuse
  // BEFORE any CLI invocation (no write, no openclaw default, no re-record).
  if (evidence.hostDecision?.failClosed === true) {
    record.ingressMode = 'ingress_host_unresolvable';
    record.status = 'upstream-failed';
    record.errorCategory = 'ingress_host_unresolvable';
    record.finishedAt = new Date().toISOString();
    record.steps.push({ step: 'ingress-host-unresolvable', at: new Date().toISOString(), basis: evidence.hostDecision.basis });
    save();
    return record;
  }
  let ingress = await runPd(baselineArm, recArgs, { shardId: upShard(sid) });
  if (ingress.code !== 0 && /session_not_found|sentinel/i.test(ingress.stdout + ingress.stderr)) {
    record.ingress.bindingFailure = { reason: 'session_not_found|sentinel', stdoutTail: ingress.stdout.slice(-1500) };
    record.ingressMode = 'ingress_binding_failed';
    record.status = 'upstream-failed';
    record.errorCategory = 'ingress_binding_failed';
    record.finishedAt = new Date().toISOString();
    record.steps.push({ step: 'ingress-binding-failed', at: new Date().toISOString(), code: ingress.code });
    save();
    return record;
  } else {
    record.ingressMode = evidence.ingressMode;
  }
  record.steps.push({ step: 'ingress', at: new Date().toISOString(), mode: record.ingressMode, code: ingress.code, stdoutTail: ingress.stdout.slice(-2000) });
  save();
  let newTaskId = null;
  try {
    const j = JSON.parse(ingress.stdout.slice(ingress.stdout.indexOf('{')));
    newTaskId = j.taskId ?? j.task_id ?? (j.pain ? j.pain.taskId : null) ?? (j.diagnosis ? j.diagnosis.taskId : null);
  } catch { /* tail retained */ }
  if (ingress.code !== 0 || !newTaskId) {
    record.status = 'upstream-failed';
    record.errorCategory = 'ingress_failed';
    record.finishedAt = new Date().toISOString();
    save();
    return record;
  }
  record.taskId = newTaskId;

  reapExpiredLeases(ws, newTaskId, new Date().toISOString());
  const diag = await runPd(baselineArm, ['diagnose', 'run', '--task-id', newTaskId], { timeoutMs: 3 * 60 * 60_000, shardId: upShard(sid) });
  record.steps.push({ step: 'diagnose-run', at: new Date().toISOString(), code: diag.code, stdoutTail: diag.stdout.slice(-4000) });
  save();

  const intake = (() => { try { return JSON.parse(diag.stdout).intake; } catch { return null; } })();
  const intakeCandidates = intake?.candidates ?? [];
  // Intake statuses: 'dreamer_seeded' = admitted with a seeded dreamer task
  // (formation will run); 'consumed' = consumed without formation; 'intake_failed'
  // = admission-gate refusal (SPEC §4.4 legitimate terminal state).
  const dreamerSeededIds = [...new Set(intakeCandidates.filter((c) => c.status === 'dreamer_seeded').map((c) => c.candidateId))];
  const hasDreamerInput = dreamerSeededIds.length > 0;
  record.intake = { candidates: intakeCandidates.length, dreamerSeeded: dreamerSeededIds.length, statuses: intakeCandidates.map((c) => c.status) };

  const dbPath = path.join(ws, '.pd', 'state.db');
  const routerStatus = new Database(dbPath, { readonly: true });
  const router = routerStatus.prepare('SELECT status FROM tasks WHERE task_id = ?').get(`diag_router-${newTaskId}`);
  routerStatus.close();

  if (hasDreamerInput && (diag.code === 0 || /"status":\s*"succeeded"/.test(diag.stdout)) && router?.status === 'succeeded') {
    const snap = snapshotUpstream(sid);
    record.upstreamSnapshot = { stage: snap.stage, artifactsSha: snap.artifactsSha, artifactCount: snap.artifactCount };
    record.dreamerSeededCandidateIds = dreamerSeededIds;
    record.status = 'admitted';
  } else if (intakeCandidates.length > 0 && !hasDreamerInput) {
    record.status = 'no-dreamer-input'; // SPEC §4.4: legitimate terminal state
  } else {
    record.status = 'upstream-failed';
    record.errorCategory = diag.code !== 0 ? 'diagnose_failed' : 'router_not_succeeded';
  }
  record.finishedAt = new Date().toISOString();
  save();
  return record;
}

// ---------------------------------------------------------------------------
// paired phase
// ---------------------------------------------------------------------------

function collectPairedArtifacts(ws, taskId) {
  const state = new Database(path.join(ws, '.pd', 'state.db'), { readonly: true, fileMustExist: true });
  try {
    const stageIds = [taskId, `diag_rootcause-${taskId}`, `diag_distiller-${taskId}`, `diag_router-${taskId}`];
    const cands = state.prepare('SELECT candidate_id, task_id, status, recommendation_kind, title FROM principle_candidates WHERE task_id IN (?,?,?,?)').all(...stageIds);
    const candIds = cands.map((c) => c.candidate_id);
    let formationTasks = [];
    if (candIds.length > 0) {
      const like = candIds.map(() => 'task_id LIKE ?').join(' OR ');
      formationTasks = state.prepare(`SELECT task_id, task_kind, status, attempt_count, last_error, created_at FROM tasks WHERE task_kind IN ('dreamer','philosopher','scribe') AND (${like}) ORDER BY created_at`).all(...candIds.map((id) => `%${id}%`));
    }
    const fmtIds = formationTasks.map((t) => t.task_id);
    const formationArts = fmtIds.length > 0
      ? state.prepare(`SELECT artifact_id, artifact_kind, source_task_id, content_json, created_at FROM pi_artifacts WHERE source_task_id IN (${fmtIds.map(() => '?').join(',')}) ORDER BY created_at`).all(...fmtIds)
      : [];
    const runs = state.prepare('SELECT task_id, execution_status, attempt_number, started_at, ended_at FROM runs WHERE task_id IN (' + [...stageIds, ...fmtIds].map(() => '?').join(',') + ') ORDER BY started_at').all(...stageIds, ...fmtIds);
    return { candidates: cands, formationTasks, formationArtifacts: formationArts, runs };
  } finally { state.close(); }
}

function validateFormationArtifacts(artifacts, schemasForArm) {
  const errors = [];
  const byKind = { dreamer: [], philosopher: [], scribe: [] };
  for (const a of artifacts.formationArtifacts ?? []) {
    for (const kind of ['dreamer', 'philosopher', 'scribe']) {
      if (a.source_task_id.startsWith(`${kind}-`)) byKind[kind].push(a);
    }
  }
  const perTaskFinal = {};
  for (const [kind, arts] of Object.entries(byKind)) {
    for (const a of arts) {
      (perTaskFinal[a.source_task_id] ??= { kind, last: a });
      perTaskFinal[a.source_task_id].last = a; // ordered by created_at
    }
  }
  for (const [taskId2, { kind, last }] of Object.entries(perTaskFinal)) {
    let parsed;
    try { parsed = JSON.parse(last.content_json); } catch { errors.push(`${taskId2}: JSON unparseable`); continue; }
    // Dreamer/philosopher/scribe artifacts may be wrapped by the runner
    // (payload envelope). Validate the innermost document that has `valid`.
    const doc = parsed?.output ?? parsed;
    const schema = schemasForArm[kind];
    if (!schema) { errors.push(`${taskId2}: no schema for ${kind}`); continue; }
    if (!Value.Check(schema, doc)) {
      const msgs = [...Value.Errors(schema, doc)].slice(0, 3).map((e) => `${e.path}: ${e.message}`);
      errors.push(`${taskId2}: ${kind} schema invalid — ${msgs.join('; ')}`);
    }
    last.schemaValidated = true;
    last.schemaKind = kind;
  }
  return { ok: errors.length === 0, errors, byKindCounts: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, v.length])) };
}

async function runPairedArm(sample, rep, arm, upstream) {
  const sid = sample.experimentPainId;
  const recPath = path.join(recordsDir, `${sid}.r${rep}.${arm}.json`);
  const prior = (() => { try { return JSON.parse(fs.readFileSync(recPath, 'utf8')); } catch { return null; } })();
  if (prior && prior.status === 'done' && prior.verification?.ok === true) return prior;

  const ws = restoreClone(upstream.upstreamSnapshot.stage, arm, sid, rep);
  fs.writeFileSync(path.join(ws, '.pd', 'config.yaml'), deriveExperimentConfig(ws, arm), 'utf8');

  const record = {
    experimentPainId: sid, rep, arm, upstreamTaskId: upstream.taskId,
    upstreamArtifactsSha: upstream.upstreamSnapshot.artifactsSha,
    workspace: path.relative(experimentRoot(), ws),
    steps: [], status: 'running', startedAt: new Date().toISOString(),
  };
  const save = () => fs.writeFileSync(recPath, JSON.stringify(record, null, 2) + '\n', 'utf8');

  const chainState = () => {
    const sdb = new Database(path.join(ws, '.pd', 'state.db'), { readonly: true });
    try {
      const live = sdb.prepare("SELECT count(*) AS c FROM tasks WHERE task_kind IN ('dreamer','philosopher','scribe') AND status IN ('pending','leased','running','retry_wait')").get().c;
      const byKind = sdb.prepare("SELECT task_kind, status, count(*) AS c FROM tasks WHERE task_kind IN ('dreamer','philosopher','scribe') GROUP BY task_kind, status").all();
      return { liveInternalization: live, byKind };
    } finally { sdb.close(); }
  };

  const loopLog = [];
  for (let i = 0; i < args.maxFormationLoops; i++) {
    const st = chainState();
    if (st.liveInternalization === 0) { loopLog.push({ i, note: 'terminal' }); break; }
    for (const runner of ['dreamer', 'philosopher', 'scribe']) {
      const once = await runPd(arm, ['runtime', 'internalization', 'run-once', '--runner', runner], { timeoutMs: 30 * 60_000, shardId: cloneShard(sid, rep, arm) });
      let j = null;
      try { j = JSON.parse(once.stdout.slice(once.stdout.indexOf('{'))); } catch { /* raw */ }
      loopLog.push({ i, runner, code: once.code, decision: j?.decision ?? 'unknown', reason: j?.reason ?? null });
    }
  }
  record.steps.push({ step: 'formation-loop', at: new Date().toISOString(), rounds: loopLog.length, tail: loopLog.slice(-10) });
  save();

  record.artifacts = collectPairedArtifacts(ws, upstream.taskId);
  const sdb = new Database(path.join(ws, '.pd', 'state.db'), { readonly: true });
  let allTerminal = { fmt: 0, ok: 0, review: 0, failed: 0 };
  let byKindStatus = {};
  try {
    const rows = sdb.prepare("SELECT task_kind, status, count(*) AS c FROM tasks WHERE task_kind IN ('dreamer','philosopher','scribe') GROUP BY task_kind, status").all();
    byKindStatus = rows;
    // Terminal-state accounting (SPEC §4.4 discipline):
    //  - 'succeeded' = ran and produced schema-valid artifacts;
    //  - 'needs_human_review' = PD governance gate set at dispatch time (0
    //    attempts) — a LEGITIMATE terminal state, never a harness failure;
    //    it is cloned upstream state, symmetric across arms, and disclosed;
    //  - 'failed' = a real pipeline failure — verification fails.
    const fmt = sdb.prepare("SELECT count(*) AS c FROM tasks WHERE task_kind IN ('dreamer','philosopher','scribe')").get().c;
    const ok = sdb.prepare("SELECT count(*) AS c FROM tasks WHERE task_kind IN ('dreamer','philosopher','scribe') AND status = 'succeeded'").get().c;
    const review = sdb.prepare("SELECT count(*) AS c FROM tasks WHERE task_kind IN ('dreamer','philosopher','scribe') AND status = 'needs_human_review'").get().c;
    const failed = sdb.prepare("SELECT count(*) AS c FROM tasks WHERE task_kind IN ('dreamer','philosopher','scribe') AND status = 'failed'").get().c;
    allTerminal = { fmt, ok, review, failed };
  } finally { sdb.close(); }

  const schemaCheck = validateFormationArtifacts(record.artifacts, armSchemas[arm]);
  const verification = {
    checks: {
      chainQuiescent: chainState().liveInternalization === 0,
      noFailedFormationTasks: allTerminal.failed === 0,
      ranTasksSucceeded: (allTerminal.ok + allTerminal.review) === allTerminal.fmt,
      formationArtifactsSchemaValid: schemaCheck.ok,
      dreamerRan: (record.artifacts.formationArtifacts ?? []).some((a) => a.source_task_id.startsWith('dreamer-')),
    },
    needsHumanReviewTasks: allTerminal.review,
    errors: schemaCheck.errors,
  };
  verification.ok = Object.values(verification.checks).every(Boolean);
  record.verification = verification;
  record.byKindStatus = byKindStatus;
  record.dreamerCandidateCounts = (record.artifacts.formationArtifacts ?? [])
    .filter((a) => a.source_task_id.startsWith('dreamer-'))
    .map((a) => {
      try { const d = JSON.parse(a.content_json); return { taskId: a.source_task_id, count: (d?.output ?? d)?.candidates?.length ?? null, valid: (d?.output ?? d)?.valid ?? null }; }
      catch { return { taskId: a.source_task_id, count: null, valid: null }; }
    });
  record.artifactsSha256 = sha256(JSON.stringify({
    candidates: (record.artifacts.candidates ?? []).map((c) => c.candidate_id),
    formationArtifacts: (record.artifacts.formationArtifacts ?? []).map((a) => a.artifact_id),
  }));
  record.status = verification.ok ? 'done' : 'incomplete';
  record.finishedAt = new Date().toISOString();
  save();
  return record;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const globalIndexById = new Map(dataset.samples.map((s, i) => [s.experimentPainId, i]));
const repeatPicks = dataset.repeatRunPicks ?? [];
const repsFor = (sid) => (repeatPicks.includes(sid) ? [0, 1, 2] : [0]);

(async () => {
  const samples = dataset.samples
    .filter((s) => (args.samples ? args.samples.includes(s.experimentPainId) : true))
    .map((s) => ({ ...s, _stageAOnly: s.sampleCategory === 'stage-a-only' }));

  for (let si = 0; si < samples.length; si++) {
    const sample = samples[si];
    const sid = sample.experimentPainId;
    if (sample._stageAOnly) {
      const p = path.join(recordsDir, `${sid}.upstream.json`);
      writeFileIfAbsent(
        p,
        JSON.stringify({ experimentPainId: sid, status: 'stage-a-only-no-dreamer-input', note: 'frozen dataset marks this sample Stage-A-only — no Dreamer upstream exists; not fabricated (SPEC §7.2)' }, null, 2) + '\n',
      );
      console.log(`[${sid}] stage-A-only → N/A`);
      continue;
    }
    const upstream = await runUpstream(sample);
    manifest.upstream[sid] = { taskId: upstream.taskId ?? null, status: upstream.status, intake: upstream.intake ?? null, artifactsSha: upstream.upstreamSnapshot?.artifactsSha ?? null };
    manifest.updatedAt = new Date().toISOString();
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log(`[${new Date().toISOString()}] ${sid} upstream: ${upstream.status}${upstream.intake ? ` (candidates=${upstream.intake.candidates}, dreamerSeeded=${upstream.intake.dreamerSeeded})` : ''}`);
    if (upstream.status !== 'admitted') continue;

    const order = armOrderFor(args.runId, globalIndexById.get(sid) ?? si, args.arms);
    for (const rep of repsFor(sid)) {
      for (const arm of order) {
        if (!args.arms.includes(arm)) continue;
        console.log(`  ${sid} rep${rep} ${arm} …`);
        const r = await runPairedArm(sample, rep, arm, upstream);
        console.log(`  -> ${r.status}${r.verification?.ok ? '' : ' (verification FAILED)'}`);
      }
    }
  }
  manifest.updatedAt = new Date().toISOString();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log('paired run complete ->', dir);
})();
