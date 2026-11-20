#!/usr/bin/env node
/* PD-Lab v0.3 T5 (PRI-1256) test fixture — a deterministic FIXTURE pd-cli.
 *
 * The T5 smoke suite copies this file into each synthetic arm worktree as
 * `packages/pd-cli/dist/index.js` (this file's .mjs extension only matters
 * in the repo; the copy is plain CJS at the destination). The harness spawns
 * it exactly like the real pd-cli. It:
 *   - records every invocation (cmd + argv) as a JSON line into
 *     `<dirname(--workspace)>/t5-fixture-cli.log`, so the suite can assert
 *     the exact child argument vector and per-unit call counts;
 *   - creates the workspace state.db through the REAL built schema module of
 *     ITS OWN arm worktree (`packages/principles-core/dist`), never
 *     hand-written DDL — same-source-version real artifacts;
 *   - writes stage artifacts whose payloads pass the REAL TypeBox output
 *     schemas ab-run validates them against (DiagRootCauseOutputV1,
 *     DiagDistillerOutputV1, DiagnosticianOutputV2 envelope);
 *   - honors the ingress contract hard-rejects the real CLI has
 *     (--reason > 500; the T5_BINDING_FAIL_SENTINEL session-binding failure);
 *   - supports deterministic failure injection via
 *     `<dirname(--workspace)>/t5-fixture-control.json`
 *     ({ failDiagnoseOnce: [{marker, arm?}], noCandidateArms: [{marker, arm?}] })
 *     so the suite can prove refuse-before-side-effect, resume and the
 *     legitimate-terminal closed set through the REAL orchestration.
 * It never touches real data, the network, or any model; its only writes are
 * inside the synthetic experiment tree (workspace + workspace parent).
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');

const argv = process.argv.slice(2);
const wsIdx = argv.indexOf('--workspace');
const ws = wsIdx >= 0 ? argv[wsIdx + 1] : null;
const cmd = wsIdx > 0 ? argv.slice(0, wsIdx) : [];

const armRoot = path.resolve(__dirname, '..', '..', '..');
const coreDist = (...p) => path.join(armRoot, 'packages', 'principles-core', 'dist', ...p);
const nowIso = () => new Date().toISOString();

function fail(message, code) {
  process.stderr.write(`t5-fixture-cli: ${message}\n`);
  process.exit(code);
}
if (!ws) fail('--workspace is required', 2);

const wsParent = path.dirname(ws);
const logPath = path.join(wsParent, 't5-fixture-cli.log');
fs.appendFileSync(logPath, JSON.stringify({ cmd: cmd.slice(0, 2).join(' '), ws: path.basename(ws), args: cmd, at: nowIso() }) + '\n');

const controlPath = path.join(wsParent, 't5-fixture-control.json');
function readControl() {
  try { return JSON.parse(fs.readFileSync(controlPath, 'utf8')); } catch { return {}; }
}
const statePath = path.join(ws, '.pd', 't5-fixture-state.json');
function readState() {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); }
  catch { return { markerByTask: {}, failedDiagnoseTasks: [] }; }
}
function writeState(state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function controlMatches(entries, marker, armHint) {
  if (!Array.isArray(entries)) return false;
  return entries.some((e) => (typeof e === 'string'
    ? e === marker
    : e && e.marker === marker && (e.arm === undefined || e.arm === armHint)));
}

const requireFromHere = createRequire(__filename);
const Database = requireFromHere('better-sqlite3');

async function openStateConnection() {
  // The REAL schema authority of THIS arm: state.db is created (schema only —
  // data rows are parameterized inserts) by the arm's own built dist, which
  // is the same module boundary ab-run's per-arm schema loading uses.
  const { SqliteConnection } = await import(pathToFileURL(coreDist('runtime', 'store', 'sqlite-connection.js')).href);
  return new SqliteConnection(ws);
}

function upsertTask(db, taskId, status, kind) {
  db.prepare(
    `INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count)
     VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(task_id) DO UPDATE SET status = excluded.status, attempt_count = tasks.attempt_count + 1, updated_at = excluded.updated_at`,
  ).run(taskId, kind ?? 'diagnosis', status, nowIso(), nowIso());
}

function insertRun(db, taskId, runtimeKind, status, attemptNumber, errorCategory) {
  db.prepare(
    `INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, ended_at, reason, output_payload, error_category, attempt_number, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `run-t5-${taskId}-${attemptNumber}`, taskId, runtimeKind, status,
    nowIso(), nowIso(), null,
    status === 'succeeded' ? JSON.stringify({ stage: runtimeKind, ok: true }) : null,
    errorCategory ?? null, attemptNumber, nowIso(), nowIso(),
  );
}

function insertPiArtifact(db, artifactId, kind, sourceTaskId, contentObj, tick) {
  const at = new Date(Date.now() + tick).toISOString();
  db.prepare(
    `INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
     VALUES (?, ?, ?, '[]', 'pending', ?, ?, ?)`,
  ).run(artifactId, kind, sourceTaskId, JSON.stringify(contentObj), at, at);
}

/* Synthetic stage payloads — every one of these is checked by ab-run against
 * the REAL TypeBox schemas from the arm's own dist, so the shapes below are
 * contract-driven (schema fields), not free-form. */
