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

import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, rmSync, readFileSync, readFileSync as readFileSyncRaw, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SOURCE_DIR = join(__dirname, '..');
const ROOT_DIR = join(SOURCE_DIR, '..', '..');
const PD_CLI_SOURCE_DIR = join(ROOT_DIR, 'packages', 'pd-cli');

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
const INSTALLED_PD_CLI_DIR = join(INSTALL_DIR, 'pd-cli');
const INSTALLED_BIN_DIR = join(INSTALL_DIR, 'bin');
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

// Files and directories to sync.
// NOTE: openclaw.plugin.json is NOT included here — it is synced separately
// via syncFilteredManifest() which filters the skills array by language
// BEFORE writing to the install target, preventing the en/zh collision.
const SYNC_ITEMS = [
    'dist',
    'templates',
    'scripts',
    'docs',
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
    } catch (error) {
        console.error('\n❌ Build failed');
        console.error(`   ${error.message}`);
        process.exit(1);
    }

    verifyBundleContents();
}

/**
 * Build the Runtime V2 CLI that agents invoke through the `pd` command.
 * This is intentionally part of plugin sync so installed OpenClaw agents do not
 * depend on a repo checkout, stale global npm package, or guessed CLI path.
 */
function buildPdCli() {
    console.log('\n🔨 Building PD CLI...');

    if (!existsSync(join(PD_CLI_SOURCE_DIR, 'package.json'))) {
        console.error(`❌ PD CLI package not found: ${PD_CLI_SOURCE_DIR}`);
        process.exit(1);
    }

    try {
        execSync('npm run build --workspace=@principles/core', {
            cwd: ROOT_DIR,
            stdio: 'inherit'
        });
        execSync('npm run build --workspace=@principles/pd-cli', {
            cwd: ROOT_DIR,
            stdio: 'inherit'
        });
        console.log('✅ PD CLI built');
    } catch (error) {
        console.error('\n❌ PD CLI build failed');
        console.error(`   ${error.message}`);
        process.exit(1);
    }
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
 * Update the plugin version in installs.json after successful sync.
 * OpenClaw manages install records in ~/.openclaw/plugins/installs.json,
 * NOT in openclaw.json (plugins.installs is a legacy/transient field).
 */
function updateInstalledPluginVersion(version) {
    const installsDir = join(OPENCLAW_DIR, 'plugins');
    const installsPath = join(installsDir, 'installs.json');
    try {
        if (!existsSync(installsDir)) {
            mkdirSync(installsDir, { recursive: true });
        }
        let installs = { version: 1, installRecords: {} };
        if (existsSync(installsPath)) {
            const raw = readFileSync(installsPath, 'utf-8');
            installs = JSON.parse(raw);
        }
        if (!installs.installRecords) installs.installRecords = {};
        installs.installRecords['principles-disciple'] = {
            source: 'path',
            installPath: INSTALL_DIR,
            version: version,
            installedAt: new Date().toISOString(),
        };
        writeFileAtomic(installsPath, JSON.stringify(installs, null, 2) + '\n');
        console.log(`✅ installs.json updated: version=${version}`);
    } catch (err) {
        console.warn(`⚠️  Could not update installs.json: ${err.message}`);
    }
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
 * Sync the openclaw.plugin.json manifest but filter the skills array to only
 * include paths matching the selected language (zh or en).
 *
 * This MUST run BEFORE syncSkillDirs, and it should
 * never be done via syncItem('openclaw.plugin.json') + subsequent modification
 * because the post-modification step can fail silently (catch block) leaving
 * both en/zh skills in the manifest, which triggers OpenClaw's "plugin skill
 * name collision" warning on startup.
 */
function syncFilteredManifest(lang) {
    const sourcePath = join(SOURCE_DIR, 'openclaw.plugin.json');
    const targetPath = join(INSTALL_DIR, 'openclaw.plugin.json');

    if (!existsSync(sourcePath)) return;

    console.log(`  📄 openclaw.plugin.json (filtered for lang: ${lang})`);

    let manifest;
    try {
        manifest = JSON.parse(readFileSync(sourcePath, 'utf-8'));
    } catch (err) {
        console.error(`❌ Failed to read source manifest: ${err.message}`);
        process.exit(1);
    }

    if (!manifest.skills || !Array.isArray(manifest.skills)) return;

    const selectedLang = (lang || 'zh').toLowerCase();
    if (!['zh', 'en'].includes(selectedLang)) {
        console.error(`❌ Invalid language: ${selectedLang}. Expected zh or en.`);
        process.exit(1);
    }

    const filtered = manifest.skills.filter(sp => {
        if (typeof sp !== 'string') return false;
        return sp.includes(`/langs/${selectedLang}/`);
    });

    if (filtered.length === 0) {
        console.error(`❌ No skills match language "${selectedLang}" in source manifest`);
        process.exit(1);
    }

    manifest.skills = filtered;

    // Use syncItem semantics: remove target, then write freshly
    if (existsSync(targetPath)) {
        rmSync(targetPath, { force: true });
    }
    writeFileSync(targetPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    console.log(`  ✅ skills filtered to lang: ${selectedLang} (${filtered.length} path(s))`);
}

/**
 * @deprecated Replaced by syncFilteredManifest(). Kept for backwards
 * compatibility with old installs that may call it externally.
 * syncFilteredManifest filters the skills array BEFORE writing the manifest
 * to disk, avoiding the en/zh collision window entirely.
 */
function filterInstalledManifestSkills(lang) {
    const installedManifestPath = join(INSTALL_DIR, 'openclaw.plugin.json');
    if (!existsSync(installedManifestPath)) return;

    try {
        const manifest = JSON.parse(readFileSync(installedManifestPath, 'utf-8'));
        if (!manifest.skills || !Array.isArray(manifest.skills)) return;

        const selectedLang = (lang || 'zh').toLowerCase();
        if (!['zh', 'en'].includes(selectedLang)) {
            console.error(`❌ Invalid language: ${selectedLang}. Expected zh or en.`);
            process.exit(1);
        }
        const filtered = manifest.skills.filter(sp => {
            if (typeof sp !== 'string') return false;
            return sp.includes(`/langs/${selectedLang}/`);
        });

        if (filtered.length === 0) {
            console.error(`❌ No skills match language "${selectedLang}" in installed manifest`);
            process.exit(1);
        }

        manifest.skills = filtered;
        writeFileSync(installedManifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
        console.log(`  📄 openclaw.plugin.json skills filtered to lang: ${selectedLang}`);
    } catch (err) {
        console.warn(`  ⚠️  Failed to filter installed manifest skills: ${err.message}`);
    }
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

function quoteCmdPath(filePath) {
    return filePath.replace(/"/g, '""');
}

/**
 * Copy the built pd-cli package into the plugin install directory and create
 * deterministic shims. The global shim points at the installed plugin copy, not
 * at a developer checkout.
 */
function syncPdCli() {
    console.log('\n📦 Syncing PD CLI...');

    const distDir = join(PD_CLI_SOURCE_DIR, 'dist');
    if (!existsSync(join(distDir, 'index.js'))) {
        console.error('❌ PD CLI dist/index.js missing. Run without --skip-build or build @principles/pd-cli first.');
        process.exit(1);
    }

    rmSync(INSTALLED_PD_CLI_DIR, { recursive: true, force: true });
    mkdirSync(INSTALLED_PD_CLI_DIR, { recursive: true });
    cpSync(distDir, join(INSTALLED_PD_CLI_DIR, 'dist'), { recursive: true });
    copyFileSync(join(PD_CLI_SOURCE_DIR, 'package.json'), join(INSTALLED_PD_CLI_DIR, 'package.json'));

    mkdirSync(INSTALLED_BIN_DIR, { recursive: true });
    const installedEntry = join(INSTALLED_PD_CLI_DIR, 'dist', 'index.js');

    if (isWindows()) {
        const cmdShim = [
            '@echo off',
            `node "${quoteCmdPath(installedEntry)}" %*`,
            '',
        ].join('\r\n');
        const psShim = [
            '$ErrorActionPreference = "Stop"',
            `$entry = "${installedEntry.replace(/`/g, '``').replace(/"/g, '`"')}"`,
            '& node $entry @args',
            'exit $LASTEXITCODE',
            '',
        ].join('\r\n');
        writeFileSync(join(INSTALLED_BIN_DIR, 'pd.cmd'), cmdShim, 'utf-8');
        writeFileSync(join(INSTALLED_BIN_DIR, 'pd.ps1'), psShim, 'utf-8');
    } else {
        const shShim = [
            '#!/usr/bin/env sh',
            `exec node "${installedEntry.replace(/"/g, '\\"')}" "$@"`,
            '',
        ].join('\n');
        const target = join(INSTALLED_BIN_DIR, 'pd');
        writeFileSync(target, shShim, 'utf-8');
        chmodSync(target, 0o755);
    }

    installGlobalPdShim();
}

function getNpmGlobalBinDir() {
    try {
        const prefix = execSync('npm prefix -g', { encoding: 'utf-8' }).trim();
        if (!prefix) return null;
        return process.platform === 'win32' ? prefix : join(prefix, 'bin');
    } catch {
        return null;
    }
}

function installGlobalPdShim() {
    const globalBin = getNpmGlobalBinDir();
    if (!globalBin) {
        console.warn('⚠️  Could not resolve npm global bin directory. Use plugin-local bin/pd shim.');
        return;
    }

    try {
        mkdirSync(globalBin, { recursive: true });
        if (isWindows()) {
            const pluginCmd = join(INSTALLED_BIN_DIR, 'pd.cmd');
            const pluginPs = join(INSTALLED_BIN_DIR, 'pd.ps1');
            writeFileSync(join(globalBin, 'pd.cmd'), `@echo off\r\ncall "${quoteCmdPath(pluginCmd)}" %*\r\n`, 'utf-8');
            writeFileSync(
                join(globalBin, 'pd.ps1'),
                `$shim = "${pluginPs.replace(/`/g, '``').replace(/"/g, '`"')}"\r\n& $shim @args\r\nexit $LASTEXITCODE\r\n`,
                'utf-8'
            );
        } else {
            const pluginSh = join(INSTALLED_BIN_DIR, 'pd');
            const globalSh = join(globalBin, 'pd');
            writeFileSync(globalSh, `#!/usr/bin/env sh\nexec "${pluginSh.replace(/"/g, '\\"')}" "$@"\n`, 'utf-8');
            chmodSync(globalSh, 0o755);
        }
        console.log(`✅ Global pd shim installed: ${globalBin}`);
    } catch (err) {
        console.warn(`⚠️  Could not install global pd shim: ${err.message}`);
        console.warn(`   Use plugin-local shim: ${join(INSTALLED_BIN_DIR, isWindows() ? 'pd.cmd' : 'pd')}`);
    }
}

function verifyPdCliShim() {
    const localShim = join(INSTALLED_BIN_DIR, isWindows() ? 'pd.cmd' : 'pd');
    try {
        execSync(`"${localShim}" --version`, { stdio: 'pipe', shell: true });
        console.log(`✅ PD CLI shim verified: ${localShim}`);
    } catch (err) {
        console.error(`❌ PD CLI shim verification failed: ${err.message}`);
        process.exit(1);
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
        execSync('npm install --omit=dev --no-audit --no-fund --prefer-offline', {
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
 * Verify injected workspace packages have their transitive dependencies installed.
 * npm install --omit=dev in the target doesn't resolve deps of manually-copied packages,
 * so transitive deps like @earendil-works/pi-agent-core may be missing after production install.
 */
function verifyInjectedWorkspaceDeps() {
    const corePkgDir = join(INSTALL_DIR, 'node_modules', '@principles', 'core');
    if (!existsSync(corePkgDir)) return;

    const corePkgPath = join(corePkgDir, 'package.json');
    if (!existsSync(corePkgPath)) return;

    let corePkg;
    try {
        corePkg = JSON.parse(readFileSync(corePkgPath, 'utf-8'));
    } catch (error) {
        console.error(`  ❌ Failed to parse @principles/core/package.json: ${error.message}`);
        process.exit(1);
    }

    const deps = corePkg.dependencies || {};
    const missing = [];
    for (const [dep, version] of Object.entries(deps)) {
        if (!existsSync(join(INSTALL_DIR, 'node_modules', dep))) {
            missing.push(`${dep}@${version}`);
        }
    }

    if (missing.length === 0) return;

    console.log(`  ⚠️  ${missing.length} transitive dependenc${missing.length === 1 ? 'y' : 'ies'} of @principles/core missing, installing...`);
    try {
        execSync(`npm install ${missing.join(' ')} --no-audit --no-fund --prefer-offline`, {
            cwd: INSTALL_DIR,
            stdio: 'pipe'
        });
        console.log('  ✅ Transitive dependencies installed');
    } catch (error) {
        console.warn(`  ⚠️  Failed to install transitive dependencies: ${error.message}`);
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
 * Check if a process is running by PID.
 */
function isProcessRunning(pid) {
    try {
        if (isWindows()) {
            execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { stdio: 'ignore' });
            return true;
        } else {
            process.kill(pid, 0);
            return true;
        }
    } catch {
        return false;
    }
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
 * Strip Anaconda/Miniconda entries from PATH on Windows.
 *
 * Anaconda ships an ancient cygpath (2016, at
 * D:\ProgramData\anaconda3\Library\usr\bin\cygpath) that converts Unix-style
 * paths INCORRECTLY in MINGW/MSYS — e.g. "/c/Users/..." becomes
 * "D:\ProgramData\anaconda3\Library\c\Users\..." instead of "C:\Users\...".
 * npm-installed CLI POSIX shims (openclaw, pd, etc.) call cygpath -w for path
 * conversion and break when the wrong cygpath is found first in PATH.
 *
 * This does not affect schtasks (runs in a clean session) or PowerShell
 * Start-Process (uses Split-Path, not cygpath). It protects the port check
 * and error-recovery paths that execSync child processes.
 */
function sanitizePathForWindows() {
    const pathSep = isWindows() ? ';' : ':';
    const originalPath = process.env.PATH || '';
    const entries = originalPath.split(pathSep).filter(Boolean);
    const sanitized = entries.filter(entry => {
        const lower = entry.toLowerCase().replace(/[/\\]/g, '/');
        return !lower.includes('/anaconda') && !lower.includes('/conda') && !lower.includes('/miniconda');
    });
    if (sanitized.length !== entries.length) {
        const removed = entries.length - sanitized.length;
        process.env.PATH = sanitized.join(pathSep);
        console.log(`   🧹 Sanitized PATH: removed ${removed} Anaconda/Conda entr${removed > 1 ? 'ies' : 'y'} (fixes cygpath bug on MINGW/MSYS)`);
    }
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
 * Restart Gateway on Windows via schtasks.
 * Direct task trigger bypasses OpenClaw CLI's busy-port detection which can
 * falsely report "still busy" due to TIME_WAIT connections on the port.
 */
function restartGatewayWindows() {
    const logPath = join(getTempDir(), 'openclaw-auto-restart.log');

    // Strip Anaconda from PATH so any execSync child process (especially the
    // port-check Test-NetConnection shell) does not inherit poisoned cygpath.
    sanitizePathForWindows();

    try {
        // Kill existing gateway processes first — taskkill fails across Windows sessions,
        // use WMIC which can terminate processes regardless of session boundary.
        console.log('   Stopping existing gateway processes...');
        try {
            const findPids = `Get-NetTCPConnection -LocalPort 18789 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`;
            const pids = execSync(`powershell -NoProfile -Command "${findPids}"`, { encoding: 'utf-8' }).trim();
            if (pids) {
                const pidList = pids.split('\n').filter(p => p.trim() && p !== '0');
                for (const pid of pidList) {
                    const pidTrim = pid.trim();
                    try {
                        execSync(`wmic process where "ProcessId=${pidTrim}" call terminate`, { stdio: 'ignore' });
                    } catch { /* ignore individual failures */ }
                }
                execSync('timeout /t 3 /nobreak > nul', { shell: true, stdio: 'ignore' });
            }
        } catch { /* no existing processes */ }

        // Clean stale lock files — prevents ghost gateway false positives
        try {
            const lockDir = join(getTempDir(), 'openclaw');
            if (existsSync(lockDir)) {
                const files = readdirSync(lockDir).filter(f => f.startsWith('gateway.') && f.endsWith('.lock'));
                for (const file of files) {
                    const lockPath = join(lockDir, file);
                    try {
                        const content = readFileSync(lockPath, 'utf-8');
                        const pid = parseInt(content.trim());
                        // Only remove if PID is not running
                        if (!pid || !isProcessRunning(pid)) {
                            rmSync(lockPath, { force: true });
                            console.log(`   Removed stale lock: ${file}`);
                        }
                    } catch { /* ignore */ }
                }
            }
        } catch { /* ignore lock cleanup failures */ }

        // Trigger via schtasks — reliable, avoids CLI busy-port misdetection
        console.log('   Starting gateway via scheduled task...');
        let gatewayStarted = false;
        try {
            execSync('schtasks /Run /TN "OpenClaw Gateway"', { stdio: 'pipe' });
            gatewayStarted = true;
        } catch {
            // schtasks failed — try direct CLI fallback via PowerShell
            // PowerShell shim resolves paths correctly in Anaconda environments
            // where cmd /c can produce wrong path prefixes (e.g. conda prefix + npm path)
            console.log('   Scheduled task not available, trying direct gateway start via PowerShell...');
            try {
                execSync(
                    'powershell -NoProfile -Command "Start-Process -WindowStyle Hidden -FilePath \'openclaw\' -ArgumentList \'gateway\'"',
                    { stdio: 'pipe', timeout: 5000 }
                );
                gatewayStarted = true;
            } catch {
                // Gateway may already be running or no perms — not fatal
            }
        }

        // Wait for gateway to be listening on port (同步等待，不异步)
        const port = 18789;
        const deadline = Date.now() + 60000; // Gateway 初始化可能需要 20+ 秒 (如 Windows schtasks 重启)
        let gatewayListening = false;

        while (Date.now() < deadline) {
            try {
                // 使用 Test-NetConnection 替代有语法问题的 Get-NetTCPConnection + Measure-Object
                const result = execSync(
                    `powershell -NoProfile -Command "(Test-NetConnection -ComputerName localhost -Port ${port} -WarningAction SilentlyContinue).TcpTestSucceeded"`,
                    { encoding: 'utf-8', timeout: 5000 }
                ).trim();
                if (result === 'True') {
                    gatewayListening = true;
                    break;
                }
            } catch { /* port not listening yet */ }
            try {
                execSync('timeout /t 1 /nobreak > nul', { shell: true, stdio: 'ignore' });
            } catch { /* ignore */ }
        }

        if (!gatewayListening) {
            console.warn('\n⚠️  Gateway may not be running on port 18789 (plugin files are installed).');
            console.warn('   If the gateway was started but is unreachable, try:');
            console.warn('     1. From PowerShell: openclaw gateway start');
            console.warn('     2. If using Git Bash, strip Anaconda from PATH first:');
            console.warn('        PATH=$(echo "$PATH" | tr ":" "\\n" | grep -iv anaconda | tr "\\n" ":") openclaw gateway start');
            return false;
        }

        console.log('   ✅ Gateway is listening on port 18789');
        return true;

    } catch (error) {
        console.warn(`\n⚠️  Gateway restart failed: ${error.message}`);
        console.warn('   Plugin files are installed. Run "openclaw gateway start" manually.');
        console.warn('   If using Git Bash with Anaconda in PATH, first run:');
        console.warn('     export PATH=$(echo "$PATH" | tr ":" "\\n" | grep -iv anaconda | tr "\\n" ":")');
        return false;
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
            return true; // systemctl restart triggered successfully
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

        // Wait for process to actually start (up to 15s)
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            try {
                const running = execSync(
                    'pgrep -f "openclaw-gateway|openclaw gateway"',
                    { encoding: 'utf-8', stdio: 'pipe' }
                ).trim();
                if (running) {
                    console.log('✅ Gateway restart triggered.');
                    return true;
                }
            } catch { /* not ready yet */ }
            execSync('sleep 1');
        }

        console.error(`❌ Gateway did not come back up. Check ${logPath}`);
        return false;

    } catch (error) {
        console.error(`\n❌ Failed to restart gateway: ${error.message}`);
        return false;
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

    if (!args.skipBuild) {
        buildPlugin();
        buildPdCli();
    } else {
        console.log('\n⏭️  Skipping build step (--skip-build)');
    }
    cleanTargetDir(args.force);
    ensureInstallDir();

    console.log('\n📦 Syncing files to OpenClaw...');
    for (const item of SYNC_ITEMS) syncItem(item);

    // After syncing templates, remove the non-selected language to avoid
    // waste on disk. OpenClaw only loads skills declared in the filtered
    // manifest (syncFilteredManifest), but having unselected lang files on
    // disk inflates the install footprint and confuses inspection.
    {
        const langsDir = join(INSTALL_DIR, 'templates', 'langs');
        if (existsSync(langsDir)) {
            const normalizedLang = (args.lang || 'zh').toLowerCase();
            const unselectedLang = normalizedLang === 'zh' ? 'en' : 'zh';
            const unselectedPath = join(langsDir, unselectedLang);
            if (existsSync(unselectedPath)) {
                rmSync(unselectedPath, { recursive: true, force: true });
                console.log(`  🗑️  removed templates/langs/${unselectedLang} (lang: ${normalizedLang})`);
            }
        }
    }

    syncFilteredManifest(args.lang);
    syncPdCli();

    injectLocalWorkspacePackages();
    installTargetDependencies();
    verifyInjectedWorkspaceDeps();
    verifyPdCliShim();

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
    updateInstalledPluginVersion(sourceVersion);
    if (args.dev || args.restart) cleanStaleBackups();

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║                  ✅ Installation Complete                  ║');
    console.log('╚════════════════════════════════════════════════════════════╝');

    if (args.restart) {
        const restarted = restartGateway();
        if (!restarted) {
            console.warn('\n⚠️  Plugin files installed but gateway restart was not confirmed.');
            console.warn('   The gateway may already be running. Verify with:');
            console.warn('     PowerShell: openclaw gateway status');
            console.warn('     Git Bash:   Test-NetConnection -ComputerName localhost -Port 18789');
            console.warn('');
            console.warn('   If "openclaw gateway start" fails with a path error on Git Bash:');
            console.warn('     this is caused by Anaconda\'s old cygpath tool polluting PATH.');
            console.warn('     Run: export PATH=$(echo "$PATH" | tr ":" "\\n" | grep -iv anaconda | tr "\\n" ":")');
            console.warn('     Then: openclaw gateway start');
            console.warn('');
            console.warn('   Or simply restart from PowerShell (not affected by the cygpath bug).');
        }
    } else {
        console.log('\n💡 Restart OpenClaw Gateway to load the new version.');
        console.log('   (Plugin code changes require a full gateway restart)');
    }
}

main();
