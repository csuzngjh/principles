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
 *   - mirrors the production commit contract (the Stage C atomic unit,
 *     stateManager.commitDiagnosticianAndFinalize): a succeeded diagnose
 *     commits artifacts('diagnostician_output') + commits + ONE
 *     principle_candidates row PER recommendation (defer included) + the
 *     router pi_artifact + the terminal task/run success updates in ONE
 *     transaction — nothing reads 'succeeded' before the boundary
 *     completes; pain_diagnoses is written in a SEPARATE transaction
 *     afterwards, mirroring the pain-signal bridge's own ledger write
 *     (it is not part of the production commit boundary); then intake
 *     consumes each candidate and seeds a dreamer task for actionable
 *     kinds — so a fresh succeeded diagnosis ALWAYS produces >=1
 *     candidate and a verified chain with zero candidates is a
 *     persistence anomaly, not a legitimate terminal;
 *   - emits the real `pd diagnose run --json` contract the harness consumes
 *     ({ status, taskId, output, attemptCount, diagnosisSucceeded,
 *     painDiagnosisLedgerWrite, intake: { enabled, candidates[] }, nextAction })
 *     including the PRI-1222 exit-1 shape when intake is refused;
 *   - supports deterministic controls via
 *     `<dirname(--workspace)>/t5-fixture-control.json`
 *     ({ failDiagnoseOnce, deferArms, refuseAdmissionArms, failCommitOnce,
 *     candidateAnomalyArms: [{marker, arm?, mode}], recommendationCountArms:
 *     [{marker, arm?, count}] }) so the suite can prove
 *     refuse-before-side-effect, resume, atomic-commit rollback, the
 *     PRODUCIBLE legitimate-terminal set and candidate-completeness
 *     classification through the REAL orchestration.
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

