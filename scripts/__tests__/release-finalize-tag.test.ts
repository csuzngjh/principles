// finalize-tag-reconcile behaviour tests (PRI-923).
//
// The finalize closing leg used to fail loud on EVERY cohort whose plugin
// version was unchanged (tag = plugin version, SPEC §25), leaving a red
// train leg and no reconciliation path for component-only releases
// (production evidence: train 36104100294, cohort 6199897a). These tests
// pin the replacement contract on two levels:
//
//   1. the pure decision matrix (scripts/release/lib/finalize-tag-
//      reconcile.mjs) — every verdict and every fail-loud branch;
//   2. the CLI end-to-end against REAL temporary git repos (file remotes)
//      and a stubbed registry via PD_RELEASE_REGISTRY — create/push,
//      idempotent skip, prior-cohort skip, foreign-commit conflict, and
//      the SPEC §18.3 rule that a registry failure is never "fine".

import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELEASE_DIR = path.resolve(HERE, '..', 'release');
const CLI = path.join(RELEASE_DIR, 'finalize-tag-reconcile.mjs');
const PKG_REL = 'packages/openclaw-plugin/package.json';

async function loadDecision() {
  const mod = await import(pathToFileURL(path.join(RELEASE_DIR, 'lib', 'finalize-tag-reconcile.mjs')).href);
  return mod.decideFinalizeTag as (f: Record<string, unknown>) => {
    action: string;
    closingSteps: string;
    reason: string;
  };
}

// ---------------------------------------------------------------------------
// 1. Pure decision matrix
// ---------------------------------------------------------------------------

