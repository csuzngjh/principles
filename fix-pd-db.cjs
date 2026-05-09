const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');

const srcPath = path.join('D:', '.openclaw', 'workspace', '.pd', 'state.db');
const tmpDir = os.tmpdir();
const tmpPath = path.join(tmpDir, 'pd-state-fix.db');

console.log('Source:', srcPath);
console.log('Temp:', tmpPath);

console.log('\n--- Step 1: Copy DB to temp ---');
fs.copyFileSync(srcPath, tmpPath);
console.log('Copied OK, size:', fs.statSync(tmpPath).size);

console.log('\n--- Step 2: Open and check ---');
try {
  const db = new Database(tmpPath);
  console.log('DB opened OK');

  const integrity = db.pragma('integrity_check');
  console.log('Integrity:', JSON.stringify(integrity));

  const jm = db.pragma('journal_mode');
  console.log('Journal mode:', JSON.stringify(jm));

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log('Tables:', tables.map(t => t.name).join(', '));

  const taskCount = db.prepare('SELECT COUNT(*) as cnt FROM tasks').get();
  console.log('Task count:', taskCount.cnt);

  const candidateCount = db.prepare('SELECT COUNT(*) as cnt FROM principle_candidates').get();
  console.log('Candidate count:', candidateCount.cnt);

  const candidateStatuses = db.prepare('SELECT status, COUNT(*) as cnt FROM principle_candidates GROUP BY status').all();
  console.log('Candidate statuses:', JSON.stringify(candidateStatuses));

  console.log('\n--- Step 3: Switch to DELETE journal mode ---');
  db.pragma('journal_mode=DELETE');
  const jm2 = db.pragma('journal_mode');
  console.log('New journal mode:', JSON.stringify(jm2));

  db.pragma('wal_checkpoint(TRUNCATE)');
  console.log('Checkpoint OK');

  db.close();
  console.log('Close OK');
} catch (e) {
  console.error('Error:', e.message, e.code);
}

console.log('\n--- Step 4: Verify fixed file ---');
try {
  const walExists = fs.existsSync(tmpPath + '-wal');
  const shmExists = fs.existsSync(tmpPath + '-shm');
  console.log('WAL exists after fix:', walExists);
  console.log('SHM exists after fix:', shmExists);
  console.log('Fixed file size:', fs.statSync(tmpPath).size);
} catch (e) {
  console.error('Verify error:', e.message);
}

console.log('\n--- Step 5: Copy back ---');
try {
  fs.copyFileSync(tmpPath, srcPath);
  console.log('Copied back OK');
  console.log('Final size:', fs.statSync(srcPath).size);
} catch (e) {
  console.error('Copy back error:', e.message);
}

console.log('\n--- Step 6: Verify source ---');
try {
  const db = new Database(srcPath, { readonly: true });
  const jm = db.pragma('journal_mode');
  console.log('Source journal mode:', JSON.stringify(jm));
  db.close();
  console.log('Source verify OK');
} catch (e) {
  console.error('Source verify error:', e.message);
}

console.log('\n--- Cleanup ---');
try {
  if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  if (fs.existsSync(tmpPath + '-wal')) fs.unlinkSync(tmpPath + '-wal');
  if (fs.existsSync(tmpPath + '-shm')) fs.unlinkSync(tmpPath + '-shm');
  console.log('Temp files cleaned up');
} catch (e) {
  console.error('Cleanup error:', e.message);
}
