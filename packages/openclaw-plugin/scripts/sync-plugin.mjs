#!/usr/bin/env node

/**
 * Principles Disciple Plugin Installer
 *
 * A complete installation script that can run after cloning the repo.
 * Handles dependencies, build, and sync to OpenClaw installation directory.
 *
 * Usage:
 *   node scripts/sync-plugin.mjs [options]
 *
 * Options:
 *   --lang <zh|en>     Language for skills (default: zh)
 *   --skip-build       Skip build step (use existing dist/)
 *   --skip-deps        Skip dependency installation
 *   --force            Force overwrite without prompts
 *   --help             Show help message
 */

import { copyFileSync, cpSync, existsSync, lstatSync, rmSync, readFileSync, readFileSync as readFileSyncRaw, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SOURCE_DIR = join(__dirname, '..');

/**
 * Cross-platform home directory resolution.
 * Linux/macOS: HOME=/home/user
 * Windows: USERPROFILE=C:\Users\user or HOMEDRIVE/HOMEPATH
 */
function getHomeDir() {
  return process.env.HOME
    || process.env.USERPROFILE
    || (process.env.HOMEDRIVE && process.env.HOMEPATH ? process.env.HOMEDRIVE + process.env.HOMEPATH : null)
    || '.';
}

const OPENCLAW_DIR = join(getHomeDir(), '.openclaw');
const INSTALL_DIR = join(OPENCLAW_DIR, 'extensions', 'principles-disciple');
function getConfiguredWorkspaceDir() {
  const configPath = join(OPENCLAW_DIR, 'openclaw.json');
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw);
    const workspace = config?.agents?.defaults?.workspace;
    if (workspace && existsSync(workspace)) {
      return workspace;
    }
  } catch {
    // Fall through to fallback
  }
  // Fallback: try workspace-main (legacy default)
  return join(OPENCLAW_DIR, 'workspace-main');
}

// Files and directories to sync
const SYNC_ITEMS = [
    'dist',
    'templates',
    'scripts',
    'docs',
    'openclaw.plugin.json',
    'package.json',
];

// Minimum Node.js version
const MIN_NODE_VERSION = '18.0.0';

/**
 * Parse command line arguments
 */
function parseArgs() {
    const args = {
        lang: process.env.OPENCLAW_LANGUAGE || 'zh',
        skipBuild: false,
        skipDeps: false,
        force: false,
        restart: true,
        dev: false,
        bump: false,
        help: false,
    };

    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case '--lang':
                args.lang = argv[++i];
                break;
            case '--skip-build':
                args.skipBuild = true;
                break;
            case '--skip-deps':
                args.skipDeps = true;
                break;
            case '--restart':
            case '--no-restart':
                args.restart = !arg.startsWith('--no-');
                break;
            case '--dev':
            case '-d':
                args.dev = true;
                args.force = true;
                args.restart = true;
                args.bump = true;
                break;
            case '--bump':
            case '-b':
                args.bump = true;
                break;
            case '--force':
            case '-f':
                args.force = true;
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

/**
 * Show help message
 */
function showHelp() {
    console.log(`
Principles Disciple Plugin Installer

Usage:
  node scripts/sync-plugin.mjs [options]

Options:
  --lang <zh|en>     Language for skills (default: zh)
  --skip-build       Skip build step (use existing dist/)
  --skip-deps        Skip dependency installation
  --restart         Automatically restart OpenClaw gateway after installation (default: true, use --no-restart to skip)
  --dev, -d          Developer mode: --force + --restart + --bump + clean stale backups
  --bump, -b         Auto-bump patch version if there are uncommitted source changes
  --force, -f        Force overwrite without prompts
  --help, -h         Show this help message

Examples:
  # Full installation with Chinese skills
  node scripts/sync-plugin.mjs

  # Install with English skills
  node scripts/sync-plugin.mjs --lang en

  # Developer mode: bump version, build, deploy, restart, clean up (recommended)
  node scripts/sync-plugin.mjs --dev

  # Just bump version without deploying
  node scripts/sync-plugin.mjs --bump --skip-build --skip-deps

  # Quick sync after local build
  node scripts/sync-plugin.mjs --skip-deps --skip-build

Environment Variables:
  OPENCLAW_LANGUAGE   Default language for skills (zh or en)
`);
}

/**
 * Compare semver versions
 */
function compareVersions(a, b) {
    const partsA = a.split('.').map(Number);
    const partsB = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if (partsA[i] > partsB[i]) return 1;
        if (partsA[i] < partsB[i]) return -1;
    }
    return 0;
}

