// G3.2 build-once: production-path tests. Every case spawns the real
// scripts/release/build-once.mjs against a throwaway npm workspace fixture
// whose `build` script counts its own executions — the counter is the
// ground truth for "built" vs "reused", independent of the helper's logs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { digestDist } from '../release/lib/dist-digest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD_ONCE = path.resolve(HERE, '..', 'release', 'build-once.mjs');

const COHORT = 'a'.repeat(40);
const OTHER_COHORT = 'b'.repeat(40);

type Fixture = { root: string; pkgDir: string; counter: string; ledger: string };

// A file symlink needs privilege on Windows; a directory junction does not.
// Both are "non-regular entries" for digestDist, so the fixture prefers a file
// symlink and falls back to a junction so this fails-closed case also runs on
// the Windows dev box (CI is ubuntu either way).
function canSymlink(): boolean {
  const probeRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-g32-symlink-probe-'));
  try {
    fs.writeFileSync(path.join(probeRoot, 'target'), 'x');
    try {
      fs.symlinkSync('target', path.join(probeRoot, 'link'));
      return true;
    } catch {
      fs.mkdirSync(path.join(probeRoot, 'targetdir'));
      fs.symlinkSync(path.join(probeRoot, 'targetdir'), path.join(probeRoot, 'linkdir'), 'junction');
      return true;
    }
  } catch {
    return false;
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
}

/** Errno code from an unknown thrown value, without a type assertion. */
function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

function createFixture(options: { failBuild?: boolean; emitSymlink?: boolean } = {}): Fixture {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-g32-build-once-'));
  const pkgDir = path.join(root, 'pkgs', 'demo');
  fs.mkdirSync(pkgDir, { recursive: true });
  const counter = path.join(root, 'build-count.txt');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'g32-fixture-root',
    private: true,
    workspaces: ['pkgs/demo'],
  }, null, 2) + '\n');
  const buildScript = options.failBuild
    ? 'node -e "process.exit(3)"'
    : 'node build.js';
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
    name: '@g32/demo',
    version: '1.0.0',
    scripts: { build: buildScript },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(pkgDir, 'build.js'), [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "fs.appendFileSync(process.env.G32_COUNTER, 'x');",
    "fs.mkdirSync(path.join(__dirname, 'dist', 'sub'), { recursive: true });",
    "fs.writeFileSync(path.join(__dirname, 'dist', 'index.js'), 'export const v = 1;\\n');",
    "fs.writeFileSync(path.join(__dirname, 'dist', 'sub', 'b.js'), 'export const b = 2;\\n');",
    ...(options.emitSymlink
      ? [
          "try { fs.symlinkSync('index.js', path.join(__dirname, 'dist', 'link.js')); }",
          "catch (error) {",
          "  if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;",
          "  fs.symlinkSync(path.join(__dirname, 'dist', 'sub'), path.join(__dirname, 'dist', 'linkdir'), 'junction');",
          "}",
        ]
      : []),
    '',
  ].join('\n'));
  return { root, pkgDir, counter, ledger: path.join(root, 'ledger', 'pd-built-once.json') };
}

function runBuildOnce(fx: Fixture, cohort = COHORT, extraArgs: string[] = []) {
  return spawnSync(process.execPath, [
    BUILD_ONCE,
    '--workspace', '@g32/demo',
    '--script', 'build',
    '--dir', fx.pkgDir,
    '--cohort', cohort,
    '--ledger', fx.ledger,
    ...extraArgs,
  ], {
    cwd: fx.root,
    encoding: 'utf8',
    env: { ...process.env, G32_COUNTER: fx.counter },
    maxBuffer: 16 * 1024 * 1024,
  });
}

const builds = (fx: Fixture): number => (fs.existsSync(fx.counter) ? fs.readFileSync(fx.counter, 'utf8').length : 0);
const out = (r: ReturnType<typeof spawnSync>): string => `${String(r.stdout)}${String(r.stderr)}`;

