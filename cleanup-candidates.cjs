const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const workspaceDir = 'D:\\.openclaw\\workspace';
const srcDbPath = path.join(workspaceDir, '.pd', 'state.db');
const stateDir = path.join(workspaceDir, '.state');
const tmpDir = path.join(os.tmpdir(), 'pd-cleanup-' + Date.now());

fs.mkdirSync(tmpDir, { recursive: true });
const tmpDbPath = path.join(tmpDir, 'state.db');
fs.copyFileSync(srcDbPath, tmpDbPath);

console.log('=== Candidate Cleanup ===\n');

const db = new Database(tmpDbPath);
db.pragma('journal_mode = DELETE');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

const pendingCandidates = db.prepare("SELECT candidate_id, title, confidence FROM principle_candidates WHERE status = 'pending'").all();
console.log(`Found ${pendingCandidates.length} pending candidates`);

const toDelete = pendingCandidates.filter(c => c.confidence < 0.5);
const toKeep = pendingCandidates.filter(c => c.confidence >= 0.5);

console.log(`Low confidence (<0.5) to delete: ${toDelete.length}`);
toDelete.forEach(c => console.log(`  DEL ${c.candidate_id}: conf=${c.confidence} "${(c.title || '').substring(0, 50)}"`));

console.log(`\nHigh confidence (>=0.5) to keep: ${toKeep.length}`);
toKeep.forEach(c => console.log(`  KEEP ${c.candidate_id}: conf=${c.confidence} "${(c.title || '').substring(0, 50)}"`));

const deleteStmt = db.prepare("DELETE FROM principle_candidates WHERE candidate_id = ?");

const deleteMany = db.transaction((ids) => {
  for (const id of ids) {
    deleteStmt.run(id);
  }
});

console.log('\n--- Executing cleanup ---');
deleteMany(toDelete.map(c => c.candidate_id));
console.log(`Deleted ${toDelete.length} low-confidence pending candidates`);

const remaining = db.prepare("SELECT status, COUNT(*) as cnt FROM principle_candidates GROUP BY status").all();
console.log('\nRemaining candidates:');
remaining.forEach(s => console.log(`  ${s.status}: ${s.cnt}`));

db.close();

console.log('\n--- Attempting to write back ---');
try {
  fs.copyFileSync(tmpDbPath, srcDbPath);
  console.log('SUCCESS: Database written back to workspace');
} catch (e) {
  console.log(`Cannot write back (sandbox): ${e.message}`);
  console.log(`Fixed database saved at: ${tmpDbPath}`);
  console.log('Manual action required: Copy the fixed database back to:');
  console.log(`  ${srcDbPath}`);
}

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
console.log('\n=== Cleanup Complete ===');
