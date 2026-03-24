#!/usr/bin/env node

/**
 * Sync plugin files to OpenClaw installation directory.
 * This ensures that after building, all necessary files are copied
 * to the actual plugin location where OpenClaw Gateway loads them.
 */

import { copyFileSync, cpSync, existsSync, rmSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SOURCE_DIR = join(__dirname, '..');
const INSTALL_DIR = join(process.env.HOME, '.openclaw', 'extensions', 'principles-disciple');

// Files and directories to sync
const SYNC_ITEMS = [
    'dist',
    'templates',
    'agents',
    'scripts',
    'docs',
    'openclaw.plugin.json',
    'package.json',
];

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
 * Check if build is up-to-date
 */
function checkBuild() {
    const distDir = join(SOURCE_DIR, 'dist');
    if (!existsSync(distDir)) {
        console.error('❌ dist/ directory not found. Run `npm run build` first.');
        process.exit(1);
    }
    
    // Check if dist/index.js exists
    const indexJs = join(distDir, 'index.js');
    if (!existsSync(indexJs)) {
        console.error('❌ dist/index.js not found. Run `npm run build` first.');
        process.exit(1);
    }
}

function syncSkills() {
    // Determine language (default to zh)
    const lang = process.env.OPENCLAW_LANGUAGE || 'zh';
    const skillsSource = join(SOURCE_DIR, 'templates', 'langs', lang, 'skills');
    const skillsTarget = join(INSTALL_DIR, 'skills');

    if (!existsSync(skillsSource)) {
        console.log(`  ⚠️  Skills not found for language: ${lang}`);
        return;
    }

    // Remove existing skills
    if (existsSync(skillsTarget)) {
        rmSync(skillsTarget, { recursive: true, force: true });
    }

    // Copy skills
    cpSync(skillsSource, skillsTarget, { recursive: true });
    console.log(`  📄 skills (from templates/langs/${lang}/skills)`);
}

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

function main() {
    console.log('🔄 Syncing plugin to OpenClaw installation...');

    // Check build
    checkBuild();

    // Get source version
    const sourceVersion = getVersion(SOURCE_DIR);
    if (!sourceVersion) {
        console.error('❌ Cannot determine source version. Check package.json.');
        process.exit(1);
    }
    console.log(`📋 Source version: v${sourceVersion}`);

    // Check installed version (if exists)
    if (existsSync(INSTALL_DIR)) {
        const installedVersion = getVersion(INSTALL_DIR);
        if (installedVersion && installedVersion !== sourceVersion) {
            console.log(`⚠️  Installed version: v${installedVersion} (will be updated)`);
        }
    } else {
        console.error(`❌ Install directory not found: ${INSTALL_DIR}`);
        console.error('💡 Make sure OpenClaw is installed and the plugin directory exists.');
        process.exit(1);
    }

    console.log('');
    console.log('📦 Syncing items:');

    // Sync all items
    for (const item of SYNC_ITEMS) {
        syncItem(item);
    }

    // Sync skills separately
    syncSkills();

    // Install production dependencies (required for native modules like better-sqlite3)
    console.log('');
    console.log('📦 Installing production dependencies...');
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

    // Verify installation
    const installedVersion = getVersion(INSTALL_DIR);
    if (installedVersion !== sourceVersion) {
        console.error('');
        console.error('❌ VERSION MISMATCH after sync!');
        console.error(`   Expected: v${sourceVersion}`);
        console.error(`   Got: v${installedVersion}`);
        process.exit(1);
    }

    console.log('');
    console.log('✅ Plugin synced successfully');
    console.log(`   Version: v${sourceVersion}`);
    console.log(`   Source: ${SOURCE_DIR}`);
    console.log(`   Target: ${INSTALL_DIR}`);
    console.log('');
    console.log('💡 Restart OpenClaw Gateway to load the new version.');
}

main();
