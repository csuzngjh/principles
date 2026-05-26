#!/usr/bin/env node

import { existsSync, mkdirSync, rmSync, cpSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT_DIR = join(__dirname, '..', '..', '..');
const PLUGIN_SRC = join(ROOT_DIR, 'packages', 'openclaw-plugin');
const PLUGIN_DEST = join(__dirname, '..', 'plugin');
const PD_CLI_SRC = join(ROOT_DIR, 'packages', 'pd-cli');
const PD_CLI_DEST = join(__dirname, '..', 'pd-cli');

const PLUGIN_REQUIRED = [
  'dist',
  'templates',
  'openclaw.plugin.json',
  'package.json',
];

const PLUGIN_OPTIONAL = [
  'scripts',
  'docs',
];

const PD_CLI_REQUIRED = [
  'dist',
  'dist/index.js',
  'package.json',
];

console.log('📦 Bundling plugin + pd-cli for npm publish...\n');

for (const item of PLUGIN_REQUIRED) {
  const src = join(PLUGIN_SRC, item);
  if (!existsSync(src)) {
    console.error(`❌ Required plugin item not found: ${src}`);
    console.error(`   Run: cd packages/openclaw-plugin && npm run build`);
    process.exit(1);
  }
}

for (const item of PD_CLI_REQUIRED) {
  const src = join(PD_CLI_SRC, item);
  if (!existsSync(src)) {
    console.error(`❌ Required pd-cli item not found: ${src}`);
    console.error(`   Run: cd packages/pd-cli && npm run build`);
    process.exit(1);
  }
}

if (existsSync(PLUGIN_DEST)) {
  console.log('  Removing old plugin/ directory...');
  rmSync(PLUGIN_DEST, { recursive: true, force: true });
}
mkdirSync(PLUGIN_DEST, { recursive: true });

for (const item of PLUGIN_REQUIRED) {
  const src = join(PLUGIN_SRC, item);
  console.log(`  Copying plugin/${item}...`);
  try {
    cpSync(src, join(PLUGIN_DEST, item), { recursive: true });
  } catch {
    cpSync(src, join(PLUGIN_DEST, item));
  }
}

for (const item of PLUGIN_OPTIONAL) {
  const src = join(PLUGIN_SRC, item);
  if (!existsSync(src)) {
    console.log(`  ⚠️  Skipping optional plugin/${item} (not found in source)`);
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

for (const item of PD_CLI_REQUIRED) {
  const src = join(PD_CLI_SRC, item);
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