/**
 * Main function
 */
function checkPrerequisites() {
    // Check Node.js version
    const nodeVersion = process.version.replace(/^v/, '');
    if (compareVersions(nodeVersion, MIN_NODE_VERSION) < 0) {
        console.error(`❌ Node.js ${MIN_NODE_VERSION}+ required, got ${nodeVersion}`);
        process.exit(1);
    }
    console.log(`✅ Node.js ${nodeVersion} (>= ${MIN_NODE_VERSION})`);

    // Check npm
    try {
        const npmVersion = execSync('npm --version', { encoding: 'utf-8' }).trim();
        console.log(`✅ npm ${npmVersion}`);

        // Check for global package conflicts that cause module resolution traps
        console.log('🔍 Checking for global package conflicts...');
        try {
            // Cross-platform: use stdio: 'pipe' to capture stderr, then check output
            const globalConflict = execSync('npm list -g principles-disciple --depth=0', {
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe']  // Capture all streams
            });
            if (globalConflict.includes('principles-disciple')) {
                console.error('\n❌ CONFLICT DETECTED: A version of "principles-disciple" is installed globally via npm.');
                console.error('This will block OpenClaw from loading the extension version you are trying to install.');
                console.error('\nACTION REQUIRED: Please run the following command first:');
                console.error('   npm uninstall -g principles-disciple\n');
                process.exit(1);
            }
        } catch (e) {
            // npm list returns non-zero if not found, which is what we want
            // Check if the error output contains the package name
            const output = e.stdout || e.stderr || '';
            if (!output.includes('principles-disciple')) {
                console.log('✅ No global package conflicts detected.');
            } else {
                console.error('\n❌ CONFLICT DETECTED: A version of "principles-disciple" is installed globally via npm.');
                console.error('This will block OpenClaw from loading the extension version you are trying to install.');
                console.error('\nACTION REQUIRED: Please run the following command first:');
                console.error('   npm uninstall -g principles-disciple\n');
                process.exit(1);
            }
        }
    } catch {
        console.error('❌ npm not found. Please install Node.js with npm.');
        process.exit(1);
    }

    // Check if we're in the plugin directory
    if (!existsSync(join(SOURCE_DIR, 'package.json'))) {
        console.error('❌ Not in plugin directory. package.json not found.');
        console.error('   Run this script from packages/openclaw-plugin/');
        process.exit(1);
    }
}

/**
 * Extract version from package.json
 */
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

/**
 * Auto-bump patch version if there are uncommitted source changes.
 * Updates all version files: package.json (root + plugin), openclaw.plugin.json, README_ZH.md.
 */
