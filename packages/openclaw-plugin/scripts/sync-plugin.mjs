#!/usr/bin/env node

/**
 * Sync plugin files to OpenClaw installation directory.
 * This ensures that after building, all necessary files are copied
 * to the actual plugin location where OpenClaw Gateway loads them.
 */

import { copyFileSync, cpSync, existsSync, rmSync } from 'fs';
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

    if (!existsSync(INSTALL_DIR)) {
        console.error(`❌ Install directory not found: ${INSTALL_DIR}`);
        console.error('💡 Make sure OpenClaw is installed and the plugin directory exists.');
        process.exit(1);
    }

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

    console.log('');
    console.log('✅ Plugin synced successfully');
    console.log(`   Source: ${SOURCE_DIR}`);
    console.log(`   Target: ${INSTALL_DIR}`);
}

main();
