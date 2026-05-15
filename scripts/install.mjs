#!/usr/bin/env node

/**
 * PD System Full Installer
 *
 * Installs the complete Principles Disciple system:
 * - openclaw-plugin to ~/.openclaw/extensions/principles-disciple
 * - pd-console to ~/.openclaw/pd-console/
 *
 * Usage:
 *   node scripts/install.mjs [options]
 *
 * Options:
 *   --skip-build       Skip build step (use existing dist/)
 *   --skip-deps        Skip dependency installation
 *   --skip-plugin     Skip plugin installation (only install pd-console)
 *   --skip-console    Skip pd-console installation (only install plugin)
 *   --force           Force overwrite without prompts
 *   --lang <zh|en>     Language for skills (default: zh)
 *   --help            Show help message
 */

import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, rmSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT_DIR = join(__dirname, '..');
const PLUGIN_SOURCE_DIR = join(ROOT_DIR, 'packages', 'openclaw-plugin');
const PD_CLI_SOURCE_DIR = join(ROOT_DIR, 'packages', 'pd-cli');
const PD_CONSOLE_SOURCE_DIR = join(ROOT_DIR, 'packages', 'pd-console');

/**
 * Cross-platform home directory resolution.
 */
function getHomeDir() {
  return process.env.HOME
    || process.env.USERPROFILE
    || (process.env.HOMEDRIVE && process.env.HOMEPATH ? process.env.HOMEDRIVE + process.env.HOMEPATH : null)
    || '.';
}

const OPENCLAW_DIR = join(getHomeDir(), '.openclaw');
const INSTALL_PLUGIN_DIR = join(OPENCLAW_DIR, 'extensions', 'principles-disciple');
const INSTALL_CONSOLE_DIR = join(OPENCLAW_DIR, 'pd-console');
const INSTALL_BIN_DIR = join(INSTALL_CONSOLE_DIR, 'bin');

const MIN_NODE_VERSION = '18.0.0';

// ── Core package injection ─────────────────────────────────────────────────────────────

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    if (lstatSync(srcPath).isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

function injectCorePackage() {
  const monorepoModules = join(ROOT_DIR, 'node_modules', '@principles', 'core');
  const targetModules = join(INSTALL_CONSOLE_DIR, 'node_modules', '@principles', 'core');

  if (!existsSync(monorepoModules)) {
    console.warn('  ⚠️  @principles/core not found in monorepo node_modules — pd-console may fail to start');
    return;
  }

  console.log('  📦 Injecting @principles/core into pd-console...');
  mkdirSync(dirname(targetModules), { recursive: true });
  try {
    execSync(`cp -rL "${monorepoModules}" "${targetModules}"`, { stdio: 'ignore' });
  } catch {
    copyDir(monorepoModules, targetModules);
  }
}

// ── Argument parsing ─────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = {
    skipBuild: false,
    skipDeps: false,
    skipPlugin: false,
    skipConsole: false,
    force: false,
    lang: 'zh',
    help: false,
  };

  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--skip-build':
        args.skipBuild = true;
        break;
      case '--skip-deps':
        args.skipDeps = true;
        break;
      case '--skip-plugin':
        args.skipPlugin = true;
        break;
      case '--skip-console':
        args.skipConsole = true;
        break;
      case '--force':
      case '-f':
        args.force = true;
        break;
      case '--lang':
        args.lang = argv[++i] || 'zh';
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        if (arg.startsWith('--')) {
          console.error(`Unknown option: ${arg}`);
          args.help = true;
        }
    }
  }
  return args;
}

function showHelp() {
  console.log(`
PD System Full Installer

Usage:
  node scripts/install.mjs [options]

Options:
  --skip-build       Skip build step (use existing dist/)
  --skip-deps        Skip dependency installation
  --skip-plugin     Skip plugin installation (only install pd-console)
  --skip-console    Skip pd-console installation (only install plugin)
  --force, -f        Force overwrite without prompts
  --lang <zh|en>     Language for skills (default: zh)
  --help, -h         Show this help message

After installation, start the WebUI:
  node ~/.openclaw/pd-console/dist/server/index.js --workspace <workspace-dir> --port 3100

Or use the helper script:
  ~/.openclaw/pd-console/bin/pd-console.ps1 --workspace <workspace-dir>
`);
}

