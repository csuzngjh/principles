// Real-git integration tests for scripts/ci/impact.mjs — the CI impact
// authority (SHADOW MODE). Fixtures mirror the REAL workspace manifest graph
// (verified against packages/*/package.json on 2026-08-29) inside temporary
// git repositories, then drive the real CLI with real `git diff base...head`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMPACT_SCRIPT = path.resolve(HERE, '..', 'ci', 'impact.mjs');

let root: string;
let repo: string;

/** The real workspace graph, as verified from the package manifests on 2026-08-29. */
const FIXTURE_PACKAGES: Array<{ dir: string; name: string; deps?: Record<string, string>; devDeps?: Record<string, string> }> = [
  { dir: 'principles-core', name: '@principles/core' },
  { dir: 'install-layout', name: '@principles/install-layout' },
  {
    dir: 'host-runtime',
    name: '@principles/host-runtime',
    deps: { '@principles/core': '^1.74.1', '@principles/install-layout': '0.1.0' },
  },
  {
    dir: 'codex-adapter',
    name: '@principles/codex-adapter',
    deps: { '@principles/core': '^1.74.1', '@principles/host-runtime': '^0.1.0' },
  },
  {
    dir: 'openclaw-plugin',
    name: 'principles-disciple',
    deps: { '@principles/core': '^1.74.1' },
    devDeps: { '@principles/host-runtime': '^0.1.0' },
  },
  {
    dir: 'pd-cli',
    name: '@principles/pd-cli',
    deps: {
      '@principles/core': '^1.74.1',
      '@principles/codex-adapter': '^0.1.0',
      '@principles/host-runtime': '^0.1.0',
      '@principles/install-layout': '0.1.0',
      'principles-disciple': '^1.74.1',
    },
  },
  { dir: 'pd-companion', name: '@principles/pd-companion', deps: { '@principles/install-layout': '0.1.0' } },
  {
    dir: 'pd-console',
    name: '@principles/pd-console',
    deps: {
      '@principles/core': '*',
      '@principles/host-runtime': '*',
      '@principles/install-layout': '0.1.0',
      'principles-disciple': '*',
    },
  },
  { dir: 'create-principles-disciple', name: 'create-principles-disciple', deps: { '@principles/install-layout': '0.1.0' } },
  { dir: 'website', name: '@principles/website', devDeps: { '@principles/core': '*' } },
];

async function sh(cmd: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { cwd, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? '' };
  }
}

async function commit(files: Record<string, string>, message: string): Promise<string> {
  const repoRoot = path.resolve(repo);
  for (const rel of Object.keys(files)) {
    // Fixture writes are repo-relative by construction; enforce the boundary
    // explicitly so no entry can escape the temporary repository.
    const abs = path.resolve(repoRoot, rel);
    if (abs !== repoRoot && !abs.startsWith(repoRoot + path.sep)) {
      throw new Error('fixture file escapes repository root: ' + rel);
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, files[rel], 'utf-8');
  }
  await sh('git', ['add', '-A'], repo);
  const r = await sh('git', ['commit', '-m', message], repo);
  if (r.code !== 0) throw new Error('fixture commit failed: ' + r.stderr);
  return (await sh('git', ['rev-parse', 'HEAD'], repo)).stdout.trim();
}

