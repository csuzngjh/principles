'use strict';
/**
 * Shell-free npm invocation for package-contract tests.
 *
 * npm is executed as `node <npm-cli.js> <args...>` where the CLI entry is
 * resolved from the running Node binary's standard install layout (never an
 * unvalidated env path, never cmd.exe string interpolation). This mirrors the
 * pattern of plugins/principles-disciple/scripts/pd-setup.cjs.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function resolveNpmCli() {
  const bundled = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(bundled)) return bundled;
  const fromEnv = process.env.npm_execpath;
  if (fromEnv && path.isAbsolute(fromEnv) && fs.existsSync(fromEnv)) return fromEnv;
  throw new Error('npm CLI entry not found (expected next to the Node binary or as an absolute npm_execpath)');
}

/** npm pack filenames are tooling-controlled; validate the shape before the
 * value is used as a positional (defense against a hostile toolchain). */
function packTarballPath(packDir, filename) {
  if (typeof filename !== 'string' || !/^[\w@][\w@/.-]*\.tgz$/.test(filename)) {
    throw new Error(`unexpected npm pack filename: ${String(filename).slice(0, 200)}`);
  }
  return path.join(packDir, filename);
}

function runNpm(args, options) {
  return execFileSync(process.execPath, [resolveNpmCli(), ...args], options);
}

module.exports = { packTarballPath, runNpm };
