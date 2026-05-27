const Database = require('D:/Code/principles/node_modules/better-sqlite3');
const path = 'D:\\.openclaw\\workspace\\.pd\\state.db';
try {
  const db = new Database(path, { timeout: 3000, readonly: false });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log('Tables:', tables.length);
  for (const t of tables) {
    const cnt = db.prepare(`SELECT COUNT(*) as c FROM "${t.name}"`).get();
    console.log(`  ${t.name}: ${cnt.c}`);
  }
  const pain = db.prepare("SELECT pain_id, reason, score, provenance, session_id, created_at FROM tasks WHERE task_kind='pain' ORDER BY created_at DESC LIMIT 3").all();
  console.log('Recent pain:', JSON.stringify(pain, null, 2));
  db.close();
} catch(e) {
  console.log('Error:', e.message, 'code:', e.code);
}
