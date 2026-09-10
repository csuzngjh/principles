#!/usr/bin/env node
// PRI-678 — Diagnostician dual-write consistency audit (READ-ONLY dev tool).
//
// DiagRouterRunner.succeedTask writes the SAME DiagnosticianOutputV1 twice:
//   1. SqliteDiagnosticianCommitter (one transaction)
//        → artifacts (kind='diagnostician_output') + commits + principle_candidates
//        → read by candidate-intake / evidence-chain read models
//   2. SqlitePIArtifactStore.upsertArtifact (separate autocommit)
//        → pi_artifacts (one row per task, ON CONFLICT (source_task_id, artifact_kind))
//        → read by tier2 lineage (CandidateLineage / evaluator stage2)
//
// The two writes have a crash window and no runtime cross-check; this script
// quantifies real drift in durable data without mutating anything (all SQLite
// opened READ-ONLY, better-sqlite3 readonly + fileMustExist — same contract
// as scripts/dev/pipeline-evolution/collect-evidence.mjs).
//
// Classification per diag_router task:
//   IDENTICAL        latest artifacts.content_json === pi_artifacts.content_json
//                    (byte-equal; both sides serialize the same string today)
//   CONTENT_DRIFT    both present, payloads differ (semantic fields reported)
//   LINEAGE_DRIFT    both present, content identical but the pi row was
//                    produced by an OLDER run than the latest legacy commit
//                    (upsert lost a retry's newer payload — hidden staleness)
//   MISSING_PI       legacy artifacts row(s) exist, pi_artifacts row absent
//                    (crash between the two writes / pre-PRI-667 workspace)
//   MISSING_LEGACY   pi_artifacts row exists, no artifacts row
//   UNCOMPARABLE     payload unparseable on either side
//   NO_ARTIFACTS     task never produced either row (informational, not drift)
//
// Output: JSON report to stdout, human summary to stderr.
// Exit codes: 0 PASS · 2 DRIFT_FOUND · 3 AUDIT_UNAVAILABLE (never report
// unreadable data as "0 drift").
//
// Usage:
//   node scripts/dev/audit-diagnostician-dual-write.mjs <workspace-dir>... [--json-only]

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const jsonOnly = args.includes('--json-only');
const workspaces = args.filter((a) => !a.startsWith('--'));
if (workspaces.length === 0) {
  console.error('Usage: audit-diagnostician-dual-write.mjs <workspace-dir>... [--json-only]');
  console.error('  <workspace-dir> may be the PD workspace root (<ws>/.pd/state.db)');
  console.error('  or a lab workspace whose agent root nests one level (<ws>/main/.pd/state.db).');
  process.exit(3);
}

// PD state may live at <ws>/.pd, <ws>/main/.pd (OpenClaw nests the main
// agent), or <ws>/ws/main/.pd (closure-lab workspaces nest the agent tree
// under ws/ — same resolution order as collect-evidence.mjs plus the lab form).
function resolveStateDb(workspace) {
  for (const root of [workspace, join(workspace, 'main'), join(workspace, 'ws'), join(workspace, 'ws', 'main')]) {
    const db = join(root, '.pd', 'state.db');
    if (existsSync(db)) return db;
  }
  return null;
}

