#!/usr/bin/env node

/**
 * Post-install script to handle plugin dependencies.
 * This ensures that when the plugin is installed, all required
 * dependencies are available in the plugin's directory.
 */

const { execFileSync } = require('child_process');
const { existsSync } = require('fs');
const { join } = require('path');

const PLUGIN_DIR = join(__dirname, '..');
const DEPENDENCIES = [
  'micromatch@^4.0.8',
  '@sinclair/typebox@^0.34.48'
];

console.log('🔧 Setting up Principles Disciple plugin dependencies...');

// Check if we're in the plugin directory (has package.json)
const packageJsonPath = join(PLUGIN_DIR, 'package.json');
if (!existsSync(packageJsonPath)) {
  console.log('ℹ️  Not in plugin directory, skipping dependency setup');
  process.exit(0);
}

// Check if node_modules exists
const nodeModulesDir = join(PLUGIN_DIR, 'node_modules');
if (existsSync(nodeModulesDir)) {
  console.log('✅ Dependencies already installed');
  process.exit(0);
}

// Install dependencies
console.log('📦 Installing plugin dependencies...');
try {
  execFileSync('npm', ['install', ...DEPENDENCIES], {
    cwd: PLUGIN_DIR,
    stdio: 'inherit'
  });
  console.log('✅ Plugin dependencies installed successfully');
} catch (error) {
  console.error('❌ Failed to install plugin dependencies:', error.message);
  console.log('\n💡 Manual fix:');
  console.log('   cd', PLUGIN_DIR);
  console.log('   npm install', DEPENDENCIES.join(' '));
  process.exit(1);
}
