#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const installerRoot = fileURLToPath(new URL('../', import.meta.url));
const lockRoot = join(installerRoot, 'release-locks');
const bundleScript = join(installerRoot, 'scripts', 'bundle-plugin.mjs');
const components = ['core', 'host-runtime', 'plugin', 'pd-cli', 'console', 'install-layout', 'release-manager'];
const stagingRoot = mkdtempSync(join(tmpdir(), 'pd-generate-release-locks-'));

// Run npm through the running Node binary's own toolchain (same resolution as
// bundle-plugin.mjs). Resolving npm from PATH instead made lock SHAPE depend
// on the ambient environment: newer npm majors write file:-dependency records
// as `link: true` while older ones write expanded real records — and the
// runtime `npm ci --install-links` on the node22 CI jobs rejects the link
// form ("Missing: <pkg>@<ver> from lock file"). Generating with the same
// toolchain that consumes the locks keeps the byte shape installable by every
// supported major.
const nodeDir = dirname(process.execPath);
const prefixDir = dirname(nodeDir);
const npmCliJs = [
  join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  join(prefixDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  join(prefixDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
].find((candidate) => existsSync(candidate));
if (!npmCliJs) {
  throw new Error(`npm-cli.js not found near ${process.execPath} — run this script with a complete Node.js installation`);
}

try {
  execFileSync(process.execPath, [bundleScript, '--prepare-release-locks', '--output-root', stagingRoot], { cwd: root, stdio: 'inherit' });
  cpSync(join(stagingRoot, 'core'), join(stagingRoot, 'plugin', 'core'), { recursive: true });
  for (const component of components) {
    const directory = join(stagingRoot, component);
    execFileSync(process.execPath, [npmCliJs,
      'install', '--package-lock-only', '--omit=dev', '--ignore-scripts', '--legacy-peer-deps', '--install-links',
    ], { cwd: directory, stdio: 'inherit' });
    const lockPath = join(directory, 'package-lock.json');
    if (!existsSync(lockPath)) throw new Error(`npm did not generate a lock for ${component}`);
    const lockText = readFileSync(lockPath, 'utf8');
    // Fail loud on the link-form layout: it is what newer npm writes for
    // file:-deps and what the consuming `npm ci --install-links` under other
    // majors cannot materialize (see the Missing-js-yaml incident).
    if (lockText.includes('"link": true')) {
      throw new Error(
        `${component}: generated lock uses npm link-form records for file dependencies. `
        + 'Re-run this script with Node 22 (npm 10.x) so release locks keep the '
        + 'expanded record shape every supported major can install.',
      );
    }
    const destination = join(lockRoot, component, 'package-lock.json');
    mkdirSync(join(lockRoot, component), { recursive: true });
    writeFileSync(destination, lockText, { flag: 'w' });
  }
} finally {
  rmSync(stagingRoot, { recursive: true, force: true });
}
