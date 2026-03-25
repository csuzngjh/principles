#!/usr/bin/env node
/**
 * Bundle plugin for npm publishing.
 * Copies pre-built plugin files from openclaw-plugin to plugin/ directory.
 */

import { existsSync, mkdirSync, rmSync, cpSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT_DIR = join(__dirname, '..', '..', '..');
const PLUGIN_SRC = join(ROOT_DIR, 'openclaw-plugin');
const PLUGIN_DEST = join(__dirname, '..', 'plugin');

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

// Copy dist
console.log('  Copying dist/...');
cpSync(distDir, join(PLUGIN_DEST, 'dist'), { recursive: true });

// Copy openclaw.plugin.json
console.log('  Copying openclaw.plugin.json...');
cpSync(
  join(PLUGIN_SRC, 'openclaw.plugin.json'),
  join(PLUGIN_DEST, 'openclaw.plugin.json')
);

// Copy package.json
console.log('  Copying package.json...');
cpSync(
  join(PLUGIN_SRC, 'package.json'),
  join(PLUGIN_DEST, 'package.json')
);

console.log('\n✅ Plugin bundled successfully!');
console.log(`   Location: ${PLUGIN_DEST}`);
