// PRI-796 (SPEC §8, §23): readiness probes L1/L2/L3, and the PRIMARY_LEAKAGE hard
// gate. The leakage case is built with a REAL directory junction pointing out of
// the worktree — the exact shape a shared `node_modules` produces on Windows —
// so the probe must catch it through genuine Node resolution, not a heuristic.

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkReadiness, isInside, listWorkspacePackages } from '../dev/lib/readiness.mjs';
import { makeJunction, makeTempDir, removeFixture, runDevScript } from './dev-worktree-test-utils';

let root: string;

beforeEach(() => {
  root = makeTempDir('pd-ready-');
});

afterEach(() => {
  removeFixture(root);
});

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf-8');
}

/**
 * A minimal npm workspace shaped like the real monorepo: two packages, each with
 * a declared entry and a subpath export, both produced by the root build script.
 */
function buildWorkspace(worktree: string, { leakA = false } = {}): string | null {
  writeJson(path.join(worktree, 'package.json'), {
    name: 'fixture-monorepo',
    private: true,
    type: 'module',
    workspaces: ['packages/*'],
    scripts: { build: 'npm run build --workspace=@x/a && npm run build --workspace=@x/b' },
  });

  let outsideA: string | null = null;
  if (leakA) {
    // A sibling of the worktree — deliberately OUTSIDE it.
    outsideA = path.join(path.dirname(worktree), path.basename(worktree) + '-outside-a');
    writeJson(path.join(outsideA, 'package.json'), {
      name: '@x/a',
      version: '1.0.0',
      main: './dist/index.js',
      exports: { '.': './dist/index.js', './sub': './dist/sub.js' },
    });
    fs.mkdirSync(path.join(outsideA, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(outsideA, 'dist', 'index.js'), 'export const a = 1;\n', 'utf-8');
    fs.writeFileSync(path.join(outsideA, 'dist', 'sub.js'), 'export const sub = 1;\n', 'utf-8');
  }

  for (const name of ['a', 'b']) {
    const pkgDir = path.join(worktree, 'packages', name);
    writeJson(path.join(pkgDir, 'package.json'), {
      name: '@x/' + name,
      version: '1.0.0',
      main: './dist/index.js',
      exports: { '.': './dist/index.js', './sub': './dist/sub.js' },
      scripts: { build: 'echo' },
    });
    fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'dist', 'index.js'), 'export const v = 1;\n', 'utf-8');
    fs.writeFileSync(path.join(pkgDir, 'dist', 'sub.js'), 'export const v = 1;\n', 'utf-8');
  }

  const scoped = path.join(worktree, 'node_modules', '@x');
  fs.mkdirSync(scoped, { recursive: true });
  makeJunction(path.join(scoped, 'a'), leakA && outsideA ? outsideA : path.join(worktree, 'packages', 'a'));
  makeJunction(path.join(scoped, 'b'), path.join(worktree, 'packages', 'b'));
  return outsideA;
}

describe('isInside', () => {
  it('treats a path as inside itself and rejects siblings', () => {
    expect(isInside('D:/a/b', 'D:/a/b/c')).toBe(true);
    expect(isInside('D:/a/b', 'D:/a/bc')).toBe(false);
    expect(isInside('D:/a/b', 'D:/a')).toBe(false);
  });
});

describe('workspace enumeration', () => {
  it('reads the packages from the root manifest instead of assuming them', () => {
    buildWorkspace(root);
    const packages = listWorkspacePackages(root).map((p) => p.name);
    expect(packages).toEqual(['@x/a', '@x/b']);
  });

  it('fails loud on an unsupported workspace glob rather than silently covering nothing', () => {
    writeJson(path.join(root, 'package.json'), { name: 'fx', workspaces: ['apps/*'] });
    expect(() => listWorkspacePackages(root)).toThrow(/unsupported workspace pattern/);
  });
});

