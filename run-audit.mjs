import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

const workspaceDir = 'D:\\.openclaw\\workspace';
const pdDbPath = path.join(workspaceDir, '.pd', 'state.db');
const stateDir = path.join(workspaceDir, '.state');

console.log('=== Candidate Audit (Read-Only) ===');
console.log('DB Path:', pdDbPath);
console.log('State Dir:', stateDir);

const db = new Database(pdDbPath, { readonly: true });

const consumedRows = db.prepare("SELECT candidate_id, task_kind, status FROM principle_candidates WHERE status = 'consumed'").all();
console.log('\nConsumed candidates:', consumedRows.length);

const pendingRows = db.prepare("SELECT candidate_id, task_kind, status FROM principle_candidates WHERE status = 'pending'").all();
console.log('Pending candidates:', pendingRows.length);

const allRows = db.prepare("SELECT candidate_id, task_kind, status FROM principle_candidates").all();
console.log('Total candidates:', allRows.length);

const statuses = db.prepare("SELECT status, COUNT(*) as cnt FROM principle_candidates GROUP BY status").all();
console.log('\nStatus breakdown:', JSON.stringify(statuses));

const ledgerPath = path.join(stateDir, 'principle_training_state.json');
if (fs.existsSync(ledgerPath)) {
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  const principles = Object.values(ledger.tree.principles);
  console.log('\nLedger principles:', principles.length);

  let missingCount = 0;
  const missingIds = [];
  for (const row of consumedRows) {
    const found = principles.some(p => p.derivedFromPainIds?.includes(row.candidate_id));
    if (!found) {
      missingCount++;
      missingIds.push(row.candidate_id);
    }
  }
  console.log('Missing ledger entries:', missingCount);
  if (missingIds.length > 0) {
    console.log('Missing IDs:', missingIds);
  }
} else {
  console.log('\nLedger not found at:', ledgerPath);
}

const derivedCandidates = db.prepare("SELECT candidate_id, task_kind, status FROM principle_candidates WHERE task_kind = 'derived'").all();
console.log('\nDerived candidates:', derivedCandidates.length);

const orphanDerived = derivedCandidates.filter(dc => {
  const hasParent = allRows.some(r => r.candidate_id !== dc.candidate_id && r.status === 'consumed');
  return !hasParent;
});
console.log('Orphan derived candidates (approx):', orphanDerived.length);

db.close();

console.log('\n=== GFI Session Analysis ===');
const sessionsDbPath = path.join(stateDir, 'sessions.db');
if (fs.existsSync(sessionsDbPath)) {
  const sdb = new Database(sessionsDbPath, { readonly: true });
  try {
    const tables = sdb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    console.log('Session tables:', tables.map(t => t.name));
    const sessionCount = sdb.prepare("SELECT COUNT(*) as cnt FROM sessions").get();
    console.log('Total sessions:', sessionCount.cnt);
    const staleSessions = sdb.prepare("SELECT COUNT(*) as cnt FROM sessions WHERE status = 'stale' OR ended_at IS NOT NULL").get();
    console.log('Stale/ended sessions:', staleSessions.cnt);
    const activeSessions = sdb.prepare("SELECT COUNT(*) as cnt FROM sessions WHERE status = 'active'").get();
    console.log('Active sessions:', activeSessions.cnt);
    sdb.close();
  } catch (e) {
    console.log('Session DB error:', e.message);
    sdb.close();
  }
} else {
  console.log('Sessions DB not found');
}

console.log('\n=== Audit Complete ===');