function rootCausePayload(stageTaskId) {
  return {
    valid: true,
    diagnosisId: `diag-t5-${stageTaskId}`,
    taskId: stageTaskId,
    summary: 'Synthetic root-cause stage output (T5 hermetic smoke fixture)',
    causalChain: [{ why: 1, statement: 'A synthetic first-why statement', evidenceRefs: ['synthetic-evidence-1'] }],
    rootCause: 'Tooling: a synthetic tooling gap identified by the fixture',
    rootCauseCategory: 'Tooling',
    evidence: [{ sourceRef: 'synthetic://turn/1', note: 'Synthetic evidence note (no real content)' }],
    confidence: 0.8,
  };
}

function distillerPayload(stageTaskId, rootCauseArtifactId) {
  return {
    valid: true,
    taskId: stageTaskId,
    sourceRootCauseArtifactId: rootCauseArtifactId,
    abstractedPrinciple: 'Verify claimed outcomes with a direct check before reporting success (synthetic)',
    rationale: 'Synthetic rationale linking the principle to the synthetic root cause',
    groundedOnCorePrincipleIds: ['T-01'],
    scope: 'general',
    confidence: 0.7,
  };
}

function routerPayload() {
  // A `principle` recommendation mirrors the production contract (a
  // diagnostician with nothing actionable MUST emit a defer instead — this
  // fixture's no-candidate terminal is produced by NOT inserting a candidate
  // row, never by swapping the recommendation kind).
  const recommendation = {
    kind: 'principle',
    recommendationRef: 'rec-t5-principle',
    description: 'Synthetic principle recommendation from the fixture',
    abstractedPrinciple: 'Verify claimed outcomes with a direct check before reporting success (synthetic)',
  };
  return {
    valid: true,
    diagnosisId: 'diag-t5-router',
    summary: 'Synthetic router stage output (T5 hermetic smoke fixture)',
    rootCause: 'Tooling: a synthetic tooling gap identified by the fixture',
    violatedPrinciples: [],
    evidence: [{ sourceRef: 'synthetic://turn/1', note: 'Synthetic evidence note (no real content)' }],
    recommendations: [recommendation],
    confidence: 0.8,
    schemaVersion: 'diagnostician-output-v2',
  };
}

function formationContent(runner, sourceTaskId) {
  if (runner === 'dreamer') {
    return { candidates: [{ candidateId: `cand-from-${sourceTaskId}`, title: 'Synthetic smoke principle', statement: 'Prefer verifying claimed behavior with a direct check.' }] };
  }
  if (runner === 'philosopher') return { review: 'approved', notes: 'synthetic philosopher review (T5 fixture)' };
  return { recorded: true, note: 'synthetic scribe record (T5 fixture)' };
}

