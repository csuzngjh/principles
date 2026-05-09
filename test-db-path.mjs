import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join('D:', '.openclaw', 'workspace', '.pd', 'state.db');

console.log('Testing journal_mode = MEMORY with INSERT...');
try {
  const db = new Database(dbPath);
  db.pragma('journal_mode = MEMORY');
  const jm = db.pragma('journal_mode', { simple: true });
  console.log('journal_mode:', jm);
  
  db.prepare("INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, max_attempts) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    `test_mem_${Date.now()}`,
    'diagnostician',
    'pending',
    new Date().toISOString(),
    new Date().toISOString(),
    0,
    3,
  );
  console.log('INSERT succeeded!');
  db.close();
} catch (err) {
  console.error('Error:', err.message, err.code);
}

console.log('\nTesting journal_mode = OFF with INSERT...');
try {
  const db = new Database(dbPath);
  db.pragma('journal_mode = OFF');
  const jm = db.pragma('journal_mode', { simple: true });
  console.log('journal_mode:', jm);
  
  db.prepare("INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, max_attempts) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    `test_off_${Date.now()}`,
    'diagnostician',
    'pending',
    new Date().toISOString(),
    new Date().toISOString(),
    0,
    3,
  );
  console.log('INSERT succeeded!');
  db.close();
} catch (err) {
  console.error('Error:', err.message, err.code);
}
