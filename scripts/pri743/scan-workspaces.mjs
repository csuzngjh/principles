// PRI-743 read-only workspace scan.
// Recursively finds PD workspace databases and reports pipeline counts per workspace.
// READONLY: opens every database with readonly=true. Never writes.
import { createRequire } from 'node:module';
import fs from 'node:fs';
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

const ROOTS = (process.argv[2] ?? 'D:/Code').split(',');
const MAX_DEPTH = 5;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next']);

const found = [];
function walk(dir, depth) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '.pd' || e.name === '.state') {
        // candidate workspace interior
      }
      walk(p, depth + 1);
    } else if (e.name === 'trajectory.db' || e.name === 'state.db') {
      found.push(p);
    }
  }
}
for (const r of ROOTS) walk(r, 0);

function probe(dbPath) {
  let db;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (e) {
    return { dbPath, error: e.message };
  }
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  const has = (n) => tables.includes(n);
  const one = (sql) => { try { return db.prepare(sql).get(); } catch { return null; } };
  const res = { dbPath, tables: tables.length };
  if (has('pain_events')) {
    const total = one('SELECT COUNT(*) AS n FROM pain_events')?.n ?? 0;
    let byHost = [];
    try {
      byHost = db.prepare("SELECT COALESCE(host_kind,'<null>') AS k, COUNT(*) AS n FROM pain_events GROUP BY host_kind").all();
    } catch { /* column missing */ }
    const canonical = one('SELECT COUNT(*) AS n FROM pain_events WHERE canonical_pain_id IS NOT NULL')?.n ?? 0;
    res.pain_events = { total, canonical, byHost };
  }
  if (has('governance_observations')) {
    res.governance_observations = one('SELECT COUNT(*) AS n FROM governance_observations')?.n ?? 0;
  }
  if (has('governance_signal_admissions')) {
    res.governance_signal_admissions = {
      total: one('SELECT COUNT(*) AS n FROM governance_signal_admissions')?.n ?? 0,
      byHost: db.prepare('SELECT host_kind AS k, COUNT(*) AS n FROM governance_signal_admissions GROUP BY host_kind').all(),
    };
  }
  if (has('pain_diagnoses')) res.pain_diagnoses = one('SELECT COUNT(*) AS n FROM pain_diagnoses')?.n ?? 0;
  if (has('principle_candidates')) res.principle_candidates = one('SELECT COUNT(*) AS n FROM principle_candidates')?.n ?? 0;
  if (has('activations')) res.activations = one('SELECT COUNT(*) AS n FROM activations')?.n ?? 0;
  if (has('tasks')) res.tasks = one('SELECT COUNT(*) AS n FROM tasks')?.n ?? 0;
  db.close();
  return res;
}

const results = found.map(probe).filter((r) => r.pain_events || r.pain_diagnoses || r.principle_candidates || r.governance_signal_admissions || r.error);
results.sort((a, b) => (b.pain_events?.total ?? 0) - (a.pain_events?.total ?? 0));
console.log(JSON.stringify({ roots: ROOTS, scanned: found.length, results }, null, 2));
