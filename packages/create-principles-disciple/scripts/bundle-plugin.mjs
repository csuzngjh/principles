#!/usr/bin/env node
/**
 * Bundle plugin for npm publishing.
 * Copies pre-built plugin files from openclaw-plugin to plugin/ directory.
 * MUST produce identical output to what sync-plugin.mjs syncs.
 */

import { existsSync, mkdirSync, rmSync, cpSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT_DIR = join(__dirname, '..', '..', '..');
const PLUGIN_SRC = join(ROOT_DIR, 'openclaw-plugin');
const PLUGIN_DEST = join(__dirname, '..', 'plugin');

// Files to bundle — MUST match SYNC_ITEMS in sync-plugin.mjs
const SYNC_ITEMS = [
  'dist',
  'templates',
  'scripts',
  'docs',
  'openclaw.plugin.json',
  'package.json',
];

console.log('📦 Bundling plugin for npm publish...\n');

// Check if openclaw-plugin is built
const distDir = join(PLUGIN_SRC, 'dist');
if (!existsSync(distDir)) {
  console.error('❌ openclaw-plugin/dist not found.');
  console.error('   Run: cd packages/openclaw-plugin && npm run build:production');
  process.exit(1);
}

// Remove and recreate plugin directory
if (existsSync(PLUGIN_DEST)) {
  console.log('  Removing old plugin/ directory...');
  rmSync(PLUGIN_DEST, { recursive: true, force: true });
}

mkdirSync(PLUGIN_DEST, { recursive: true });

// Copy each item — same as sync-plugin.mjs
for (const item of SYNC_ITEMS) {
  const src = join(PLUGIN_SRC, item);
  if (!existsSync(src)) {
    console.log(`  ⚠️  Skipping ${item} (not found in source)`);
    continue;
  }
  console.log(`  Copying ${item}...`);
  try {
    cpSync(src, join(PLUGIN_DEST, item), { recursive: true });
  } catch {
    // File copy for regular files
    cpSync(src, join(PLUGIN_DEST, item));
  }
}

console.log('\n✅ Plugin bundled successfully!');
console.log(`   Location: ${PLUGIN_DEST}`);