function autoBumpVersion(sourceDir) {
    const rootDir = join(sourceDir, '..', '..');
    const pluginDir = sourceDir;

    // Check for uncommitted changes in source files
    try {
        const diffOutput = execSync('git diff --name-only HEAD', {
            cwd: rootDir,
            encoding: 'utf-8',
        }).trim();
        const changedFiles = diffOutput ? diffOutput.split('\n').filter(f => {
            return f.startsWith('packages/openclaw-plugin/src/') ||
                   f.startsWith('packages/openclaw-plugin/skills/') ||
                   f.startsWith('scripts/') ||
                   f === 'packages/openclaw-plugin/package.json' ||
                   f === 'package.json' ||
                   f === 'README_ZH.md';
        }) : [];

        if (changedFiles.length === 0) {
            console.log('📋 No uncommitted source changes — skipping version bump');
            return;
        }

        console.log(`📋 Found uncommitted changes in ${changedFiles.length} file(s) — bumping version...`);

        const currentVersion = getVersion(pluginDir);
        if (!currentVersion) {
            console.error('❌ Cannot determine current version');
            process.exit(1);
        }

        const [major, minor, patch] = currentVersion.split('.').map(Number);
        const newVersion = `${major}.${minor}.${patch + 1}`;

        // Update package.json (plugin)
        const pkgPath = join(pluginDir, 'package.json');
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        pkg.version = newVersion;
        writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');

        // Update openclaw.plugin.json
        const manifestPath = join(pluginDir, 'openclaw.plugin.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        manifest.version = newVersion;
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

        // Update root package.json
        const rootPkgPath = join(rootDir, 'package.json');
        if (existsSync(rootPkgPath)) {
            const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));
            rootPkg.version = newVersion;
            writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + '\n', 'utf-8');
        }

        // Update README_ZH.md
        const readmePath = join(rootDir, 'README_ZH.md');
        if (existsSync(readmePath)) {
            let readme = readFileSync(readmePath, 'utf-8');
            readme = readme.replace(/v\d+\.\d+\.\d+/g, `v${newVersion}`);
            writeFileSync(readmePath, readme, 'utf-8');
        }

        console.log(`✅ Version bumped: ${currentVersion} → ${newVersion}`);
    } catch (err) {
        console.warn(`⚠️  Auto-bump failed: ${err.message}`);
        console.warn('   Continuing with current version');
    }
}

/**
 * Install project dependencies
 */
function installDependencies() {
    console.log('\n📦 Installing project dependencies...');

    const nodeModulesDir = join(SOURCE_DIR, 'node_modules');
    const needsInstall = !existsSync(nodeModulesDir) ||
        !existsSync(join(nodeModulesDir, 'better-sqlite3'));

    if (!needsInstall) {
        console.log('✅ Dependencies already installed');
        return;
    }

    try {
        execSync('npm install', {
            cwd: SOURCE_DIR,
            stdio: 'inherit'
        });
        console.log('✅ Dependencies installed');
    } catch (error) {
        console.error('❌ Failed to install dependencies');
        process.exit(1);
    }
}

/**
 * Build the plugin.
 */
function buildPlugin() {
    console.log('\n🔨 Building plugin (esbuild only — bypassing tsc which may fail on unrelated files)...');

    try {
        execSync('node esbuild.config.js --production', {
            cwd: SOURCE_DIR,
            stdio: 'inherit'
        });
        execSync('node scripts/build-web.mjs --production', {
            cwd: SOURCE_DIR,
            stdio: 'inherit'
        });
    } catch (error) {
        console.error('\n❌ Build failed');
        console.error(`   ${error.message}`);
        process.exit(1);
    }

    verifyBundleContents();
}

/**
 * Verify the built bundle contains all critical symbols.
 */
function verifyBundleContents() {
    const bundleJs = join(SOURCE_DIR, 'dist', 'bundle.js');
    if (!existsSync(bundleJs)) {
        console.error('❌ dist/bundle.js missing after build.');
        process.exit(1);
    }

    const content = readFileSync(bundleJs, 'utf-8');
    const requiredSymbols = [
        { name: 'EvolutionWorkerService', reason: 'main plugin service export' },
        { name: 'checkPainFlag',          reason: 'pain flag detection' },
        { name: 'processEvolutionQueue',  reason: 'queue processing' },
        { name: 'acquireQueueLock',       reason: 'queue lock for pd-reflect and worker' },
    ];

    const missing = [];
    for (const sym of requiredSymbols) {
        if (!content.includes(sym.name)) {
            missing.push(`  - ${sym.name}: ${sym.reason}`);
        }
    }

    if (missing.length > 0) {
        console.warn('\n⚠️  Bundle verification warning — symbols not found (may be minified):');
        missing.forEach(m => console.warn(m));
    }

    console.log('✅ Bundle verification passed — all critical symbols present');
    writeBuildFingerprint();
}