describe('build-once (G3.2) — job-scoped ledger with artifact identity', () => {
  it('builds on first use, records cohort+version+dist SHA-256, and reuses an unchanged dist', () => {
    const fx = createFixture();
    try {
      const first = runBuildOnce(fx);
      expect(first.status, out(first)).toBe(0);
      expect(builds(fx)).toBe(1);
      const ledger = JSON.parse(fs.readFileSync(fx.ledger, 'utf8')) as Record<string, { cohort: string; version: string; distSha256: string }>;
      expect(ledger['@g32/demo#build']).toEqual({
        cohort: COHORT,
        version: '1.0.0',
        distSha256: digestDist(path.join(fx.pkgDir, 'dist')),
      });

      const second = runBuildOnce(fx);
      expect(second.status, out(second)).toBe(0);
      expect(builds(fx)).toBe(1);
      expect(out(second)).toContain('reused for cohort');
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  }, 120_000);

  it('rebuilds (with a visible warning) when the cohort differs', () => {
    const fx = createFixture();
    try {
      expect(runBuildOnce(fx).status).toBe(0);
      const other = runBuildOnce(fx, OTHER_COHORT);
      expect(other.status, out(other)).toBe(0);
      expect(builds(fx)).toBe(2);
      expect(out(other)).toContain('::warning::');
      expect(out(other)).toContain('recorded cohort');
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  }, 120_000);

  it('rebuilds when the package version changed (stale/older artifact)', () => {
    const fx = createFixture();
    try {
      expect(runBuildOnce(fx).status).toBe(0);
      const manifestPath = path.join(fx.pkgDir, 'package.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: '1.0.1' }, null, 2) + '\n');
      const bumped = runBuildOnce(fx);
      expect(bumped.status, out(bumped)).toBe(0);
      expect(builds(fx)).toBe(2);
      expect(out(bumped)).toContain('recorded version 1.0.0 != current 1.0.1');
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  }, 120_000);

  it('rebuilds when the dist was corrupted after recording (SHA-256 mismatch)', () => {
    const fx = createFixture();
    try {
      expect(runBuildOnce(fx).status).toBe(0);
      fs.writeFileSync(path.join(fx.pkgDir, 'dist', 'sub', 'b.js'), 'tampered\n');
      const tampered = runBuildOnce(fx);
      expect(tampered.status, out(tampered)).toBe(0);
      expect(builds(fx)).toBe(2);
      expect(out(tampered)).toContain('SHA-256 mismatch');
      // The rebuild restored the real output and re-recorded its identity.
      expect(fs.readFileSync(path.join(fx.pkgDir, 'dist', 'sub', 'b.js'), 'utf8')).toBe('export const b = 2;\n');
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  }, 120_000);

  it('rebuilds when the dist is missing', () => {
    const fx = createFixture();
    try {
      expect(runBuildOnce(fx).status).toBe(0);
      fs.rmSync(path.join(fx.pkgDir, 'dist'), { recursive: true, force: true });
      const missing = runBuildOnce(fx);
      expect(missing.status, out(missing)).toBe(0);
      expect(builds(fx)).toBe(2);
      expect(out(missing)).toContain('dist/ is missing or empty');
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  }, 120_000);

  it('never skips on a corrupt ledger', () => {
    const fx = createFixture();
    try {
      expect(runBuildOnce(fx).status).toBe(0);
      fs.writeFileSync(fx.ledger, '{not json');
      const corrupt = runBuildOnce(fx);
      expect(corrupt.status, out(corrupt)).toBe(0);
      expect(builds(fx)).toBe(2);
      expect(out(corrupt)).toContain('ledger');
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  }, 120_000);

  it('fails the step on a failed build and records nothing', () => {
    const fx = createFixture({ failBuild: true });
    try {
      const failed = runBuildOnce(fx);
      expect(failed.status).not.toBe(0);
      expect(fs.existsSync(fx.ledger)).toBe(false);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  }, 120_000);

  it('rejects malformed invocations without building', () => {
    const fx = createFixture();
    try {
      const badCohort = runBuildOnce(fx, 'not-a-sha');
      expect(badCohort.status).toBe(2);
      expect(builds(fx)).toBe(0);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  }, 120_000);

  it.skipIf(!canSymlink())('fails closed when a build emits a symlink into dist (never records it)', () => {
    const fx = createFixture({ emitSymlink: true });
    try {
      const result = runBuildOnce(fx);
      expect(result.status, out(result)).not.toBe(0);
      expect(out(result)).toContain('not a regular-file artifact');
      expect(fs.existsSync(fx.ledger)).toBe(false);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('digestDist — deterministic dist identity', () => {
  it('is stable, content-sensitive, rename-sensitive and null for an empty or missing dist', () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-g32-digest-'));
    try {
      const dist = path.join(root, 'dist');
      expect(digestDist(dist)).toBeNull();
      fs.mkdirSync(path.join(dist, 'nested'), { recursive: true });
      expect(digestDist(dist)).toBeNull();
      fs.writeFileSync(path.join(dist, 'a.js'), 'a');
      fs.writeFileSync(path.join(dist, 'nested', 'b.js'), 'b');
      const base = digestDist(dist);
      expect(base).toMatch(/^[a-f0-9]{64}$/);
      expect(digestDist(dist)).toBe(base);

      fs.writeFileSync(path.join(dist, 'a.js'), 'A');
      expect(digestDist(dist)).not.toBe(base);
      fs.writeFileSync(path.join(dist, 'a.js'), 'a');
      expect(digestDist(dist)).toBe(base);

      fs.renameSync(path.join(dist, 'nested', 'b.js'), path.join(dist, 'nested', 'c.js'));
      expect(digestDist(dist)).not.toBe(base);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!canSymlink())('refuses a dist containing a symlink instead of silently ignoring it', () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-g32-digest-symlink-'));
    try {
      const dist = path.join(root, 'dist');
      fs.mkdirSync(dist, { recursive: true });
      fs.writeFileSync(path.join(dist, 'a.js'), 'a');
      const base = digestDist(dist);
      try {
        fs.symlinkSync('a.js', path.join(dist, 'link.js'));
      } catch (error) {
        const code = errnoCode(error);
        if (code !== 'EPERM' && code !== 'EACCES') throw error;
        fs.mkdirSync(path.join(dist, 'sub'));
        fs.symlinkSync(path.join(dist, 'sub'), path.join(dist, 'linkdir'), 'junction');
      }
      // Before the fix a symlink was neither hashed nor reported, so this
      // returned the SAME digest while the emitted artifact changed.
      expect(() => digestDist(dist)).toThrow(/non-regular entry/);
      expect(base).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!canSymlink())('fails closed when the dist ROOT is a symlink instead of following it', () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-g32-digest-root-symlink-'));
    try {
      const external = path.join(root, 'external');
      fs.mkdirSync(external, { recursive: true });
      fs.writeFileSync(path.join(external, 'a.js'), 'a');
      // A directory junction needs no file-symlink privilege on Windows.
      const linked = path.join(root, 'dist');
      fs.symlinkSync(external, linked, 'junction');
      // Before the fix the root symlink was followed, so an external tree got a
      // valid-looking digest while the package's own dist/ was never read.
      expect(() => digestDist(linked)).toThrow(/dist root is a symlink/);

      const dangling = path.join(root, 'dangling-dist');
      fs.symlinkSync(path.join(root, 'missing-target'), dangling, 'junction');
      // Before the fix existsSync() reported false, so a dangling root symlink
      // was silently classified as a missing dist.
      expect(() => digestDist(dangling)).toThrow(/dist root is a symlink/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the dist root is not a directory', () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-g32-digest-root-file-'));
    try {
      const notADirectory = path.join(root, 'dist');
      fs.writeFileSync(notADirectory, 'not a directory');
      expect(() => digestDist(notADirectory)).toThrow(/dist root is not a directory/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
