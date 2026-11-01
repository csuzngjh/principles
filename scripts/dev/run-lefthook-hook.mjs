// PRI-962: path-independent git hook entry point.
//
// Every worktree shares one hooks directory (AGENTS.md git-10), so an installed
// hook must not embed a binary path captured from whichever worktree last ran
// `lefthook install`. This dispatcher resolves lefthook from the CURRENT
// worktree and runs it with that worktree's lefthook.yml.
//
// Usage (from an installed hook): node scripts/dev/run-lefthook-hook.mjs <hook> [args...]
//
// Compatibility:
//   LEFTHOOK=0        skip hooks (same meaning as lefthook's generated hook)
//   LEFTHOOK_BIN      explicit binary or .js entry point (takes precedence)
//   LEFTHOOK_VERBOSE  print the resolved binary/config on stderr
//   PD_HOOKS_TRACE    same trace without changing lefthook's own verbosity

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [hookName, ...hookArgs] = process.argv.slice(2);

function fail(message) {
  console.error('[pd-hooks] ' + message);
  process.exit(1);
}

if (!hookName) {
  console.error('[pd-hooks] usage: run-lefthook-hook.mjs <hook> [args...]');
  process.exit(2);
}

// Mirrors the LEFTHOOK=0 short-circuit in lefthook's generated hook.
if (process.env.LEFTHOOK === '0') process.exit(0);

const topResult = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' });
const top = topResult.status === 0 ? topResult.stdout.trim() : '';
if (!top) fail('cannot resolve the current worktree root (git rev-parse --show-toplevel failed)');

const isWindows = process.platform === 'win32';
const os = isWindows ? 'windows' : process.platform;
const platformPackage = 'lefthook-' + os + '-' + process.arch;
const ext = isWindows ? '.exe' : '';

// Same resolution order lefthook's own generated hook falls back to, scoped to
// the current worktree. A PATH/global lookup is deliberately absent: missing
// local dependencies must fail loudly instead of silently borrowing a binary
// from another worktree or from an unrelated global install.
const candidates = [
  path.join(top, 'node_modules', platformPackage, 'bin', 'lefthook' + ext),
  path.join(top, 'node_modules', '@evilmartians', 'lefthook', 'bin', platformPackage, 'lefthook' + ext),
  path.join(top, 'node_modules', '@evilmartians', 'lefthook-installer', 'bin', 'lefthook' + ext),
  path.join(top, 'node_modules', 'lefthook', 'bin', 'index.js'),
];

function resolveBinary() {
  const override = process.env.LEFTHOOK_BIN;
  if (override && override.length > 0) {
    if (!fs.existsSync(override)) {
      fail('LEFTHOOK_BIN points to a path that does not exist: ' + override);
    }
    return override;
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const binary = resolveBinary();
if (!binary) {
  fail(
    'lefthook is not installed in this worktree (' + top + ').\n' +
      'Each worktree installs its own dependencies (AGENTS.md git-13).\n' +
      'Fix: run `npm run dev:worktree:bootstrap` (or `npm install`) in ' + top + '\n' +
      'Refusing to skip the ' + hookName + ' hook silently. ' +
      'Set LEFTHOOK_BIN to use a specific binary, or LEFTHOOK=0 to skip intentionally.'
  );
}

const isJsEntry = path.extname(binary).toLowerCase() === '.js';
const command = isJsEntry ? process.execPath : binary;
const args = isJsEntry ? [binary, 'run', hookName, ...hookArgs] : ['run', hookName, ...hookArgs];

const isOn = (value) => value === '1' || value === 'true';
if (isOn(process.env.LEFTHOOK_VERBOSE) || isOn(process.env.PD_HOOKS_TRACE)) {
  console.error('[pd-hooks] ' + hookName + ' -> ' + binary);
  const config = path.join(top, 'lefthook.yml');
  if (fs.existsSync(config)) console.error('[pd-hooks] config -> ' + config);
}

const result = spawnSync(command, args, { cwd: top, stdio: 'inherit', env: process.env });
if (result.error) fail('failed to run lefthook (' + binary + '): ' + result.error.message);
process.exit(result.status === null ? 1 : result.status);
