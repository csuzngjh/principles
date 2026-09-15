// PRI-796 (SPEC §8, §23): readiness probes L1/L2/L3, and the PRIMARY_LEAKAGE
// hard gate. The leakage case is built with a REAL directory junction pointing
// out of the worktree — the exact shape a shared `node_modules` produces on
// Windows — so the probe must catch it through genuine Node resolution, not a
// heuristic.
//
// Round-2 review (Blocker 3): build freshness is CONTENT IDENTITY — the build
// stamp (HEAD + package-lock digest + build-authority digest + clean tracked
// inputs) — never mtimes. These fixtures are therefore REAL git repositories:
// a stamp over a fake clock is exactly what this change replaces.

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkReadiness, isInside, listWorkspacePackages } from '../dev/lib/readiness.mjs';
import { verifyBuildStamp, writeBuildStamp, installAttestedWithSkip } from '../dev/lib/build-state.mjs';
import { commitFile, git, initRepo, makeJunction, makeTempDir, removeFixture, runDevScript } from './dev-worktree-test-utils';

let root: string;

beforeEach(() => {
  root = makeTempDir('pd-ready-');
});

afterEach(() => {
  removeFixture(root);
});

/**
 * Every fixture path is derived from a fixed literal under a known root and
 * bound-checked — the test never accepts caller-controlled segments.
 */
function under(dir: string, ...segments: string[]): string {
  const target = path.resolve(dir, ...segments);
  const base = path.resolve(dir) + path.sep;
  if (target !== path.resolve(dir) && !target.startsWith(base)) {
    throw new Error('fixture bug: path escaped ' + dir);
  }
  return target;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf-8');
}

const COVERED_DIRS = (worktree: string): string[] => [
  under(worktree, 'packages', 'a'),
  under(worktree, 'packages', 'b'),
];

/**
 * A minimal npm workspace shaped like the real monorepo — as a REAL git
 * repository with the tracked inputs committed, so content-identity checks
 * (HEAD, dirt, digests) work exactly as in production. dist/ and
 * node_modules/ stay untracked (gitignored in the real repo, invisible to
 * `git status -uno` here), which also lets artifacts survive a checkout —
 * the scenario readiness must then catch via the stamp, not timestamps.
 */