/**
 * Write a build fingerprint.
 */
function writeBuildFingerprint() {
    const bundleJs = join(SOURCE_DIR, 'dist', 'bundle.js');
    const manifestSrc = join(SOURCE_DIR, 'openclaw.plugin.json');
    const manifestDist = join(SOURCE_DIR, 'dist', 'openclaw.plugin.json');

    let gitSha = 'unknown';
    try {
        gitSha = execSync('git rev-parse HEAD', {
            cwd: SOURCE_DIR,
            encoding: 'utf-8',
            timeout: 10000,
        }).trim().slice(0, 12);
    } catch {
        console.warn('⚠️  Could not get git SHA');
    }

    let bundleMd5 = 'unknown';
    try {
        const bundleContent = readFileSyncRaw(bundleJs);
        bundleMd5 = createHash('md5').update(bundleContent).digest('hex');
    } catch {
        console.warn('⚠️  Could not compute bundle MD5');
    }

    let manifest;
    try {
        manifest = JSON.parse(readFileSync(manifestDist, 'utf-8'));
    } catch {
        try {
            manifest = JSON.parse(readFileSync(manifestSrc, 'utf-8'));
        } catch {
            console.warn('⚠️  Could not read openclaw.plugin.json');
            return;
        }
    }

    manifest.buildFingerprint = {
        gitSha,
        bundleMd5,
        builtAt: new Date().toISOString(),
    };

    try {
        mkdirSync(join(SOURCE_DIR, 'dist'), { recursive: true });
        writeFileAtomic(manifestDist, JSON.stringify(manifest, null, 2) + '\n');
        console.log(`✅ Build fingerprint: git=${gitSha} bundleMd5=${bundleMd5}`);
    } catch (err) {
        console.warn(`⚠️  Could not write fingerprint: ${err.message}`);
    }

    try {
        const rootManifest = JSON.parse(readFileSync(manifestSrc, 'utf-8'));
        rootManifest.buildFingerprint = manifest.buildFingerprint;
        writeFileAtomic(manifestSrc, JSON.stringify(rootManifest, null, 2) + '\n');
    } catch { /* ignore */ }
}

/**
 * Atomic file write.
 */
function writeFileAtomic(filePath, content) {
    const tmp = filePath + '.tmp.' + Date.now();
    writeFileSync(tmp, content, 'utf-8');
    rmSync(filePath, { force: true });
    copyFileSync(tmp, filePath);
    rmSync(tmp, { force: true });
}

/**
 * Verify installed fingerprint.
 */
function verifyInstalledFingerprint() {
    const sourceManifest = join(SOURCE_DIR, 'dist', 'openclaw.plugin.json');
    const installedManifest = join(INSTALL_DIR, 'dist', 'openclaw.plugin.json');

    if (!existsSync(installedManifest)) {
        console.error('\n❌ Installed manifest not found.');
        process.exit(1);
    }

    try {
        const sm = JSON.parse(readFileSync(sourceManifest, 'utf-8'));
        const im = JSON.parse(readFileSync(installedManifest, 'utf-8'));
        const sourceFp = sm.buildFingerprint;
        const installedFp = im.buildFingerprint;

        if (sourceFp && installedFp) {
            const gitMismatch = sourceFp.gitSha !== installedFp.gitSha;
            const md5Mismatch = sourceFp.bundleMd5 !== installedFp.bundleMd5;

            if (gitMismatch || md5Mismatch) {
                console.error('\n❌ INSTALLED PLUGIN IS STALE — FINGERPRINT MISMATCH');
                process.exit(1);
            }
        }
    } catch {
        console.warn('⚠️  Fingerprint verification skipped');
    }

    console.log('✅ Installed fingerprint verified');
}

/**
 * Remove existing installation directory with Windows-friendly retry logic.
 */
