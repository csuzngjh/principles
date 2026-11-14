/**
 * PD-SPEC-001 Experiment A — per-agent paired A/B (SPEC §4.4).
 *
 * For each sample and BOTH arms, seeds the HISTORICAL production rows
 * verbatim into a dedicated per-agent arm workspace (…-pa suffix, isolated
 * from the full-chain workspaces):
 *   - predecessor task rows (status succeeded, untouched diagnostic_json);
 *   - predecessor pi_artifacts rows (verbatim — the EXACT upstream inputs);
 *   - the target stage's task row normalized to pending (lease cleared).
 * Then executes the ONE stage through the production CLI:
 *   distiller/router → pd diagnose run (split runner skips succeeded stages);
 *   dreamer/philosopher/scribe → pd runtime internalization run-once --runner <kind>.
 * Both arms therefore run the same agent on byte-identical upstream inputs;
 * the only delta is the prompt builder (proven elsewhere).
 *
 * Usage:
 *   node ab-stage.mjs --run-id <id> --stage distiller|router|dreamer|philosopher|scribe
 *                      [--samples S01,...] [--arms v1,v2]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  WORKTREES, EXPERIMENT_ROOT, SNAPSHOT_DIR, DATASET_FILE, childEnv, gitHead, sha256, deriveExperimentConfig,
} from './ab-lib.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const here = path.dirname(fileURLToPath(import.meta.url));
const TASK_COLUMNS = ['task_id', 'task_kind', 'status', 'created_at', 'updated_at', 'lease_owner', 'lease_expires_at', 'attempt_count', 'max_attempts', 'last_error', 'input_ref', 'result_ref', 'diagnostic_json'];
const ART_COLUMNS = ['artifact_id', 'artifact_kind', 'source_task_id', 'source_principle_id', 'source_rule_id', 'lineage_artifact_ids', 'validation_status', 'content_json', 'created_at', 'updated_at'];

function parseArgs(argv) {
  const out = { arms: ['v1', 'v2'] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run-id') out.runId = argv[++i];
    else if (a === '--stage') out.stage = argv[++i];
    else if (a === '--samples') out.samples = argv[++i].split(',');
    else if (a === '--arms') out.arms = argv[++i].split(',');
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!out.runId || !out.stage) throw new Error('--run-id and --stage are required');
  if (!['distiller', 'router', 'dreamer', 'philosopher', 'scribe'].includes(out.stage)) throw new Error(`unsupported stage: ${out.stage}`);
  return out;
}

function snapshotDb() {
  return new Database(path.join(SNAPSHOT_DIR, 'state.db'), { readonly: true });
}

/** Pull a sample's historical stage rows from the frozen dataset/snapshot. */
function historicalRows(sample, stage) {
  const snap = snapshotDb();
  try {
    const diagTaskId = sample.originalTaskId;
    const getTask = snap.prepare(`SELECT ${TASK_COLUMNS.join(', ')} FROM tasks WHERE task_id = ?`);
    const getArts = snap.prepare(`SELECT ${ART_COLUMNS.join(', ')} FROM pi_artifacts WHERE source_task_id = ? ORDER BY created_at`);
    const stages = sample.stageArtifacts ?? {};
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
      // formation stages: pick the sample's first candidate that reached this stage historically
      const formation = sample.formation ?? [];
      const cand = formation.find((f) => Array.isArray(f[stage]) && f[stage].length > 0 && f[stage].some((t) => t.task?.status === 'succeeded'));
      if (!cand) return null; // sample not usable for this stage
      const target = cand[stage].find((t) => t.task?.status === 'succeeded');
      out.targetTask = getTask.get(target.task.task_id);
      out.targetKind = stage;
      if (stage === 'dreamer') {
        // predecessor = router artifact (diagnosis)
        const routerArts = getArts.all(`diag_router-${diagTaskId}`);
        out.predecessorArtifacts.push(...routerArts);
      } else if (stage === 'philosopher') {
        for (const t of cand.dreamer ?? []) out.predecessorArtifacts.push(...getArts.all(t.task.task_id));
        for (const t of cand.dreamer ?? []) { const row = getTask.get(t.task.task_id); if (row) out.predecessorTasks.push(row); }
      } else {
        for (const t of [...(cand.dreamer ?? []), ...(cand.philosopher ?? [])]) out.predecessorArtifacts.push(...getArts.all(t.task.task_id));
        for (const t of [...(cand.dreamer ?? []), ...(cand.philosopher ?? [])]) { const row = getTask.get(t.task.task_id); if (row) out.predecessorTasks.push(row); }
      }
    }
    if (!out.targetTask) return null;
    return out;
  } finally {
    snap.close();
  }
}