async function buildWorkspace(worktree: string, { leakA = false, stamp = true } = {}): Promise<string | null> {
  await initRepo(worktree);
  // node_modules and dist are gitignored exactly like the real repo: dist is
  // the build OUTPUT (it survives a checkout untouched) and is NOT dirt —
  // dirt counts tracked + untracked-but-not-ignored files (round-3 rule).
  fs.writeFileSync(under(worktree, '.gitignore'), 'node_modules/\npackages/*/dist/\n', 'utf-8');
  writeJson(under(worktree, 'package.json'), {
    name: 'fixture-monorepo',
    private: true,
    type: 'module',
    workspaces: ['packages/*'],
    scripts: { build: 'npm run build --workspace=@x/a && npm run build --workspace=@x/b' },
  });
  fs.writeFileSync(under(worktree, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}', 'utf-8');

  let outsideA: string | null = null;
  if (leakA) {
    // A sibling of the worktree — deliberately OUTSIDE it.
    outsideA = path.join(path.dirname(worktree), path.basename(worktree) + '-outside-a');
    writeJson(under(outsideA, 'package.json'), {
      name: '@x/a',
      version: '1.0.0',
      main: './dist/index.js',
      exports: { '.': './dist/index.js', './sub': './dist/sub.js' },
    });
    fs.mkdirSync(under(outsideA, 'dist'), { recursive: true });
    fs.writeFileSync(under(outsideA, 'dist', 'index.js'), 'export const a = 1;\n', 'utf-8');
    fs.writeFileSync(under(outsideA, 'dist', 'sub.js'), 'export const sub = 1;\n', 'utf-8');
  }

  for (const name of ['a', 'b']) {
    const pkgDir = under(worktree, 'packages', name);
    writeJson(under(pkgDir, 'package.json'), {
      name: '@x/' + name,
      version: '1.0.0',
      main: './dist/index.js',
      exports: { '.': './dist/index.js', './sub': './dist/sub.js' },
      scripts: { build: 'echo' },
    });
    // A tracked source file — the exact class of input whose change must flip
    // the tree to NOT_READY even while dist stays on disk.
    writeJson(under(pkgDir, 'src', 'placeholder.json'), { v: 1 });
    fs.mkdirSync(under(pkgDir, 'dist'), { recursive: true });
    fs.writeFileSync(under(pkgDir, 'dist', 'index.js'), 'export const v = 1;\n', 'utf-8');
    fs.writeFileSync(under(pkgDir, 'dist', 'sub.js'), 'export const v = 1;\n', 'utf-8');
  }

  const scoped = under(worktree, 'node_modules', '@x');
  fs.mkdirSync(scoped, { recursive: true });
  makeJunction(under(scoped, 'a'), leakA && outsideA ? outsideA : under(worktree, 'packages', 'a'));
  makeJunction(under(scoped, 'b'), under(worktree, 'packages', 'b'));

  await git(worktree, 'add', '-A');
  await git(worktree, 'commit', '-m', 'fixture workspace');
  if (stamp) {
    const written = writeBuildStamp(worktree, { coveredDirs: COVERED_DIRS(worktree) });
    if (!written.ok) throw new Error('fixture stamp failed: ' + written.error);
  }
  return outsideA;
}

function stampVerdict(worktree: string) {
  return verifyBuildStamp(worktree, { coveredDirs: COVERED_DIRS(worktree) });
}

describe('isInside', () => {
  it('treats a path as inside itself and rejects siblings', () => {
    expect(isInside('D:/a/b', 'D:/a/b/c')).toBe(true);
    expect(isInside('D:/a/b', 'D:/a/bc')).toBe(false);
    expect(isInside('D:/a/b', 'D:/a')).toBe(false);
  });
});

describe('workspace enumeration', () => {
  it('reads the packages from the root manifest instead of assuming them', async () => {
    await buildWorkspace(root);
    const packages = listWorkspacePackages(root).map((p) => p.name);
    expect(packages).toEqual(['@x/a', '@x/b']);
  });

  it('fails loud on an unsupported workspace glob rather than silently covering nothing', async () => {
    await initRepo(root);
    writeJson(under(root, 'package.json'), { name: 'fx', workspaces: ['apps/*'] });
    expect(() => listWorkspacePackages(root)).toThrow(/unsupported workspace pattern/);
  });
});

describe('readiness on a self-contained worktree', () => {
  it('is READY when dependencies, artifacts, resolutions and the build stamp all hold', async () => {
    await buildWorkspace(root);
    const report = checkReadiness({ worktreeRoot: root });
    expect(report.ok, JSON.stringify(report.levels.l2)).toBe(true);
    expect(report.leakage).toEqual([]);
    expect(report.levels.l1.ok).toBe(true);
    expect(report.levels.l2.ok).toBe(true);
    expect(report.levels.l3.ok).toBe(true);
    // L3 must actually probe the declared subpath export, not just the root.
    expect(report.levels.l3.probes.map((p) => p.specifier)).toContain('@x/a/sub');
  });

  it('is NOT_READY with a bootstrap hint when node_modules is absent', async () => {
    await buildWorkspace(root);
    fs.rmSync(under(root, 'node_modules'), { recursive: true, force: true });
    const report = checkReadiness({ worktreeRoot: root });
    expect(report.ok).toBe(false);
    expect(report.nextAction).toContain('dev:worktree:bootstrap');
  });

  it('is NOT_READY when the build authority produced no artifact', async () => {
    await buildWorkspace(root);
    fs.rmSync(under(root, 'packages', 'b', 'dist'), { recursive: true, force: true });
    const report = checkReadiness({ worktreeRoot: root });
    expect(report.ok).toBe(false);
    expect(report.levels.l2.ok).toBe(false);
    expect(report.levels.l2.results.find((r) => r.name === '@x/b')?.ok).toBe(false);
  });

  it('is NOT_READY without a build stamp at all — installed state is unverified', async () => {
    await buildWorkspace(root, { stamp: false });
    const report = checkReadiness({ worktreeRoot: root });
    expect(report.ok).toBe(false);
    const row = report.levels.l1.checks.find((c) => c.name === 'node_modules matches package-lock.json');
    expect(row?.ok).toBe(false);
    expect(row?.detail).toMatch(/no build stamp/);
  });

  it('scopes L2/L3 to what the root build authority promises', async () => {
    await buildWorkspace(root);
    // A package that exists but that the root build does not cover must not be
    // required to have an artifact — pd-console/pd-companion build elsewhere.
    writeJson(under(root, 'packages', 'c', 'package.json'), {
      name: '@x/c',
      version: '1.0.0',
      main: './dist/index.js',
      scripts: { build: 'echo' },
    });
    const report = checkReadiness({ worktreeRoot: root });
    expect(report.levels.l2.results.map((r) => r.name)).toEqual(['build stamp', '@x/a', '@x/b']);
  });
});

// PRI-796 round-2 (Blocker 3): the owner's freshness matrix. Every case proves
// the verdict comes from CONTENT IDENTITY: HEAD, the lockfile digest, the
// build-authority digest, and tracked dirt — never a timestamp comparison.
describe('build readiness stamp (content identity, not clocks)', () => {
  it('T1: committed + built + stamped → READY', async () => {
    await buildWorkspace(root);
    expect(stampVerdict(root).ok).toBe(true);
  });

  it('T2: tracked source modified, dist kept → NOT_READY (dirty inputs, then gitHead)', async () => {
    await buildWorkspace(root);
    // Modify a TRACKED source input — new untracked files are not dirt to
    // `git status -uno`, but a tracked edit is, even uncommitted.
    fs.writeFileSync(under(root, 'packages', 'a', 'src', 'placeholder.json'), '{"v":2}\n', 'utf-8');
    const beforeCommit = stampVerdict(root);
    expect(beforeCommit.ok).toBe(false);
    expect(beforeCommit.mismatches).toContain('dirty-build-inputs');
    await git(root, 'add', '-A');
    await git(root, 'commit', '-m', 'modify src');
    const afterCommit = stampVerdict(root);
    expect(afterCommit.ok).toBe(false);
    expect(afterCommit.mismatches).toContain('git-head');
    const report = checkReadiness({ worktreeRoot: root });
    expect(report.ok).toBe(false);
    expect(report.levels.l2.ok).toBe(false);
  });

  it('T3: checkout of an older commit with the new dist kept on disk → NOT_READY', async () => {
    await buildWorkspace(root);
    const firstCommit = (await git(root, 'rev-parse', 'HEAD')).trim();
    // Build + stamp the SECOND state (HEAD=B, READY): this is "commit B
    // bootstrap → READY".
    await commitFile(root, 'packages/a/src/placeholder.json', '{"v":2}\n', 'second commit');
    expect(writeBuildStamp(root, { coveredDirs: COVERED_DIRS(root) }).ok).toBe(true);
    expect(stampVerdict(root).ok).toBe(true);
    // Then check out A with the B-era dist still on disk (dist is untracked,
    // so checkout never touches it). Only the stamp's HEAD comparison catches
    // this — mtimes of A-checkout vs B-build prove nothing.
    await git(root, 'checkout', firstCommit);
    const verdict = stampVerdict(root);
    expect(verdict.ok).toBe(false);
    expect(verdict.mismatches).toContain('git-head');
  });

  it('T4: package-lock content changes (committed), node_modules kept → NOT_READY', async () => {
    await buildWorkspace(root);
    await commitFile(root, 'package-lock.json', '{"lockfileVersion":3,"packages":{"changed":true}}', 'lock bump');
    const verdict = stampVerdict(root);
    expect(verdict.ok).toBe(false);
    expect(verdict.mismatches).toContain('package-lock');
    const report = checkReadiness({ worktreeRoot: root });
    expect(report.levels.l1.checks.find((c) => c.name === 'node_modules matches package-lock.json')?.ok).toBe(false);
    expect(report.nextAction).toMatch(/npm install/);
  });

  it('T5: re-stamping a freshly built state returns to READY', async () => {
    await buildWorkspace(root);
    await commitFile(root, 'package-lock.json', '{"lockfileVersion":3,"packages":{"changed":true}}', 'lock bump');
    expect(stampVerdict(root).ok).toBe(false);
    const rewritten = writeBuildStamp(root, { coveredDirs: COVERED_DIRS(root) });
    expect(rewritten.ok).toBe(true);
    expect(stampVerdict(root).ok).toBe(true);
  });

  it('T6: a touched (newer) artifact does not fool the verdict when content mismatches', async () => {
    await buildWorkspace(root);
    // Mismatch the content, then push the timestamps the OLD mtime heuristic
    // consulted into the future. A clock-based check would call this fresh.
    await commitFile(root, 'package-lock.json', '{"lockfileVersion":3,"packages":{"x":true}}', 'lock bump');
    const future = new Date(Date.now() + 10 * 60_000);
    fs.utimesSync(under(root, 'packages', 'a', 'dist', 'index.js'), future, future);
    fs.utimesSync(under(root, 'packages', 'a', 'src', 'placeholder.json'), future, future);
    const verdict = stampVerdict(root);
    expect(verdict.ok).toBe(false);
    expect(verdict.mismatches).toContain('package-lock');
  });

  it('refuses to mint a stamp over untracked build inputs (round-3: dirt includes untracked)', async () => {
    await buildWorkspace(root, { stamp: false });
    // A brand-new, not-ignored source file: the recorded build never saw it.
    fs.writeFileSync(under(root, 'packages', 'a', 'src', 'loose.ts'), 'export const v = 1;\n', 'utf-8');
    const written = writeBuildStamp(root, { coveredDirs: COVERED_DIRS(root) });
    expect(written.ok).toBe(false);
    expect(written.error).toMatch(/dirty/);
  });

  it('an untracked source addition under covered inputs flips a READY tree to NOT_READY', async () => {
    await buildWorkspace(root);
    expect(stampVerdict(root).ok).toBe(true);
    fs.writeFileSync(under(root, 'packages', 'b', 'src', 'addition.ts'), 'export const x = 1;\n', 'utf-8');
    const verdict = stampVerdict(root);
    expect(verdict.ok).toBe(false);
    expect(verdict.mismatches).toContain('dirty-build-inputs');
    // gitignored build output must NOT count as dirt (dist is untracked on purpose).
    fs.writeFileSync(under(root, 'packages', 'b', 'dist', 'extra.js'), 'x\n', 'utf-8');
    fs.rmSync(under(root, 'packages', 'b', 'src', 'addition.ts'));
    expect(stampVerdict(root).ok).toBe(true);
  });
});

// setup-worktree must never mint a stamp claiming an install nobody observed.
// The predicate is the exported rule (build-state.mjs is the stamp authority);
// the CLI consults it before accepting --skip-install.
describe('install attestation with --skip-install (round-3)', () => {
  const stampedResult = { stamp: { packageLockDigest: 'abc' }, mismatches: [] as string[] };
  const driftedResult = { stamp: { packageLockDigest: 'abc' }, mismatches: ['package-lock'] as string[] };

  it('attests only when the marker exists AND a prior stamp proves the current lock', () => {
    expect(installAttestedWithSkip({ markerPresent: true, stampResult: stampedResult })).toBe(true);
  });

  it('refuses: no install marker at all', () => {
    expect(installAttestedWithSkip({ markerPresent: false, stampResult: stampedResult })).toBe(false);
  });

  it('refuses: no prior stamp — nothing proves what was installed', () => {
    expect(installAttestedWithSkip({ markerPresent: true, stampResult: { stamp: null, mismatches: ['stamp'] } })).toBe(false);
  });

  it('refuses: lockfile drifted since the stamped install', () => {
    expect(installAttestedWithSkip({ markerPresent: true, stampResult: driftedResult })).toBe(false);
  });
});

describe('PRIMARY_LEAKAGE — the silent false-verification gate', () => {
  it('FAILS when a workspace package resolves outside the worktree', async () => {
    const outsideA = await buildWorkspace(root, { leakA: true });
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
    await buildWorkspace(root, { leakA: true });
    const result = await runDevScript('worktree-ready.mjs', [root, '--json'], { cwd: root });
    expect(result.code).toBe(1);
    const out = JSON.parse(result.stdout) as { ok: boolean; code: string; leakage: unknown[] };
    expect(out.ok).toBe(false);
    expect(out.leakage.length).toBeGreaterThan(0);
  });

  it('reports READY through the CLI when the worktree is self-contained and stamped', async () => {
    await buildWorkspace(root);
    const result = await runDevScript('worktree-ready.mjs', [root, '--json'], { cwd: root });
    expect(result.code).toBe(0);
    const out = JSON.parse(result.stdout) as { ok: boolean };
    expect(out.ok).toBe(true);
  });
});
