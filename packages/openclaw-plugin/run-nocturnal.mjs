import { randomUUID } from 'crypto';
import * as fs from 'fs';

const workspaceDir = '/home/csuzngjh/.openclaw/workspace-main';
const stateDir = '/home/csuzngjh/.openclaw/workspace-main/.state';

console.error('WorkspaceDir:', workspaceDir);
console.error('StateDir:', stateDir);

try {
  const bundlePath = './dist/nocturnal-service.bundle.js';
  console.error('Importing from:', bundlePath);
  
  const mod = await import(bundlePath);
  
  console.log('Available exports:', Object.keys(mod));
  
  if (!mod.executeNocturnalReflection) {
    throw new Error('executeNocturnalReflection not found in bundle. Available exports: ' + Object.keys(mod).join(', '));
  }

  console.error('Calling executeNocturnalReflection...');
  const result = await mod.executeNocturnalReflection(workspaceDir, stateDir);
  
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error('ERROR:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
}