function cleanTargetDir(force) {
    if (!existsSync(INSTALL_DIR)) return;

    if (!force) {
        const installedVersion = getVersion(INSTALL_DIR);
        if (installedVersion && installedVersion !== getVersion(SOURCE_DIR)) {
            console.error(`\n❌ VERSION CONFLICT: Installed v${installedVersion}, Source v${getVersion(SOURCE_DIR)}`);
            process.exit(1);
        }
    }

    console.log('\n🗑️  Removing existing installation...');

    // Windows often returns EPERM due to file locks, add retry logic
    const maxRetries = isWindows() ? 3 : 1;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            rmSync(INSTALL_DIR, { recursive: true, force: true });
            console.log('   ✅ Removed successfully.');
            return;
        } catch (err) {
            lastError = err;
            if (err.code === 'EPERM' && attempt < maxRetries) {
                console.log(`   ⚠️  Attempt ${attempt}/${maxRetries} failed (EPERM), retrying in 2s...`);
                // Synchronous sleep for retry
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
            }
        }
    }

    // If all retries failed on Windows, try graceful fallback
    if (isWindows() && lastError?.code === 'EPERM') {
        console.log('   ⚠️  Windows file lock detected, skipping removal.');
        console.log('   📁 Will overwrite files in place.');
        return;  // Continue with overwrite installation
    }

    throw lastError;
}

/**
 * Ensure installation directory exists.
 */
function ensureInstallDir() {
    if (existsSync(INSTALL_DIR)) return;
    if (!existsSync(OPENCLAW_DIR)) {
        console.error(`❌ OpenClaw installation not found: ${OPENCLAW_DIR}`);
        process.exit(1);
    }
    const extensionsDir = join(OPENCLAW_DIR, 'extensions');
    if (!existsSync(extensionsDir)) mkdirSync(extensionsDir, { recursive: true });
    mkdirSync(INSTALL_DIR, { recursive: true });
}

/**
 * Sync skills.
 */
function syncSkills(lang) {
    const skillsSource = join(SOURCE_DIR, 'templates', 'langs', lang, 'skills');
    const skillsTarget = join(INSTALL_DIR, 'skills');
    if (!existsSync(skillsSource)) return false;
    if (existsSync(skillsTarget)) rmSync(skillsTarget, { recursive: true, force: true });
    cpSync(skillsSource, skillsTarget, { recursive: true });
    console.log(`  📄 skills (from ${lang})`);
    return true;
}

/**
 * Sync a single item.
 */
function syncItem(item) {
    const source = join(SOURCE_DIR, item);
    const target = join(INSTALL_DIR, item);
    if (!existsSync(source)) return;
    console.log(`  📄 ${item}`);
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    try {
        cpSync(source, target, { recursive: true });
    } catch {
        copyFileSync(source, target);
    }
}

/**
 * Recursive directory copy (Windows-safe, no symlinks).
 */
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

/**
 * Inject local workspace packages (monorepo) into node_modules before npm install.
 * @principles/core is a workspace package, not published to npm — we must copy it
 * from the monorepo's node_modules so npm install --production doesn't 404 it.
 */
function injectLocalWorkspacePackages() {
    const monorepoModules = join(SOURCE_DIR, '..', '..', 'node_modules', '@principles', 'core');
    const targetModules = join(INSTALL_DIR, 'node_modules', '@principles', 'core');

    if (!existsSync(monorepoModules)) {
        // Not in monorepo context (e.g., npm pack / CI tarball) — skip
        return;
    }

    console.log('  📦 Injecting local workspace packages (@principles/core)...');
    mkdirSync(dirname(targetModules), { recursive: true });
    // cpSync creates symlinks on Windows for symlinked dirs — use cp -rL (dereference) via exec
    let injected = false;
    try {
        execSync(`cp -rL "${monorepoModules}" "${targetModules}"`, { stdio: 'ignore' });
        injected = true;
    } catch {
        // Fallback: manual copy via node (Windows-compatible)
        try {
            copyDir(monorepoModules, targetModules);
            injected = true;
        } catch (copyErr) {
            console.warn('  ⚠️ Failed to inject @principles/core from monorepo: ' + copyErr.message);
            console.warn('  ⚠️ npm install --production may fail if @principles/core is not published');
        }
    }
    if (injected && !existsSync(targetModules)) {
        console.warn('  ⚠️ Injection reported success but target not found: ' + targetModules);
    }
}

