#!/usr/bin/env node

import { existsSync, mkdirSync, rmSync, cpSync, copyFileSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFile, execFileSync, execSync } from 'child_process';
import { promisify } from 'util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const ROOT_DIR = join(__dirname, '..', '..', '..');
const OUTPUT_ROOT = readOption('--output-root') ?? join(__dirname, '..');
const PLUGIN_SRC = join(ROOT_DIR, 'packages', 'openclaw-plugin');
const PLUGIN_DEST = join(OUTPUT_ROOT, 'plugin');
const PD_CLI_SRC = join(ROOT_DIR, 'packages', 'pd-cli');
const PD_CLI_DEST = join(OUTPUT_ROOT, 'pd-cli');
const CONSOLE_SRC = join(ROOT_DIR, 'packages', 'pd-console');
const CONSOLE_DEST = join(OUTPUT_ROOT, 'console');
const CORE_SRC = join(ROOT_DIR, 'packages', 'principles-core');
const CORE_DEST = join(OUTPUT_ROOT, 'core');
const HOST_RUNTIME_SRC = join(ROOT_DIR, 'packages', 'host-runtime');
const HOST_RUNTIME_DEST = join(OUTPUT_ROOT, 'host-runtime');
const INSTALL_LAYOUT_SRC = join(ROOT_DIR, 'packages', 'install-layout');
const INSTALL_LAYOUT_DEST = join(OUTPUT_ROOT, 'install-layout');
const RELEASE_LOCKS_ROOT = join(ROOT_DIR, 'packages', 'create-principles-disciple', 'release-locks');
const BUILD_SELF_CONTAINED_ASSET = process.argv.includes('--self-contained');
const PREPARE_RELEASE_LOCKS = process.argv.includes('--prepare-release-locks');
const execFileAsync = promisify(execFile);

const PLUGIN_REQUIRED = [
  'dist',
  'dist/bundle.js',
  'dist/governance-audit.js',
  'templates',
  'openclaw.plugin.json',
  'package.json',
];

