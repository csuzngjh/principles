import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// npm runs through a shell-free helper (tests/helpers/run-npm.cjs): every
// argument stays positional (`node <npm-cli.js> args...>`), pack filenames are
// shape-validated before use, and dynamic positionals always sit AFTER the
// `--` terminator at the call sites below.
const nodeRequire = createRequire(import.meta.url);
const { packTarballPath, runNpm } = nodeRequire('./helpers/run-npm.cjs') as {
  packTarballPath: (packDir: string, filename: unknown) => string;
  runNpm: (args: string[], options: Parameters<typeof execFileSync>[2]) => string;
};
let tempDir = '';

describe('published @principles/codex-adapter bundle safety', () => {
  beforeAll(() => {
    // The adapter depends on @principles/core and @principles/host-runtime.
    // For clean-install verification we pack the adapter tarball and install
    // it into an isolated consumer dir with a local file: resolver for its
    // workspace dependencies. This proves the tarball is self-contained
    // for the published dependency range and does not pull in openclaw-plugin.
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.dependencies).not.toHaveProperty('principles-disciple');
    expect(manifest.dependencies).not.toHaveProperty('@principles/openclaw-plugin');

    runNpm(['run', 'build'], { cwd: packageRoot, stdio: 'pipe' });
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pack-codex-adapter-'));
    // `--` before the package spec: the dynamic directory can never parse as
    // an npm option; the tarball lands in cwd (tempDir).
    const packOutput = runNpm(['pack', '--json', '--', packageRoot], {
      cwd: tempDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const packed: unknown = JSON.parse(packOutput);
    if (!Array.isArray(packed) || !packed[0] || typeof packed[0] !== 'object' || !Object.hasOwn(packed[0], 'filename')) {
      throw new Error(`npm pack returned an unexpected result: ${packOutput.slice(0, 500)}`);
    }
    const adapterTarball = packTarballPath(tempDir, (packed[0] as Record<string, unknown>).filename);

    const consumerDir = path.join(tempDir, 'consumer');
    fs.mkdirSync(consumerDir);
    fs.writeFileSync(
      path.join(consumerDir, 'package.json'),
      JSON.stringify({ private: true, type: 'module' }),
    );

    // Install the packed tarball. @principles/core is on npm; @principles/host-runtime
    // may not yet be published at PR2 time, so install the packed host-runtime
    // tarball first when the registry lookup would fail. We attempt the normal
    // install and accept a fallback that points the consumer at a packed
    // host-runtime tarball produced from the same worktree.
    const hostRuntimeDir = path.resolve(packageRoot, '../host-runtime');
    const hostRuntimePackDir = path.join(tempDir, 'host-runtime-pack');
    fs.mkdirSync(hostRuntimePackDir);
    const hrPackOutput = runNpm(['pack', '--json', '--', hostRuntimeDir], {
      cwd: hostRuntimePackDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const hrPacked: unknown = JSON.parse(hrPackOutput);
    if (!Array.isArray(hrPacked) || !hrPacked[0] || typeof hrPacked[0] !== 'object' || !Object.hasOwn(hrPacked[0], 'filename')) {
      throw new Error(`npm pack host-runtime returned an unexpected result: ${hrPackOutput.slice(0, 500)}`);
    }
    const hostRuntimeTarball = packTarballPath(hostRuntimePackDir, (hrPacked[0] as Record<string, unknown>).filename);

    // host-runtime depends on @principles/install-layout at runtime; pack it
    // too so the standalone install resolves offline.
    const installLayoutDir = path.resolve(packageRoot, '../install-layout');
    const installLayoutPackDir = path.join(tempDir, 'install-layout-pack');
    fs.mkdirSync(installLayoutPackDir);
    const ilPackOutput = runNpm(['pack', '--json', '--', installLayoutDir], {
      cwd: installLayoutPackDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ilPacked: unknown = JSON.parse(ilPackOutput);
    if (!Array.isArray(ilPacked) || !ilPacked[0] || typeof ilPacked[0] !== 'object' || !Object.hasOwn(ilPacked[0], 'filename')) {
      throw new Error(`npm pack install-layout returned an unexpected result: ${ilPackOutput.slice(0, 500)}`);
    }
    const installLayoutTarball = packTarballPath(installLayoutPackDir, (ilPacked[0] as Record<string, unknown>).filename);

    // host-runtime's telemetry modules import new @principles/core/runtime-v2
    // exports that the npm-registry core may not yet carry; pack core from the
    // worktree too so the standalone consumer resolves the same code the repo
    // tests against (same fallback pattern as host-runtime above).
    const coreDir = path.resolve(packageRoot, '../principles-core');
    const corePackDir = path.join(tempDir, 'core-pack');
    fs.mkdirSync(corePackDir);
    const corePackOutput = runNpm(['pack', '--json', '--', coreDir], {
      cwd: corePackDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const corePacked: unknown = JSON.parse(corePackOutput);
    if (!Array.isArray(corePacked) || !corePacked[0] || typeof corePacked[0] !== 'object' || !Object.hasOwn(corePacked[0], 'filename')) {
      throw new Error(`npm pack core returned an unexpected result: ${corePackOutput.slice(0, 500)}`);
    }
    const coreTarball = packTarballPath(corePackDir, (corePacked[0] as Record<string, unknown>).filename);

    runNpm(
      ['install', '--ignore-scripts', '--omit=optional', '--no-package-lock', '--', adapterTarball, hostRuntimeTarball, installLayoutTarball, coreTarball],
      // Registry-latency headroom (PRI-634-F CI): the 2026-09-04 slow window
      // pushed this 4-tarball install past 420s as well.
      { cwd: consumerDir, stdio: 'pipe', timeout: 900_000 },
    );

    // The packed tarball must ship the built hook entry and codec modules.
    expect(fs.existsSync(path.join(consumerDir, 'node_modules', '@principles', 'codex-adapter', 'dist', 'pd-hook.js'))).toBe(true);
    expect(fs.existsSync(path.join(consumerDir, 'node_modules', '@principles', 'codex-adapter', 'dist', 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(consumerDir, 'node_modules', '@principles', 'codex-adapter', 'dist', 'codec', 'output-encoder.js'))).toBe(true);

    // The adapter must not bundle openclaw-plugin into its tarball.
    expect(fs.existsSync(path.join(consumerDir, 'node_modules', 'principles-disciple'))).toBe(false);
    expect(fs.existsSync(path.join(consumerDir, 'node_modules', '@principles', 'openclaw-plugin'))).toBe(false);

    // The adapter's dist/pd-hook.js must be loadable without throwing at
    // import time (it only runs on stdin input). This proves the published
    // tarball resolves its @principles/host-runtime and @principles/core
    // imports correctly.
    execFileSync(
      process.execPath,
      // pathToFileURL — not manual `file:///` concatenation: on POSIX the
      // joined absolute path would produce file:////... which Node cannot
      // import (ERR_INVALID_FILE_URL_HOST).
      ['--input-type=module', '--eval', `await import(${JSON.stringify(pathToFileURL(path.join(consumerDir, 'node_modules', '@principles', 'codex-adapter', 'dist', 'index.js')).href)})`],
      { cwd: consumerDir, stdio: 'pipe', timeout: 30_000 },
    );
  // Hook budget = build + 4×npm pack + 4-tarball install, all serial and
  // registry-bound; raised twice after the 2026-09-04 slow window (10m14s).
  }, 1_200_000);

  afterAll(() => {
    if (tempDir) {
      // Windows deletion of the installed node_modules can exceed vitest's
      // default 10s hookTimeout; give cleanup room to finish.
      try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 0 }); } catch { /* best effort */ }
    }
  }, 180_000);

  it('packs and installs without pulling in openclaw-plugin', () => {
    expect(tempDir).not.toBe('');
  });
});
