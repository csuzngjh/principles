const fs = require('fs');
const path = require('path');

const filePath = path.join(
  'C:', 'Users', 'Administrator', '.openclaw', 'extensions',
  'principles-disciple', 'pd-cli', 'dist', 'commands', 'candidate.js'
);

let content = fs.readFileSync(filePath, 'utf8');

content = content.replace(
  '    finally {\n        await stateManager.close();\n    }\n}',
  '    finally {\n        try { conn?.close(); } catch {}\n    }\n}'
);

fs.writeFileSync(filePath, content, 'utf8');
console.log('Patched finally block OK');
