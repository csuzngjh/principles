/**
 * PD-SPEC-001 A/B executor — remediated (Owner directive Phase 4); config-
 * driven + ingress contract per PD-Lab v0.3 T3b (PRI-1254, TECH §7).
 *
 * Drives the REAL production chain per arm per shard:
 *   pd pain record (ingress; TECH §7 ingress contract)
 *   → pd diagnose run (Stage A/B/C + candidate intake + dreamer seeding)
 *   → pd runtime internalization run-once --runner dreamer|philosopher|scribe
 *
 * T3b ingress contract (TECH §7):
 *   - --score takes painEvent.score (NEVER confidence — different semantics);
 *   - --reason truncated to <=500 chars BEFORE the CLI (MAX_REASON_LENGTH is
 *     a hard CLI rejection) and the truncation is recorded per sample;
 *   - session binding failure records the terminal state
 *     'ingress_binding_failed' — NO automatic unbound re-record (that would
 *     change the research subject's input category);
 *   - --host follows the sample's host_kind + session evidence; an empty
 *     host_kind never masquerades as openclaw (PT-05);
 *   - every sample records its ingressMode, input digest, truncation and
 *     binding facts; credentials are never recorded.
 * Terminal states: done / done-admission-refused / done-deferred
 * (legitimate research outcomes, NOT harness failures) / incomplete /
 * failed / ingress_binding_failed. `done-no-candidate` is retired as a
 * producible terminal (PRI-1256 r3): the current commit contract always
 * persists >=1 candidate on success, so a chain that verifies without
 * candidates is `incomplete`. The terminal survives ONLY inside already
 * persisted historical records, which the resume set below still honors.
 *
 * The run manifest records the TECH §7 digest set (experimentId,
 * configSha256, preregistrationStatus/Sha256, per-arm heads + derived-config
 * digests, dataset + snapshot digests) — replacing the hardcoded heads.v1/v2.
 * Before the FIRST run-record write / child process, the generic preflight
 * is RE-RUN from the current files (CF-16 — never a stale preflight result).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  bootstrapConfigContext, currentConfig, configArms, armWorktree, runPd, loadDataset,
  runDir, armOrderFor, materializeWorkspace, gitHead, childEnv, sha256, sha256File,
  armWorkspaceDir, preflightChecks,
} from './ab-lib.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const USAGE = 'usage: node ab-run.mjs --config <experiment-config.json> --run-id <id> [--samples S1,S2] [--arms <armA>,<armB>] [--shard-id <id>] [--max-formation-loops N]';

function parseArgs(argv) {
  const out = { samples: null, arms: null, shardId: 'solo', maxFormationLoops: 24 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run-id') out.runId = argv[++i];
    else if (a === '--samples') out.samples = argv[++i].split(',');
    else if (a === '--arms') out.arms = argv[++i].split(',');
    else if (a === '--shard-id') out.shardId = argv[++i];
    else if (a === '--max-formation-loops') out.maxFormationLoops = Number(argv[++i]);
    else if (a !== '--config' && !(i > 0 && argv[i - 1] === '--config')) throw new Error(`unknown arg: ${a}`);
  }
  if (!out.runId) throw new Error('--run-id is required');
  return out;
}

const config = bootstrapConfigContext(process.argv, USAGE);
const args = parseArgs(process.argv);

// Arms come from the config; --arms (when given) must be exactly the
// configured pair (any order) — never a default, never an unknown arm.
const configuredArms = configArms();
const arms = args.arms ?? configuredArms;
{
  const sorted = (xs) => [...xs].sort();
  if (args.arms && (sorted(args.arms).join(',') !== sorted(configuredArms).join(',') || args.arms.length !== 2)) {
    throw new Error(`--arms must be exactly the configured arm pair (${configuredArms.join(',')} in any order) — got ${args.arms.join(',')}`);
  }
}

// CF-16: re-run the generic preflight from the CURRENT files BEFORE the
// first run-record write or child process. bootstrapConfigContext already
// re-loaded the config (fresh digests); preflightChecks adds HEAD/dist/
// modelEnv/derived-diff on top. Any failure exits non-zero here.
const preflight = preflightChecks();
if (!preflight.ok) {
  console.error('preflight failed BEFORE any run record was written:');
  for (const c of preflight.checks.filter((x) => !x.ok)) console.error(`  - ${c.name}: ${JSON.stringify(c.detail).slice(0, 400)}`);
  process.exit(1);
}

const dataset = loadDataset(); // fail-closed: full fidelity, EVERY sample probed
const dir = runDir(args.runId); // validates runId (pattern + strict under-runs + reparse fence)
const recordsDir = path.join(dir, 'records');
fs.mkdirSync(recordsDir, { recursive: true });

// Global sample index (CF-12): arm order must be a function of the sample's
// position in the FULL dataset, never the shard-local list position.
const globalIndexById = new Map(dataset.samples.map((s, i) => [s.experimentPainId, i]));

// Manifest FIRST (visibility), then workspaces (per-artifact atomic placement).
const shardId = sha256((args.samples ?? ['ALL']).join(',') + '|' + args.shardId).slice(0, 8);
const manifestPath = path.join(dir, `run-manifest.${shardId}.json`);
const cfg = currentConfig();
const manifest = {
  runId: args.runId,
  shard: args.samples ?? 'ALL',
  shardId: args.shardId,
  startedAt: new Date().toISOString(),
  experimentId: cfg.experimentId,
  configSha256: cfg.verification.configSha256,
  preregistrationStatus: cfg.verification.preregistrationStatus,
  preregistrationSha256: cfg.verification.preregistrationSha256,
  roles: { baseline: cfg.baselineArm, candidate: cfg.candidateArm },
  arms: Object.fromEntries(configuredArms.map((armId) => [
    armId,
    {
      head: gitHead(armWorktree(armId)),
      expectedHead: cfg.arms[armId].expectedHead,
      worktree: armWorktree(armId),
    },
  ])),
  datasetFile: cfg.dataset.file,
  datasetSha256: cfg.dataset.sha256,
  snapshot: { dir: cfg.snapshot.dir, sha256: cfg.snapshot.sha256 },
};
manifest.updatedAt = new Date().toISOString();
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

// Materialize this shard's OWN arm workspaces (never shared across shards);
// the derived-config digest per arm is recorded after materialization.
for (const arm of arms) {
  const m = materializeWorkspace(arm, { shardId: args.shardId });
  manifest.arms[arm].derivedConfigSha256 = m.configSha256;
}
manifest.updatedAt = new Date().toISOString();
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

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
    // The committed diagnostician_output artifact anchors the
    // recommendation->candidate linkage check (PRI-1256 r4).
    const commitArtifact = state.prepare(
      `SELECT artifact_id, run_id, task_id, artifact_kind, content_json FROM artifacts WHERE task_id = ? AND artifact_kind = 'diagnostician_output' ORDER BY created_at LIMIT 1`,
    ).get(`diag_router-${taskId}`) ?? null;
    const routerRun = state.prepare("SELECT run_id FROM runs WHERE task_id = ? AND execution_status = 'succeeded' ORDER BY attempt_number DESC LIMIT 1").get(`diag_router-${taskId}`) ?? null;
    // PRI-1256 r6 (P2-02): the candidate query spans ALL THREE production
    // anchors — the four stage task_ids, the current commit artifact and
    // the actual succeeded router run — so an extra candidate whose
    // task_id alone is wrong can no longer escape verification. Missing
    // anchors widen nothing (fail-closed): no placeholder conditions are
    // fabricated for an absent commit artifact or succeeded run.
    const candWhere = ['task_id IN (?,?,?,?)'];
    const candParams = [...stageIds];
    if (commitArtifact) { candWhere.push('artifact_id = ?'); candParams.push(commitArtifact.artifact_id); }
    if (routerRun) { candWhere.push('source_run_id = ?'); candParams.push(routerRun.run_id); }
    const cands = state.prepare(`SELECT candidate_id, task_id, status, recommendation_kind, abstracted_principle, title, artifact_id, source_run_id, source_recommendation_json FROM principle_candidates WHERE ${candWhere.join(' OR ')}`).all(...candParams);
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
    return { stageArtifacts: arts, candidates: cands, formationTasks, formationArtifacts: formationArts, painDiagnosis: diagRow, runs, commitArtifact, routerRun };
  } finally { state.close(); }
}

// TypeBox validation is loaded LAZILY from each arm's own dist (the arm gates
// its own artifacts; loading at module top level would require the dist to
// exist before --config validation could even run).
const schemaCache = new Map();
async function schemasFor(arm) {
  if (schemaCache.has(arm)) return schemaCache.get(arm);
  const coreDist = (p) => 'file://' + path.join(armWorktree(arm), 'packages/principles-core/dist', p).replace(/\\/g, '/');
  const { Value } = require('@sinclair/typebox/value');
  const rootcause = (await import(coreDist('runtime/diagnostician/diag-rootcause-output.js'))).DiagRootCauseOutputV1Schema;
  const distiller = (await import(coreDist('runtime/diagnostician/diag-distiller-output.js'))).DiagDistillerOutputV1Schema;
  const envelope = await import(coreDist('runtime/diagnostician-output.js'));
  const loaded = { Value, rootcause, distiller, routerEnvelope: envelope.readDiagnosticianOutputFromEnvelope };
  schemaCache.set(arm, loaded);
  return loaded;
}

/** Schema-validate the terminal artifact of each stage (arm's own dist gates). */
async function validateStageArtifacts(arm, artifacts, taskId) {
  const schemas = await schemasFor(arm);
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
    try { parsed = JSON.parse(last.content_json); } catch { errors.push(`${stage}: artifact JSON unparseable`); continue; }
    if (stage === 'router') {
      const out = schemas.routerEnvelope(parsed);
      if (!out) errors.push('router: artifact failed envelope schema validation');
    } else {
      const schema = schemas[stage];
      if (!schemas.Value.Check(schema, parsed)) {
        const msgs = [...schemas.Value.Errors(schema, parsed)].slice(0, 3).map((e) => `${e.path}: ${e.message}`);
        errors.push(`${stage}: schema invalid — ${msgs.join('; ')}`);
      }
    }
    last.schemaValidated = true;
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Ingress contract (TECH §7 / T3b §5.8) — shared helpers re-exported from
// ab-lib so every ingress site (ab-run chain + paired upstream) follows the
// SAME contract: score (never confidence), reason<=500 + truncation record,
// session-binding failure is a sample failure, host by host_kind evidence.
// ---------------------------------------------------------------------------

import { buildIngressArgs, classifyTerminal, detectDeferOnly, verifyCandidateLinkage } from './ab-lib.mjs';

/**
 * The closed set of completed terminals resume may honor from a PERSISTED
 * record (TECH §7 终态语义 + PRI-1256 r3): 'done-no-candidate' stays ONLY
 * for pre-existing historical records — classifyTerminal can no longer
 * produce it, so it can never appear on a fresh run record.
 */
const COMPLETED_TERMINAL_STATUSES = ['done', 'done-admission-refused', 'done-no-candidate', 'done-deferred'];

async function runSampleArm(sample, arm, rep) {
  const repPath = recordPath(sample.experimentPainId, arm, rep);
  let resumedTaskId = null;
  const priorExists = (() => { try { fs.statSync(repPath); return true; } catch { return false; } })();
  if (priorExists) {
    const prior = JSON.parse(fs.readFileSync(repPath, 'utf8'));
    // PRI-1254 r2 (review 0007 / P1-05): resume ONLY the closed set of
    // legitimate completed terminals with verified ok — no prefix matching,
    // no implied extension. failed / incomplete / ok=false records follow
    // the original re-execution logic.
    if (COMPLETED_TERMINAL_STATUSES.includes(prior.status) && prior.verification?.ok === true) return prior;
    if (prior.newTaskId) resumedTaskId = prior.newTaskId;
  }
  const record = {
    experimentPainId: sample.experimentPainId, arm, armRole: arm === cfg.baselineArm ? 'baseline' : 'candidate', rep, shardId: args.shardId,
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
    Object.assign(record, extra);
    record.finishedAt = new Date().toISOString();
    fs.writeFileSync(repPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
    return record;
  };
  try {
    // 1) Ingress (resume reuses the ingressed task — never re-records the pain).
    let newTaskId = resumedTaskId;
    if (!newTaskId) {
      const painEvent = sample.painEvent;
      const { argv: recArgs, evidence } = buildIngressArgs(painEvent);
      record.ingress = evidence; // evidence FIRST: even a failed ingress keeps its facts
      // PRI-1254 r2 (review P1-02): a session-bound sample whose host cannot
      // be SAFELY expressed on the real CLI (unknown/codex-without-lineage —
      // omitting --host would hard-default the CLI to openclaw) fails closed
      // BEFORE any CLI invocation: no write, no attribution guess, no unbound
      // re-record, session preserved in the evidence record.
      if (evidence.hostDecision?.failClosed === true) {
        record.ingressMode = 'ingress_host_unresolvable';
        log('ingress-host-unresolvable', { basis: evidence.hostDecision.basis, hasSession: evidence.inputArgsSummary.hasSession });
        return fail('ingress_host_unresolvable',
          `cannot express a session-bound ingress for ${JSON.stringify(evidence.hostDecision.basis)} — the CLI would silently attribute openclaw; sample refused before any write`,
          { status: 'failed' });
      }
      log('ingress', { mode: evidence.ingressMode, code: null, stdoutTail: null, stderrTail: null });
      const ingress = await runPd(arm, recArgs, { shardId: args.shardId });
      // Full-trajectory contract: a binding failure is a SAMPLE failure —
      // never auto-re-record without the session (that changes the input
      // category of the research subject; TECH §7 / T3b §5.8C).
      if (ingress.code !== 0 && /session_not_found|sentinel/i.test(ingress.stdout + ingress.stderr)) {
        record.ingress.bindingFailure = {
          reason: 'session_not_found|sentinel',
          stdoutTail: ingress.stdout.slice(-1500),
          stderrTail: ingress.stderr.slice(-800),
        };
        record.ingressMode = 'ingress_binding_failed';
        log('ingress-binding-failed', { code: ingress.code, stdoutTail: ingress.stdout.slice(-1500), stderrTail: ingress.stderr.slice(-800) });
        return fail('ingress_binding_failed', 'session binding failed — the sample is NOT re-recorded without its session (input category must not change)', { status: 'ingress_binding_failed' });
      }
      record.ingressMode = evidence.ingressMode;
      log('ingress', { mode: evidence.ingressMode, code: ingress.code, stdoutTail: ingress.stdout.slice(-3000), stderrTail: ingress.stderr.slice(-1500) });
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
      // PRI-1222: diagnose exits 1 when intake refused a candidate even though
      // the diagnosis chain succeeded — legitimate terminal (done-admission-refused).
      const intakeNow = (() => { try { return JSON.parse(diag.stdout).intake; } catch { return null; } })();
      const intakeCandsNow = intakeNow?.candidates ?? [];
      const diagOkNow = /"status":\s*"succeeded"/.test(diag.stdout);
      const allRefusedNow = intakeCandsNow.length > 0 && intakeCandsNow.every((c) => c.status === 'intake_failed');
      if (diagOkNow && allRefusedNow) {
        log('admission-refused', { exitCode: diag.code, refused: intakeCandsNow.map((c) => c.error ?? c.status) });
      } else {
        let category = 'diagnose_failed';
        if (/rate_limit/i.test(diag.stdout + diag.stderr)) category = 'provider_rate_limited';
        else if (/timed out|timeout/i.test(diag.stdout + diag.stderr)) category = 'provider_timeout';
        else if (/lease_conflict/i.test(diag.stdout + diag.stderr)) category = 'lease_conflict';
        return fail(category, `diagnose run exit=${diag.code}`);
      }
    }

    // 3) Formation: round-robin ALL THREE runner kinds.
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
    const routerRun = record.artifacts.routerRun;
    chainDb.close();
    record.finalRouterStatus = finalRouter;
    const verification = { checks: {}, ok: false };
    const intake = (() => { try { return JSON.parse(diag.stdout).intake; } catch { return null; } })();
    const intakeCandidates = intake?.candidates ?? [];
    const allRefused = intakeCandidates.length > 0 && intakeCandidates.every((c) => c.status === 'intake_failed');
    record.admissionRefused = allRefused ? intakeCandidates.map((c) => ({ candidateId: c.candidateId, error: c.error })) : null;
    verification.admissionRefused = record.admissionRefused;
    const diagnoseStatusSucceeded = /"status":\s*"succeeded"/.test(diag.stdout);
    verification.checks.diagnoseOk = diag.code === 0 || diagnoseStatusSucceeded || allRefused;
    verification.checks.routerTaskSucceeded = finalRouter === 'succeeded';
    verification.checks.routerRunSucceeded = Boolean(routerRun);
    const schemaCheck = await validateStageArtifacts(arm, record.artifacts, newTaskId);
    verification.checks.stageArtifactsSchemaValid = schemaCheck.ok;
    verification.errors = schemaCheck.errors;

    // Legitimate defer / admission-refused classification (TECH §7 终态语义)
    // — shared, testable classifier in ab-lib. Candidates are REQUIRED for
    // every completed terminal: a verified chain with zero candidates is a
    // persistence anomaly → `incomplete`, never done-* (PRI-1256 r3).
    const candidateCount = record.artifacts.candidates?.length ?? 0;
    // Review 0006: the committer creates candidates for defer recommendations
    // too, so an all-defer diagnosis has candidateCount > 0 — classify defer
    // from the router artifact REGARDLESS of candidate presence.
    const deferOnly = finalRouter === 'succeeded'
      ? detectDeferOnly(record.artifacts.stageArtifacts) : false;
    verification.checks.candidatesPresent = candidateCount > 0;
    // PRI-1256 r4/r5 (P2-01): presence alone is not enough — the persisted
    // candidates must correspond 1:1 (recommendationRef + verbatim content +
    // kind + task_id/artifact_id/source_run_id anchors) to the committed
    // recommendations; the commit artifact must be bound to the ACTUAL
    // succeeded router run and identical to the router pi_artifact (Stage C
    // dual-write). Any deviation is a persistence anomaly -> fail-closed
    // `incomplete`.
    const routerPiArtifact = (record.artifacts.stageArtifacts ?? [])
      .filter((a) => a.source_task_id === `diag_router-${newTaskId}`).pop() ?? null;
    const linkage = verifyCandidateLinkage(record.artifacts.commitArtifact, record.artifacts.candidates, {
      piArtifact: routerPiArtifact,
      succeededRouterRunId: routerRun?.run_id ?? null,
    });
    verification.checks.candidatesComplete = linkage.ok;
    if (linkage.problems.length > 0) verification.candidateProblems = linkage.problems.slice(0, 8);
    const terminal = classifyTerminal({
      diagnoseOk: verification.checks.diagnoseOk,
      routerTaskSucceeded: verification.checks.routerTaskSucceeded,
      routerRunSucceeded: verification.checks.routerRunSucceeded,
      stageArtifactsSchemaValid: verification.checks.stageArtifactsSchemaValid,
      candidatesComplete: linkage.ok,
      admissionRefused: Boolean(allRefused),
      deferOnly,
    });
    verification.legitimateTerminal = terminal.legitimateTerminal;
    verification.ok = terminal.ok;
    record.verification = verification;
    record.artifactsSha256 = sha256(JSON.stringify({
      stageArtifacts: (record.artifacts.stageArtifacts ?? []).map((a) => a.artifact_id),
      candidates: (record.artifacts.candidates ?? []).map((c) => c.candidate_id),
      formationArtifacts: (record.artifacts.formationArtifacts ?? []).map((a) => a.artifact_id),
    }));
    record.status = terminal.status;
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
    // GLOBAL sample index (CF-12): the sample's position in the FULL dataset,
    // invariant under any shard split.
    const globalIndex = globalIndexById.get(sample.experimentPainId);
    if (globalIndex === undefined) throw new Error(`sample ${sample.experimentPainId} not present in the full dataset samples list`);
    const order = armOrderFor(args.runId, globalIndex, arms);
    for (const rep of repsFor(sample.experimentPainId)) {
      for (const arm of order) {
        if (!arms.includes(arm)) continue;
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
