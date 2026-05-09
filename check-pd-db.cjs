const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join('D:', '.openclaw', 'workspace', '.pd', 'state.db');
console.log('DB path:', dbPath);
console.log('File exists:', fs.existsSync(dbPath));
console.log('File size:', fs.statSync(dbPath).size);

const pdDir = path.join('D:', '.openclaw', 'workspace', '.pd');
const files = fs.readdirSync(pdDir);
console.log('Files in .pd:', files);

const walPath = dbPath + '-wal';
const shmPath = dbPath + '-shm';
console.log('WAL exists:', fs.existsSync(walPath));
console.log('SHM exists:', fs.existsSync(shmPath));

console.log('\n--- Attempt 1: Open readonly ---');
try {
  const db = new Database(dbPath, { readonly: true });
  console.log('DB opened readonly OK');
  const jm = db.pragma('journal_mode');
  console.log('Journal mode:', JSON.stringify(jm));
  db.close();
  console.log('Close OK');
} catch (e) {
  console.error('Readonly error:', e.message, e.code);
}

console.log('\n--- Attempt 2: Open with fileMustExist=false ---');
try {
  const db = new Database(dbPath, { fileMustExist: false });
  console.log('DB opened OK');
  const jm = db.pragma('journal_mode');
  console.log('Journal mode:', JSON.stringify(jm));
  db.close();
  console.log('Close OK');
} catch (e) {
  console.error('Error:', e.message, e.code);
}

console.log('\n--- Attempt 3: Check file header ---');
try {
  const fd = fs.openSync(dbPath, 'r');
  const header = Buffer.alloc(16);
  fs.readSync(fd, header, 0, 16, 0);
  fs.closeSync(fd);
  console.log('Header:', header.toString('utf8'));
  console.log('Is SQLite:', header.toString('utf8').startsWith('SQLite format 3'));
} catch (e) {
  console.error('Header read error:', e.message);
}

console.log('\n--- Attempt 4: Copy and open copy ---');
try {
  const copyPath = path.join('D:', '.openclaw', 'workspace', '.pd', 'state-copy.db');
  fs.copyFileSync(dbPath, copyPath);
  console.log('Copied to:', copyPath);
  const db = new Database(copyPath);
  console.log('Copy opened OK');
  const integrity = db.pragma('integrity_check');
  console.log('Integrity:', JSON.stringify(integrity));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log('Tables:', JSON.stringify(tables));
  db.close();
  console.log('Copy close OK');
  fs.unlinkSync(copyPath);
  console.log('Copy cleaned up');
} catch (e) {
  console.error('Copy error:', e.message, e.code);
}
