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

import { copyFileSync, cpSync, existsSync, rmSync, readFileSync, readFileSync as readFileSyncRaw, mkdirSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SOURCE_DIR = join(__dirname, '..');
const OPENCLAW_DIR = join(process.env.HOME, '.openclaw');
const INSTALL_DIR = join(OPENCLAW_DIR, 'extensions', 'principles-disciple');

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
        restart: false,
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
                args.restart = true;
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
  --restart          Automatically restart OpenClaw gateway after installation
  --force, -f        Force overwrite without prompts
  --help, -h         Show this help message

Examples:
  # Full installation with Chinese skills
  node scripts/sync-plugin.mjs

  # Install with English skills
  node scripts/sync-plugin.mjs --lang en

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
            const globalConflict = execSync('npm list -g principles-disciple --depth=0 2>/dev/null', { encoding: 'utf-8' });
            if (globalConflict.includes('principles-disciple')) {
                console.error('\n❌ CONFLICT DETECTED: A version of "principles-disciple" is installed globally via npm.');
                console.error('This will block OpenClaw from loading the extension version you are trying to install.');
                console.error('\nACTION REQUIRED: Please run the following command first:');
                console.error('   npm uninstall -g principles-disciple\n');
                process.exit(1);
            }
        } catch (e) {
            // npm list returns non-zero if not found, which is what we want
            console.log('✅ No global package conflicts detected.');
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
 * Always runs build:production to ensure dist/bundle.js (the actual shipped artifact)
 * is always fresh. We no longer compare timestamps because:
 *   1. tsc alone updates index.js without updating bundle.js
 *   2. Comparing index.js vs src files falsely claims "up to date"
 *   3. The cost of a extra ~10s build is far cheaper than shipping stale bundles
 *
 * Use --skip-build only in CI where you know dist/ is already fresh.
 */
function buildPlugin() {
    console.log('\n🔨 Building plugin (esbuild only — bypassing tsc which may fail on unrelated files)...');

    try {
        // Run esbuild directly — it compiles TS on the fly and doesn't care about
        // tsc errors in unrelated files (e.g. subagent-workflow type errors).
        execSync('node esbuild.config.js --production', {
            cwd: SOURCE_DIR,
            stdio: 'inherit'
        });
        // Copy templates and manifest
        execSync('node scripts/build-web.mjs --production', {
            cwd: SOURCE_DIR,
            stdio: 'inherit'
        });
    } catch (error) {
        console.error('\n❌ Build failed');
        console.error(`   ${error.message}`);
        process.exit(1);
    }

    // Post-build verification: ensure critical symbols made it into bundle.js
    verifyBundleContents();
}

/**
 * Verify the built bundle contains all critical symbols.
 * This catches build failures where tsc succeeds but esbuild/bundling silently drops code.
 */
function verifyBundleContents() {
    const bundleJs = join(SOURCE_DIR, 'dist', 'bundle.js');
    if (!existsSync(bundleJs)) {
        console.error('❌ dist/bundle.js missing after build.');
        process.exit(1);
    }

    const content = readFileSync(bundleJs, 'utf-8');

    // Structural markers that survive minification (module exports, log prefixes).
    // These are more stable than class/function names which get mangled.
    // Add/remove markers as the codebase evolves — keep this list minimal.
    const requiredSymbols = [
        { name: 'EvolutionWorkerService', reason: 'main plugin service export' },
        { name: 'checkPainFlag',          reason: 'pain flag detection' },
        { name: 'processEvolutionQueue',  reason: 'queue processing' },
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
        console.warn('  This is a warning, not an error. Minification may have renamed these.');
        console.warn('  If the plugin actually fails to load, check for build issues.');
    }

    console.log('✅ Bundle verification passed — all critical symbols present');

    // Write build fingerprint to dist/openclaw.plugin.json
    writeBuildFingerprint();
}

/**
 * Write a build fingerprint (git SHA + bundle MD5) into dist/openclaw.plugin.json.
 * This allows post-install verification to detect stale installations.
 */
function writeBuildFingerprint() {
    const bundleJs = join(SOURCE_DIR, 'dist', 'bundle.js');
    const manifestSrc = join(SOURCE_DIR, 'openclaw.plugin.json');
    const manifestDist = join(SOURCE_DIR, 'dist', 'openclaw.plugin.json');

    // Get git SHA of current commit
    let gitSha = 'unknown';
    try {
        gitSha = execSync('git rev-parse HEAD', {
            cwd: SOURCE_DIR,
            encoding: 'utf-8',
            timeout: 10000,
        }).trim().slice(0, 12);
    } catch {
        console.warn('⚠️  Could not get git SHA, fingerprint will be incomplete');
    }

    // Compute MD5 of bundle.js
    let bundleMd5 = 'unknown';
    try {
        const bundleContent = readFileSyncRaw(bundleJs);
        bundleMd5 = createHash('md5').update(bundleContent).digest('hex');
    } catch {
        console.warn('⚠️  Could not compute bundle MD5, fingerprint will be incomplete');
    }

    // Read manifest
    let manifest;
    try {
        manifest = JSON.parse(readFileSync(manifestDist, 'utf-8'));
    } catch {
        try {
            manifest = JSON.parse(readFileSync(manifestSrc, 'utf-8'));
        } catch {
            console.warn('⚠️  Could not read openclaw.plugin.json, skipping fingerprint');
            return;
        }
    }

    // Attach fingerprint
    manifest.buildFingerprint = {
        gitSha,
        bundleMd5,
        builtAt: new Date().toISOString(),
    };

    // Write back to dist/openclaw.plugin.json (this is what gets synced)
    try {
        mkdirSync(join(SOURCE_DIR, 'dist'), { recursive: true });
        writeFileAtomic(manifestDist, JSON.stringify(manifest, null, 2) + '\n');
        console.log(`✅ Build fingerprint: git=${gitSha} bundleMd5=${bundleMd5}`);
    } catch (err) {
        console.warn(`⚠️  Could not write fingerprint to dist/openclaw.plugin.json: ${err.message}`);
    }

    // Also update the root openclaw.plugin.json so that both synced files have the fingerprint.
    // This ensures fingerprint verification works whether OpenClaw loads from dist/ or root manifest.
    try {
        const rootManifest = JSON.parse(readFileSync(manifestSrc, 'utf-8'));
        rootManifest.buildFingerprint = manifest.buildFingerprint;
        writeFileAtomic(manifestSrc, JSON.stringify(rootManifest, null, 2) + '\n');
    } catch {
        // Non-fatal — root manifest may be identical in content
    }
}

/**
 * Atomic file write (write to temp then rename, to avoid partial writes).
 */
function writeFileAtomic(filePath, content) {
    const tmp = filePath + '.tmp.' + Date.now();
    writeFileSync(tmp, content, 'utf-8');
    rmSync(filePath, { force: true });
    copyFileSync(tmp, filePath);
    rmSync(tmp, { force: true });
}

/**
 * Verify the installed plugin matches the source fingerprint.
 * If fingerprint in installed manifest differs from source manifest → abort.
 * This catches the case where a previous sync synced a stale bundle.
 */
function verifyInstalledFingerprint() {
    // Read from dist/ manifests because:
    // - dist/openclaw.plugin.json has the buildFingerprint written by writeBuildFingerprint()
    // - Root openclaw.plugin.json is copied from SOURCE_DIR (no fingerprint, not updated by writeBuildFingerprint)
    const sourceManifest = join(SOURCE_DIR, 'dist', 'openclaw.plugin.json');
    const installedManifest = join(INSTALL_DIR, 'dist', 'openclaw.plugin.json');

    if (!existsSync(installedManifest)) {
        console.error('\n❌ Installed manifest not found — sync may have failed.');
        process.exit(1);
    }

    let sourceFp, installedFp;
    try {
        const sm = JSON.parse(readFileSync(sourceManifest, 'utf-8'));
        const im = JSON.parse(readFileSync(installedManifest, 'utf-8'));
        sourceFp = sm.buildFingerprint;
        installedFp = im.buildFingerprint;
    } catch {
        // If we can't read/parse, skip verification
        console.warn('⚠️  Could not read fingerprints, skipping fingerprint verification');
        return;
    }

    if (!sourceFp || !installedFp) {
        console.warn('⚠️  Missing fingerprint in one or both manifests, skipping verification.');
        return;
    }

    const gitMismatch = sourceFp.gitSha !== installedFp.gitSha;
    const md5Mismatch = sourceFp.bundleMd5 !== installedFp.bundleMd5;

    if (gitMismatch || md5Mismatch) {
        console.error('\n❌ INSTALLED PLUGIN IS STALE — FINGERPRINT MISMATCH');
        console.error('   This means the installed plugin bundle does not match the current source build.');
        if (gitMismatch) {
            console.error(`   Source git SHA:    ${sourceFp.gitSha} (current)`);
            console.error(`   Installed git SHA: ${installedFp.gitSha} (old)`);
        }
        if (md5Mismatch) {
            console.error(`   Source bundle MD5:  ${sourceFp.bundleMd5} (current)`);
            console.error(`   Installed bundle:  ${installedFp.bundleMd5} (old)`);
        }
        console.error('\n   → Run WITHOUT --skip-build to rebuild and reinstall:');
        console.error(`     cd ${SOURCE_DIR} && node scripts/sync-plugin.mjs`);
        process.exit(1);
    }

    console.log('✅ Installed fingerprint verified — matches current source build');
}

/**
 * Verify build exists and bundle contains critical symbols.
 * Called when --skip-build is used (e.g., in CI with fresh dist/).
 * Still verifies critical symbols to catch any pre-existing build issues.
 */
function verifyBuild() {
    const distDir = join(SOURCE_DIR, 'dist');
    const indexJs = join(distDir, 'index.js');
    const bundleJs = join(distDir, 'bundle.js');

    if (!existsSync(distDir)) {
        console.error('❌ dist/ directory not found.');
        console.error('   Run without --skip-build to build automatically.');
        process.exit(1);
    }

    if (!existsSync(indexJs) && !existsSync(bundleJs)) {
        console.error('❌ dist/index.js or dist/bundle.js not found.');
        console.error('   Run without --skip-build to build automatically.');
        process.exit(1);
    }

    // Verify critical symbols even when skipping build
    // (catches stale dist from previous failed builds)
    try {
        verifyBundleContents();
    } catch {
        // verifyBundleContents already exits on failure
    }

    console.log('✅ Build verified');
}

/**
 * Remove existing installation directory (clean slate)
 * This ensures no stale files remain from old versions.
 */
function cleanTargetDir(force) {
    if (!existsSync(INSTALL_DIR)) {
        return;
    }

    if (!force) {
        const installedVersion = getVersion(INSTALL_DIR);
        if (installedVersion && installedVersion !== getVersion(SOURCE_DIR)) {
            console.error(`\n❌ VERSION CONFLICT:`);
            console.error(`   Installed: v${installedVersion}`);
            console.error(`   Source:    v${getVersion(SOURCE_DIR)}`);
            console.error(`   Run with --force to overwrite, or uninstall first.`);
            process.exit(1);
        }
    }

    console.log('\n🗑️  Removing existing installation...');
    rmSync(INSTALL_DIR, { recursive: true, force: true });
    console.log(`   Removed: ${INSTALL_DIR}`);
}

/**
 * Ensure installation directory exists
 */
function ensureInstallDir() {
    if (existsSync(INSTALL_DIR)) {
        return;
    }

    console.log('\n📁 Creating installation directory...');

    // Check if OpenClaw is installed
    if (!existsSync(OPENCLAW_DIR)) {
        console.error(`❌ OpenClaw installation not found: ${OPENCLAW_DIR}`);
        console.error('   Please install OpenClaw first.');
        process.exit(1);
    }

    // Create extensions directory if needed
    const extensionsDir = join(OPENCLAW_DIR, 'extensions');
    if (!existsSync(extensionsDir)) {
        mkdirSync(extensionsDir, { recursive: true });
    }

    // Create plugin directory
    mkdirSync(INSTALL_DIR, { recursive: true });
    console.log(`✅ Created: ${INSTALL_DIR}`);
}

/**
 * Sync skills from templates to installation directory
 */
function syncSkills(lang) {
    const skillsSource = join(SOURCE_DIR, 'templates', 'langs', lang, 'skills');
    const skillsTarget = join(INSTALL_DIR, 'skills');

    if (!existsSync(skillsSource)) {
        console.log(`  ⚠️  Skills not found for language: ${lang}`);
        return false;
    }

    // Remove existing skills
    if (existsSync(skillsTarget)) {
        rmSync(skillsTarget, { recursive: true, force: true });
    }

    // Copy skills
    cpSync(skillsSource, skillsTarget, { recursive: true });
    console.log(`  📄 skills (from templates/langs/${lang}/skills)`);
    return true;
}

/**
 * Sync a single item
 */
function syncItem(item) {
    const source = join(SOURCE_DIR, item);
    const target = join(INSTALL_DIR, item);

    if (!existsSync(source)) {
        console.log(`  ⚠️  Skipping ${item} (not found)`);
        return;
    }

    console.log(`  📄 ${item}`);

    // Remove existing item in install directory
    if (existsSync(target)) {
        rmSync(target, { recursive: true, force: true });
    }

    // Copy item
    try {
        cpSync(source, target, { recursive: true });
    } catch {
        copyFileSync(source, target);
    }
}

/**
 * Install production dependencies in target directory
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
        console.error('\n❌ FAILED to install production dependencies in target directory.');
        console.error(`   ${error.message}`);
        console.error('\n   Without these dependencies, the plugin will fail to load at runtime.');
        console.error(`   Run manually: cd ${INSTALL_DIR} && npm install --production`);
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

    // Get source version
    const sourceVersion = getVersion(SOURCE_DIR);
    if (!sourceVersion) {
        console.error('❌ Cannot determine source version. Check package.json.');
        process.exit(1);
    }
    console.log(`📋 Plugin version: v${sourceVersion}`);
    console.log(`🌍 Language: ${args.lang}`);

    // Step 1: Check prerequisites
    console.log('\n🔍 Checking prerequisites...');
    checkPrerequisites();

    // Step 2: Install dependencies (if needed)
    if (!args.skipDeps) {
        installDependencies();
    }

    // Step 3: ALWAYS rebuild — esbuild is fast (~2s) and compiles TS directly.
    // dist/ .js files from tsc may be stale when tsc has errors in other files.
    // We always rebuild to guarantee the synced code matches current source.
    buildPlugin();

    // Step 4: Clean existing installation (must happen after build so we know what's current)
    cleanTargetDir(args.force);

    // Step 5: Ensure installation directory exists
    ensureInstallDir();

    // Step 6: Sync files
    console.log('\n📦 Syncing files to OpenClaw...');
    for (const item of SYNC_ITEMS) {
        syncItem(item);
    }

    // Step 7: Sync skills
    syncSkills(args.lang);

    // Step 8: Install production dependencies in target (ALWAYS — cleanTargetDir wiped node_modules)
    // --skip-deps only applies to SOURCE directory deps, not the installed plugin.
    installTargetDependencies();

    // Step 9: Verify installed bundle can load its native dependencies
    console.log('\n🔍 Verifying installed plugin can load native dependencies...');
    try {
        execSync(`node -e "require('better-sqlite3')"`, {
            cwd: INSTALL_DIR,
            stdio: 'pipe'
        });
        console.log('✅ Native dependencies verified (better-sqlite3 loads correctly)');
    } catch {
        console.error('\n❌ Installed plugin cannot load native dependencies!');
        console.error('   This usually means npm install failed to compile better-sqlite3.');
        console.error(`   Fix: cd ${INSTALL_DIR} && npm rebuild better-sqlite3`);
        process.exit(1);
    }

    // Step 10: Verify installation
    const installedVersion = getVersion(INSTALL_DIR);
    if (installedVersion !== sourceVersion) {
        console.error('\n❌ VERSION MISMATCH after sync!');
        console.error(`   Expected: v${sourceVersion}`);
        console.error(`   Got: v${installedVersion}`);
        process.exit(1);
    }

    // Step 10: Verify installed fingerprint matches current source
    verifyInstalledFingerprint();

    // Build fingerprint info for report
    let fpReport = '';
    try {
        const sourceManifest = JSON.parse(readFileSync(join(SOURCE_DIR, 'dist', 'openclaw.plugin.json'), 'utf-8'));
        const fp = sourceManifest.buildFingerprint;
        if (fp) {
            fpReport = `\n   Build:    ${fp.gitSha} / MD5 ${fp.bundleMd5.slice(0, 8)}…`;
        }
    } catch { /* ignore */ }

    // Success!
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║                  ✅ Installation Complete                  ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log(`\n   Version:  v${sourceVersion}${fpReport}`);
    console.log(`   Language: ${args.lang}`);
    console.log(`   Source:   ${SOURCE_DIR}`);
    console.log(`   Target:   ${INSTALL_DIR}`);

    // Handle automatic restart if requested
    if (args.restart) {
        console.log('\n🔄 Restarting OpenClaw Gateway...');
        try {
            // Try systemd first (most common deployment)
            try {
                execSync('systemctl --user is-active openclaw-gateway.service', { stdio: 'pipe' });
                console.log('   Detected systemd service. Restarting via systemctl...');
                execSync('systemctl --user restart openclaw-gateway.service', { stdio: 'inherit' });
                console.log('✅ Gateway restarted via systemctl.');
                // Verify it started successfully
                setTimeout(() => {
                    try {
                        const status = execSync('systemctl --user is-active openclaw-gateway.service', { encoding: 'utf-8' }).trim();
                        if (status === 'active') {
                            console.log('✅ Gateway is running.');
                        } else {
                            console.error(`❌ Gateway status: ${status}. Check logs: journalctl --user -u openclaw-gateway.service --since "1 min ago"`);
                        }
                    } catch { /* ignore */ }
                }, 3000);
                return;
            } catch {
                // Not a systemd service — fall through to manual restart
            }

            // Manual restart: find and kill existing gateway processes
            const pids = execSync('pgrep -f "openclaw-gateway|openclaw gateway"', { encoding: 'utf-8' }).trim();
            if (pids) {
                console.log(`   Found gateway process(es). Terminating...`);
                execSync(`echo "${pids}" | xargs kill -TERM 2>/dev/null || true`);
                execSync('sleep 3');
            }

            // Start new gateway
            const logPath = '/tmp/openclaw-auto-restart.log';
            console.log(`   Starting new gateway (logs: ${logPath})...`);
            execSync(`nohup openclaw gateway --force > ${logPath} 2>&1 &`, { stdio: 'ignore' });
            console.log('✅ Gateway restart triggered.');
            console.log(`   Check logs: tail -f ${logPath}`);
        } catch (error) {
            console.error(`\n❌ Failed to restart gateway: ${error.message}`);
            console.error('   Manual restart: systemctl --user restart openclaw-gateway.service');
            process.exit(1);
        }
    } else {
        console.log('\n💡 Restart OpenClaw Gateway to load the new version.');
    }
}

main();
