// PRI-743 read-only dogfood data probe.
// Opens the real workspace databases in READONLY mode and reports counts.
// Never writes, never mutates, never repairs.
import { createRequire } from 'node:module';
import path from 'node:path';

// Resolve better-sqlite3 from this checkout when installed; fall back to the
// primary checkout's node_modules when running from a bare probe checkout.
function loadSqlite() {
  try {
    return createRequire(import.meta.url)('better-sqlite3');
  } catch {
    return createRequire('D:/Code/principles/package.json')('better-sqlite3');
  }
}
const Database = loadSqlite();

const WS = process.argv[2] ?? 'D:/Code/principles';
const trajPath = path.join(WS, 'trajectory.db');
const statePath = path.join(WS, '.pd', 'state.db');

function open(p) {
  try {
    return { db: new Database(p, { readonly: true }), path: p, ok: true };
  } catch (e) {
    return { db: null, path: p, ok: false, error: e.message };
  }
}

function tables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
}

function countBy(db, table, col) {
  try {
    return db.prepare(`SELECT ${col} AS k, COUNT(*) AS n FROM ${table} GROUP BY ${col} ORDER BY n DESC`).all();
  } catch (e) {
    return [{ error: e.message }];
  }
}

function scalar(db, sql) {
  try {
    return db.prepare(sql).get();
  } catch (e) {
    return { error: e.message };
  }
}

const out = { workspace: WS, generatedAt: new Date().toISOString(), databases: {} };

for (const [label, p] of [['trajectory', trajPath], ['state', statePath]]) {
  const { db, ok, error } = open(p);
  if (!ok) {
    out.databases[label] = { path: p, ok: false, error };
    continue;
  }
  const t = tables(db);
  const info = { path: p, ok: true, tables: t };
  const has = (n) => t.includes(n);

  if (has('pain_events')) {
    info.pain_events = {
      total: scalar(db, 'SELECT COUNT(*) AS n FROM pain_events').n,
      by_host_kind: countBy(db, 'pain_events', 'host_kind'),
      by_source: countBy(db, 'pain_events', 'source'),
      distinct_canonical: scalar(db, 'SELECT COUNT(DISTINCT canonical_pain_id) AS n FROM pain_events').n,
      null_canonical: scalar(db, 'SELECT COUNT(*) AS n FROM pain_events WHERE canonical_pain_id IS NULL').n,
      range: scalar(db, 'SELECT MIN(created_at) AS first, MAX(created_at) AS last FROM pain_events'),
      recent: db
        .prepare("SELECT id, host_kind, source, score, severity, canonical_pain_id, substr(COALESCE(reason,text,''),1,90) AS why, created_at FROM pain_events ORDER BY id DESC LIMIT 15")
        .all(),
    };
  }
  if (has('governance_observations')) {
    info.governance_observations = {
      total: scalar(db, 'SELECT COUNT(*) AS n FROM governance_observations').n,
      by_host_kind: countBy(db, 'governance_observations', 'host_kind'),
    };
  }
  if (has('governance_signal_admissions')) {
    info.governance_signal_admissions = {
      total: scalar(db, 'SELECT COUNT(*) AS n FROM governance_signal_admissions').n,
      by_host_kind: countBy(db, 'governance_signal_admissions', 'host_kind'),
      by_decision: countBy(db, 'governance_signal_admissions', 'decision'),
      by_signal_kind: countBy(db, 'governance_signal_admissions', 'signal_kind'),
      recent: db
        .prepare('SELECT id, host_kind, signal_kind, decision, canonical_pain_id, reason, created_at FROM governance_signal_admissions ORDER BY id DESC LIMIT 10')
        .all(),
    };
  }
  if (has('pain_diagnoses')) {
    info.pain_diagnoses = {
      total: scalar(db, 'SELECT COUNT(*) AS n FROM pain_diagnoses').n,
      by_category: countBy(db, 'pain_diagnoses', 'category'),
      recent: db.prepare('SELECT pain_id, task_id, category, substr(root_cause,1,120) AS root_cause, confidence, created_at FROM pain_diagnoses ORDER BY created_at DESC LIMIT 15').all(),
    };
  }
  if (has('principle_candidates')) {
    const cols = db.prepare('PRAGMA table_info(principle_candidates)').all().map((c) => c.name);
    info.principle_candidates = {
      total: scalar(db, 'SELECT COUNT(*) AS n FROM principle_candidates').n,
      columns: cols,
      recent: db.prepare('SELECT * FROM principle_candidates ORDER BY rowid DESC LIMIT 12').all(),
    };
  }
  if (has('activations')) {
    info.activations = {
      total: scalar(db, 'SELECT COUNT(*) AS n FROM activations').n,
      recent: db.prepare('SELECT * FROM activations ORDER BY rowid DESC LIMIT 10').all(),
    };
  }
  if (has('diagnostician_tasks') || has('tasks')) {
    const tn = has('diagnostician_tasks') ? 'diagnostician_tasks' : 'tasks';
    info[tn] = { total: scalar(db, `SELECT COUNT(*) AS n FROM ${tn}`).n };
  }
  out.databases[label] = info;
  db.close();
}

console.log(JSON.stringify(out, null, 2));
