#!/usr/bin/env node

/**
 * PD System Full Installer
 *
 * Installs the complete Principles Disciple system:
 * - openclaw-plugin to ~/.openclaw/extensions/principles-disciple
 * - pd-console to ~/.openclaw/extensions/principles-disciple/console/
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
// Console lives INSIDE the plugin extension dir — same location as npm installer
const INSTALL_CONSOLE_DIR = join(INSTALL_PLUGIN_DIR, 'console');
const INSTALL_BIN_DIR = join(INSTALL_PLUGIN_DIR, 'bin');

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

function injectCorePackage(targetDir) {
  const monorepoModules = join(ROOT_DIR, 'node_modules', '@principles', 'core');
  const targetModules = join(targetDir, 'node_modules', '@principles', 'core');

  if (!existsSync(monorepoModules)) {
    console.warn('  ⚠️  @principles/core not found in monorepo node_modules');
    return;
  }

  console.log('  📦 Injecting @principles/core...');

  // Remove target first: cp -rL on an existing directory copies INTO it,
  // producing a nested core/core/ that leaves the npm version intact.
  if (existsSync(targetModules)) {
    rmSync(targetModules, { recursive: true, force: true });
  }

  mkdirSync(dirname(targetModules), { recursive: true });
  // Use copyDir (Node-based) instead of cp -rL for reliable overwrite
  copyDir(monorepoModules, targetModules);
  console.log('    ✅ @principles/core injected');
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
  node ~/.openclaw/extensions/principles-disciple/console/dist/server.js --workspace <workspace-dir> --port 3100

Or use the helper script:
  ~/.openclaw/extensions/principles-disciple/bin/pd-console.ps1 --workspace <workspace-dir>
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
  try {
    execSync('npm install --prefer-offline --no-audit --no-fund', { cwd: ROOT_DIR, stdio: 'inherit' });
    console.log('✅ Dependencies installed');
  } catch (error) {
    console.error('❌ Failed to install root dependencies');
    process.exit(1);
  }
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

  try {
    execSync('npm run build', { cwd: PD_CONSOLE_SOURCE_DIR, stdio: 'inherit' });
    console.log('✅ pd-console built (UI + server)');
  } catch (error) {
    console.error('\n❌ pd-console build failed');
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
    console.error(`\n❌ Plugin installation script failed: ${error.message}`);
    process.exit(1);
  }

  // Register plugin in openclaw.json (sync-plugin.mjs does not do this)
  registerPlugin();
}

/**
 * Register principles-disciple in openclaw.json.
 * Merges with existing config — preserves hooks, config, and other user settings.
 * Does NOT write plugins.installs (OpenClaw manages installs.json).
 */
