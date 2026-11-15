/**
 * PD-SPEC-001 Phase 0c step 1 — production DB snapshot (consistent, read-only)
 * + linkage discovery for the pain inventory.
 *
 * - Sources are opened READONLY (fileMustExist); never written.
 * - Snapshots created via better-sqlite3 backup API (reads through hot WAL
 *   consistently); integrity_check run on BOTH source and snapshot.
 * - All SQL uses bound parameters; discovery output only (counts, PRAGMA,
 *   small samples) — no full-dump to stdout.
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { findRepoRoot } from './repo-root.mjs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const worktree = findRepoRoot(import.meta.url);
const outDir = path.join(worktree, '.tmp/prompt-v2-inventory');
const snapDir = path.join(outDir, 'snapshot');
mkdirSync(snapDir, { recursive: true });

const SOURCES = {
  state: 'D:/.openclaw/workspace/.pd/state.db',
  trajectory: 'D:/.openclaw/workspace/.state/trajectory.db',
};

const sha256File = (p) => {
  const fs = require('node:fs');
  const buf = fs.readFileSync(p);
  return createHash('sha256').update(buf).digest('hex');
};

const report = { spec: 'PD-SPEC-001', phase: '0c-snapshot', takenAt: new Date().toISOString(), sources: {}, snapshots: {}, counts: {}, discovery: {} };

for (const [name, srcPath] of Object.entries(SOURCES)) {
  const src = new Database(srcPath, { readonly: true, fileMustExist: true });
  const integrity = src.pragma('integrity_check', { simple: true });
  const destPath = path.join(snapDir, `${name}.db`);
  await src.backup(destPath);
  const snap = new Database(destPath, { readonly: true });
  const snapIntegrity = snap.pragma('integrity_check', { simple: true });
  report.sources[name] = { path: srcPath, integrityCheck: integrity, sizeBytes: require('node:fs').statSync(srcPath).size };
  report.snapshots[name] = { path: destPath, integrityCheck: snapIntegrity, sha256: sha256File(destPath), sizeBytes: require('node:fs').statSync(destPath).size };
  snap.close();
  src.close();
}

// ── Count verification source vs snapshot ──
const COUNT_TABLES = {
  state: ['tasks', 'runs', 'artifacts', 'pi_artifacts', 'principle_candidates', 'pain_diagnoses', 'dead_letter_pains', 'pending_agent_drafts', 'intent_decisions'],
  trajectory: ['pain_events'],
};
for (const [name, tables] of Object.entries(COUNT_TABLES)) {
  const src = new Database(SOURCES[name], { readonly: true, fileMustExist: true });
  const snap = new Database(report.snapshots[name].path, { readonly: true });
  report.counts[name] = {};
  for (const t of tables) {
    try {
      const a = src.prepare(`SELECT count(*) AS c FROM "${t}"`).get().c;
      const b = snap.prepare(`SELECT count(*) AS c FROM "${t}"`).get().c;
      report.counts[name][t] = { source: a, snapshot: b, match: a === b };
    } catch (e) {
      report.counts[name][t] = { error: String(e.message) };
    }
  }
  snap.close();
  src.close();
}

// ── Discovery (on snapshots) ──
const state = new Database(report.snapshots.state.path, { readonly: true });
const traj = new Database(report.snapshots.trajectory.path, { readonly: true });

// pain_events overview
report.discovery.painBySource = traj.prepare('SELECT source, count(*) AS c FROM pain_events GROUP BY source ORDER BY c DESC').all();
report.discovery.painBySeverity = traj.prepare('SELECT severity, count(*) AS c FROM pain_events GROUP BY severity ORDER BY c DESC').all();
report.discovery.painByHostKind = traj.prepare('SELECT host_kind, count(*) AS c FROM pain_events GROUP BY host_kind ORDER BY c DESC').all();
report.discovery.painColumns = traj.prepare('PRAGMA table_info(pain_events)').all().map((c) => c.name);

// task kinds + status matrix
report.discovery.taskKindStatus = state.prepare('SELECT task_kind, status, count(*) AS c FROM tasks GROUP BY task_kind, status ORDER BY task_kind, c DESC').all();

// task id patterns per kind (2 samples each)
const kinds = state.prepare('SELECT DISTINCT task_kind FROM tasks').all().map((r) => r.task_kind);
report.discovery.taskIdSamples = {};
for (const k of kinds) {
  report.discovery.taskIdSamples[k] = state.prepare('SELECT task_id FROM tasks WHERE task_kind = ? LIMIT 2').all(k).map((r) => r.task_id);
}

// pain_diagnoses linkage samples
report.discovery.painDiagnosesColumns = state.prepare('PRAGMA table_info(pain_diagnoses)').all().map((c) => c.name);
report.discovery.painDiagnosesSamples = state.prepare('SELECT id, pain_id, task_id, diagnosis_id, category, confidence, created_at FROM pain_diagnoses ORDER BY created_at DESC LIMIT 5').all();

// principle_candidates columns + status histogram
report.discovery.principleCandidateColumns = state.prepare('PRAGMA table_info(principle_candidates)').all().map((c) => c.name);
report.discovery.piArtifactKinds = state.prepare('SELECT artifact_kind, validation_status, count(*) AS c FROM pi_artifacts GROUP BY artifact_kind, validation_status ORDER BY c DESC').all();

// does a `principles` table exist?
report.discovery.allTables = state.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);

state.close();
traj.close();

writeFileSync(path.join(outDir, 'snapshot-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ sources: report.sources, snapshots: report.snapshots, counts: report.counts }, null, 1));
console.log('painBySource:', JSON.stringify(report.discovery.painBySource));
console.log('taskKindStatus:', JSON.stringify(report.discovery.taskKindStatus));
console.log('piArtifactKinds:', JSON.stringify(report.discovery.piArtifactKinds.slice(0, 12)));
console.log('allTables:', JSON.stringify(report.discovery.allTables));
console.log('report ->', path.relative(worktree, path.join(outDir, 'snapshot-report.json')));
