import { spawn, execSync } from 'child_process';

let resolved = 'openclaw';
try {
  const result = execSync('where.exe openclaw', { encoding: 'utf-8', timeout: 5000, windowsHide: true });
  const lines = result.split('\n').map(l => l.trim()).filter(Boolean);
  const windowsNative = lines.find(l => /\.(cmd|bat|exe)$/i.test(l));
  resolved = windowsNative || lines[0] || resolved;
  console.log('Resolved:', resolved);
} catch (e) {
  console.log('where failed');
}

const isWindowsBatch = /\.bat$/i.test(resolved) || /\.cmd$/i.test(resolved);
console.log('isWindowsBatch:', isWindowsBatch);

const normalizedPath = resolved.replace(/\\/g, '/');
console.log('normalizedPath:', normalizedPath);

const spawnArgs = isWindowsBatch ? ['/d', '/s', '/c', normalizedPath, '--version'] : ['--version'];
console.log('spawnArgs:', spawnArgs);

const proc = spawn('cmd.exe', spawnArgs, {
  shell: false,
  detached: true,
  timeout: 10000,
});
let stdout = '';
proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
proc.on('close', (code) => {
  console.log('exit:', code, 'stdout:', stdout.substring(0, 200));
});
proc.on('error', (err) => console.log('error:', err.message, err.code));