/** Run the impact CLI between two refs; returns parsed JSON (throws on non-zero exit). */
async function impact(base: string, head: string): Promise<{
  changedFiles: string[];
  changedPackages: string[];
  affectedPackages: string[];
  docsOnly: boolean;
  scopes: Record<string, boolean>;
  reasons: Record<string, string>;
}> {
  const r = await sh(process.execPath, [IMPACT_SCRIPT, '--base', base, '--head', head, '--format', 'json', '--repo', repo], repo);
  if (r.code !== 0) throw new Error('impact CLI failed:\n' + r.stderr);
  return JSON.parse(r.stdout);
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-impact-test-'));
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  await sh('git', ['init', '-b', 'main'], repo);
  await sh('git', ['config', 'user.email', 'test@example.com'], repo);
  await sh('git', ['config', 'user.name', 'PD Test'], repo);
  await sh('git', ['config', 'core.autocrlf', 'false'], repo);

  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fixture-monorepo', private: true, workspaces: ['packages/*'] }, null, 2),
    'package-lock.json': '# lockfile v3\n',
  };
  for (const pkg of FIXTURE_PACKAGES) {
    const manifest: Record<string, unknown> = { name: pkg.name, version: '1.0.0', private: true };
    if (pkg.deps) manifest.dependencies = pkg.deps;
    if (pkg.devDeps) manifest.devDependencies = pkg.devDeps;
    files['packages/' + pkg.dir + '/package.json'] = JSON.stringify(manifest, null, 2);
    files['packages/' + pkg.dir + '/src/index.ts'] = 'export {};\n';
  }
  files['docs/index.md'] = '# docs\n';
  await commit(files, 'fixture: workspace manifests');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('impact resolver — package semantics', () => {
  it('docs-only change → docsOnly, no scopes', async () => {
    const head = await commit({ 'docs/guide.md': '# guide\n' }, 'docs');
    const out = await impact('HEAD~1', head);
    expect(out.docsOnly).toBe(true);
    expect(out.changedPackages).toEqual([]);
    expect(Object.values(out.scopes).every((v) => v === false)).toBe(true);
  }, 60_000);

  it('core change → core + all transitive consumers + perf', async () => {
    const head = await commit({ 'packages/principles-core/src/change.ts': 'export const x = 1;\n' }, 'core');
    const out = await impact('HEAD~1', head);
    expect(out.changedPackages).toEqual(['@principles/core']);
    expect(out.affectedPackages).toEqual(
      [
        '@principles/core',
        '@principles/codex-adapter',
        '@principles/host-runtime',
        '@principles/pd-cli',
        '@principles/pd-console',
        '@principles/website',
        'principles-disciple',
      ].sort()
    );
    expect(out.scopes.core).toBe(true);
    expect(out.scopes.hostRuntime).toBe(true);
    expect(out.scopes.plugin).toBe(true);
    expect(out.scopes.cli).toBe(true);
    expect(out.scopes.console).toBe(true);
    expect(out.scopes.companion).toBe(false); // companion depends only on install-layout
    expect(out.scopes.installer).toBe(false);
    expect(out.scopes.perf).toBe(true);
    // Core is a DIRECT component of the self-contained release asset
    // (build-release-asset.mjs REQUIRED_COMPONENTS) — a core change is
    // release-verification-relevant even though publish-npm's lockstep rule
    // does not republish the installer for core-only merges (publish
    // selection and artifact impact are different questions).
    expect(out.scopes.release).toBe(true);
    expect(out.reasons.release).toContain('component');
  }, 60_000);

  it('plugin change → plugin + consumers + release lockstep overlay', async () => {
    const head = await commit({ 'packages/openclaw-plugin/src/change.ts': 'export const x = 1;\n' }, 'plugin');
    const out = await impact('HEAD~1', head);
    expect(out.scopes.plugin).toBe(true);
    expect(out.scopes.cli).toBe(true);
    expect(out.scopes.console).toBe(true);
    expect(out.scopes.release).toBe(true);
    expect(out.reasons.release).toContain('asset');
  }, 60_000);

  it('console-only change → console scope + release-asset impact, installer package tests NOT claimed', async () => {
    const head = await commit({ 'packages/pd-console/src/change.ts': 'export const x = 1;\n' }, 'console');
    const out = await impact('HEAD~1', head);
    expect(out.scopes.console).toBe(true);
    expect(out.scopes.installer).toBe(false);
    expect(out.scopes.release).toBe(true);
    expect(out.reasons.release).toContain('asset');
  }, 60_000);

  it('cli-only change → cli scope only', async () => {
    const head = await commit({ 'packages/pd-cli/src/change.ts': 'export const x = 1;\n' }, 'cli');
    const out = await impact('HEAD~1', head);
    expect(out.scopes.cli).toBe(true);
    expect(out.affectedPackages).toEqual(['@principles/pd-cli']);
    expect(out.scopes.core).toBe(false);
    // pd-cli is itself a release asset component.
    expect(out.scopes.release).toBe(true);
  }, 60_000);

  it('host-runtime change → runtime consumers', async () => {
    const head = await commit({ 'packages/host-runtime/src/change.ts': 'export const x = 1;\n' }, 'hr');
    const out = await impact('HEAD~1', head);
    expect(out.scopes.hostRuntime).toBe(true);
    expect(out.scopes.codexAdapter).toBe(true);
    expect(out.scopes.plugin).toBe(true);
    expect(out.scopes.cli).toBe(true);
    expect(out.scopes.console).toBe(true);
    expect(out.scopes.core).toBe(false);
    // host-runtime is a release asset component.
    expect(out.scopes.release).toBe(true);
  }, 60_000);

  it('codex-adapter change → adapter + cli', async () => {
    const head = await commit({ 'packages/codex-adapter/src/change.ts': 'export const x = 1;\n' }, 'codex');
    const out = await impact('HEAD~1', head);
    expect(out.scopes.codexAdapter).toBe(true);
    expect(out.scopes.cli).toBe(true);
    expect(out.scopes.plugin).toBe(false);
    // codex-adapter reaches the asset through pd-cli's bundled node_modules.
    expect(out.scopes.release).toBe(true);
    expect(out.reasons.release).toContain('transitive');
  }, 60_000);

  it('install-layout change → layout consumers incl. installer → release evidence', async () => {
    const head = await commit({ 'packages/install-layout/src/change.ts': 'export const x = 1;\n' }, 'layout');
    const out = await impact('HEAD~1', head);
    expect(out.scopes.installLayout).toBe(true);
    expect(out.scopes.hostRuntime).toBe(true);
    expect(out.scopes.companion).toBe(true);
    expect(out.scopes.installer).toBe(true);
    expect(out.scopes.release).toBe(true);
  }, 60_000);

  it('companion change → companion only', async () => {
    const head = await commit({ 'packages/pd-companion/src/change.ts': 'export const x = 1;\n' }, 'companion');
    const out = await impact('HEAD~1', head);
    expect(out.affectedPackages).toEqual(['@principles/pd-companion']);
  }, 60_000);

  it('website-only and companion-only changes do NOT claim release evidence (release boundary negative control)', async () => {
    const webHead = await commit({ 'packages/website/src/change.ts': 'export const x = 1;\n' }, 'website-rel');
    const web = await impact('HEAD~1', webHead);
    expect(web.scopes.website).toBe(true);
    expect(web.scopes.release).toBe(false);

    const compHead = await commit({ 'packages/pd-companion/src/change.ts': 'export const x = 2;\n' }, 'companion-rel');
    const comp = await impact('HEAD~1', compHead);
    expect(comp.scopes.companion).toBe(true);
    expect(comp.scopes.release).toBe(false);
  }, 60_000);

  it('installer source change → installer + release', async () => {
    const head = await commit({ 'packages/create-principles-disciple/src/change.ts': 'export const x = 1;\n' }, 'installer');
    const out = await impact('HEAD~1', head);
    expect(out.scopes.installer).toBe(true);
    expect(out.scopes.release).toBe(true);
  }, 60_000);
});

describe('impact resolver — conservative root rules', () => {
  it('package-lock.json change → repo + EVERY package scope broadened + release', async () => {
    const head = await commit({ 'package-lock.json': '# lockfile v3 updated\n' }, 'lock');
    const out = await impact('HEAD~1', head);
    expect(out.scopes.repo).toBe(true);
    for (const scope of ['core', 'installLayout', 'hostRuntime', 'codexAdapter', 'plugin', 'cli', 'console', 'companion', 'installer', 'website']) {
      expect(out.scopes[scope]).toBe(true);
    }
    expect(out.scopes.release).toBe(true);
    expect(out.reasons.core).toContain('broadened');
    expect(out.docsOnly).toBe(false);
  }, 60_000);

  it('root package.json change → broad', async () => {
    const head = await commit({ 'package.json': JSON.stringify({ name: 'fixture-monorepo', workspaces: ['packages/*'] }) }, 'rootpkg');
    const out = await impact('HEAD~1', head);
    expect(out.scopes.repo).toBe(true);
    expect(out.scopes.core).toBe(true);
  }, 60_000);

  it('CI workflow change → broad', async () => {
    fs.mkdirSync(path.join(repo, '.github', 'workflows'), { recursive: true });
    const head = await commit({ '.github/workflows/ci.yml': 'name: CI\n' }, 'ciwf');
    const out = await impact('HEAD~1', head);
    expect(out.scopes.repo).toBe(true);
    expect(out.scopes.plugin).toBe(true);
  }, 60_000);

  it('release workflow change → release scope (not just broad)', async () => {
    const head = await commit({ '.github/workflows/publish-npm.yml': 'name: Publish\n' }, 'pubwf');
    const out = await impact('HEAD~1', head);
    expect(out.scopes.release).toBe(true);
    expect(out.reasons.release).toContain('release workflow');
  }, 60_000);

  it('release-locks change → release scope', async () => {
    const head = await commit({ 'packages/create-principles-disciple/release-locks/core.json': '{}\n' }, 'locks');
    const out = await impact('HEAD~1', head);
    expect(out.scopes.release).toBe(true);
    expect(out.scopes.installer).toBe(true);
  }, 60_000);

  it('unknown root file → conservative broad (never skip)', async () => {
    const head = await commit({ 'mystery-tool.config': 'unknown\n' }, 'unknown');
    const out = await impact('HEAD~1', head);
    expect(out.scopes.repo).toBe(true);
    expect(out.scopes.core).toBe(true);
    expect(out.scopes.cli).toBe(true);
    // Broad changes reach release inputs — conservative by construction.
    expect(out.scopes.release).toBe(true);
  }, 60_000);

  it('shared scripts/ tooling change → broad', async () => {
    const head = await commit({ 'scripts/check-something.cjs': '// tool\n' }, 'tooling');
    const out = await impact('HEAD~1', head);
    expect(out.scopes.repo).toBe(true);
    expect(out.scopes.console).toBe(true);
  }, 60_000);

  it('mixed docs + core → NOT docsOnly, core scopes fire', async () => {
    const head = await commit(
      { 'docs/mixed.md': '# mixed\n', 'packages/principles-core/src/mixed.ts': 'export {};\n' },
      'mixed'
    );
    const out = await impact('HEAD~1', head);
    expect(out.docsOnly).toBe(false);
    expect(out.scopes.core).toBe(true);
    expect(out.scopes.console).toBe(true);
  }, 60_000);
});

describe('impact resolver — CLI contract', () => {
  it('is deterministic for the same base/head (AC-6)', async () => {
    const head = await commit({ 'packages/principles-core/src/det.ts': 'export {};\n' }, 'det');
    const a = await impact('HEAD~1', head);
    const b = await impact('HEAD~1', head);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  }, 60_000);

  it('fails loudly when base or head does not resolve', async () => {
    const r = await sh(process.execPath, [IMPACT_SCRIPT, '--base', 'deadbeef', '--head', 'HEAD', '--format', 'json', '--repo', repo], repo);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('git command failed');
  }, 60_000);

  it('markdown output contains the SHADOW ONLY banner and a scope table', async () => {
    const head = await commit({ 'packages/pd-cli/src/md.ts': 'export {};\n' }, 'md');
    const r = await sh(process.execPath, [IMPACT_SCRIPT, '--base', 'HEAD~1', '--head', head, '--format', 'markdown', '--repo', repo], repo);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('SHADOW ONLY');
    expect(r.stdout).toContain('| Scope | Predicted |');
    expect(r.stdout).toContain('Docs-only change');
  }, 60_000);
});
