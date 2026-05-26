#!/usr/bin/env node
/**
 * Bundle plugin + pd-cli for npm publishing.
 * Copies pre-built plugin files from openclaw-plugin and pd-cli to package directories.
 * MUST produce identical output to what sync-plugin.mjs syncs.
 */

import { existsSync, mkdirSync, rmSync, cpSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT_DIR = join(__dirname, '..', '..', '..');
const PLUGIN_SRC = join(ROOT_DIR, 'openclaw-plugin');
const PLUGIN_DEST = join(__dirname, '..', 'plugin');
const PD_CLI_SRC = join(ROOT_DIR, 'pd-cli');
const PD_CLI_DEST = join(__dirname, '..', 'pd-cli');

const SYNC_ITEMS = [
  'dist',
  'templates',
  'scripts',
  'docs',
  'openclaw.plugin.json',
  'package.json',
];

const PD_CLI_ITEMS = [
  'dist',
  'package.json',
];

console.log('📦 Bundling plugin + pd-cli for npm publish...\n');

const distDir = join(PLUGIN_SRC, 'dist');
if (!existsSync(distDir)) {
  console.error('❌ openclaw-plugin/dist not found.');
  console.error('   Run: cd packages/openclaw-plugin && npm run build');
  process.exit(1);
}

const pdCliDist = join(PD_CLI_SRC, 'dist');
if (!existsSync(pdCliDist)) {
  console.error('❌ pd-cli/dist not found.');
  console.error('   Run: cd packages/pd-cli && npm run build');
  process.exit(1);
}

if (existsSync(PLUGIN_DEST)) {
  console.log('  Removing old plugin/ directory...');
  rmSync(PLUGIN_DEST, { recursive: true, force: true });
}
mkdirSync(PLUGIN_DEST, { recursive: true });

for (const item of SYNC_ITEMS) {
  const src = join(PLUGIN_SRC, item);
  if (!existsSync(src)) {
    console.log(`  ⚠️  Skipping ${item} (not found in source)`);
    continue;
  }
  console.log(`  Copying plugin/${item}...`);
  try {
    cpSync(src, join(PLUGIN_DEST, item), { recursive: true });
  } catch {
    cpSync(src, join(PLUGIN_DEST, item));
  }
}

if (existsSync(PD_CLI_DEST)) {
  console.log('  Removing old pd-cli/ directory...');
  rmSync(PD_CLI_DEST, { recursive: true, force: true });
}
mkdirSync(PD_CLI_DEST, { recursive: true });

for (const item of PD_CLI_ITEMS) {
  const src = join(PD_CLI_SRC, item);
  if (!existsSync(src)) {
    console.error(`❌ pd-cli/${item} not found. Cannot bundle pd-cli.`);
    process.exit(1);
  }
  console.log(`  Copying pd-cli/${item}...`);
  try {
    cpSync(src, join(PD_CLI_DEST, item), { recursive: true });
  } catch {
    cpSync(src, join(PD_CLI_DEST, item));
  }
}

console.log('\n✅ Plugin + pd-cli bundled successfully!');
console.log(`   Plugin: ${PLUGIN_DEST}`);
console.log(`   pd-cli: ${PD_CLI_DEST}`);