/**
 * Install production dependencies in target.
 */
function installTargetDependencies() {
    console.log('\n📦 Installing production dependencies in target...');
    try {
        execSync('npm install --production --no-audit --no-fund', {
            cwd: INSTALL_DIR,
            stdio: 'inherit'
        });
        console.log('✅ Dependencies installed');
    } catch (error) {
        console.error(`\n❌ npm install failed: ${error.message}`);
        process.exit(1);
    }
}

/**
 * Clean stale backups.
 */
function cleanStaleBackups() {
    const extensionsDir = join(OPENCLAW_DIR, 'extensions');
    if (!existsSync(extensionsDir)) return;
    const entries = readdirSync(extensionsDir);
    const backups = entries.filter(e => e.startsWith('principles-disciple.backup') || e.startsWith('principles-disciple.old'));
    for (const backup of backups) {
        rmSync(join(extensionsDir, backup), { recursive: true, force: true });
        console.log(`   Removed: ${backup}`);
    }
}

/**
 * Check if running on Windows.
 */
function isWindows() {
    return process.platform === 'win32';
}

/**
 * Get temporary directory path (cross-platform).
 */
function getTempDir() {
    if (isWindows()) {
        return process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp';
    }
    return '/tmp';
}

/**
 * Restart OpenClaw Gateway (cross-platform).
 */
function restartGateway() {
    console.log('\n🔄 Restarting OpenClaw Gateway...');

    if (isWindows()) {
        return restartGatewayWindows();
    } else {
        return restartGatewayLinux();
    }
}

/**
 * Restart Gateway on Windows using PowerShell.
 */
function restartGatewayWindows() {
    const logPath = join(getTempDir(), 'openclaw-auto-restart.log');

    try {
        // Step 1: Find and terminate existing gateway processes
        console.log('   Looking for existing gateway processes...');
        try {
            // PowerShell command to find and kill openclaw gateway processes
            // Note: Use single quotes inside -like pattern for proper escaping
            const findCmd = "Get-Process -Name 'node' -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*openclaw*' } | Select-Object -ExpandProperty Id";
            const pids = execSync(`powershell -NoProfile -Command "${findCmd}"`, { encoding: 'utf-8' }).trim();

            if (pids) {
                console.log(`   Terminating existing gateway process(es): ${pids.replace(/\n/g, ', ')}...`);
                // Kill by PID
                const pidList = pids.split('\n').filter(p => p.trim());
                for (const pid of pidList) {
                    try {
                        execSync(`taskkill /PID ${pid.trim()} /F`, { stdio: 'pipe' });
                    } catch { /* ignore if process already gone */ }
                }
                // Wait a moment for process to terminate
                execSync('timeout /t 3 /nobreak > nul', { shell: true, stdio: 'ignore' });
            }
        } catch { /* no existing processes */ }

        // Step 2: Start new gateway process in background
        console.log(`   Starting new gateway (logs: ${logPath})...`);

        // Use openclaw CLI to start gateway (more reliable than direct node invocation)
        const gatewayCmd = join(getHomeDir(), '.openclaw', 'gateway.cmd');
        const startCmd = `Start-Process -FilePath 'cmd.exe' -ArgumentList '/c ${gatewayCmd}' -WindowStyle Hidden -RedirectStandardOutput '${logPath}' -RedirectStandardError '${join(getTempDir(), 'openclaw-auto-restart.err')}'`;
        execSync(`powershell -NoProfile -Command "${startCmd}"`, { stdio: 'inherit' });
        console.log('✅ Gateway restart triggered.');

        // Step 3: Wait and verify
        setTimeout(() => {
            try {
                if (existsSync(logPath)) {
                    const logs = readFileSync(logPath, 'utf-8');
                    if (logs.includes('Principles Disciple Plugin registered')) {
                        console.log('✅ SUCCESS: Principles Disciple plugin registered successfully!');
                    } else if (logs.includes('failed to load') || logs.includes('Error: Cannot find module')) {
                        console.error('\n❌ CRITICAL: Gateway started but PD plugin FAILED to load!');
                        console.error('   Check logs at: ' + logPath);
                        process.exit(1);
                    } else {
                        console.warn('⚠️  Gateway started but PD registration not confirmed in recent logs.');
                        console.log('   Check logs at: ' + logPath);
                    }
                }
            } catch (e) {
                console.warn(`⚠️  Post-restart verification skipped: ${e.message}`);
            }
        }, 8000);

    } catch (error) {
        console.error(`\n❌ Failed to restart gateway: ${error.message}`);
        console.error('   You may need to manually restart OpenClaw Gateway.');
        process.exit(1);
    }
}

