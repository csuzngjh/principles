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

import { copyFileSync, cpSync, existsSync, rmSync, readFileSync, mkdirSync } from 'fs';
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
 * Check prerequisites
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
 * Build the plugin
 */
function buildPlugin() {
    console.log('\n🔨 Building plugin...');

    const distDir = join(SOURCE_DIR, 'dist');
    const indexJs = join(distDir, 'index.js');

    // Check if rebuild is needed
    if (existsSync(indexJs)) {
        const pkgJson = join(SOURCE_DIR, 'package.json');
        const srcDir = join(SOURCE_DIR, 'src');

        // Simple check: if dist is newer than src, skip
        try {
            const distTime = execSync(`stat -c %Y "${indexJs}"`, { encoding: 'utf-8' }).trim();
            const srcFiles = execSync(`find "${srcDir}" -name "*.ts" -exec stat -c %Y {} \\; | sort -rn | head -1`, { encoding: 'utf-8' }).trim();
            if (srcFiles && parseInt(distTime) > parseInt(srcFiles)) {
                console.log('✅ Build is up to date');
                return;
            }
        } catch {
            // Ignore stat errors, proceed with build
        }
    }

    try {
        execSync('npm run build:production', {
            cwd: SOURCE_DIR,
            stdio: 'inherit'
        });
        console.log('✅ Build complete');
    } catch (error) {
        console.error('❌ Build failed');
        process.exit(1);
    }
}

/**
 * Verify build exists
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
        console.error('⚠️  Failed to install dependencies. Run manually:');
        console.error(`   cd ${INSTALL_DIR} && npm install --production`);
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

    // Step 3: Build (if needed)
    if (!args.skipBuild) {
        buildPlugin();
    } else {
        verifyBuild();
    }

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

    // Step 8: Install production dependencies
    if (!args.skipDeps) {
        installTargetDependencies();
    }

    // Step 9: Verify installation
    const installedVersion = getVersion(INSTALL_DIR);
    if (installedVersion !== sourceVersion) {
        console.error('\n❌ VERSION MISMATCH after sync!');
        console.error(`   Expected: v${sourceVersion}`);
        console.error(`   Got: v${installedVersion}`);
        process.exit(1);
    }

    // Success!
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║                  ✅ Installation Complete                  ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log(`\n   Version:  v${sourceVersion}`);
    console.log(`   Language: ${args.lang}`);
    console.log(`   Source:   ${SOURCE_DIR}`);
    console.log(`   Target:   ${INSTALL_DIR}`);
    console.log('\n💡 Restart OpenClaw Gateway to load the new version.');
}

main();
