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
  'dist/governance-audit.js',
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

// 3. Verify skill template roots for BOTH languages ship in dist — the
// installer rewrites the installed manifest per --lang (PR #1332 companion),
// so a missing root breaks install-time language selection. A "publishable"
// skill is an immediate child directory containing SKILL.md (what OpenClaw
// links into ~/.openclaw/plugin-skills).
//
// PRI-547 (ClawHub audit remediation): the shipped set is EXACTLY the
// MVP pd-* set — neither fewer (broken build) nor more (legacy skills
// re-entering the published artifact).
//
// PRI-548 follow-up: generic SOP role skills pd-planner / pd-explorer /
// pd-auditor retired (zero programmatic consumers, never auto-invoked,
// outside the ADR-0014 product boundary).
const EXPECTED_SKILLS = [
  'pd-cli-operator',
  'pd-implementer',
  'pd-mentor',
  'pd-pain-signal',
  'pd-runtime-v2',
];

for (const lang of ['zh', 'en']) {
  const skillsDir = join(rootDir, 'dist/templates/langs', lang, 'skills');
  if (!existsSync(skillsDir)) {
    console.error(`❌ Missing skill templates: dist/templates/langs/${lang}/skills`);
    hasError = true;
    continue;
  }
  const publishable = readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(skillsDir, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort();
  const expected = [...EXPECTED_SKILLS].sort();
  const missing = expected.filter((name) => !publishable.includes(name));
  const unexpected = publishable.filter((name) => !expected.includes(name));
  if (missing.length > 0 || unexpected.length > 0) {
    if (missing.length > 0) {
      console.error(`❌ dist/templates/langs/${lang}/skills is missing expected skills: ${missing.join(', ')}`);
    }
    if (unexpected.length > 0) {
      console.error(`❌ dist/templates/langs/${lang}/skills contains non-approved skills: ${unexpected.join(', ')}`);
    }
    hasError = true;
  } else {
    console.log(`✅ ${lang} skills: exactly the ${publishable.length} approved pd-* skills (dist/templates/langs/${lang}/skills/)`);
  }
}

console.log(hasError ? '\n❌ Build verification failed!' : '\n✅ Build verification passed!');
process.exit(hasError ? 1 : 0);
