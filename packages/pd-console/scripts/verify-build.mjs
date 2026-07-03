import { existsSync } from 'fs';

// dist/web/index.html is REQUIRED: without it the console server returns 404
// "Run npm run build:ui first" on every route (EP-06 regression — PR #1169).
// Previously optional, which let broken installs pass verification.
const required = ['dist/server.js', 'dist/server/index.js', 'dist/web/index.html'];
const optional = ['dist/lib/utils.js'];
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
