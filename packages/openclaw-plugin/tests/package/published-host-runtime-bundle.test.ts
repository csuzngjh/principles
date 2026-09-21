import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPendingPublishWindow } from '../../../../scripts/release/lib/pending-window.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(packageRoot, '../..');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm_execpath is required for the package contract test');
const runNpm = (args: string[], options: Parameters<typeof execFileSync>[2]) =>
  execFileSync(process.execPath, [npmCli, ...args], options);
let tempDir = '';

// This suite packs the working tree and installs its INTERNAL deps FROM THE
// REGISTRY, so it decides its own skip here rather than being excluded by the
// workflow: between a changesets Version PR materializing new component
// versions and the release train publishing them, the install would ETARGET by
// design (the train's dependency-ordered preflight owns that ordering
// guarantee). A genuinely unresolvable range makes the probe throw, failing
// this file loudly instead of silently skipping. Local `npm test` and CI
// therefore behave identically.
const pendingPublishWindow = await isPendingPublishWindow(repoRoot, 'packages/openclaw-plugin');

describe.skipIf(pendingPublishWindow)('published OpenClaw bundle host-runtime safety', () => {
  beforeAll(() => {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.dependencies).not.toHaveProperty('@principles/host-runtime');
    expect(manifest.devDependencies).toHaveProperty('@principles/host-runtime');

    runNpm(['run', 'build:production'], { cwd: packageRoot, stdio: 'pipe' });
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pack-host-runtime-'));
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
    const isolatedHome = path.join(tempDir, 'home');
    fs.mkdirSync(consumerDir);
    fs.mkdirSync(isolatedHome);
    fs.writeFileSync(path.join(consumerDir, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    runNpm(['install', path.join(tempDir, filename), '--ignore-scripts', '--omit=optional', '--no-package-lock'], {
      // Registry-latency headroom: the 2026-09-04 slow window pushed even a
      // single-tarball install past 300s; 600s + the 900s hook budget below
      // absorb it.
      cwd: consumerDir, stdio: 'pipe', timeout: 600_000,
    });
    expect(fs.existsSync(path.join(consumerDir, 'node_modules', '@principles', 'host-runtime'))).toBe(false);
    execFileSync(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(new URL(`file:///${path.join(consumerDir, 'node_modules', 'principles-disciple', 'dist', 'bundle.js').replace(/\\/g, '/')}`).href)})`], {
      cwd: consumerDir, stdio: 'pipe', timeout: 30_000,
      env: { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome },
    });
    expect(fs.existsSync(path.join(isolatedHome, '.openclaw', 'openclaw.json'))).toBe(false);
  }, 900_000);

  afterAll(() => {
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
    }
  });

  it('packs and runs without resolving an unpublished host-runtime package', () => {
    expect(tempDir).not.toBe('');
  });
});
