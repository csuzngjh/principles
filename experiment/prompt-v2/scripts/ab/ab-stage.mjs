/**
 * PD-SPEC-001 Experiment A — per-agent paired A/B (remediated, Owner §7.1/§7.2).
 *
 * Seeds HISTORICAL production rows verbatim into per-arm `-pa` workspaces and
 * runs ONE stage through the production CLI. Remediation changes:
 *  - arm databases are initialized with the REAL PD schema (SqliteConnection
 *    bootstrap, schema_version verified) — no more INSERTs into a table-less
 *    SQLite file;
 *  - seed happens only on a freshly bootstrapped DB (existing non-empty DBs
 *    are rejected — no cross-run contamination);
 *  - terminal 'done' REQUIRES: child exit 0 + target task succeeded + a
 *    succeeded run + a schema-valid artifact (TypeBox via the arm dist) +
 *    artifact→task linkage. Anything else → 'failed' with the error category.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  bootstrapConfigContext, configArms, armWorktree, experimentRoot, snapshotDir,
  datasetFile, sha256, armWorkspaceDir, spawnPdChild,
  assertWorkspaceIsolation, assertArtifactReuseSafety, recordArtifactProvenance,
  preflightChecks, materializeWorkspaceFiles, validateRunId,
} from './ab-lib.mjs';
import { loadArmRuntime } from './arm-runtime.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { Value } = require('@sinclair/typebox/value');

const STAGE_USAGE = 'usage: node ab-stage.mjs --config <experiment-config.json> --run-id <id> --stage <distiller|router|dreamer|philosopher|scribe> [--samples S1,S2] [--arms <armA>,<armB>]';
bootstrapConfigContext(process.argv, STAGE_USAGE);

// PRI-1254 r2 (review P2-06): every arm's runtime machinery (SqliteConnection
// + stage-output schemas) loads from THAT ARM'S OWN worktree dist — the
// previous module-scope candidate-only loading bootstrapped baseline
// databases and validated baseline outputs with candidate code. Loaders are
// lazily resolved per arm (arm-runtime.mjs) and cached there; a stage
// validates an arm's artifact with THAT arm's schema, never cross-arm.

const here = path.dirname(fileURLToPath(import.meta.url));
const TASK_COLUMNS = ['task_id', 'task_kind', 'status', 'created_at', 'updated_at', 'lease_owner', 'lease_expires_at', 'attempt_count', 'max_attempts', 'last_error', 'input_ref', 'result_ref', 'diagnostic_json'];
const ART_COLUMNS = ['artifact_id', 'artifact_kind', 'source_task_id', 'source_principle_id', 'source_rule_id', 'lineage_artifact_ids', 'validation_status', 'content_json', 'created_at', 'updated_at'];

function parseArgs(argv) {
  const out = { arms: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run-id') out.runId = argv[++i];
    else if (a === '--stage') out.stage = argv[++i];
    else if (a === '--samples') out.samples = argv[++i].split(',');
    else if (a === '--arms') out.arms = argv[++i].split(',');
    else if (a === '--config') { ++i; /* consumed by bootstrapConfigContext */ }
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!out.runId || !out.stage) throw new Error('--run-id and --stage are required');
  if (!['distiller', 'router', 'dreamer', 'philosopher', 'scribe'].includes(out.stage)) throw new Error(`unsupported stage: ${out.stage}`);
  const configured = configArms();
  if (out.arms && ([...out.arms].sort().join(',') !== [...configured].sort().join(',') || out.arms.length !== 2)) {
    throw new Error(`--arms must be exactly the configured arm pair (${configured.join(',')} in any order)`);
  }
  out.arms = out.arms ?? configured;
  return out;
}

function snapshotDb() {
  return new Database(path.join(snapshotDir(), 'state.db'), { readonly: true });
}