describe('readiness on a self-contained worktree', () => {
  it('is READY when dependencies, artifacts and resolutions all stay inside', () => {
    buildWorkspace(root);
    const report = checkReadiness({ worktreeRoot: root });
    expect(report.ok).toBe(true);
    expect(report.leakage).toEqual([]);
    expect(report.levels.l1.ok).toBe(true);
    expect(report.levels.l2.ok).toBe(true);
    expect(report.levels.l3.ok).toBe(true);
    // L3 must actually probe the declared subpath export, not just the root.
    expect(report.levels.l3.probes.map((p) => p.specifier)).toContain('@x/a/sub');
  });

  it('is NOT_READY with a bootstrap hint when node_modules is absent', () => {
    buildWorkspace(root);
    fs.rmSync(path.join(root, 'node_modules'), { recursive: true, force: true });
    const report = checkReadiness({ worktreeRoot: root });
    expect(report.ok).toBe(false);
    expect(report.nextAction).toContain('dev:worktree:bootstrap');
  });

  it('is NOT_READY when the build authority produced no artifact', () => {
    buildWorkspace(root);
    fs.rmSync(path.join(root, 'packages', 'b', 'dist'), { recursive: true, force: true });
    const report = checkReadiness({ worktreeRoot: root });
    expect(report.ok).toBe(false);
    expect(report.levels.l2.ok).toBe(false);
    expect(report.levels.l2.results.find((r) => r.name === '@x/b')?.ok).toBe(false);
  });

  it('scopes L2/L3 to what the root build authority promises', () => {
    buildWorkspace(root);
    // A package that exists but that the root build does not cover must not be
    // required to have an artifact — pd-console/pd-companion build elsewhere.
    writeJson(path.join(root, 'packages', 'c', 'package.json'), {
      name: '@x/c',
      version: '1.0.0',
      main: './dist/index.js',
      scripts: { build: 'echo' },
    });
    const report = checkReadiness({ worktreeRoot: root });
    expect(report.levels.l2.results.map((r) => r.name)).toEqual(['@x/a', '@x/b']);
  });
});

describe('PRIMARY_LEAKAGE — the silent false-verification gate', () => {
  it('FAILS when a workspace package resolves outside the worktree', () => {
    const outsideA = buildWorkspace(root, { leakA: true });
    expect(outsideA).not.toBeNull();

    const report = checkReadiness({ worktreeRoot: root });
    expect(report.ok).toBe(false);
    expect(report.leakage.length).toBeGreaterThan(0);

    // The report must NAME the package, the actual resolved path and the
    // expected root — otherwise the operator cannot fix it.
    const leaked = report.leakage.map((l) => l.package);
    expect(leaked).toContain('@x/a');
    const first = report.leakage[0];
    expect(isInside(root, first.actual)).toBe(false);
    expect(first.expected).toBe(path.resolve(root));

    // L1 catches it through real resolution, before any build output is trusted.
    expect(report.levels.l1.ok).toBe(false);
    expect(report.levels.l1.checks.find((c) => c.name === 'dependency @x/a')?.ok).toBe(false);
  });

  it('surfaces the leakage through the CLI as NOT_READY with a non-zero exit', async () => {
    buildWorkspace(root, { leakA: true });
    const result = await runDevScript('worktree-ready.mjs', [root, '--json'], { cwd: root });
    expect(result.code).toBe(1);
    const out = JSON.parse(result.stdout) as { ok: boolean; code: string; leakage: unknown[] };
    expect(out.ok).toBe(false);
    expect(out.leakage.length).toBeGreaterThan(0);
  });

  it('reports READY through the CLI when the worktree is self-contained', async () => {
    buildWorkspace(root);
    const result = await runDevScript('worktree-ready.mjs', [root, '--json'], { cwd: root });
    expect(result.code).toBe(0);
    const out = JSON.parse(result.stdout) as { ok: boolean };
    expect(out.ok).toBe(true);
  });
});
