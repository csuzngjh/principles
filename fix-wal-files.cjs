const fs = require('fs');
const path = require('path');

const dbPath = path.join('D:', '.openclaw', 'workspace', '.pd', 'state.db');
const walPath = dbPath + '-wal';
const shmPath = dbPath + '-shm';

console.log('Creating WAL/SHM files for:', dbPath);

if (!fs.existsSync(walPath)) {
  const walHeader = Buffer.alloc(32);
  walHeader.writeUInt32BE(0x377f0682, 0); // WAL magic
  walHeader.writeUInt32BE(3007000, 4);     // WAL format version
  walHeader.writeUInt32BE(4096, 8);        // page size
  walHeader.writeUInt32BE(0, 12);          // checkpoint sequence
  walHeader.writeUInt32BE(0, 16);          // salt-1
  walHeader.writeUInt32BE(0, 20);          // salt-2
  walHeader.writeUInt32BE(0, 24);          // checksum-1
  walHeader.writeUInt32BE(0, 28);          // checksum-2
  fs.writeFileSync(walPath, walHeader);
  console.log('Created WAL file:', walPath);
} else {
  console.log('WAL file already exists');
}

if (!fs.existsSync(shmPath)) {
  const shmSize = 32768;
  const shm = Buffer.alloc(shmSize, 0);
  fs.writeFileSync(shmPath, shm);
  console.log('Created SHM file:', shmPath);
} else {
  console.log('SHM file already exists');
}

console.log('\nVerifying...');
const Database = require('better-sqlite3');
try {
  const db = new Database(dbPath, { readonly: true });
  const result = db.prepare("SELECT COUNT(*) as cnt FROM principle_candidates").get();
  console.log('Candidate count:', result.cnt);
  db.close();
  console.log('SUCCESS: Database is now accessible!');
} catch (e) {
  console.error('Still failing:', e.message);
  try { fs.unlinkSync(walPath); } catch {}
  try { fs.unlinkSync(shmPath); } catch {}
  console.log('Cleaned up WAL/SHM files');
}