// ── Version helpers ─────────────────────────────────────────────────────────────────────

function getVersion(dir) {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version;
  } catch {
    return null;
  }
}

// ── Build ─────────────────────────────────────────────────────────────────────────────

function isWindows() {
  return process.platform === 'win32';
}

function compareVersions(a, b) {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (partsA[i] > partsB[i]) return 1;
    if (partsA[i] < partsB[i]) return -1;
  }
  return 0;
}

function checkPrerequisites() {
  const nodeVersion = process.version.replace(/^v/, '');
  if (compareVersions(nodeVersion, MIN_NODE_VERSION) < 0) {
    console.error(`❌ Node.js ${MIN_NODE_VERSION}+ required, got ${nodeVersion}`);
    process.exit(1);
  }
  console.log(`✅ Node.js ${nodeVersion} (>= ${MIN_NODE_VERSION})`);

  if (!existsSync(join(ROOT_DIR, 'package.json'))) {
    console.error('❌ Not in repo root. Run from the principles-disciple directory.');
    process.exit(1);
  }
}

function installRootDeps() {
  console.log('\n📦 Installing root dependencies...');
  const nodeModulesDir = join(ROOT_DIR, 'node_modules');
  if (!existsSync(nodeModulesDir)) {
    try {
      execSync('npm install', { cwd: ROOT_DIR, stdio: 'inherit' });
    } catch (error) {
      console.error('❌ Failed to install root dependencies');
      process.exit(1);
    }
  }
  console.log('✅ Dependencies installed');
}

function buildCoreAndCli() {
  console.log('\n🔨 Building @principles/core and @principles/pd-cli...');
  try {
    execSync('npm run build --workspace=@principles/core', { cwd: ROOT_DIR, stdio: 'inherit' });
    execSync('npm run build --workspace=@principles/pd-cli', { cwd: ROOT_DIR, stdio: 'inherit' });
    console.log('✅ @principles/core and @principles/pd-cli built');
  } catch (error) {
    console.error('\n❌ Core/CLI build failed');
    process.exit(1);
  }
}

function buildPdConsole() {
  console.log('\n🔨 Building pd-console...');
  const distDir = join(PD_CONSOLE_SOURCE_DIR, 'dist');
  const webDist = join(distDir, 'web');

  try {
    execSync('npm run build:ui', { cwd: PD_CONSOLE_SOURCE_DIR, stdio: 'inherit' });
    console.log('✅ pd-console UI built');
  } catch (error) {
    console.error('\n❌ pd-console UI build failed');
    process.exit(1);
  }
}

// ── Plugin installation ────────────────────────────────────────────────────────────────