/** Pull a sample's historical stage rows from the frozen dataset/snapshot. */
function historicalRows(sample, stage) {
  const snap = snapshotDb();
  try {
    const diagTaskId = sample.originalTaskId;
    const getTask = snap.prepare(`SELECT ${TASK_COLUMNS.join(', ')} FROM tasks WHERE task_id = ?`);
    const getArts = snap.prepare(`SELECT ${ART_COLUMNS.join(', ')} FROM pi_artifacts WHERE source_task_id = ? ORDER BY created_at`);
    const out = { predecessorTasks: [], predecessorArtifacts: [], parentTask: null, targetTask: null, targetKind: null };

    if (stage === 'distiller' || stage === 'router') {
      out.parentTask = getTask.get(diagTaskId);
      const rcId = `diag_rootcause-${diagTaskId}`;
      const rcTask = getTask.get(rcId);
      const rcArt = getArts.all(rcId);
      if (!rcTask || rcArt.length === 0) throw new Error(`${sample.experimentPainId}: no historical rootcause rows`);
      out.predecessorTasks.push(rcTask);
      out.predecessorArtifacts.push(...rcArt);
      if (stage === 'distiller') {
        out.targetTask = getTask.get(`diag_distiller-${diagTaskId}`);
        out.targetKind = 'diag_distiller';
      } else {
        const diId = `diag_distiller-${diagTaskId}`;
        const diTask = getTask.get(diId);
        const diArt = getArts.all(diId);
        if (!diTask || diArt.length === 0) throw new Error(`${sample.experimentPainId}: no historical distiller rows`);
        out.predecessorTasks.push(diTask);
        out.predecessorArtifacts.push(...diArt);
        out.targetTask = getTask.get(`diag_router-${diagTaskId}`);
        out.targetKind = 'diag_router';
      }
    } else {
      const formation = sample.formation ?? [];
      const cand = formation.find((f) => Array.isArray(f[stage]) && f[stage].length > 0 && f[stage].some((t) => t.task?.status === 'succeeded'));
      if (!cand) return null;
      const target = cand[stage].find((t) => t.task?.status === 'succeeded');
      out.targetTask = getTask.get(target.task.task_id);
      out.targetKind = stage;
      if (stage === 'dreamer') {
        out.predecessorArtifacts.push(...getArts.all(`diag_router-${diagTaskId}`));
      } else if (stage === 'philosopher') {
        for (const t of cand.dreamer ?? []) {
          out.predecessorArtifacts.push(...getArts.all(t.task.task_id));
          const row = getTask.get(t.task.task_id); if (row) out.predecessorTasks.push(row);
        }
      } else {
        for (const t of [...(cand.dreamer ?? []), ...(cand.philosopher ?? [])]) {
          out.predecessorArtifacts.push(...getArts.all(t.task.task_id));
          const row = getTask.get(t.task.task_id); if (row) out.predecessorTasks.push(row);
        }
      }
    }
    if (!out.targetTask) return null;
    return out;
  } finally {
    snap.close();
  }
}

