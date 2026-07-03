#!/usr/bin/env node

import { existsSync, mkdirSync, rmSync, cpSync, copyFileSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT_DIR = join(__dirname, '..', '..', '..');
const PLUGIN_SRC = join(ROOT_DIR, 'packages', 'openclaw-plugin');
const PLUGIN_DEST = join(__dirname, '..', 'plugin');
const PD_CLI_SRC = join(ROOT_DIR, 'packages', 'pd-cli');
const PD_CLI_DEST = join(__dirname, '..', 'pd-cli');
const CONSOLE_SRC = join(ROOT_DIR, 'packages', 'pd-console');
const CONSOLE_DEST = join(__dirname, '..', 'console');
const CORE_SRC = join(ROOT_DIR, 'packages', 'principles-core');
const CORE_DEST = join(__dirname, '..', 'core');

const PLUGIN_REQUIRED = [
  'dist',
  'dist/bundle.js',
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

const CONSOLE_REQUIRED = [
  'dist',
  'dist/server.js',
  'dist/server/index.js',
  'dist/web/index.html',
  'package.json',
];

const CORE_REQUIRED = [
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

for (const item of CONSOLE_REQUIRED) {
  const src = join(CONSOLE_SRC, item);
  if (!existsSync(src)) {
    console.error(`❌ Required console item not found: ${src}`);
    console.error(`   Run: cd packages/pd-console && npm run build`);
    process.exit(1);
  }
}

for (const item of CORE_REQUIRED) {
  const src = join(CORE_SRC, item);
  if (!existsSync(src)) {
    console.error(`❌ Required core item not found: ${src}`);
    console.error(`   Run: cd packages/principles-core && npm run build`);
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

if (existsSync(CONSOLE_DEST)) {
  console.log('  Removing old console/ directory...');
  rmSync(CONSOLE_DEST, { recursive: true, force: true });
}
mkdirSync(CONSOLE_DEST, { recursive: true });

for (const item of CONSOLE_REQUIRED) {
  const src = join(CONSOLE_SRC, item);
  const dest = join(CONSOLE_DEST, item);
  console.log(`  Copying console/${item}...`);
  try {
    cpSync(src, dest, { recursive: true });
  } catch {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
}

console.log('\n✅ Plugin + pd-cli + pd-console bundled successfully!');
console.log(`   Plugin: ${PLUGIN_DEST}`);
console.log(`   pd-cli: ${PD_CLI_DEST}`);
console.log(`   Console: ${CONSOLE_DEST}`);

if (existsSync(CORE_DEST)) {
  console.log('  Removing old core/ directory...');
  rmSync(CORE_DEST, { recursive: true, force: true });
}
mkdirSync(CORE_DEST, { recursive: true });

for (const item of CORE_REQUIRED) {
  const src = join(CORE_SRC, item);
  const dest = join(CORE_DEST, item);
  console.log(`  Copying core/${item}...`);
  try {
    cpSync(src, dest, { recursive: true });
  } catch {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
}

console.log(`   Core: ${CORE_DEST}`);

console.log('\n🔧 Rewriting bundled dependencies (@principles/core, principles-disciple)...');

function rewriteBundledDependency(pkgPath, label, depName, replacement) {
  if (!existsSync(pkgPath)) return;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  let changed = false;
  if (pkg.dependencies && depName in pkg.dependencies) {
    pkg.dependencies[depName] = replacement;
    changed = true;
  }
  if (pkg.devDependencies && depName in pkg.devDependencies) {
    delete pkg.devDependencies[depName];
    changed = true;
  }
  if (changed) {
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`  ✅ Rewrote ${depName} → ${replacement} in ${label}/package.json`);
  }
}

rewriteBundledDependency(join(PLUGIN_DEST, 'package.json'), 'plugin', '@principles/core', 'file:./core');
rewriteBundledDependency(join(PD_CLI_DEST, 'package.json'), 'pd-cli', '@principles/core', 'file:../core');
rewriteBundledDependency(join(CONSOLE_DEST, 'package.json'), 'console', '@principles/core', 'file:../core');
// pd-cli also depends on principles-disciple (the plugin package). Rewrite to a local
// file reference so the bundled package is self-contained. The installer's syncPdCli()
// creates a node_modules/principles-disciple symlink to the installed plugin directory.
// Without this rewrite + symlink, `pd runtime init` crashes with ERR_MODULE_NOT_FOUND
// because pd-cli statically imports initTrajectorySchema/initWorkflowSchema from it.
rewriteBundledDependency(join(PD_CLI_DEST, 'package.json'), 'pd-cli', 'principles-disciple', 'file:../plugin');

console.log('\n🔍 Verifying hook activation contract...');

const manifestPath = join(PLUGIN_DEST, 'openclaw.plugin.json');
if (!existsSync(manifestPath)) {
  console.error('❌ openclaw.plugin.json not found in bundled plugin');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
const onCapabilities = manifest?.activation?.onCapabilities;
if (!Array.isArray(onCapabilities) || !onCapabilities.includes('hook')) {
  console.error('❌ openclaw.plugin.json.activation.onCapabilities does not include "hook"');
  console.error('   PD hooks will not execute via OpenClaw gateway without this entry.');
  console.error('   See PR #725 for the fix that adds this field.');
  process.exit(1);
}
console.log('  ✅ openclaw.plugin.json.activation.onCapabilities includes "hook"');

const pluginPkgPath = join(PLUGIN_DEST, 'package.json');
if (!existsSync(pluginPkgPath)) {
  console.error('❌ plugin package.json not found');
  process.exit(1);
}
const pluginPkg = JSON.parse(readFileSync(pluginPkgPath, 'utf-8'));
const setupEntry = pluginPkg?.openclaw?.setupEntry;
if (setupEntry !== './dist/bundle.js') {
  console.error(`❌ plugin package.json openclaw.setupEntry is "${setupEntry}" (expected "./dist/bundle.js")`);
  console.error('   OpenClaw gateway will not load PD hooks without this entry point.');
  console.error('   See PR #725 for the fix that adds this field.');
  process.exit(1);
}
console.log('  ✅ plugin package.json openclaw.setupEntry === "./dist/bundle.js"');

console.log('\n✅ Hook activation contract verified!');

console.log('\n🔍 Verifying console bundle...');

const consoleServerJs = join(CONSOLE_DEST, 'dist', 'server.js');
if (!existsSync(consoleServerJs)) {
  console.error(`❌ console dist/server.js not found at ${consoleServerJs}`);
  process.exit(1);
}
console.log('  ✅ console dist/server.js present');

const consoleWebIndex = join(CONSOLE_DEST, 'dist', 'web', 'index.html');
if (!existsSync(consoleWebIndex)) {
  console.error(`❌ console dist/web/index.html not found at ${consoleWebIndex}`);
  process.exit(1);
}
console.log('  ✅ console dist/web/index.html present');

console.log('\n✅ Console bundle verified!');