function registerPlugin() {
  const configPath = join(OPENCLAW_DIR, 'openclaw.json');
  if (!existsSync(configPath)) {
    console.warn('  ⚠️  openclaw.json not found — skipping plugin registration');
    return;
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw);
    if (typeof config !== 'object' || config === null || Array.isArray(config)) return;

    let modified = false;

    // Ensure plugins object exists
    if (!config.plugins) { config.plugins = {}; modified = true; }
    const plugins = config.plugins;

    // Add to plugins.allow only if the user already uses an allowlist.
    // Do NOT create plugins.allow if it doesn't exist — that would block
    // all other plugins the user hasn't explicitly listed.
    if (Array.isArray(plugins.allow) && !plugins.allow.includes('principles-disciple')) {
      plugins.allow.push('principles-disciple');
      modified = true;
    }

    // Merge plugins.entries (preserve existing hooks, config, etc.)
    if (!plugins.entries) { plugins.entries = {}; modified = true; }
    const existing = (typeof plugins.entries['principles-disciple'] === 'object' && plugins.entries['principles-disciple'] !== null)
      ? plugins.entries['principles-disciple']
      : {};
    plugins.entries['principles-disciple'] = { ...existing, enabled: true };
    modified = true;

    if (modified) {
      const tmp = configPath + '.tmp.' + Date.now();
      writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf-8');
      rmSync(configPath, { force: true });
      copyFileSync(tmp, configPath);
      rmSync(tmp, { force: true });
      console.log('  ✅ Plugin registered in openclaw.json');
    }
  } catch (e) {
    console.warn(`  ⚠️  Could not register plugin in openclaw.json: ${e.message}`);
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

  mkdirSync(INSTALL_CONSOLE_DIR, { recursive: true });
  mkdirSync(INSTALL_BIN_DIR, { recursive: true });

  // Copy dist with Windows EPERM resilience
  const sourceDist = join(PD_CONSOLE_SOURCE_DIR, 'dist');
  const targetDist = join(INSTALL_CONSOLE_DIR, 'dist');

  // Best-effort cleanup: EPERM can't block installation — will overwrite in place
  try {
    if (existsSync(targetDist)) rmSync(targetDist, { recursive: true, force: true });
  } catch {
    console.log('  ⚠️  Could not remove old dist (EPERM), will overwrite in place.');
  }

  // Retry loop for cpSync (Windows file lock resilience)
  const maxRetries = 3;
  let copied = false;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      cpSync(sourceDist, targetDist, { recursive: true });
      copied = true;
      break;
    } catch (e) {
      if (attempt < maxRetries) {
        console.log(`  ⚠️  Copy attempt ${attempt}/${maxRetries} failed, retrying in 2s...`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
      }
    }
  }
  if (!copied) {
    console.error('❌ Failed to copy pd-console dist after 3 retries');
    process.exit(1);
  }
  console.log('  📄 dist/');

  // Copy minimal package.json (for reference only)
  copyFileSync(
    join(PD_CONSOLE_SOURCE_DIR, 'package.json'),
    join(INSTALL_CONSOLE_DIR, 'package.json')
  );
  console.log('  📄 package.json');

  // Install production dependencies for pd-console FIRST,
  // THEN inject @principles/core from monorepo to overwrite any npm registry version.
  // The npm-published @principles/core lacks the ./principle-tree-ledger export
  // that the local build provides. Injection must be the authoritative source.
  console.log('  📦 Installing pd-console dependencies...');
  try {
    execSync('npm install --omit=dev --no-audit --no-fund --prefer-offline --legacy-peer-deps', {
      cwd: INSTALL_CONSOLE_DIR,
      stdio: 'inherit'
    });
  } catch (e) {
    console.warn(`  ⚠️  npm install failed for pd-console: ${e.message}`);
  }

  // Inject @principles/core from monorepo (console lives inside plugin dir)
  injectCorePackage(INSTALL_CONSOLE_DIR);

  // Create startup scripts — console is at extensions/principles-disciple/console/
  if (isWindows()) {
    const psScript = [
      '# PD Console startup script',
      '$workspace = $args[0]',
      'if (-not $workspace) { $workspace = "$env:USERPROFILE\\.openclaw\\workspace-main" }',
      '$port = $args[1]',
      'if (-not $port) { $port = 3100 }',
      '$serverEntry = "$PSScriptRoot\\..\\console\\dist\\server.js"',
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
      'node "%~dp0..\\console\\dist\\server.js" --workspace %WORKSPACE% --port %PORT%',
      '',
    ].join('\r\n');
    writeFileSync(join(INSTALL_BIN_DIR, 'pd-console.cmd'), cmdScript, 'utf-8');
    console.log('  📄 bin/pd-console.cmd');
  } else {
    const shScript = [
      '#!/usr/bin/env sh',
      'workspace=${1:-$HOME/.openclaw/workspace-main}',
      'port=${2:-3100}',
      'server_entry="$(dirname "$0")/../console/dist/server.js"',
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

  const sourceVersion = getVersion(PD_CONSOLE_SOURCE_DIR);
  if (sourceVersion) {
    console.log(`✅ pd-console installed: v${sourceVersion}`);
  }
}

// ── Verification ─────────────────────────────────────────────────────────────────────

function verifyPdConsole() {
  const serverEntry = join(INSTALL_CONSOLE_DIR, 'dist', 'server.js');
  if (!existsSync(serverEntry) || lstatSync(serverEntry).size === 0) {
    console.error('❌ pd-console server entry not found or empty after installation');
    process.exit(1);
  }

  // Verify UI dist is non-empty
  const indexPath = join(INSTALL_CONSOLE_DIR, 'dist', 'web', 'index.html');
  if (!existsSync(indexPath) || lstatSync(indexPath).size === 0) {
    console.error('❌ pd-console UI dist not found or empty');
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

    // Post-restart safety net: Gateway restart (inside sync-plugin.mjs, before console install)
    // releases Windows file locks asynchronously. Verify console survived the restart.
    const serverEntry = join(INSTALL_CONSOLE_DIR, 'dist', 'server.js');
    if (!existsSync(serverEntry) || lstatSync(serverEntry).size === 0) {
      console.log('\n⚠️  Console dist missing after Gateway restart — reinstalling...');
      installPdConsole({ ...args, force: true });
      verifyPdConsole();
    }
  }

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║                  ✅ Installation Complete                  ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  if (!args.skipConsole) {
    console.log('\n🌐 To start the PD Console WebUI:');
    const extDir = join(OPENCLAW_DIR, 'extensions', 'principles-disciple');
    if (isWindows()) {
      console.log(`   ${extDir}\\bin\\pd-console.ps1 --workspace <path-to-workspace>`);
      console.log(`   Or: node ${extDir}\\console\\dist\\server.js --workspace <path-to-workspace> --port 3100`);
    } else {
      console.log(`   ${extDir}/bin/pd-console.sh <path-to-workspace>`);
      console.log(`   Or: node ${extDir}/console/dist/server.js --workspace <path-to-workspace> --port 3100`);
    }
  }
}

main();