function openReadOnly(dbPath) {
  const Database = require('better-sqlite3');
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

const sha256 = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');

function classifyTask(task, legacyRows, piRow) {
  const latest = legacyRows.length > 0 ? legacyRows[legacyRows.length - 1] : null;
  const base = {
    taskId: task.task_id,
    taskStatus: task.status,
    legacyRowCount: legacyRows.length,
    retryAccumulation: legacyRows.length > 1,
  };
  if (!latest && !piRow) return { ...base, classification: 'NO_ARTIFACTS', drift: false };
  if (latest && !piRow) {
    return { ...base, classification: 'MISSING_PI', drift: true, legacyLatestRun: latest.run_id, legacyContentSha: sha256(latest.content_json) };
  }
  if (!latest && piRow) {
    return { ...base, classification: 'MISSING_LEGACY', drift: true, piArtifactId: piRow.artifact_id, piContentSha: sha256(piRow.content_json) };
  }
  if (latest.content_json === piRow.content_json) {
    // Same payload: is the lineage row from the same (latest) producing run?
    // pi artifact ids are `pi-art-<taskId>-<runId>`.
    const piRun = piRow.artifact_id.startsWith(`pi-art-${task.task_id}-`)
      ? piRow.artifact_id.slice(`pi-art-${task.task_id}-`.length)
      : null;
    if (piRun !== null && piRun !== latest.run_id) {
      return {
        ...base,
        classification: 'LINEAGE_DRIFT',
        drift: true,
        piRun,
        legacyLatestRun: latest.run_id,
        note: 'pi row payload identical but produced by an older run than the latest legacy commit',
      };
    }
    return { ...base, classification: 'IDENTICAL', drift: false };
  }
  let semantic = null;
  try {
    const a = JSON.parse(latest.content_json);
    const b = JSON.parse(piRow.content_json);
    const fields = ['diagnosisId', 'valid', 'summary', 'rootCause', 'confidence'];
    const diff = fields.filter((f) => JSON.stringify(a[f]) !== JSON.stringify(b[f]));
    const recDiff = (a.recommendations?.length ?? -1) !== (b.recommendations?.length ?? -1);
    semantic = { semanticFieldsDiffer: [...diff, ...(recDiff ? ['recommendations.length'] : [])] };
  } catch {
    semantic = { semanticFieldsDiffer: null, parseError: true };
  }
  return {
    ...base,
    classification: semantic?.parseError ? 'UNCOMPARABLE' : 'CONTENT_DRIFT',
    drift: true,
    legacyLatestRun: latest.run_id,
    legacyContentSha: sha256(latest.content_json),
    piArtifactId: piRow.artifact_id,
    piContentSha: sha256(piRow.content_json),
    ...semantic,
  };
}

function auditWorkspace(workspace) {
  const dbPath = resolveStateDb(workspace);
  if (!dbPath) {
    return { workspace, status: 'AUDIT_UNAVAILABLE', reason: 'no .pd/state.db under workspace (nor <ws>/main/.pd)' };
  }
  let db;
  try {
    db = openReadOnly(dbPath);
  } catch (err) {
    return { workspace, stateDb: dbPath, status: 'AUDIT_UNAVAILABLE', reason: `cannot open read-only: ${err.message}` };
  }
  try {
    const has = (t) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
    for (const t of ['tasks', 'artifacts', 'pi_artifacts']) {
      if (!has(t)) return { workspace, stateDb: dbPath, status: 'AUDIT_UNAVAILABLE', reason: `table ${t} missing (not a PD state.db?)` };
    }
    const tasks = db.prepare("SELECT task_id, status FROM tasks WHERE task_kind = 'diag_router' ORDER BY task_id").all();
    const legacyStmt = db.prepare(
      "SELECT artifact_id, run_id, content_json, created_at FROM artifacts WHERE task_id = ? AND artifact_kind = 'diagnostician_output' ORDER BY created_at, artifact_id",
    );
    const piStmt = db.prepare('SELECT artifact_id, content_json, updated_at FROM pi_artifacts WHERE source_task_id = ?');
    const counts = {
      IDENTICAL: 0,
      CONTENT_DRIFT: 0,
      LINEAGE_DRIFT: 0,
      MISSING_PI: 0,
      MISSING_LEGACY: 0,
      UNCOMPARABLE: 0,
      NO_ARTIFACTS: 0,
    };
    const details = [];
    for (const task of tasks) {
      const result = classifyTask(task, legacyStmt.all(task.task_id), piStmt.get(task.task_id) ?? null);
      counts[result.classification] += 1;
      if (result.classification !== 'IDENTICAL') details.push(result);
    }
    const driftTotal = counts.CONTENT_DRIFT + counts.LINEAGE_DRIFT + counts.MISSING_PI + counts.MISSING_LEGACY + counts.UNCOMPARABLE;
    return {
      workspace,
      stateDb: dbPath,
      status: driftTotal > 0 ? 'DRIFT_FOUND' : 'PASS',
      diagRouterTasks: tasks.length,
      classifications: counts,
      driftTotal,
      details,
    };
  } catch (err) {
    return { workspace, stateDb: dbPath, status: 'AUDIT_UNAVAILABLE', reason: `query failed: ${err.message}` };
  } finally {
    db.close();
  }
}

const results = workspaces.map(auditWorkspace);
const anyDrift = results.some((r) => r.status === 'DRIFT_FOUND');
const anyUnavailable = results.some((r) => r.status === 'AUDIT_UNAVAILABLE');
const report = {
  audit: 'diagnostician-dual-write-consistency',
  issue: 'PRI-678',
  readOnly: true,
  results,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

if (!jsonOnly) {
  for (const r of results) {
    if (r.status === 'AUDIT_UNAVAILABLE') {
      process.stderr.write(`[UNAVAILABLE] ${r.workspace}: ${r.reason}\n`);
    } else {
      const c = r.classifications;
      process.stderr.write(
        `[${r.status}] ${r.workspace}: diagRouterTasks=${r.diagRouterTasks} identical=${c.IDENTICAL} ` +
          `contentDrift=${c.CONTENT_DRIFT} lineageDrift=${c.LINEAGE_DRIFT} missingPi=${c.MISSING_PI} ` +
          `missingLegacy=${c.MISSING_LEGACY} uncomparable=${c.UNCOMPARABLE} noArtifacts=${c.NO_ARTIFACTS}\n`,
      );
    }
  }
}
// Priority: real drift outranks audit unavailability, and an audit that could
// not read some workspace must never exit PASS (that would read as "0 drift").
process.exit(anyDrift ? 2 : anyUnavailable ? 3 : 0);
