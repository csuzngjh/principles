#!/usr/bin/env node
/**
 * Verify build artifacts after production build.
 * Catches issues like missing static files in the bundle.
 *
 * Usage: node scripts/verify-build.mjs
 * Exit: 0 on success, 1 on failure
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

// Required paths in dist/
const requiredPaths = [
  'dist/bundle.js',
  'dist/openclaw.plugin.json',
  'dist/templates',
];

// Expected minimum counts
const expectedCounts = {
  'dist/templates': { min: 1, label: 'template directories' },
};

function getFilesRecursively(dir, extension = null) {
  if (!existsSync(dir)) return [];
  
  const result = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...getFilesRecursively(fullPath, extension));
    } else if (extension) {
      if (entry.name.endsWith(extension)) {
        result.push(fullPath);
      }
    } else {
      result.push(fullPath);
    }
  }
  return result;
}

function getDirectories(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);
}

console.log('🔍 Verifying build artifacts...\n');

let hasError = false;

// 1. Check required paths exist
for (const path of requiredPaths) {
  const fullPath = join(rootDir, path);
  if (!existsSync(fullPath)) {
    console.error(`❌ Missing: ${path}`);
    hasError = true;
  } else {
    console.log(`✅ Found: ${path}`);
  }
}

// 2. Check expected counts
for (const [path, config] of Object.entries(expectedCounts)) {
  const fullPath = join(rootDir, path);
  
  if (!existsSync(fullPath)) {
    continue; // Already reported above
  }
  
  let count;
  if (config.extension) {
    count = getFilesRecursively(fullPath, config.extension).length;
  } else {
    count = getDirectories(fullPath).length;
  }
  
  if (count < config.min) {
    console.error(`❌ ${path} has only ${count} ${config.label} (expected at least ${config.min})`);
    hasError = true;
  } else {
    console.log(`✅ ${path} contains ${count} ${config.label}`);
  }
}

// 3. List skill files for visibility (agents migrated to skills in templates/)
const skillsDir = join(rootDir, 'dist/templates/langs/zh/skills');
if (existsSync(skillsDir)) {
  const skillFiles = readdirSync(skillsDir)
    .filter(f => f.endsWith('.md'));
  
  if (skillFiles.length > 0) {
    console.log(`\n📦 Skills available: ${skillFiles.length} (in dist/templates/langs/zh/skills/)`);
  }
}

console.log(hasError ? '\n❌ Build verification failed!' : '\n✅ Build verification passed!');
process.exit(hasError ? 1 : 0);
