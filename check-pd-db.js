const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join('D:', '.openclaw', 'workspace', '.pd', 'state.db');
console.log('Opening:', dbPath);

try {
  const db = new Database(dbPath);
  console.log('DB opened OK');

  const integrity = db.pragma('integrity_check');
  console.log('Integrity:', JSON.stringify(integrity));

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log('Tables:', JSON.stringify(tables));

  const jm = db.pragma('journal_mode');
  console.log('Journal mode:', JSON.stringify(jm));

  const taskCount = db.prepare('SELECT COUNT(*) as cnt FROM tasks').get();
  console.log('Task count:', taskCount.cnt);

  const candidateCount = db.prepare('SELECT COUNT(*) as cnt FROM principle_candidates').get();
  console.log('Candidate count:', candidateCount.cnt);

  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    console.log('WAL checkpoint OK');
  } catch (e) {
    console.error('WAL checkpoint failed:', e.message, e.code);
    console.log('Trying DELETE journal mode...');
    db.pragma('journal_mode=DELETE');
    console.log('Switched to DELETE mode');
  }

  db.close();
  console.log('Close OK');
} catch (e) {
  console.error('Error:', e.message, e.code);
}
