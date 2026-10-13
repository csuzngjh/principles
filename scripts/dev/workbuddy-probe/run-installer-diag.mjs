// One-off: run the extracted installer with full stderr visible (installer
// crash diagnosis for the installed-product E2E).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const labs = fs.readdirSync('D:/Code/wb-probe-lab').filter((d) => d.startsWith('e2e-install-')).sort();
const lab = labs.at(-1);
const entry = path.join('D:/Code/wb-probe-lab', lab, 'app', 'node_modules', 'create-principles-disciple', 'dist', 'index.js');
console.log('entry exists:', fs.existsSync(entry), entry);
const iso = path.join('D:/Code/wb-probe-lab', lab, 'fake-home', '.workbuddy');
const home = path.join('D:/Code/wb-probe-lab', lab, 'fake-home');
const project = path.join('D:/Code/wb-probe-lab', lab, 'project-a');
const r = spawnSync(process.execPath, [entry, '--host', 'workbuddy', '--workspace', project, '--yes', '--json'], {
  encoding: 'utf8', timeout: 600_000,
  env: { ...process.env, WORKBUDDY_CONFIG_DIR: iso, CODEBUDDY_CONFIG_DIR: iso, USERPROFILE: home, HOME: home },
});
console.log('exit:', r.status);
console.log('stdout tail:', (r.stdout || '').slice(-400));
console.log('stderr full:\n', (r.stderr || '').slice(0, 2500));
