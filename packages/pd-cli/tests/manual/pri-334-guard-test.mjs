#!/usr/bin/env node
/**
 * PRI-334: Simple manual test for production workspace guard.
 *
 * This script tests the guard behavior without requiring full UAT setup.
 *
 * Expected results:
 * - D:\.openclaw\workspace → refused
 * - C:\.openclaw\workspace → refused
 * - C:\Users\Administrator\.openclaw\workspace → refused
 * - C:\pd-test-temp → allowed
 * - C:\.openclaw\workspace-test → allowed (sibling, ERR-030 compliance)
 */

import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '..', '..', 'dist');

// Import the built guard module
const guardModule = await import(path.join(distDir, 'utils', 'production-workspace-guard.js'));

const {
  isProductionWorkspace,
  guardUatWorkspace,
  getSafeUatWorkspacePath,
} = guardModule;

console.log('PRI-334: Production Workspace Guard Test\n');

// Test cases
const testCases = [
  { path: 'D:\\.openclaw\\workspace', expectedRefused: true, desc: 'D: production' },
  { path: 'C:\\.openclaw\\workspace', expectedRefused: true, desc: 'C: production' },
  { path: 'C:\\Users\\Administrator\\.openclaw\\workspace', expectedRefused: true, desc: 'User production' },
  { path: path.join(os.tmpdir(), 'pd-test-temp'), expectedRefused: false, desc: 'Temp workspace' },
  { path: 'C:\\.openclaw\\workspace-test', expectedRefused: false, desc: 'Sibling directory (ERR-030)' },
  { path: path.join('D:\\.openclaw\\workspace', 'subdir'), expectedRefused: true, desc: 'Production descendant' },
];

let passed = 0;
let failed = 0;

for (const testCase of testCases) {
  const resolved = path.resolve(testCase.path);
  const guardResult = guardUatWorkspace(resolved, 'test command');
  const passedTest = guardResult.refused === testCase.expectedRefused;

  if (passedTest) {
    passed++;
    console.log(`✓ ${testCase.desc}: ${guardResult.refused ? 'refused' : 'allowed'}`);
  } else {
    failed++;
    console.log(
      `✗ ${testCase.desc}: expected ${testCase.expectedRefused ? 'refused' : 'allowed'}, got ${guardResult.refused ? 'refused' : 'allowed'}`
    );
  }
}

// Test safe workspace path
const safePath = getSafeUatWorkspacePath();
if (safePath.includes(os.tmpdir()) && safePath.includes('pd-uat-workspace')) {
  passed++;
  console.log(`✓ Safe UAT workspace path: ${safePath}`);
} else {
  failed++;
  console.log(`✗ Safe UAT workspace path invalid: ${safePath}`);
}

// Summary
console.log(`\nSummary: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}