// PRI-547 (ClawHub audit remediation): the scripts entry was removed —
// maintainer scripts (sync-plugin, bootstrap-rules, postinstall.cjs, ...)
// have zero installed-runtime readers (census in the PR) and their
// shell/process execution was a top ClawHub static-analysis finding.
// Only docs stays optional.
const PLUGIN_OPTIONAL = [
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

const HOST_RUNTIME_REQUIRED = [
  'dist',
  'dist/index.js',
  'package.json',
];

const INSTALL_LAYOUT_REQUIRED = [
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

// PR #1332 companion: the installer rewrites the installed manifest's skills
// root per --lang, so BOTH language template sets must ship in the bundle —
// a missing root silently breaks install-time language selection.
const LANG_SKILL_DIRS = ['templates/langs/zh/skills', 'templates/langs/en/skills'];
for (const dir of LANG_SKILL_DIRS) {
  const src = join(PLUGIN_SRC, dir);
  if (!existsSync(src)) {
    console.error(`❌ Required skill language templates not found: ${src}`);
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

for (const item of HOST_RUNTIME_REQUIRED) {
  const src = join(HOST_RUNTIME_SRC, item);
  if (!existsSync(src)) {
    console.error(`❌ Required host-runtime item not found: ${src}`);
    console.error(`   Run: cd packages/host-runtime && npm run build`);
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

if (existsSync(HOST_RUNTIME_DEST)) {
  console.log('  Removing old host-runtime/ directory...');
  rmSync(HOST_RUNTIME_DEST, { recursive: true, force: true });
}
mkdirSync(HOST_RUNTIME_DEST, { recursive: true });

for (const item of HOST_RUNTIME_REQUIRED) {
  const src = join(HOST_RUNTIME_SRC, item);
  const dest = join(HOST_RUNTIME_DEST, item);
  console.log(`  Copying host-runtime/${item}...`);
  try {
    cpSync(src, dest, { recursive: true });
  } catch {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
}

console.log(`   Host Runtime: ${HOST_RUNTIME_DEST}`);

if (existsSync(INSTALL_LAYOUT_DEST)) {
  console.log('  Removing old install-layout/ directory...');
  rmSync(INSTALL_LAYOUT_DEST, { recursive: true, force: true });
}
mkdirSync(INSTALL_LAYOUT_DEST, { recursive: true });
for (const item of INSTALL_LAYOUT_REQUIRED) {
  const src = join(INSTALL_LAYOUT_SRC, item);
  const dest = join(INSTALL_LAYOUT_DEST, item);
  console.log(`  Copying install-layout/${item}...`);
  cpSync(src, dest, { recursive: true });
}
console.log(`   Install Layout: ${INSTALL_LAYOUT_DEST}`);

console.log('\n🔧 Rewriting bundled dependencies (@principles/core, @principles/host-runtime, @principles/install-layout, principles-disciple)...');

function rewriteBundledDependency(pkgPath, label, depName, replacement) {
  // Avoid TOCTOU: skip the existsSync check and handle ENOENT from readFileSync
  // directly. The prior existsSync + readFileSync pair allowed a race where the
  // file could be deleted between check and use.
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
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

function removeBundledDependency(pkgPath, label, depName) {
  // Avoid TOCTOU: same pattern as rewriteBundledDependency — read directly and
  // handle ENOENT instead of checking existsSync first.
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  let changed = false;
  for (const section of ['dependencies', 'devDependencies']) {
    if (pkg[section] && Object.hasOwn(pkg[section], depName)) {
      delete pkg[section][depName];
      changed = true;
    }
  }
  if (changed) {
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`  ✅ Removed inlined ${depName} from ${label}/package.json`);
  }
}

rewriteBundledDependency(join(PLUGIN_DEST, 'package.json'), 'plugin', '@principles/core', 'file:./core');
removeBundledDependency(join(PLUGIN_DEST, 'package.json'), 'plugin', '@principles/host-runtime');
rewriteBundledDependency(join(PD_CLI_DEST, 'package.json'), 'pd-cli', '@principles/core', 'file:../core');
// pd-cli depends on @principles/host-runtime at runtime (it statically imports
// createProductionHostRuntime). Rewrite to a local file reference so the
// bundled package is self-contained. The installer's syncPdCli() creates a
// node_modules/@principles/host-runtime symlink to the installed host-runtime
// directory. Without this rewrite + symlink, `pd --version` crashes with
// ERR_MODULE_NOT_FOUND because pd-cli cannot resolve @principles/host-runtime.
rewriteBundledDependency(join(PD_CLI_DEST, 'package.json'), 'pd-cli', '@principles/host-runtime', 'file:../host-runtime');
rewriteBundledDependency(join(PD_CLI_DEST, 'package.json'), 'pd-cli', '@principles/install-layout', 'file:../install-layout');
rewriteBundledDependency(join(CONSOLE_DEST, 'package.json'), 'console', '@principles/install-layout', 'file:../install-layout');
// host-runtime itself depends on @principles/core. Rewrite to a local file
// reference so the bundled host-runtime package can resolve core without a
// separate npm install. The installer creates the corresponding symlink.
rewriteBundledDependency(join(HOST_RUNTIME_DEST, 'package.json'), 'host-runtime', '@principles/core', 'file:../core');
rewriteBundledDependency(join(CONSOLE_DEST, 'package.json'), 'console', '@principles/core', 'file:../core');
// console statically imports OPENCLAW_HOST_LIVENESS_CONTRACT at runtime for the
// RuleCode owner live-decision readiness checks. Rewrite to a local file reference
// (same as pd-cli) so the bundled package self-resolves the freshly built
// host-runtime; otherwise the installer resolves @principles/host-runtime from the
// npm registry and crashes with an ESM named-export SyntaxError.
rewriteBundledDependency(join(CONSOLE_DEST, 'package.json'), 'console', '@principles/host-runtime', 'file:../host-runtime');
rewriteBundledDependency(join(CONSOLE_DEST, 'package.json'), 'console', 'principles-disciple', 'file:../plugin');
// pd-cli also depends on principles-disciple (the plugin package). Rewrite to a local
// file reference so the bundled package is self-contained. The installer's syncPdCli()
// creates a node_modules/principles-disciple symlink to the installed plugin directory.
// Without this rewrite + symlink, `pd runtime init` crashes with ERR_MODULE_NOT_FOUND
// because pd-cli statically imports initTrajectorySchema/initWorkflowSchema from it.
rewriteBundledDependency(join(PD_CLI_DEST, 'package.json'), 'pd-cli', 'principles-disciple', 'file:../plugin');

if (BUILD_SELF_CONTAINED_ASSET) {
  console.log('\n📦 Installing build-time runtime dependencies for the self-contained release asset...');

  const installBundledRuntimeDependencies = async (directory, label) => {
    const runNpm = (args) => execFileAsync(
      process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm',
      process.platform === 'win32' ? ['/d', '/s', '/c', ['npm', ...args].join(' ')] : args,
      {
        cwd: directory,
        timeout: 300_000,
        windowsHide: true,
      },
    );
    const lockPath = join(RELEASE_LOCKS_ROOT, label, 'package-lock.json');
    if (!existsSync(lockPath)) {
      throw new Error(`Missing committed release lock for ${label}: ${lockPath}`);
    }
    copyFileSync(lockPath, join(directory, 'package-lock.json'));
    await runNpm(['ci', '--omit=dev', '--ignore-scripts', '--legacy-peer-deps', '--install-links']);
    const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    if (pkg.dependencies && Object.hasOwn(pkg.dependencies, 'better-sqlite3')) {
      await runNpm(['rebuild', 'better-sqlite3']);
      execFileSync(process.execPath, ['-e', "require('better-sqlite3')"], {
        cwd: directory,
        stdio: 'pipe',
        timeout: 30_000,
      });
    }
    console.log(`  ✅ ${label}/node_modules is complete`);
  };

  // plugin's local core reference is package-relative (`file:./core`). Provide
  // the source while npm materializes it into node_modules via --install-links,
  // then remove the temporary duplicate from the shipped component root.
  cpSync(CORE_DEST, join(PLUGIN_DEST, 'core'), { recursive: true });
  try {
    await Promise.all([
      installBundledRuntimeDependencies(CORE_DEST, 'core'),
      installBundledRuntimeDependencies(HOST_RUNTIME_DEST, 'host-runtime'),
    ]);
    await installBundledRuntimeDependencies(PLUGIN_DEST, 'plugin');
    const installedPluginCore = join(PLUGIN_DEST, 'node_modules', '@principles', 'core');
    rmSync(installedPluginCore, { recursive: true, force: true });
    cpSync(CORE_DEST, installedPluginCore, { recursive: true });
    await Promise.all([
      installBundledRuntimeDependencies(PD_CLI_DEST, 'pd-cli'),
      installBundledRuntimeDependencies(CONSOLE_DEST, 'console'),
    ]);
  } finally {
    rmSync(join(PLUGIN_DEST, 'core'), { recursive: true, force: true });
  }
} else {
  console.log('\nℹ️  Skipping platform node_modules (use --self-contained for release assets).');
}

// ---------------------------------------------------------------------------
// Version sync: stamp the bundled plugin with the latest published
// principles-disciple npm version.
//
// The working tree's packages/openclaw-plugin/package.json version is
// permanently stale (CI bumps versions at publish time but never writes back
// to main). Without this sync, the bundled plugin carries a stale version,
// causing a permanent false "update available" after install.
// ---------------------------------------------------------------------------
if (BUILD_SELF_CONTAINED_ASSET || PREPARE_RELEASE_LOCKS) {
  console.log('\n🔢 Preserving source component versions for the immutable release asset.');
} else {
console.log('\n🔢 Syncing bundled plugin version to latest npm principles-disciple...');

let npmPluginVersion = null;
try {
  npmPluginVersion = execSync('npm view principles-disciple version', {
    encoding: 'utf-8',
    timeout: 15000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
} catch (e) {
  console.warn('  ⚠️  Could not fetch principles-disciple version from npm — using working-tree version.');
  console.warn(`      (${e instanceof Error ? e.message : String(e)})`);
}

if (npmPluginVersion && /^\d+\.\d+\.\d+/.test(npmPluginVersion)) {
  // Stamp plugin/package.json
  // CodeQL: TOCTOU here is a false positive — this is a single-threaded build
  // script; the file was just written by the copy step above with no concurrency.
  const bundledPluginPkgPath = join(PLUGIN_DEST, 'package.json');
  const pkgRaw = readFileSync(bundledPluginPkgPath, 'utf-8');
  const pkg = JSON.parse(pkgRaw);
  const oldVersion = pkg.version;
  pkg.version = npmPluginVersion;
  writeFileSync(bundledPluginPkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`  ✅ plugin/package.json: ${oldVersion} → ${npmPluginVersion}`);

  // Record the bundled plugin version on the INSTALLER's own package.json so
  // the registry metadata (`create-principles-disciple/latest`) exposes which
  // plugin version this installer can actually deliver. The console `/check`
  // reads this field to compare against what the full update will install —
  // without it, check (plugin registry latest) and apply-full (installer's
  // build-time-frozen plugin) drift and produce the permanent false
  // "update available". Unknown fields are preserved; only the
  // `pd.bundledPluginVersion` stamp is added/updated.
  const installerPkgPath = join(OUTPUT_ROOT, 'package.json');
  try {
    const installerRaw = readFileSync(installerPkgPath, 'utf-8');
    const installerPkg = JSON.parse(installerRaw);
    installerPkg.pd = installerPkg.pd && typeof installerPkg.pd === 'object' ? installerPkg.pd : {};
    installerPkg.pd.bundledPluginVersion = npmPluginVersion;
    writeFileSync(installerPkgPath, JSON.stringify(installerPkg, null, 2) + '\n');
    console.log(`  ✅ create-principles-disciple/package.json pd.bundledPluginVersion → ${npmPluginVersion}`);
  } catch (e) {
    console.warn('  ⚠️  Could not stamp pd.bundledPluginVersion on installer package.json.');
    console.warn(`      (${e instanceof Error ? e.message : String(e)})`);
  }

  // Stamp plugin/openclaw.plugin.json (if it has a version field)
  // CodeQL: same TOCTOU false positive as above — build script, single-threaded.
  const bundledManifestPath = join(PLUGIN_DEST, 'openclaw.plugin.json');
  try {
    const manifestRaw = readFileSync(bundledManifestPath, 'utf-8');
    const manifest = JSON.parse(manifestRaw);
    if (manifest.version) {
      const oldManifestVersion = manifest.version;
      manifest.version = npmPluginVersion;
      writeFileSync(bundledManifestPath, JSON.stringify(manifest, null, 2) + '\n');
      console.log(`  ✅ openclaw.plugin.json: ${oldManifestVersion} → ${npmPluginVersion}`);
    }
  } catch {
    console.log('  ⚠️  openclaw.plugin.json not found or unreadable — skipping version stamp');
  }
}
}

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