function seedArm(armSuffix, arm, rows, stage) {
  const ws = path.join(EXPERIMENT_ROOT, 'workspaces', `${arm}-${armSuffix}`);
  fs.mkdirSync(path.join(ws, '.pd'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.state'), { recursive: true });
  const trajSrc = path.join(SNAPSHOT_DIR, 'trajectory.db');
  const trajDst = path.join(ws, '.state', 'trajectory.db');
  if (!fs.existsSync(trajDst)) fs.copyFileSync(trajSrc, trajDst);
  const cfgDst = path.join(ws, '.pd', 'config.yaml');
  if (!fs.existsSync(cfgDst)) fs.writeFileSync(cfgDst, deriveExperimentConfig(ws), 'utf8');
  const db = new Database(path.join(ws, '.pd', 'state.db'));
  try {
    const insertTask = db.prepare(`INSERT OR REPLACE INTO tasks (${TASK_COLUMNS.join(', ')}) VALUES (${TASK_COLUMNS.map(() => '?').join(', ')})`);
    const insertArt = db.prepare(`INSERT OR REPLACE INTO pi_artifacts (${ART_COLUMNS.join(', ')}) VALUES (${ART_COLUMNS.map(() => '?').join(', ')})`);
    const asTask = (t, overrides = {}) => TASK_COLUMNS.map((c) => overrides[c] !== undefined ? overrides[c] : t[c]);
    // predecessors: verbatim (succeeded status preserved)
    for (const t of rows.predecessorTasks) insertTask.run(...asTask(t));
    if (rows.parentTask && stage !== 'dreamer' && stage !== 'philosopher' && stage !== 'scribe') {
      insertTask.run(...asTask(rows.parentTask, { status: 'pending', lease_owner: null, lease_expires_at: null, last_error: null }));
    }
    for (const a of rows.predecessorArtifacts) insertArt.run(...ART_COLUMNS.map((c) => a[c]));
    // target: pending, lease cleared, attempts reset
    insertTask.run(...asTask(rows.targetTask, {
      status: 'pending', lease_owner: null, lease_expires_at: null, attempt_count: 0, last_error: null, result_ref: null,
    }));
    return ws;
  } finally {
    db.close();
  }
}

async function runPdIn(arm, ws, args, timeoutMs = 45 * 60_000) {
  const { spawn } = await import('node:child_process');
  const cli = path.join(WORKTREES[arm], 'packages/pd-cli/dist/index.js');
  const env = childEnv({ PD_WORKSPACE_DIR: ws });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args, '--workspace', ws, '--json'], { env, cwd: ws });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

const args = parseArgs(process.argv);
const dataset = JSON.parse(fs.readFileSync(DATASET_FILE, 'utf8'));
const samples = dataset.samples.filter((s) => (args.samples ? args.samples.includes(s.experimentPainId) : true));

const dir = path.join(EXPERIMENT_ROOT, 'runs', args.runId);
const recordsDir = path.join(dir, 'records-pa');
fs.mkdirSync(recordsDir, { recursive: true });

(async () => {
  for (const sample of samples) {
    let rows;
    try { rows = historicalRows(sample, args.stage); } catch (e) { console.log(`${sample.experimentPainId}: no historical rows (${e.message})`); continue; }
    if (!rows) { console.log(`${sample.experimentPainId}: no historical ${args.stage} run — skipped`); continue; }
    for (const arm of args.arms) {
      const recPath = path.join(recordsDir, `${sample.experimentPainId}.${args.stage}.${arm}.json`);
      if (fs.existsSync(recPath)) { const prior = JSON.parse(fs.readFileSync(recPath, 'utf8')); if (prior.status === 'done') { console.log(`${sample.experimentPainId}.${args.stage}.${arm}: done (cached)`); continue; } }
      const ws = seedArm('pa', arm, rows, args.stage);
      const record = { experimentPainId: sample.experimentPainId, stage: args.stage, arm, targetTaskId: rows.targetTask.task_id, inputDigest: sha256(JSON.stringify(rows.predecessorArtifacts.map((a) => a.content_json))), steps: [], status: 'running', startedAt: new Date().toISOString() };
      const log = (step, data) => { record.steps.push({ step, at: new Date().toISOString(), ...data }); fs.writeFileSync(recPath, JSON.stringify(record, null, 2) + '\n', 'utf8'); };
      try {
        if (args.stage === 'distiller' || args.stage === 'router') {
          const r = await runPdIn(arm, ws, ['diagnose', 'run', '--task-id', rows.parentTask.task_id]);
          log('diagnose-run', { code: r.code, stdoutTail: r.stdout.slice(-6000), stderrTail: r.stderr.slice(-3000) });
        } else {
          const r = await runPdIn(arm, ws, ['runtime', 'internalization', 'run-once', '--runner', args.stage]);
          log('run-once', { code: r.code, stdoutTail: r.stdout.slice(-6000), stderrTail: r.stderr.slice(-3000) });
        }
        // collect the fresh target artifact (latest for the target task)
        const db = new Database(path.join(ws, '.pd', 'state.db'), { readonly: true });
        const targetArts = db.prepare('SELECT artifact_id, content_json, created_at FROM pi_artifacts WHERE source_task_id = ? ORDER BY created_at').all(rows.targetTask.task_id);
        const targetTask = db.prepare('SELECT task_id, status, attempt_count, last_error FROM tasks WHERE task_id = ?').get(rows.targetTask.task_id);
        const targetRuns = db.prepare('SELECT task_id, execution_status, attempt_number, reason FROM runs WHERE task_id = ? ORDER BY attempt_number').all(rows.targetTask.task_id);
        db.close();
        record.result = { targetTask, targetRuns, artifacts: targetArts };
        record.status = 'done';
        record.finishedAt = new Date().toISOString();
        fs.writeFileSync(recPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
        console.log(`${sample.experimentPainId}.${args.stage}.${arm}: done (task ${targetTask?.status})`);
      } catch (err) {
        record.status = 'error';
        record.error = String(err?.message ?? err);
        fs.writeFileSync(recPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
        console.log(`${sample.experimentPainId}.${args.stage}.${arm}: ERROR ${record.error.slice(0, 120)}`);
      }
    }
  }
  console.log('per-agent run complete ->', recordsDir);
})();
