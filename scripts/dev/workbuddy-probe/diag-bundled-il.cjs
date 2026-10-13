// One-off diagnostic (CJS): bundled install-layout state vs installer dep spec.
const fs = require('node:fs');
const p = 'install-layout/dist/index.js';
console.log('bundled dist exists:', fs.existsSync(p));
if (fs.existsSync(p)) {
  console.log('bundled dist has export:', fs.readFileSync(p, 'utf8').includes('getWorkbuddyWorkspaceDir'));
}
const pj = fs.existsSync('install-layout/package.json') ? JSON.parse(fs.readFileSync('install-layout/package.json', 'utf8')) : null;
console.log('bundled il version:', pj && pj.version);
console.log('installer dep spec:', JSON.parse(fs.readFileSync('package.json', 'utf8')).dependencies['@principles/install-layout']);