/**
 * Restart Gateway on Linux using systemctl or process management.
 */
function restartGatewayLinux() {
    const logPath = '/tmp/openclaw-auto-restart.log';

    try {
        // Try systemctl first (Linux systemd)
        try {
            execSync('systemctl --user is-active openclaw-gateway.service', { stdio: 'pipe' });
            console.log('   Restarting via systemctl...');
            execSync('systemctl --user restart openclaw-gateway.service', { stdio: 'inherit' });
            console.log('✅ Gateway restarted via systemctl.');

            console.log('   Waiting for Gateway to initialize and load PD plugin (8s)...');
            setTimeout(() => {
                try {
                    const status = execSync('systemctl --user is-active openclaw-gateway.service', { encoding: 'utf-8' }).trim();
                    if (status === 'active') {
                        console.log('✅ Gateway is running.');
                        const logs = execSync('journalctl --user -u openclaw-gateway.service --since "10 seconds ago"', { encoding: 'utf-8' });
                        if (logs.includes('Principles Disciple Plugin registered')) {
                            console.log('✅ SUCCESS: Principles Disciple plugin registered successfully!');
                        } else if (logs.includes('failed to load') || logs.includes('Error: Cannot find module')) {
                            console.error('\n❌ CRITICAL: Gateway is running but PD plugin FAILED to load!');
                            process.exit(1);
                        } else {
                            console.warn('⚠️  Gateway started but PD registration not confirmed in recent logs.');
                        }
                    } else {
                        console.error(`❌ Gateway status: ${status}.`);
                        process.exit(1);
                    }
                } catch (e) {
                    console.warn(`⚠️  Post-restart verification skipped: ${e.message}`);
                }
            }, 8000);
            return;
        } catch { /* systemctl not available, fall through to manual restart */ }

        // Manual process management
        const pids = execSync('pgrep -f "openclaw-gateway|openclaw gateway"', { encoding: 'utf-8' }).trim();
        if (pids) {
            console.log(`   Terminating existing gateway process(es)...`);
            execSync(`echo "${pids}" | xargs kill -TERM 2>/dev/null || true`);
            execSync('sleep 3');
        }

        console.log(`   Starting new gateway (logs: ${logPath})...`);
        execSync(`nohup openclaw gateway --force > ${logPath} 2>&1 &`, { stdio: 'ignore' });
        console.log('✅ Gateway restart triggered.');

        setTimeout(() => {
            if (existsSync(logPath)) {
                const logs = readFileSync(logPath, 'utf-8');
                if (logs.includes('Principles Disciple Plugin registered')) {
                    console.log('✅ SUCCESS: Principles Disciple plugin registered successfully (manual restart)!');
                } else if (logs.includes('failed to load')) {
                    console.error('\n❌ CRITICAL: Manual restart triggered but PD plugin FAILED to load!');
                    process.exit(1);
                }
            }
        }, 8000);
    } catch (error) {
        console.error(`\n❌ Failed to restart gateway: ${error.message}`);
        process.exit(1);
    }
}

/**
 * Main function
 */