function quoteCmdPath(filePath) {
  return filePath.replace(/"/g, '""');
}

function installPlugin(args) {
  console.log('\n🔌 Installing openclaw-plugin...');

  const syncScript = join(PLUGIN_SOURCE_DIR, 'scripts', 'sync-plugin.mjs');
  if (!existsSync(syncScript)) {
    console.error(`❌ sync-plugin.mjs not found: ${syncScript}`);
    process.exit(1);
  }

  const pluginArgs = [
    'node', syncScript,
    '--lang', args.lang,
    '--force',
  ];
  if (args.skipDeps) pluginArgs.push('--skip-deps');
  if (args.skipBuild) pluginArgs.push('--skip-build');
  if (args.restart === false) pluginArgs.push('--no-restart');

  try {
    execSync(pluginArgs.join(' '), { cwd: PLUGIN_SOURCE_DIR, shell: true, stdio: 'inherit' });
    console.log('✅ Plugin installed');
  } catch (error) {
    console.error('\n❌ Plugin installation failed');
    process.exit(1);
  }
}

// ── pd-console installation ──────────────────────────────────────────────────────────────

function installPdConsole(args) {
  console.log('\n🌐 Installing pd-console...');

  const consoleSourceDist = join(PD_CONSOLE_SOURCE_DIR, 'dist');
  if (!existsSync(join(consoleSourceDist, 'web', 'index.html'))) {
    console.error('❌ pd-console dist/web/index.html missing. Run build first.');
    process.exit(1);
  }

  // Clean existing installation
  if (existsSync(INSTALL_CONSOLE_DIR) && args.force) {
    rmSync(INSTALL_CONSOLE_DIR, { recursive: true, force: true });
  } else if (existsSync(INSTALL_CONSOLE_DIR)) {
    const installedVersion = getVersion(INSTALL_CONSOLE_DIR);
    const sourceVersion = getVersion(PD_CONSOLE_SOURCE_DIR);
    if (installedVersion && sourceVersion && installedVersion !== sourceVersion) {
      console.log(`\n⚠️  pd-console already installed: v${installedVersion}, source: v${sourceVersion}`);
      console.log('   Use --force to overwrite');
      console.log('   Skipping pd-console installation');
      return;
    }
  }

  mkdirSync(INSTALL_CONSOLE_DIR, { recursive: true });
  mkdirSync(INSTALL_BIN_DIR, { recursive: true });

  // Copy dist
  const sourceDist = join(PD_CONSOLE_SOURCE_DIR, 'dist');
  const targetDist = join(INSTALL_CONSOLE_DIR, 'dist');
  if (existsSync(targetDist)) rmSync(targetDist, { recursive: true, force: true });
  cpSync(sourceDist, targetDist, { recursive: true });
  console.log('  📄 dist/');

  // Copy minimal package.json (for reference only)
  copyFileSync(
    join(PD_CONSOLE_SOURCE_DIR, 'package.json'),
    join(INSTALL_CONSOLE_DIR, 'package.json')
  );
  console.log('  📄 package.json');

  // Inject @principles/core from monorepo (similar to plugin install)
  injectCorePackage();

  // Install production dependencies for pd-console
  console.log('  📦 Installing pd-console dependencies...');
  try {
    execSync('npm install --omit=dev --no-audit --no-fund --prefer-offline --legacy-peer-deps', {
      cwd: INSTALL_CONSOLE_DIR,
      stdio: 'inherit'
    });
  } catch (e) {
    console.warn(`  ⚠️  npm install failed for pd-console: ${e.message}`);
  }

  // Create startup scripts
  if (isWindows()) {
    const psScript = [
      '# PD Console startup script',
      '$workspace = $args[0]',
      'if (-not $workspace) { $workspace = "$env:USERPROFILE\\.openclaw\\workspace-main" }',
      '$port = $args[1]',
      'if (-not $port) { $port = 3100 }',
      '$serverEntry = "$PSScriptRoot\\dist\\server\\index.js"',
      'if (-not (Test-Path $serverEntry)) {',
      '  Write-Host "❌ pd-console not installed. Run install.mjs first."',
      '  exit 1',
      '}',
      'node "$serverEntry" --workspace $workspace --port $port',
      '',
    ].join('\r\n');
    writeFileSync(join(INSTALL_BIN_DIR, 'pd-console.ps1'), psScript, 'utf-8');
    console.log('  📄 bin/pd-console.ps1');

    const cmdScript = [
      '@echo off',
      'set WORKSPACE=%1',
      'if "%WORKSPACE%"=="" set WORKSPACE=%USERPROFILE%\\.openclaw\\workspace-main',
      'set PORT=%2',
      'if "%PORT%"=="" set PORT=3100',
      'node "%~dp0..\\dist\\server\\index.js" --workspace %WORKSPACE% --port %PORT%',
      '',
    ].join('\r\n');
    writeFileSync(join(INSTALL_BIN_DIR, 'pd-console.cmd'), cmdScript, 'utf-8');
    console.log('  📄 bin/pd-console.cmd');
  } else {
    const shScript = [
      '#!/usr/bin/env sh',
      'workspace=${1:-$HOME/.openclaw/workspace-main}',
      'port=${2:-3100}',
      'server_entry="$(dirname "$0")/../dist/server/index.js"',
      'if [ ! -f "$server_entry" ]; then',
      '  echo "❌ pd-console not installed. Run install.mjs first."',
      '  exit 1',
      'fi',
      'exec node "$server_entry" --workspace "$workspace" --port "$port"',
      '',
    ].join('\n');
    writeFileSync(join(INSTALL_BIN_DIR, 'pd-console.sh'), shScript, 'utf-8');
    chmodSync(join(INSTALL_BIN_DIR, 'pd-console.sh'), 0o755);
    console.log('  📄 bin/pd-console.sh');
  }

  // Update version
  const sourceVersion = getVersion(PD_CONSOLE_SOURCE_DIR);
  if (sourceVersion) {
    try {
      const configPath = join(OPENCLAW_DIR, 'openclaw.json');
      if (existsSync(configPath)) {
        const config = JSON.parse(readFileSync(configPath, 'utf-8'));
        if (!config.pdConsole) config.pdConsole = {};
        config.pdConsole.version = sourceVersion;
        config.pdConsole.installedAt = new Date().toISOString();
        const raw = JSON.stringify(config, null, 2) + '\n';
        const tmp = configPath + '.tmp.' + Date.now();
        writeFileSync(tmp, raw, 'utf-8');
        rmSync(configPath, { force: true });
        copyFileSync(tmp, configPath);
        rmSync(tmp, { force: true });
      }
    } catch (e) {
      console.warn(`⚠️  Could not update openclaw.json: ${e.message}`);
    }
    console.log(`✅ pd-console installed: v${sourceVersion}`);
  }
}

// ── Verification ─────────────────────────────────────────────────────────────────────

function verifyPdConsole() {
  const serverEntry = join(INSTALL_CONSOLE_DIR, 'dist', 'server', 'index.js');
  if (!existsSync(serverEntry)) {
    console.error('❌ pd-console server entry not found after installation');
    process.exit(1);
  }

  // Verify UI dist
  if (!existsSync(join(INSTALL_CONSOLE_DIR, 'dist', 'web', 'index.html'))) {
    console.error('❌ pd-console UI dist not found');
    process.exit(1);
  }

  console.log('✅ pd-console verification passed');
}

// ── Main ─────────────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs();
  if (args.help) {
    showHelp();
    process.exit(0);
  }

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║         PD System Full Installer                           ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  console.log(`🌍 Language: ${args.lang}`);
  console.log(`📦 Plugin: ${args.skipPlugin ? 'skip' : 'install'}`);
  console.log(`🌐 Console: ${args.skipConsole ? 'skip' : 'install'}`);

  console.log('\n🔍 Checking prerequisites...');
  checkPrerequisites();

  if (!args.skipDeps) installRootDeps();

  if (!args.skipBuild) {
    buildCoreAndCli();
    buildPdConsole();
  } else {
    console.log('\n⏭️  Skipping build (--skip-build)');
  }

  if (!args.skipPlugin) {
    installPlugin(args);
  }

  if (!args.skipConsole) {
    installPdConsole(args);
    verifyPdConsole();
  }

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║                  ✅ Installation Complete                  ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  if (!args.skipConsole) {
    console.log('\n🌐 To start the PD Console WebUI:');
    if (isWindows()) {
      console.log('   .\\bin\\pd-console.ps1 --workspace <path-to-workspace>');
      console.log('   Or: node ~/.openclaw/pd-console/dist/server/index.js --workspace <path-to-workspace> --port 3100');
    } else {
      console.log('   ~/.openclaw/pd-console/bin/pd-console.sh <path-to-workspace>');
      console.log('   Or: node ~/.openclaw/pd-console/dist/server/index.js --workspace <path-to-workspace> --port 3100');
    }
  }
}

main();