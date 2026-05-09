const fs = require('fs');
const path = require('path');

const filePath = path.join(
  'C:', 'Users', 'Administrator', '.openclaw', 'extensions',
  'principles-disciple', 'pd-cli', 'dist', 'commands', 'candidate.js'
);

let content = fs.readFileSync(filePath, 'utf8');

const oldStr = 'await stateManager.close();';
const newStr = 'try { conn?.close(); } catch {}';

if (content.includes(oldStr)) {
  content = content.replaceAll(oldStr, newStr);
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('Patched OK');
  } catch (e) {
    console.error('Write failed:', e.message);
    const tmpPath = path.join(require('os').tmpdir(), 'candidate-patched.js');
    fs.writeFileSync(tmpPath, content, 'utf8');
    console.log('Wrote to temp:', tmpPath);
  }
} else {
  console.log('Pattern not found - already patched or different content');
}
