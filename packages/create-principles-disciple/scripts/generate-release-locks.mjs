#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const installerRoot = fileURLToPath(new URL('../', import.meta.url));
const lockRoot = join(installerRoot, 'release-locks');
const bundleScript = join(installerRoot, 'scripts', 'bundle-plugin.mjs');
const components = ['core', 'host-runtime', 'plugin', 'pd-cli', 'console', 'install-layout'];
const stagingRoot = mkdtempSync(join(tmpdir(), 'pd-generate-release-locks-'));
const npmCommand = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
const npmArgs = (args) => process.platform === 'win32' ? ['/d', '/s', '/c', ['npm', ...args].join(' ')] : args;

try {
  execFileSync(process.execPath, [bundleScript, '--prepare-release-locks', '--output-root', stagingRoot], { cwd: root, stdio: 'inherit' });
  cpSync(join(stagingRoot, 'core'), join(stagingRoot, 'plugin', 'core'), { recursive: true });
  for (const component of components) {
    const directory = join(stagingRoot, component);
    execFileSync(npmCommand, npmArgs([
      'install', '--package-lock-only', '--omit=dev', '--ignore-scripts', '--legacy-peer-deps', '--install-links',
    ]), { cwd: directory, stdio: 'inherit' });
    const lockPath = join(directory, 'package-lock.json');
    if (!existsSync(lockPath)) throw new Error(`npm did not generate a lock for ${component}`);
    const destination = join(lockRoot, component, 'package-lock.json');
    mkdirSync(join(lockRoot, component), { recursive: true });
    writeFileSync(destination, readFileSync(lockPath), { flag: 'w' });
  }
} finally {
  rmSync(stagingRoot, { recursive: true, force: true });
}