async function seedArm(arm, rows, stage) {
  const ws = armWorkspaceDir(arm, 'pa');
  // PRI-1252 r2 fence: the DB bootstrap/copy/config write must not go through
  // an out-of-bounds path (same timing rule as materializeWorkspace — the
  // spawn itself is re-validated later by spawnPdChild).
  assertWorkspaceIsolation(ws, { phase: 'seed:pre-write' });
  const cfg = path.join(ws, '.pd', 'config.yaml');
  fs.mkdirSync(path.join(ws, '.pd'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.state'), { recursive: true });
  // PRI-1252 r4 (P1-2): reuse is identity-gated, not existence-gated — an
  // existing config must not carry nlink > 1 (external hardlink class) and
  // must match its provenance record when one exists.
  const cfgExists = (() => { try { fs.statSync(cfg); return true; } catch { return false; } })();
  if (!cfgExists) fs.writeFileSync(cfg, deriveExperimentConfig(ws, arm), 'utf8');
  else assertArtifactReuseSafety(ws, path.join('.pd', 'config.yaml'), 'seed:reuse-config');
  // PRI-1254 r2 (review 0004): the seeded workspace must also install the
  // arm's declared workspaceFiles — same fences as materializeWorkspace.
  materializeWorkspaceFiles(arm, ws);
  // REAL PD schema bootstrap (Owner §7.1) — schema_version verified below —
  // with THIS ARM'S OWN SqliteConnection (P2-06: never candidate code for a
  // baseline database).
  const { SqliteConnection } = await stageRuntimeFor(arm);
  const conn = new SqliteConnection({ workspaceDir: ws, bootstrapIfMissing: true, readonlyMode: false });
  const db = conn.getDb();
  try {
    const sv = db.prepare('SELECT max(version) AS v FROM schema_version').get().v;
    const required = db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name IN ('tasks','pi_artifacts','runs')").get().c;
    if (required !== 3 || !sv) throw new Error(`PD schema bootstrap failed (tables=${required}, schema_version=${sv})`);
    // Fresh-DB-only seeding: reject an existing contaminated DB.
    const existing = db.prepare('SELECT count(*) AS c FROM tasks').get().c;
    if (existing > 0) throw new Error(`workspace ${ws} already carries ${existing} tasks — refusing to seed over an existing run (cross-run contamination guard)`);
    const trajSrc = path.join(snapshotDir(), 'trajectory.db');
    const trajDst = path.join(ws, '.state', 'trajectory.db');
    // PRI-1252 r4 (P1-2): same identity gate for the trajectory DB — the
    // reproduced hardlink attack targeted exactly this file.
    const trajExists = (() => { try { fs.statSync(trajDst); return true; } catch { return false; } })();
    if (!trajExists) fs.copyFileSync(trajSrc, trajDst);
    else assertArtifactReuseSafety(ws, path.join('.state', 'trajectory.db'), 'seed:reuse-trajectory');

    const insertTask = db.prepare(`INSERT INTO tasks (${TASK_COLUMNS.join(', ')}) VALUES (${TASK_COLUMNS.map(() => '?').join(', ')})`);
    const insertArt = db.prepare(`INSERT INTO pi_artifacts (${ART_COLUMNS.join(', ')}) VALUES (${ART_COLUMNS.map(() => '?').join(', ')})`);
    const asTask = (t, overrides = {}) => TASK_COLUMNS.map((c) => (overrides[c] !== undefined ? overrides[c] : t[c]));
    for (const t of rows.predecessorTasks) insertTask.run(...asTask(t));
    if (rows.parentTask && stage !== 'dreamer' && stage !== 'philosopher' && stage !== 'scribe') {
      insertTask.run(...asTask(rows.parentTask, { status: 'pending', lease_owner: null, lease_expires_at: null, last_error: null }));
    }
    for (const a of rows.predecessorArtifacts) insertArt.run(...ART_COLUMNS.map((c) => a[c]));
    insertTask.run(...asTask(rows.targetTask, {
      status: 'pending', lease_owner: null, lease_expires_at: null, attempt_count: 0, last_error: null, result_ref: null,
    }));
    // PRI-1252 r4: after ALL writes land, record provenance identity for the
    // sensitive artifacts so spawn-level checks can verify them (a hardlink
    // that exists at this point is refused by recordArtifactProvenance).
    recordArtifactProvenance(ws);
    return { ws, schemaVersion: sv };
  } finally {
    db.close();
    conn.close?.();
  }
}

/**
 * PRI-1252 r2: the ONLY spawn wiring for pd-cli children lives in ab-lib
 * spawnPdChild() — runPdIn() delegates so the physical workspace fence
 * (pre-spawn revalidation + PD_WORKSPACE_DIR value gate against THIS ws) is
 * enforced identically for both entry points. A local pointer injection via
 * the env builder here would bypass the fence — guarded by the spawn-refusal
 * source tripwire (r2 describes in pdspec001-childenv-pointer-isolation.test.ts).
 */
async function runPdIn(arm, ws, args2, timeoutMs = 45 * 60_000) {
  return spawnPdChild({ arm, worktree: armWorktree(arm), ws, args: args2, timeoutMs });
}

const args = parseArgs(process.argv);
const { deriveExperimentConfig } = await import('./ab-lib.mjs');
// PRI-1254 r2 (review 0005): per-stage entry spawns REAL children — full
// generic preflight BEFORE any record write or child spawn.
{
  const pre = preflightChecks();
  if (!pre.ok) {
    console.error('stage preflight failed BEFORE any side effect:');
    for (const c of pre.checks.filter((x) => !x.ok)) console.error(`  - ${c.name}: ${JSON.stringify(c.detail).slice(0, 400)}`);
    process.exit(1);
  }
}
const dataset = JSON.parse(fs.readFileSync(datasetFile(), 'utf8'));
const samples = dataset.samples.filter((s) => (args.samples ? args.samples.includes(s.experimentPainId) : true));

const dir = path.join(validateRunId(args.runId)); // runId fence BEFORE mkdir
const recordsDir = path.join(dir, 'records-pa');
fs.mkdirSync(recordsDir, { recursive: true });

/** Per-arm runtime: SqliteConnection + stage schemas from THAT arm's dist (P2-06). */
const armRuntimeCache = new Map();
async function stageRuntimeFor(arm) {
  if (!armRuntimeCache.has(arm)) {
    const rt = await loadArmRuntime(arm);
    armRuntimeCache.set(arm, {
      SqliteConnection: rt.SqliteConnection,
      STAGE_SCHEMAS: {
        router: { validate: (parsed) => rt.schemas.routerEnvelope(parsed) !== undefined },
        distiller: { validate: (parsed) => Value.Check(rt.schemas.distiller, parsed) },
        dreamer: { validate: (parsed) => Value.Check(rt.schemas.dreamer, parsed) },
        philosopher: { validate: (parsed) => Value.Check(rt.schemas.philosopher, parsed) },
        scribe: { validate: (parsed) => Value.Check(rt.schemas.scribe, parsed) },
      },
    });
  }
  return armRuntimeCache.get(arm);
}

(async () => {
  for (const sample of samples) {
    let rows;
    try { rows = historicalRows(sample, args.stage); } catch (e) { console.log(`${sample.experimentPainId}: no historical rows (${e.message})`); continue; }
    if (!rows) { console.log(`${sample.experimentPainId}: no historical ${args.stage} run — skipped`); continue; }
    for (const arm of args.arms) {
      const recPath = path.join(recordsDir, `${sample.experimentPainId}.${args.stage}.${arm}.json`);
      // CodeQL js/file-system-race: stat once instead of existsSync-then-read.
      const priorExists = (() => { try { fs.statSync(recPath); return true; } catch { return false; } })();
      if (priorExists) {
        const prior = JSON.parse(fs.readFileSync(recPath, 'utf8'));
        if (prior.status === 'done' && prior.verification?.ok === true) { console.log(`${sample.experimentPainId}.${args.stage}.${arm}: done (cached)`); continue; }
      }
      const record = { experimentPainId: sample.experimentPainId, stage: args.stage, arm, targetTaskId: rows.targetTask.task_id, inputDigest: sha256(JSON.stringify(rows.predecessorArtifacts.map((a) => a.content_json))), steps: [], status: 'running', startedAt: new Date().toISOString() };
      const log = (step, data) => { record.steps.push({ step, at: new Date().toISOString(), ...data }); fs.writeFileSync(recPath, JSON.stringify(record, null, 2) + '\n', 'utf8'); };
      const fail = (category, message) => {
        record.status = 'failed'; record.errorCategory = category; record.error = message;
        record.finishedAt = new Date().toISOString();
        fs.writeFileSync(recPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
        return record;
      };
      try {
        const stageRuntime = await stageRuntimeFor(arm); // THIS arm's schemas (P2-06)
        const { ws, schemaVersion } = await seedArm(arm, rows, args.stage);
        record.schemaVersion = schemaVersion;
        log('seed', { workspace: path.basename(ws), schemaVersion });
        let r;
        if (args.stage === 'distiller' || args.stage === 'router') {
          r = await runPdIn(arm, ws, ['diagnose', 'run', '--task-id', rows.parentTask.task_id]);
        } else {
          r = await runPdIn(arm, ws, ['runtime', 'internalization', 'run-once', '--runner', args.stage]);
        }
        log('execute', { code: r.code, stdoutTail: r.stdout.slice(-4000), stderrTail: r.stderr.slice(-1500) });

        // STRICT terminal verification (Owner §7.2).
        const db = new Database(path.join(ws, '.pd', 'state.db'), { readonly: true });
        const targetTask = db.prepare('SELECT task_id, status, attempt_count, last_error FROM tasks WHERE task_id = ?').get(rows.targetTask.task_id);
        const succeededRun = db.prepare("SELECT run_id FROM runs WHERE task_id = ? AND execution_status = 'succeeded' LIMIT 1").get(rows.targetTask.task_id);
        const targetArts = db.prepare('SELECT artifact_id, content_json FROM pi_artifacts WHERE source_task_id = ? ORDER BY created_at').all(rows.targetTask.task_id);
        db.close();
        const v = { checks: {}, errors: [] };
        v.checks.childExit0 = r.code === 0;
        v.checks.taskSucceeded = targetTask?.status === 'succeeded';
        v.checks.runSucceeded = Boolean(succeededRun);
        v.checks.artifactPresent = targetArts.length > 0;
        if (targetArts.length > 0) {
          try {
            const parsed = JSON.parse(targetArts[targetArts.length - 1].content_json);
            v.checks.artifactSchemaValid = stageRuntime.STAGE_SCHEMAS[args.stage].validate(parsed);
            if (!v.checks.artifactSchemaValid) v.errors.push('artifact failed schema validation');
          } catch (e) { v.checks.artifactSchemaValid = false; v.errors.push('artifact JSON unparseable'); }
        } else { v.checks.artifactSchemaValid = false; }
        v.checks.artifactLinkedToTask = targetArts.length > 0;
        v.ok = Object.values(v.checks).every(Boolean);
        record.verification = v;
        record.result = { targetTask, succeededRun: Boolean(succeededRun), artifacts: targetArts.map((a) => a.artifact_id) };
        record.artifactsSha256 = sha256(targetArts.map((a) => a.artifact_id).join('|'));
        record.status = v.ok ? 'done' : 'failed';
        if (!v.ok) { record.errorCategory = 'verification_failed'; record.error = 'terminal verification failed: ' + v.errors.join('; '); }
        record.finishedAt = new Date().toISOString();
        fs.writeFileSync(recPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
        console.log(`${sample.experimentPainId}.${args.stage}.${arm}: ${record.status}${v.ok ? '' : ' (' + record.errorCategory + ')'}`);
      } catch (err) {
        fail('harness_exception', String(err?.message ?? err));
        console.log(`${sample.experimentPainId}.${args.stage}.${arm}: ERROR ${String(err?.message ?? err).slice(0, 120)}`);
      }
    }
  }
  console.log('per-agent run complete ->', recordsDir);
})();