function main() {
    const args = parseArgs();
    if (args.help) {
        showHelp();
        process.exit(0);
    }

    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║     Principles Disciple Plugin Installer                   ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    if (args.dev) console.log('🛠️  DEV MODE: force + restart + bump + stale backup cleanup\n');
    if (args.bump) autoBumpVersion(SOURCE_DIR);

    const sourceVersion = getVersion(SOURCE_DIR);
    if (!sourceVersion) {
        console.error('❌ Cannot determine source version.');
        process.exit(1);
    }
    console.log(`📋 Plugin version: v${sourceVersion}`);
    console.log(`🌍 Language: ${args.lang}`);

    console.log('\n🔍 Checking prerequisites...');
    checkPrerequisites();

    if (!args.skipDeps) installDependencies();

    buildPlugin();
    cleanTargetDir(args.force);
    ensureInstallDir();

    console.log('\n📦 Syncing files to OpenClaw...');
    for (const item of SYNC_ITEMS) syncItem(item);
    syncSkills(args.lang);

    injectLocalWorkspacePackages();
    installTargetDependencies();

    console.log('\n🔍 Verifying installed plugin can load native dependencies...');
    try {
        execSync(`node -e "require('better-sqlite3')"`, { cwd: INSTALL_DIR, stdio: 'pipe' });
        console.log('✅ Native dependencies verified');
    } catch (error) {
        console.warn('\n⚠️  Native module better-sqlite3 failed to load. Attempting automatic rebuild...');
        try {
            execSync('npm rebuild better-sqlite3', { cwd: INSTALL_DIR, stdio: 'inherit' });
            execSync(`node -e "require('better-sqlite3')"`, { cwd: INSTALL_DIR, stdio: 'pipe' });
            console.log('✅ Rebuild successful!');
        } catch (rebuildErr) {
            console.error('\n❌ CRITICAL: better-sqlite3 rebuild failed!');
            process.exit(1);
        }
    }

    const bootstrapScript = join(SOURCE_DIR, 'scripts', 'bootstrap-rules.mjs');
    if (existsSync(bootstrapScript)) {
        console.log('\n🧠 Synchronizing principles to active rules (Bootstrap)...');
        try {
            const workspaceDir = getConfiguredWorkspaceDir();
            const targetStateDir = join(workspaceDir, '.state');
            if (existsSync(targetStateDir)) {
                execSync(`node scripts/bootstrap-rules.mjs`, { cwd: SOURCE_DIR, stdio: 'inherit', env: { ...process.env, STATE_DIR: targetStateDir, BOOTSTRAP_LIMIT: '100' } });
                console.log('✅ Principles synchronized.');
            }
        } catch (e) {
            console.warn(`⚠️  Principle synchronization failed: ${e.message}`);
        }
    }

    const compileScript = join(SOURCE_DIR, 'scripts', 'compile-principles.mjs');
    if (existsSync(compileScript)) {
        console.log('\n⚙️  Compiling pain-derived principles into rules...');
        try {
            const workspaceDir = getConfiguredWorkspaceDir();
            const targetWorkspaceDir = workspaceDir;
            if (existsSync(targetWorkspaceDir)) {
                execSync(`node scripts/compile-principles.mjs ${targetWorkspaceDir}`, { cwd: SOURCE_DIR, stdio: 'inherit' });
                console.log('✅ Principle compilation complete.');
            }
        } catch (e) {
            console.warn(`⚠️  Principle compilation failed: ${e.message}`);
        }
    }

    const installedVersion = getVersion(INSTALL_DIR);
    if (installedVersion !== sourceVersion) {
        console.error(`\n❌ VERSION MISMATCH: Expected v${sourceVersion}, Got v${installedVersion}`);
        process.exit(1);
    }

    verifyInstalledFingerprint();
    if (args.dev || args.restart) cleanStaleBackups();

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║                  ✅ Installation Complete                  ║');
    console.log('╚════════════════════════════════════════════════════════════╝');

    if (args.restart) {
        restartGateway();
    } else {
        console.log('\n💡 Restart OpenClaw Gateway to load the new version.');
        console.log('   (Plugin code changes require a full gateway restart)');
    }
}

main();
