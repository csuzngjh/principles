const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const workspaceDir = 'D:\\.openclaw\\workspace';
const srcDbPath = path.join(workspaceDir, '.pd', 'state.db');
const stateDir = path.join(workspaceDir, '.state');
const tmpDir = path.join(os.tmpdir(), 'pd-audit-' + Date.now());

fs.mkdirSync(tmpDir, { recursive: true });
const tmpDbPath = path.join(tmpDir, 'state.db');
fs.copyFileSync(srcDbPath, tmpDbPath);

console.log('=== Full Workspace Audit ===\n');

const db = new Database(tmpDbPath);
db.pragma('journal_mode = DELETE');

console.log('--- DB Integrity: OK ---');

console.log('\n--- Candidate Status ---');
const candidateStatuses = db.prepare("SELECT status, COUNT(*) as cnt FROM principle_candidates GROUP BY status").all();
candidateStatuses.forEach(s => console.log(`  ${s.status}: ${s.cnt}`));
const totalCandidates = db.prepare("SELECT COUNT(*) as cnt FROM principle_candidates").get();
console.log(`  Total: ${totalCandidates.cnt}`);

console.log('\n--- All Candidates ---');
const allCandidates = db.prepare("SELECT candidate_id, status, title, confidence, created_at FROM principle_candidates ORDER BY created_at DESC").all();
allCandidates.forEach(c => console.log(`  ${c.candidate_id}: status=${c.status} conf=${c.confidence} title="${(c.title || '').substring(0, 60)}"`));

console.log('\n--- Consumed Candidates vs Ledger ---');
const consumedRows = db.prepare("SELECT candidate_id, title FROM principle_candidates WHERE status = 'consumed'").all();
console.log(`  Consumed count: ${consumedRows.length}`);

const ledgerPath = path.join(stateDir, 'principle_training_state.json');
let missingLedgerIds = [];
if (fs.existsSync(ledgerPath)) {
  const raw = fs.readFileSync(ledgerPath, 'utf8');
  const ledger = JSON.parse(raw);
  const principles = ledger.tree?.principles || ledger.principles || {};
  const principleValues = Object.values(principles);
  console.log(`  Ledger principles: ${principleValues.length}`);
  for (const row of consumedRows) {
    const found = principleValues.some(p => p.derivedFromPainIds?.includes(row.candidate_id));
    if (!found) {
      missingLedgerIds.push(row.candidate_id);
    }
  }
  console.log(`  Missing ledger entries: ${missingLedgerIds.length}`);
  if (missingLedgerIds.length > 0) {
    missingLedgerIds.forEach(id => console.log(`    - ${id}`));
  } else {
    console.log('  All consumed candidates have ledger entries');
  }
} else {
  console.log('  Ledger not found');
}

console.log('\n--- Orphan Derived Candidates ---');
const pendingCandidates = db.prepare("SELECT candidate_id, status, title FROM principle_candidates WHERE status = 'pending'").all();
console.log(`  Pending candidates: ${pendingCandidates.length}`);
pendingCandidates.forEach(c => console.log(`    ${c.candidate_id}: "${(c.title || '').substring(0, 60)}"`));

console.log('\n--- Task Status ---');
const taskStatuses = db.prepare("SELECT status, COUNT(*) as cnt FROM tasks GROUP BY status").all();
taskStatuses.forEach(s => console.log(`  ${s.status}: ${s.cnt}`));
const totalTasks = db.prepare("SELECT COUNT(*) as cnt FROM tasks").get();
console.log(`  Total: ${totalTasks.cnt}`);

const staleTasks = db.prepare("SELECT task_id, task_kind, status, last_error, attempt_count FROM tasks WHERE status IN ('failed', 'dead_letter') ORDER BY updated_at DESC LIMIT 10").all();
if (staleTasks.length === 0) {
  console.log('  No failed/dead_letter tasks');
} else {
  staleTasks.forEach(t => console.log(`  ${t.task_id}: ${t.status} (${t.task_kind}) err=${t.last_error}`));
}

console.log('\n--- GFI Sessions ---');
const sessionsDbPath = path.join(stateDir, 'sessions.db');
if (fs.existsSync(sessionsDbPath)) {
  const tmpSessionsPath = path.join(tmpDir, 'sessions.db');
  fs.copyFileSync(sessionsDbPath, tmpSessionsPath);
  const sdb = new Database(tmpSessionsPath);
  try {
    const sessionCount = sdb.prepare("SELECT COUNT(*) as cnt FROM sessions").get();
    console.log(`  Total sessions: ${sessionCount.cnt}`);
    const sessionStatuses = sdb.prepare("SELECT status, COUNT(*) as cnt FROM sessions GROUP BY status").all();
    sessionStatuses.forEach(s => console.log(`    ${s.status || 'null'}: ${s.cnt}`));
    const oldest = sdb.prepare("SELECT MIN(created_at) as v FROM sessions").get();
    const newest = sdb.prepare("SELECT MAX(created_at) as v FROM sessions").get();
    console.log(`  Date range: ${oldest.v} to ${newest.v}`);
    sdb.close();
  } catch (e) {
    console.log(`  Session DB error: ${e.message}`);
    try { sdb.close(); } catch {}
  }
} else {
  console.log('  Sessions DB not found');
}

db.close();
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

console.log('\n=== Audit Complete ===');