describe('finalize tag decision (pure, PRI-923)', () => {
  it('absent tag -> create and push, closing runs', async () => {
    const decide = await loadDecision();
    const d = decide({ tagExistsRemotely: false });
    expect(d.action).toBe('create-and-push');
    expect(d.closingSteps).toBe('ran');
  });

  it('tag at the cohort -> idempotent tag skip, closing still reconciles', async () => {
    const decide = await loadDecision();
    const d = decide({ tagExistsRemotely: true, tagPointsAtCohort: true });
    expect(d.action).toBe('run-closing');
    expect(d.closingSteps).toBe('ran');
  });

  it('unchanged plugin published from an ancestor -> green skip of the closing steps', async () => {
    const decide = await loadDecision();
    const d = decide({
      tag: 'v2.0.4',
      tagExistsRemotely: true,
      tagPointsAtCohort: false,
      cohort: 'c0hort',
      pluginName: 'principles-disciple',
      pluginVersion: '2.0.4',
      introducedByCohort: false,
      registryStatus: 'PRESENT_PRIOR',
      publishedCommit: 'aaaa1111',
      publishedCommitIsAncestor: true,
      taggedCommit: 'aaaa1111',
    });
    expect(d.action).toBe('skip-closing');
    expect(d.closingSteps).toBe('skipped-prior-tag');
    expect(d.reason).toContain('prior cohort');
  });

  it('EVERY other tag-elsewhere combination fails loud', async () => {
    const decide = await loadDecision();
    const base = {
      tag: 'v2.0.4',
      tagExistsRemotely: true,
      tagPointsAtCohort: false,
      taggedCommit: 'aaaa1111',
      cohort: 'c0hort',
      pluginName: 'principles-disciple',
      pluginVersion: '2.0.4',
      introducedByCohort: false,
      registryStatus: 'PRESENT_PRIOR',
      publishedCommit: 'aaaa1111',
      publishedCommitIsAncestor: true,
    };
    // The green path is the ONLY non-fail shape outside these two baselines.
    expect(decide(base).action).toBe('skip-closing');
    const mutations: Array<[string, Record<string, unknown>]> = [
      ['registry error', { registryStatus: 'REGISTRY_ERROR' }],
      ['registry behind', { registryStatus: 'LOCAL_BEHIND_REGISTRY' }],
      ['registry absent', { registryStatus: 'ABSENT', publishedCommit: null }],
      ['unverifiable provenance', { registryStatus: 'PRESENT_UNVERIFIED', publishedCommit: null }],
      ['foreign provenance', { registryStatus: 'PRESENT_CONFLICT' }],
      ['cohort introduced the plugin', { introducedByCohort: true }],
      ['publisher commit not an ancestor', { publishedCommitIsAncestor: false }],
      ['publisher commit missing', { publishedCommit: '' }],
      ['tag sits on a different commit than the publisher', { taggedCommit: 'oldsha' }],
      ['tag commit unreadable locally', { taggedCommit: null }],
    ];
    for (const [label, patch] of mutations) {
      const d = decide({ ...base, ...patch });
      expect(d.action, label).toBe('fail');
      expect(d.reason, label).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. CLI end-to-end on real fixture repos
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
let stubServer: http.Server | null = null;
let stubPort = 0;
const stubPacks = new Map<string, unknown>();

function sh(cmd: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  return execFileAsync(cmd, args, { cwd, env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 });
}
async function gitSh(args: string[], cwd: string) {
  await sh('git', args, cwd);
}

async function makeStubRegistry() {
  stubServer = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url ?? '').replace(/^\//, '').replace(/\/[^/]*$/, '');
    const pack = stubPacks.get(name);
    if (pack === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(pack));
  });
  await new Promise<void>((r) => stubServer!.listen(0, '127.0.0.1', r));
  stubPort = (stubServer!.address() as { port: number }).port;
}

function removeTree(dir: string) {
  // Windows: git writes read-only objects; clear the bit before removing.
  try {
    for (const entry of fs.readdirSync(dir, { recursive: true })) {
      try {
        fs.chmodSync(path.join(dir, entry as string), 0o666);
      } catch {
        /* raced or already gone */
      }
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // The temp-lifecycle guardian keeps and later reclaims these dirs;
    // a failed cleanup must never fail the suite.
  }
}

afterAll(async () => {
  if (stubServer) await new Promise<void>((r) => stubServer!.close(() => r()));
  for (const dir of tempDirs) removeTree(dir);
});

/**
 * Fixture: a file "origin" (upstream clone so it has a master branch), a
 * product checkout at the cohort commit, plugin manifest at PKG_REL, and
 * optional tags pushed at given commits.
 */
async function makeFixture(scenario: string) {
  const base = process.env.TMPDIR ?? os.tmpdir();
  const root = fs.mkdtempSync(path.join(base, `fin-tag-${scenario}-`));
  tempDirs.push(root);
  const upstream = path.join(root, 'upstream.git');
  const seedDir = path.join(root, 'seed');
  const product = path.join(root, 'product');
  await sh('git', ['init', '--bare', '-b', 'main', upstream], root);
  fs.mkdirSync(path.join(seedDir, 'packages', 'openclaw-plugin'), { recursive: true });
  await sh('git', ['init', '-b', 'main', seedDir], root);
  const setPlugin = async (version: string) => {
    fs.writeFileSync(
      path.join(seedDir, PKG_REL),
      JSON.stringify({ name: 'principles-disciple-fixture', version }, null, 2) + '\n',
    );
  };
  await setPlugin('1.0.0');
  fs.writeFileSync(path.join(seedDir, 'README.md'), 'seed\n');
  await gitSh(['add', '-A'], seedDir);
  await gitSh(['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'c1'], seedDir);
  const c1 = (await sh('git', ['rev-parse', 'HEAD'], seedDir)).stdout.trim();
  await gitSh(['push', upstream, 'main'], seedDir);
  await sh('git', ['clone', upstream, product], root);
  // c2 bumps an unrelated file — a component-only cohort (plugin unchanged).
  fs.writeFileSync(path.join(product, 'installer-note.md'), 'component bump\n');
  await gitSh(['add', '-A'], product);
  await gitSh(['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'c2'], product);
  const c2 = (await sh('git', ['rev-parse', 'HEAD'], product)).stdout.trim();
  return { root, upstream, product, c1, c2 };
}

async function pushTagAt(workDir: string, sha: string, tag: string) {
  await gitSh(['checkout', sha], workDir);
  // Annotated tags carry a tagger identity; CI runners have no global git
  // config, so pin it explicitly like the fixture commits do.
  await gitSh(
    ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'tag', '-a', tag, '-m', tag],
    workDir,
  );
  await gitSh(['push', 'origin', `refs/tags/${tag}`], workDir);
  await gitSh(['checkout', 'main'], workDir);
}

async function runCli(repoRoot: string, cohort: string, extraEnv: Record<string, string> = {}) {
  if (!stubServer) await makeStubRegistry();
  const outFile = path.join(repoRoot, '.gha-output');
  const summaryFile = path.join(repoRoot, '.gha-summary');
  try {
    const { stdout, stderr } = await sh(
      process.execPath,
      [CLI, '--cohort', cohort, '--repo-root', repoRoot],
      repoRoot,
      {
        GITHUB_OUTPUT: outFile,
        GITHUB_STEP_SUMMARY: summaryFile,
        PD_RELEASE_REGISTRY: `http://127.0.0.1:${stubPort}`,
        PD_RELEASE_RETRY_DELAY_MS: '1',
        ...extraEnv,
      },
    );
    return { code: 0, stdout, stderr, outFile, summaryFile };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '', outFile, summaryFile };
  }
}

function readOut(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

describe('finalize-tag-reconcile CLI on fixture repos (PRI-923)', { timeout: 180_000 }, () => {
  it('creates and pushes the tag when it is absent', async () => {
    const f = await makeFixture('create');
    const r = await runCli(f.product, f.c1);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('Created and pushed tag: v1.0.0');
    expect(readOut(r.outFile)).toContain('closing_steps=ran');
    const remoteTags = await sh('git', ['ls-remote', '--tags', 'origin'], f.product);
    expect(remoteTags.stdout).toContain('refs/tags/v1.0.0');
  });

  it('tag already at the cohort: green, closing steps keep running', async () => {
    const f = await makeFixture('at-cohort');
    await pushTagAt(f.product, f.c1, 'v1.0.0');
    const r = await runCli(f.product, f.c1);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('already exists at the cohort commit');
    expect(readOut(r.outFile)).toContain('closing_steps=ran');
  });

  it('short/mixed-case cohort SHA is normalized, not misread as a foreign tag', async () => {
    const f = await makeFixture('shortsha');
    await pushTagAt(f.product, f.c1, 'v1.0.0');
    const short = f.c1.slice(0, 12);
    const r = await runCli(f.product, short);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('already exists at the cohort commit');
    expect(readOut(r.outFile)).toContain('closing_steps=ran');
  });

  it('plugin-unchanged cohort with prior-cohort publish: green skip of the closing steps', async () => {
    const f = await makeFixture('prior');
    await pushTagAt(f.product, f.c1, 'v1.0.0');
    stubPacks.set('principles-disciple-fixture', {
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { version: '1.0.0', gitHead: f.c1 } },
    });
    const r = await runCli(f.product, f.c2);
    expect(r.code, r.stderr).toBe(0);
    expect(readOut(r.outFile)).toContain('closing_steps=skipped-prior-tag');
    expect(r.stderr + r.stdout).toContain('closing steps skipped (PRI-923)');
    expect(readOut(r.summaryFile)).toContain('belongs to an earlier cohort');
  });

  it('tag sits elsewhere than the registry publisher commit: skip claim unproven -> fail loud', async () => {
    const f = await makeFixture('tag-not-at-publisher');
    // Registry published from c1 (an ancestor of c2), but the tag was moved
    // onto a side-branch commit — priorOwned must NOT green-skip on it.
    await gitSh(['checkout', '-b', 'side', f.c1], f.product);
    fs.writeFileSync(path.join(f.product, 'side.md'), 'side\n');
    await gitSh(['add', '-A'], f.product);
    await gitSh(['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'side'], f.product);
    const side = (await sh('git', ['rev-parse', 'HEAD'], f.product)).stdout.trim();
    await gitSh(['checkout', 'main'], f.product);
    await pushTagAt(f.product, side, 'v1.0.0');
    stubPacks.set('principles-disciple-fixture', {
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { version: '1.0.0', gitHead: f.c1 } },
    });
    const r = await runCli(f.product, f.c2);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Refusing to move an existing tag');
    expect(readOut(r.summaryFile)).not.toContain('belongs to an earlier cohort');
  });

  it('foreign publisher commit (not an ancestor) still refuses to move the tag', async () => {
    const f = await makeFixture('foreign');
    await pushTagAt(f.product, f.c1, 'v1.0.0');
    // A commit on a side branch that c2 never integrated.
    await gitSh(['checkout', '-b', 'side', f.c1], f.product);
    fs.writeFileSync(path.join(f.product, 'side.md'), 'side\n');
    await gitSh(['add', '-A'], f.product);
    await gitSh(['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'side'], f.product);
    const side = (await sh('git', ['rev-parse', 'HEAD'], f.product)).stdout.trim();
    await gitSh(['checkout', 'main'], f.product);
    stubPacks.set('principles-disciple-fixture', {
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { version: '1.0.0', gitHead: side } },
    });
    const r = await runCli(f.product, f.c2);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Refusing to move an existing tag');
    expect(r.stderr).toContain('PRESENT_CONFLICT');
  });

  it('registry failure is never read as a prior release (SPEC §18.3)', async () => {
    const f = await makeFixture('regfail');
    await pushTagAt(f.product, f.c1, 'v1.0.0');
    // Server that answers 500 for everything.
    const bad = http.createServer((_req, res) => {
      res.writeHead(500);
      res.end('boom');
    });
    await new Promise<void>((r) => bad.listen(0, '127.0.0.1', r));
    const badPort = (bad.address() as { port: number }).port;
    try {
      const r = await runCli(f.product, f.c2, { PD_RELEASE_REGISTRY: `http://127.0.0.1:${badPort}` });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('Refusing to move an existing tag');
      expect(r.stderr).toContain('REGISTRY_ERROR');
    } finally {
      await new Promise<void>((r) => bad.close(() => r()));
    }
  });
});