async function painRecord() {
  const get = (name) => { const i = cmd.indexOf(name); return i >= 0 ? cmd[i + 1] : undefined; };
  const reason = get('--reason');
  const source = get('--source') ?? 'manual';
  const scoreArg = get('--score');
  const session = get('--session');
  const host = get('--host');
  if (typeof reason !== 'string') fail('pain record requires --reason', 2);
  if (reason.length > 500) {
    process.stderr.write('--reason exceeds MAX_REASON_LENGTH=500\n');
    process.exit(1);
  }
  if (reason.includes('T5_BINDING_FAIL_SENTINEL')) {
    process.stdout.write('{"error":"session_not_found"}');
    process.exit(1);
  }
  // trajectory.db: REAL schema from this arm's dist (the file was copied from
  // the snapshot by the harness; IF NOT EXISTS makes this idempotent).
  const trajectorySchema = await import(pathToFileURL(coreDist('runtime', 'trajectory-schema.js')).href);
  const trajDbPath = path.join(ws, '.state', 'trajectory.db');
  fs.mkdirSync(path.dirname(trajDbPath), { recursive: true });
  const traj = new Database(trajDbPath);
  try {
    trajectorySchema.applyTrajectorySchemaBase(traj);
    trajectorySchema.convergeTrajectorySchemaVersion(traj);
    const sessionForStorage = session ?? `unbound-${traj.prepare('SELECT COUNT(*) AS c FROM pain_events').get().c + 1}`;
    traj.prepare(
      'INSERT INTO pain_events (session_id, source, score, reason, host_kind, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(sessionForStorage, source, Number(scoreArg ?? 0), reason, host ?? null, nowIso());
  } finally { traj.close(); }

  const conn = await openStateConnection();
  const db = conn.getDb();
  const state = readState();
  const n = Object.keys(state.markerByTask).length + 1;
  const taskId = `diagnosis_t5-${String(n).padStart(4, '0')}`;
  const marker = (reason.match(/smoke-s\d+/) || [path.basename(ws)])[0];
  state.markerByTask[taskId] = marker;
  writeState(state);
  upsertTask(db, taskId, 'pending', 'diagnosis');
  conn.close();
  process.stdout.write(JSON.stringify({ ok: true, taskId }));
  process.exit(0);
}

async function diagnoseRun() {
  const i = cmd.indexOf('--task-id');
  const taskId = i >= 0 ? cmd[i + 1] : null;
  if (!taskId) fail('diagnose run requires --task-id', 2);
  const conn = await openStateConnection();
  const db = conn.getDb();
  const state = readState();
  const marker = state.markerByTask[taskId] ?? 'unknown';
  const control = readControl();
  const armHint = path.basename(ws).split('-')[0];
  const attemptNumber = db.prepare('SELECT COUNT(*) AS c FROM runs WHERE task_id = ?').get(taskId).c + 1;

  // Deterministic failure injection (T5 control): the FIRST diagnose attempt
  // for a matching unit fails; every later attempt succeeds. This is what
  // lets the suite drive the real resume path without any environment flag.
  const shouldFail = controlMatches(control.failDiagnoseOnce, marker, armHint)
    && !state.failedDiagnoseTasks.includes(taskId);
  if (shouldFail) {
    state.failedDiagnoseTasks.push(taskId);
    writeState(state);
    insertRun(db, taskId, 'diagnostician', 'failed', attemptNumber, 'synthetic_injected');
    upsertTask(db, taskId, 'failed', 'diagnosis');
    conn.close();
    process.stdout.write(JSON.stringify({ status: 'failed', error: 'synthetic injected failure (T5 control)' }));
    process.exit(1);
  }

  // Success path: the closed synthetic chain — rootcause → distiller →
  // router — with REAL-schema artifacts, terminal tasks/runs and (unless the
  // control asks for the no-candidate terminal) one pending principle
  // candidate. Formation work is enqueued for the internalization loop.
  const stageTaskIds = {
    rootcause: `diag_rootcause-${taskId}`,
    distiller: `diag_distiller-${taskId}`,
    router: `diag_router-${taskId}`,
  };
  const noCandidate = controlMatches(control.noCandidateArms, marker, armHint);
  const routerPayloadObj = routerPayload();
  // Tasks first — the real schema fences runs.task_id with a FK to tasks.
  upsertTask(db, taskId, 'succeeded', 'diagnosis');
  upsertTask(db, stageTaskIds.rootcause, 'succeeded', 'diagnosis');
  upsertTask(db, stageTaskIds.distiller, 'succeeded', 'diagnosis');
  upsertTask(db, stageTaskIds.router, 'succeeded', 'diagnosis');
  insertRun(db, taskId, 'diagnostician', 'succeeded', attemptNumber, null);
  insertRun(db, stageTaskIds.rootcause, 'diag_rootcause', 'succeeded', 1, null);
  insertRun(db, stageTaskIds.distiller, 'diag_distiller', 'succeeded', 1, null);
  insertRun(db, stageTaskIds.router, 'diag_router', 'succeeded', 1, null);

  const rootCauseArtifactId = `art-t5-rootcause-${taskId}`;
  const distillerArtifactId = `art-t5-distiller-${taskId}`;
  const routerArtifactId = `art-t5-router-${taskId}`;
  insertPiArtifact(db, rootCauseArtifactId, 'diag_rootcause_output', stageTaskIds.rootcause,
    rootCausePayload(stageTaskIds.rootcause), 0);
  insertPiArtifact(db, distillerArtifactId, 'diag_distiller_output', stageTaskIds.distiller,
    distillerPayload(stageTaskIds.distiller, rootCauseArtifactId), 1);
  insertPiArtifact(db, routerArtifactId, 'diagnostician_output', stageTaskIds.router, routerPayloadObj, 2);

  db.prepare(
    `INSERT INTO pain_diagnoses (id, pain_id, task_id, diagnosis_id, category, root_cause, evidence_json, confidence, artifact_id, created_at)
     VALUES (?, ?, ?, ?, 'Tooling', ?, ?, 0.8, ?, ?)`,
  ).run(`pd-t5-${taskId}`, marker, taskId, `diag-t5-${taskId}`,
    'Tooling: a synthetic tooling gap identified by the fixture',
    JSON.stringify([{ sourceRef: 'synthetic://turn/1', note: 'synthetic' }]),
    routerArtifactId, nowIso());

  if (!noCandidate) {
    // The production committer inserts a candidate for EVERY recommendation
    // kind — the fixture mirrors that (a defer router payload with no
    // candidates would misstate the defer terminal's data shape).
    db.prepare(
      `INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at)
       VALUES (?, ?, ?, 'diagnosis_result', ?, ?)`,
    ).run(`art5-${taskId}`, `run-t5-${stageTaskIds.router}-1`, taskId, JSON.stringify(routerPayloadObj), nowIso());
    db.prepare(
      `INSERT INTO principle_candidates (candidate_id, artifact_id, task_id, source_run_id, title, description, confidence, source_recommendation_json, idempotency_key, status, created_at, recommendation_kind, abstracted_principle)
       VALUES (?, ?, ?, ?, ?, ?, 0.7, ?, ?, 'pending', ?, 'principle', ?)`,
    ).run(
      `cand-t5-${taskId}`, `art5-${taskId}`, taskId, `run-t5-${stageTaskIds.router}-1`,
      'Synthetic smoke principle', 'Synthetic candidate description (T5 fixture)',
      JSON.stringify(routerPayloadObj.recommendations[0]),
      `idem-t5-${taskId}`, nowIso(),
      'Verify claimed outcomes with a direct check before reporting success (synthetic)',
    );
    // Formation tasks carry the candidate id inside their task_id — the
    // harness collects formation history by `%candidateId%` matching.
    for (const runner of ['dreamer', 'philosopher', 'scribe']) {
      db.prepare(
        `INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)`,
      ).run(`${runner}-t5-${`cand-t5-${taskId}`}`, runner, nowIso(), nowIso());
    }
  }
  conn.close();
  process.stdout.write(JSON.stringify({ status: 'succeeded', intake: { candidates: [] } }));
  process.exit(0);
}

async function runOnce() {
  const i = cmd.indexOf('--runner');
  const runner = i >= 0 ? cmd[i + 1] : null;
  if (!runner || !['dreamer', 'philosopher', 'scribe'].includes(runner)) {
    fail('run-once requires --runner dreamer|philosopher|scribe', 2);
  }
  const conn = await openStateConnection();
  const db = conn.getDb();
  const task = db.prepare(
    `SELECT task_id FROM tasks WHERE task_kind = ? AND status = 'pending' ORDER BY created_at LIMIT 1`,
  ).get(runner);
  if (!task) {
    conn.close();
    process.stdout.write(JSON.stringify({ decision: 'skip', reason: 'no pending work' }));
    process.exit(0);
  }
  const attemptNumber = db.prepare('SELECT COUNT(*) AS c FROM runs WHERE task_id = ?').get(task.task_id).c + 1;
  insertRun(db, task.task_id, runner, 'succeeded', attemptNumber, null);
  db.prepare(
    `UPDATE tasks SET status = 'succeeded', attempt_count = attempt_count + 1, updated_at = ? WHERE task_id = ?`,
  ).run(nowIso(), task.task_id);
  insertPiArtifact(db, `art-t5-${runner}-${task.task_id}`, `${runner}_output`, task.task_id,
    formationContent(runner, task.task_id), 3);
  conn.close();
  process.stdout.write(JSON.stringify({ decision: 'leased', taskId: task.task_id }));
  process.exit(0);
}

async function main() {
  if (cmd[0] === 'pain' && cmd[1] === 'record') return painRecord();
  if (cmd[0] === 'diagnose' && cmd[1] === 'run') return diagnoseRun();
  if (cmd[0] === 'runtime' && cmd[1] === 'internalization' && cmd[2] === 'run-once') return runOnce();
  fail(`unsupported command: ${cmd.join(' ')}`, 2);
}

main().catch((err) => {
  process.stderr.write(`t5-fixture-cli: ${String(err && err.stack ? err.stack : err)}\n`);
  process.exit(1);
});
