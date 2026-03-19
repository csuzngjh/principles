#!/usr/bin/env node

const { execFileSync } = require('child_process');
const { existsSync, readFileSync } = require('fs');
const { join } = require('path');

const PLUGIN_DIR = join(__dirname, '..');

console.log('Setting up Principles Disciple plugin dependencies...');

const packageJsonPath = join(PLUGIN_DIR, 'package.json');
if (!existsSync(packageJsonPath)) {
  console.log('Not in plugin directory, skipping dependency setup');
  process.exit(0);
}

const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const dependencyNames = ['micromatch', '@sinclair/typebox', 'better-sqlite3'];
const DEPENDENCIES = dependencyNames.map((name) => {
  const version = packageJson.dependencies?.[name] || packageJson.devDependencies?.[name];
  if (!version) {
    throw new Error(`Missing dependency version in package.json for ${name}`);
  }
  return `${name}@${version}`;
});

const nodeModulesDir = join(PLUGIN_DIR, 'node_modules');
const betterSqliteDir = join(nodeModulesDir, 'better-sqlite3');
if (existsSync(nodeModulesDir) && existsSync(betterSqliteDir)) {
  console.log('Dependencies already installed');
  process.exit(0);
}

console.log('Installing plugin dependencies...');
try {
  execFileSync('npm', ['install', ...DEPENDENCIES], {
    cwd: PLUGIN_DIR,
    stdio: 'inherit',
  });
  console.log('Plugin dependencies installed successfully');
} catch (error) {
  console.error('Failed to install plugin dependencies:', error.message);
  console.log('\nManual fix:');
  console.log('  cd', PLUGIN_DIR);
  console.log('  npm install', DEPENDENCIES.join(' '));
  process.exit(1);
}
