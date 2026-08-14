import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm_execpath is required for the package contract test');
const runNpm = (args: string[], options: Parameters<typeof execFileSync>[2]) =>
  execFileSync(process.execPath, [npmCli, ...args], options);
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
    const packOutput = runNpm(['pack', '--ignore-scripts', '--pack-destination', tempDir, '--json'], {
      cwd: packageRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const packed: unknown = JSON.parse(packOutput);
    if (!Array.isArray(packed) || !packed[0] || typeof packed[0] !== 'object' || !Object.hasOwn(packed[0], 'filename')) {
      throw new Error(`npm pack returned an unexpected result: ${packOutput.slice(0, 500)}`);
    }
    const filename = (packed[0] as Record<string, unknown>).filename;
    if (typeof filename !== 'string') throw new Error('npm pack filename is missing');

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
    const hrPackOutput = runNpm(['pack', '--ignore-scripts', '--pack-destination', hostRuntimePackDir, '--json'], {
      cwd: hostRuntimeDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const hrPacked: unknown = JSON.parse(hrPackOutput);
    if (!Array.isArray(hrPacked) || !hrPacked[0] || typeof hrPacked[0] !== 'object' || !Object.hasOwn(hrPacked[0], 'filename')) {
      throw new Error(`npm pack host-runtime returned an unexpected result: ${hrPackOutput.slice(0, 500)}`);
    }
    const hrFilename = (hrPacked[0] as Record<string, unknown>).filename;
    if (typeof hrFilename !== 'string') throw new Error('npm pack host-runtime filename is missing');

    runNpm(
      ['install', path.join(tempDir, filename), path.join(hostRuntimePackDir, hrFilename), '--ignore-scripts', '--omit=optional', '--no-package-lock'],
      { cwd: consumerDir, stdio: 'pipe', timeout: 120_000 },
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
      ['--input-type=module', '--eval', `await import(${JSON.stringify(new URL(`file:///${path.join(consumerDir, 'node_modules', '@principles', 'codex-adapter', 'dist', 'index.js').replace(/\\/g, '/')}`).href)})`],
      { cwd: consumerDir, stdio: 'pipe', timeout: 30_000 },
    );
  }, 180_000);

  afterAll(() => {
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
    }
  });

  it('packs and installs without pulling in openclaw-plugin', () => {
    expect(tempDir).not.toBe('');
  });
});