function insertRun(db, taskId, runtimeKind, status, attemptNumber, errorCategory, outputPayload) {
  const runId = `run-t5-${taskId}-${attemptNumber}`;
  db.prepare(
    `INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, ended_at, reason, output_payload, error_category, attempt_number, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId, taskId, runtimeKind, status,
    nowIso(), nowIso(), null,
    status === 'succeeded' ? (outputPayload ?? JSON.stringify({ stage: runtimeKind, ok: true })) : null,
    errorCategory ?? null, attemptNumber, nowIso(), nowIso(),
  );
  return runId;
}

function insertPiArtifact(db, artifactId, sourceTaskId, contentObj, lineageIds, tick) {
  const at = new Date(Date.now() + tick).toISOString();
  // Production writes EVERY diagnostician stage output into pi_artifacts with
  // artifact_kind 'principle' (diag-*-runner.ts: piArtifact.artifactKind).
  db.prepare(
    `INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
     VALUES (?, 'principle', ?, ?, 'pending', ?, ?, ?)`,
  ).run(artifactId, sourceTaskId, JSON.stringify(lineageIds ?? []), JSON.stringify(contentObj), at, at);
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

function routerPayload(deferOnly, count) {
  // Production contract (DiagnosticianOutputV2Schema, PRI-518/rc-9):
  // recommendations requires minItems 1 and UNIQUE recommendationRefs — a
  // no-actionable diagnosis MUST emit a `defer` recommendation, never an
  // empty list. The committer persists one candidate per recommendation
  // either way. `count` (T5 control) varies the number of recommendations so
  // the suite can test N->M candidate-completeness classification.
  const n = Number.isInteger(count) && count > 0 ? count : 1;
  const mkRec = (kind, i) => {
    const rec = {
      kind,
      recommendationRef: `rec-t5-${kind}-${i}`,
      description: `Synthetic ${kind} recommendation #${i} (T5 fixture)`,
    };
    if (kind === 'principle') {
      rec.abstractedPrinciple = `Verify claimed outcomes with a direct check #${i} (synthetic)`;
    }
    return rec;
  };
  const recommendations = deferOnly
    ? Array.from({ length: n }, (_, i) => mkRec('defer', i))
    : Array.from({ length: n }, (_, i) => mkRec(['principle', 'implementation', 'prompt'][i % 3], i));
  return {
    valid: true,
    diagnosisId: 'diag-t5-router',
    summary: 'Synthetic router stage output (T5 hermetic smoke fixture)',
    rootCause: 'Tooling: a synthetic tooling gap identified by the fixture',
    violatedPrinciples: [],
    evidence: [{ sourceRef: 'synthetic://turn/1', note: 'Synthetic evidence note (no real content)' }],
    recommendations,
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
  // router — written through the REAL schema. Boundary model mirrors
  // production: Stage A/B each publish in their OWN transaction (each stage
  // runner finalizes independently), then Stage C publishes through ONE
  // atomic commit unit — the fixture's mirror of
  // stateManager.commitDiagnosticianAndFinalize(): artifact + commit + one
  // candidate per recommendation + router pi_artifact + pain_diagnoses +
  // the TERMINAL task/run success updates, all inside one
  // db.transaction().immediate(). NOTHING is marked 'succeeded' before that
  // boundary completes; a failure anywhere rolls the whole unit back and
  // leaves no partial success state. This fixture SIMULATES the production
  // transaction boundary — it does not execute the production Stage C code;
  // `failCommitOnce` injects a one-shot fault INSIDE the unit (a test-only
  // control the real runner has no equivalent of).
  const stageTaskIds = {
    rootcause: `diag_rootcause-${taskId}`,
    distiller: `diag_distiller-${taskId}`,
    router: `diag_router-${taskId}`,
  };
  const deferOnly = controlMatches(control.deferArms, marker, armHint);
  const refuseAdmission = controlMatches(control.refuseAdmissionArms, marker, armHint);
  const recCount = (Array.isArray(control.recommendationCountArms) ? control.recommendationCountArms : [])
    .find((e) => e && e.marker === marker && (e.arm === undefined || e.arm === armHint))?.count ?? null;
  const routerPayloadObj = routerPayload(deferOnly, recCount);

  // failCommitOnce control: [{ marker, arm?, stage }] — stage ∈
  // 'artifact' | 'commit' | 'candidate' | 'piArtifact' | 'finalize'. The
  // FIRST matching diagnose attempt throws inside the commit transaction
  // right AFTER that stage's write; the bookkeeping lives in fixture state
  // (outside the DB transaction) so the retry commits cleanly.
  const failStage = (() => {
    const entries = Array.isArray(control.failCommitOnce) ? control.failCommitOnce : [];
    const hit = entries.find((e) => e && (typeof e === 'string'
      ? false
      : (e.marker === undefined || e.marker === marker) && (e.arm === undefined || e.arm === armHint)));
    return hit?.stage ?? null;
  })();
  state.failedCommits = state.failedCommits ?? [];
  const injectOnce = (stage) => {
    if (failStage === stage && !state.failedCommits.includes(`${taskId}:${stage}`)) {
      state.failedCommits.push(`${taskId}:${stage}`);
      writeState(state);
      throw new Error(`t5 synthetic commit failure at '${stage}' (injected, transaction rolls back)`);
    }
  };

  // Stage A/B: each stage's own publication unit — task+run+pi_artifact in
  // ONE small transaction per stage, like each production stage runner's
  // own fenced finalize. IDEMPOTENT on the stage task id: a diagnose retry
  // after a downstream Stage C rollback reuses the already-committed stage
  // output instead of writing duplicate task/run/artifact rows.
  const stagePublish = (stageTaskId, kind, payloadObj, lineage, tick) => db.transaction(() => {
    const prior = db.prepare(
      `SELECT run_id FROM runs WHERE task_id = ? AND execution_status = 'succeeded' ORDER BY attempt_number LIMIT 1`,
    ).get(stageTaskId);
    if (prior) return prior.run_id;
    upsertTask(db, stageTaskId, 'succeeded', kind);
    const runId = insertRun(db, stageTaskId, kind, 'succeeded', 1, null, JSON.stringify(payloadObj));
    insertPiArtifact(db, `pi-art-${stageTaskId}-${runId}`, stageTaskId, payloadObj, lineage, tick);
    return runId;
  }).immediate();

  const rootCauseRunId = stagePublish(stageTaskIds.rootcause, 'diag_rootcause',
    rootCausePayload(stageTaskIds.rootcause), [], 0);
  const rootCauseArtifactId = `pi-art-${stageTaskIds.rootcause}-${rootCauseRunId}`;
  const distillerRunId = stagePublish(stageTaskIds.distiller, 'diag_distiller',
    distillerPayload(stageTaskIds.distiller, rootCauseArtifactId), [rootCauseArtifactId], 1);
  const distillerArtifactId = `pi-art-${stageTaskIds.distiller}-${distillerRunId}`;

  // Stage C atomic commit unit (mirror of commitDiagnosticianAndFinalize):
  // the commit contract (SqliteDiagnosticianCommitter.commitSync) is
  // artifacts('diagnostician_output') + commits + ONE principle_candidates
  // row per recommendation (every kind, defer included); the router
  // pi_artifact dual-write and the TERMINAL task/run success updates ride
  // the same boundary.
  // `candidateAnomalyArms` [{marker, arm?, mode}] simulates persistence-layer
  // anomalies the current chain must never certify:
  //   'none'           → commit publishes ZERO candidates
  //   'missing-tail'   → the last recommendation's candidate is dropped
  //   'only-first'     → only the first recommendation is persisted
  //   'duplicate-link' → N rows but the tail row claims an earlier
  //                      recommendation's ref (one recommendation unpersisted)
  //   'wrong-link'     → N rows but the tail row claims a ref that does not
  //                      exist in the committed artifact
  //   'wrong-task'     → N rows, every linkage field correct EXCEPT
  //                      candidate.task_id lands on the parent diagnosis task
  //                      instead of the router stage task (ownership anomaly)
  //   'divergent-pi'   → the commit artifact keeps all recommendations but the
  //                      router pi_artifact is persisted with a DIVERGENT
  //                      (still schema-valid) payload — a Stage C dual-write
  //                      split production's single routerContentJson forbids
  //   'tampered-rec'   → N rows, every ref correct, but the tail candidate's
  //                      stored source_recommendation_json + kind are mutated
  //                      (correct ref over tampered content)
  // Every anomaly still writes a 'committed' artifact+commit — the harness
  // must classify the unit `incomplete`.
  const anomalyEntry = (Array.isArray(control.candidateAnomalyArms) ? control.candidateAnomalyArms : [])
    .find((e) => e && e.marker === marker && (e.arm === undefined || e.arm === armHint));
  const anomalyMode = anomalyEntry?.mode ?? null;
  let persistedRecs = routerPayloadObj.recommendations.map((rec) => ({ ...rec }));
  if (anomalyMode === 'none') persistedRecs = [];
  else if (anomalyMode === 'missing-tail') persistedRecs = persistedRecs.slice(0, -1);
  else if (anomalyMode === 'only-first') persistedRecs = persistedRecs.slice(0, 1);
  else if (anomalyMode === 'duplicate-link' && persistedRecs.length >= 2)
    persistedRecs[persistedRecs.length - 1] = {
      ...persistedRecs[persistedRecs.length - 1],
      recommendationRef: persistedRecs[persistedRecs.length - 2].recommendationRef,
    };
  else if (anomalyMode === 'wrong-link' && persistedRecs.length >= 1)
    persistedRecs[persistedRecs.length - 1] = {
      ...persistedRecs[persistedRecs.length - 1],
      recommendationRef: 'rec-t5-nonexistent-ref',
    };
  else if (anomalyMode === 'tampered-rec' && persistedRecs.length >= 1)
    persistedRecs[persistedRecs.length - 1] = {
      ...persistedRecs[persistedRecs.length - 1],
      kind: persistedRecs[persistedRecs.length - 1].kind === 'defer' ? 'principle' : 'defer',
      description: `${persistedRecs[persistedRecs.length - 1].description} [tampered]`,
    };
  // 'wrong-task': candidates land on the parent task, not the router stage
  // task — production writes input.taskId for both artifact and candidates.
  const candidateTaskId = anomalyMode === 'wrong-task' ? taskId : stageTaskIds.router;
  // 'divergent-pi': the pi_artifact copy diverges from the committed one —
  // production dual-writes the SAME routerContentJson to both.
  const piPayloadObj = anomalyMode === 'divergent-pi' && routerPayloadObj.recommendations.length >= 2
    ? { ...routerPayloadObj, recommendations: routerPayloadObj.recommendations.slice(0, 1) }
    : routerPayloadObj;
  const commitId = `commit-t5-${taskId}-${attemptNumber}`;
  const commitArtifactId = `art5-${taskId}-${attemptNumber}`;
  const candidates = [];
  const finalizeTask = (id) => db.prepare(
    `UPDATE tasks SET status = 'succeeded', updated_at = ? WHERE task_id = ?`,
  ).run(nowIso(), id);
  const finalizeRun = (runId, outputPayload) => db.prepare(
    `UPDATE runs SET execution_status = 'succeeded', ended_at = ?, output_payload = ? WHERE run_id = ?`,
  ).run(nowIso(), outputPayload, runId);
  let routerRunId;
  try {
    db.transaction(() => {
      // In-flight, NON-terminal states first — the FK chain needs task/run
      // rows, but nothing reads 'succeeded' until the finalize step below.
      upsertTask(db, taskId, 'running', 'diagnosis');
      upsertTask(db, stageTaskIds.router, 'running', 'diag_router');
      const parentRunId = insertRun(db, taskId, 'diagnostician', 'running', attemptNumber, null);
      const routerAttempt = db.prepare('SELECT COUNT(*) AS c FROM runs WHERE task_id = ?').get(stageTaskIds.router).c + 1;
      routerRunId = insertRun(db, stageTaskIds.router, 'diag_router', 'running', routerAttempt, null);
      const routerArtifactId = `pi-art-${stageTaskIds.router}-${routerRunId}`;

      db.prepare(
        `INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at)
         VALUES (?, ?, ?, 'diagnostician_output', ?, ?)`,
      ).run(commitArtifactId, routerRunId, stageTaskIds.router, JSON.stringify(routerPayloadObj), nowIso());
      injectOnce('artifact');
      db.prepare(
        `INSERT INTO commits (commit_id, task_id, run_id, artifact_id, idempotency_key, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'committed', ?)`,
      ).run(commitId, stageTaskIds.router, routerRunId, commitArtifactId, `${stageTaskIds.router}:${routerRunId}`, nowIso());
      injectOnce('commit');
      if (persistedRecs.length > 0) {
        for (let idx = 0; idx < persistedRecs.length; idx++) {
          const rec = persistedRecs[idx];
          const candidateId = `cand-t5-${taskId}-${idx}`;
          db.prepare(
            `INSERT INTO principle_candidates (candidate_id, artifact_id, task_id, source_run_id, title, description, confidence, source_recommendation_json, idempotency_key, status, created_at, recommendation_kind, trigger_pattern, action, abstracted_principle)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
          ).run(
            candidateId, commitArtifactId, candidateTaskId, routerRunId,
            rec.description.slice(0, 200), rec.description,
            routerPayloadObj.confidence ?? null,
            JSON.stringify(rec),
            `${commitId}:${idx}`, nowIso(),
            rec.kind, rec.triggerPattern ?? null, rec.action ?? null, rec.abstractedPrinciple ?? null,
          );
          candidates.push({ candidateId, kind: rec.kind });
          injectOnce('candidate'); // mid-loop: "during candidate writes"
        }
      }
      // Router pi_artifact — the Stage C dual-write (PRI-667), same tx.
      // Production persists the SAME routerContentJson here as in the commit
      // artifact; `piPayloadObj` equals it unless 'divergent-pi' is armed.
      insertPiArtifact(db, routerArtifactId, stageTaskIds.router, piPayloadObj,
        [rootCauseArtifactId, distillerArtifactId], 2);
      injectOnce('piArtifact');
      // Finalize LAST — the terminal task/run success update is part of the
      // SAME atomic unit (production markSucceededSync inside the tx).
      finalizeRun(routerRunId, JSON.stringify(routerPayloadObj));
      finalizeRun(parentRunId, JSON.stringify({ stage: 'diagnostician', ok: true }));
      finalizeTask(stageTaskIds.router);
      finalizeTask(taskId);
      injectOnce('finalize');
    }).immediate();
  } catch (err) {
    if (!String(err?.message ?? '').startsWith('t5 synthetic commit failure')) throw err;
    // Mirror production's post-commit failure path (artifact_commit_failed):
    // the rollback removed every in-flight row — including the 'running'
    // task/run inserts — so the failure is recorded in fresh rows written
    // OUTSIDE the rolled-back unit. No partial success state survives.
    upsertTask(db, stageTaskIds.router, 'failed', 'diag_router');
    upsertTask(db, taskId, 'failed', 'diagnosis');
    insertRun(db, stageTaskIds.router, 'diag_router', 'failed', 1, 'artifact_commit_failed');
    insertRun(db, taskId, 'diagnostician', 'failed', attemptNumber, 'artifact_commit_failed');
    conn.close();
    process.stdout.write(JSON.stringify({ status: 'failed', error: String(err.message) }));
    process.exit(1);
  }

  // pain_diagnoses ledger write — in production this is dispatched by the
  // pain-signal bridge as its OWN write (pain-signal-bridge.ts runs before
  // admission, NOT inside commitDiagnosticianAndFinalize). It gets its own
  // transaction so the Stage C boundary above mirrors production exactly.
  db.transaction(() => {
    db.prepare(
      `INSERT INTO pain_diagnoses (id, pain_id, task_id, diagnosis_id, category, root_cause, evidence_json, confidence, artifact_id, created_at)
       VALUES (?, ?, ?, ?, 'Tooling', ?, ?, 0.8, ?, ?)`,
    ).run(`pd-t5-${taskId}`, marker, taskId, `diag-t5-${taskId}`,
      'Tooling: a synthetic tooling gap identified by the fixture',
      JSON.stringify([{ sourceRef: 'synthetic://turn/1', note: 'synthetic' }]),
      commitArtifactId, nowIso());
  }).immediate();

  // Intake (the real CLI's intake loop): admission refusal is a governed,
  // legal terminal — the candidate stays 'pending' and the CLI exits 1 with
  // diagnosisSucceeded:true (PRI-1222). A consumed candidate whose kind is
  // actionable gets a dreamer seed; defer/implementation kinds stop at
  // consumed (diagnose.ts seed loop).
  const intakeResults = [];
  let intakeFailed = false;
  for (const cand of candidates) {
    if (refuseAdmission) {
      intakeFailed = true;
      intakeResults.push({
        candidateId: cand.candidateId,
        status: 'intake_failed',
        error: 'Admission gate refused: synthetic admission refusal (T5 control)',
        nextAction: 'provide additional evidence or request manual review',
        admissionRefused: true,
      });
      continue;
    }
    db.prepare(`UPDATE principle_candidates SET status = 'consumed', consumed_at = ? WHERE candidate_id = ?`).run(nowIso(), cand.candidateId);
    intakeResults.push({ candidateId: cand.candidateId, status: 'consumed', ledgerEntryId: `ledger-t5-${cand.candidateId}` });
    if (cand.kind === 'defer' || cand.kind === 'implementation') continue;
    // Formation tasks carry the candidate id inside their task_id — the
    // harness collects formation history by `%candidateId%` matching.
    for (const runner of ['dreamer', 'philosopher', 'scribe']) {
      db.prepare(
        `INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)`,
      ).run(`${runner}-t5-${cand.candidateId}`, runner, nowIso(), nowIso());
    }
    intakeResults.push({
      candidateId: cand.candidateId,
      status: 'dreamer_seeded',
      nextAction: `pd task show dreamer-t5-${cand.candidateId} | pd dreamer run --task-id dreamer-t5-${cand.candidateId}`,
    });
  }
  conn.close();
  process.stdout.write(JSON.stringify({
    status: 'succeeded',
    taskId,
    contextHash: `t5-context-${taskId}`,
    output: routerPayloadObj,
    attemptCount: attemptNumber,
    diagnosisSucceeded: true,
    painDiagnosisLedgerWrite: 'attempted',
    intake: { enabled: true, candidates: intakeResults },
    nextAction: refuseAdmission
      ? 'All candidates were refused by the admission gate — internalization is correctly blocked.'
      : 'Dreamer tasks seeded automatically for the admitted candidate(s).',
  }));
  process.exit(intakeFailed ? 1 : 0);
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
  insertPiArtifact(db, `art-t5-${runner}-${task.task_id}`, task.task_id,
    formationContent(runner, task.task_id), [], 3);
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
