import { existsSync } from 'fs';

const required = ['dist/server.js', 'dist/server/index.js'];
const optional = ['dist/lib/utils.js', 'dist/web/index.html'];
let ok = true;

for (const f of required) {
  if (!existsSync(f)) { console.error('MISSING:', f); ok = false; }
  else { console.log('OK:', f); }
}
for (const f of optional) {
  if (existsSync(f)) console.log('OK:', f);
}
if (!ok) process.exit(1);
console.log('Build verification passed');
