const Database = require('D:\\Code\\principles\\node_modules\\better-sqlite3');
const path = 'D:\\.openclaw\\workspace\\.pd\\state.db';
const db = new Database(path, { readonly: true, timeout: 5000 });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', JSON.stringify(tables, null, 2));
if (tables.length > 0) {
  const firstTable = tables[0].name;
  const count = db.prepare(`SELECT COUNT(*) as cnt FROM "${firstTable}"`).get();
  console.log(`Count in ${firstTable}:`, count);
}
db.close();
