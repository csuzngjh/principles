// Release governance contract tests — fixture-repo driven (SPEC v1.2 §31).
//
// Every scenario drives the REAL scripts (check-pr-release-intent.mjs,
// materialize-version-plan.mjs, resolve-release-cohort.mjs, the
// @changesets/cli this repo pins) inside temporary git repositories that
// mirror the real workspace shape. Registry-facing scenarios live in
// release-registry.test.ts; workflow-shape scenarios in
// release-workflows.test.ts.
//
// SPEC scenario map (T-numbers refer to SPEC v1.2 §31):
//   T2 basic patch .............. version-pr/materializes core patch
//   T3 independent versions ..... version-pr/two packages two bump types
//   T4 internal major+lockfile .. version-pr/internal major + lockfile + npm ci
//   T5 ghost packages ........... version-pr/nested ghost copy untouched
//   T6 unknown package .......... guard/unknown package declaration fails
//   T7 private package .......... guard/private package declaration fails
//   T8 missing changeset ........ guard/release change without intent fails
//   T9 empty changeset .......... guard/docs-only + empty changeset passes
//   T10 version PR self-check .... version-pr describe
//   T11 direct plugin->installer . guard/plugin release without installer fails
//   T12 console->installer ....... guard/console change without installer fails
//   T13 transitive plugin ........ guard/core patch propagates plugin release
//   T14 product version ......... version-pr/root product version unchanged
//   T15 runtime pins ............ version-pr/runtime pin file untouched
//   T16 component mirror ........ version-pr/openclaw.plugin.json mirror
//   T21 main advances ........... cohort/resolve stays on cohort merge SHA
//   T24 weekly no pending ....... cohort/no cohort is a clean exit-2 no-op
//   T26 ERR-131 ................. err131/changeset version is install-free

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELEASE_DIR = path.resolve(HERE, '..', 'release');
const GUARD = path.join(RELEASE_DIR, 'check-pr-release-intent.mjs');
const MATERIALIZE = path.join(RELEASE_DIR, 'materialize-version-plan.mjs');
const COHORT = path.join(RELEASE_DIR, 'resolve-release-cohort.mjs');

let root: string;
let repo: string;

async function sh(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? '' };
  }
}

/** Fixture writer with a hard containment boundary (test hygiene). */
function write(rel: string, content: string) {
  const abs = path.resolve(repo, rel);
  if (abs !== repo && !abs.startsWith(repo + path.sep)) {
    throw new Error(`fixture write escaped the repo boundary: ${rel}`);
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function read(rel: string): string {
  return fs.readFileSync(path.join(repo, rel), 'utf8');
}

async function git(args: string[]): Promise<string> {
  return (await sh('git', args, repo)).stdout.trim();
}

async function commitAll(message: string): Promise<string> {
  await sh('git', ['add', '-A'], repo);
  const r = await sh('git', ['commit', '-m', message, '--no-verify'], repo);
  if (r.code !== 0) throw new Error(`commit failed: ${r.stderr}`);
  return await git(['rev-parse', 'HEAD']);
}

async function runGuard(baseSha: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return sh(process.execPath, [GUARD, '--repo-root', repo], repo, { PR_BASE_SHA: baseSha });
}

/** npm is npm.cmd on Windows and needs a shell there (fixed args, no quoting hazards). */
function npmSh(args: string[], cwd: string) {
  const isWin = process.platform === 'win32';
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      isWin ? 'npm.cmd' : 'npm',
      args,
      { cwd, encoding: 'utf8', shell: isWin, env: process.env },
      (err, stdout, stderr) => {
        resolve({
          code: err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        });
      },
    );
  });
}

function changeset(body: string): string {
  return `---\n${body}\n---\n\nRelease-affecting change for contract tests.\n`;
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-release-contracts-'));
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  await sh('git', ['init', '-b', 'main'], repo);
  await sh('git', ['config', 'user.name', 'test'], repo);
  await sh('git', ['config', 'user.email', 'test@example.com'], repo);

  write(
    'package.json',
    JSON.stringify(
      { name: 'fixture-monorepo', private: true, version: '1.0.0', workspaces: ['packages/*'] },
      null,
      2,
    ) + '\n',
  );
  // @manypkg's NpmTool only recognizes an npm workspace root when
  // package-lock.json EXISTS (existence check) — without it, changesets'
  // plan engine sees a single-package "root" workspace and rejects every
  // changeset as declaring an unknown package. The materialize step rewrites
  // this into a real lockfile (that IS the lockfile materialization).
  write(
    'package-lock.json',
    JSON.stringify({ name: 'fixture-monorepo', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'fixture-monorepo', version: '1.0.0' } } }, null, 2) + '\n',
  );
  write(
    '.changeset/config.json',
    JSON.stringify(
      {
        $schema: 'https://unpkg.com/@changesets/config@3.1.3/schema.json',
        changelog: '@changesets/cli/changelog',
        commit: false,
        fixed: [],
        linked: [],
        access: 'restricted',
        baseBranch: 'main',
        updateInternalDependencies: 'patch',
        ignore: [],
      },
      null,
      2,
    ) + '\n',
  );
  const pkg = (name: string, version: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ name, version, main: 'index.js', ...extra }, null, 2) + '\n';
  write('packages/core/package.json', pkg('@principles/core', '1.0.0'));
  write('packages/core/index.js', "module.exports = 'core';\n");
  write(
    'packages/openclaw-plugin/package.json',
    pkg('principles-disciple', '1.0.0', { dependencies: { '@principles/core': '^1.0.0' } }),
  );
  write('packages/openclaw-plugin/index.js', "module.exports = 'plugin';\n");
  write(
    'packages/openclaw-plugin/openclaw.plugin.json',
    JSON.stringify({ name: 'principles-disciple', version: '1.0.0' }, null, 2) + '\n',
  );
  write('packages/create-principles-disciple/package.json', pkg('create-principles-disciple', '1.0.0'));
  write('packages/create-principles-disciple/index.js', "module.exports = 'installer';\n");
  // Runtime pin artifact (C5 territory — must never be touched by a Version PR).
  write('packages/create-principles-disciple/release-locks/core.json', JSON.stringify({ pin: '1.0.0' }, null, 2) + '\n');
  // Ghost nested copy inside the installer (SPEC §7.3): NOT a workspace
  // member, never discovered, never versioned.
  write('packages/create-principles-disciple/vendor/core-copy/package.json', pkg('@principles/core', '0.0.1-ghost'));
  write('packages/pd-console/package.json', pkg('@principles/pd-console', '0.1.0', { private: true }));
  write('packages/pd-console/index.js', "module.exports = 'console';\n");
  await commitAll('base');
}, 120000);

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('guard: normal PR release-intent contract', () => {
  it('T8: release-affecting publishable change without a changeset fails', async () => {
    const base = await git(['rev-parse', 'HEAD']);
    write('packages/core/src-thing.js', 'export {};\n');
    await commitAll('feat(core): new thing');
    const r = await runGuard(base);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('N-3');
    await git(['reset', '--hard', base]);
  });

  it('passes with a matching changeset (baseline for later tests)', async () => {
    const base = await git(['rev-parse', 'HEAD']);
    write('packages/core/src-thing.js', 'export {};\n');
    write('.changeset/core-patch.md', changeset("'@principles/core': patch"));
    await commitAll('feat(core): new thing with intent');
    const r = await runGuard(base);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('RELEASE_INTENT_GUARD PASS mode=normal');
    await git(['reset', '--hard', base]);
  });

  it('T6: unknown package declaration fails', async () => {
    const base = await git(['rev-parse', 'HEAD']);
    write('packages/core/src-thing.js', 'export {};\n');
    write('.changeset/bad.md', changeset("'not-a-package': patch"));
    await commitAll('feat(core): unknown package');
    const r = await runGuard(base);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('N-1');
    await git(['reset', '--hard', base]);
  });

  it('T7: private package declaration fails', async () => {
    const base = await git(['rev-parse', 'HEAD']);
    write('packages/pd-console/index.js', "module.exports = 'console2';\n");
    write('.changeset/bad.md', changeset("'@principles/pd-console': patch"));
    await commitAll('feat(console): private declaration');
    const r = await runGuard(base);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('N-2');
    await git(['reset', '--hard', base]);
  });

  it('N-4: invalid bump type fails', async () => {
    const base = await git(['rev-parse', 'HEAD']);
    write('packages/core/src-thing.js', 'export {};\n');
    write('.changeset/bad.md', changeset("'@principles/core': weird"));
    await commitAll('feat(core): bad type');
    const r = await runGuard(base);
    expect(r.code).toBe(1);
    // The official parser rejects invalid types outright (N-parse/N-4 —
    // only major/minor/patch ever reach the plan).
    expect(r.stderr).toMatch(/N-parse|N-4/);
    expect(r.stderr).toContain('invalid version type');
    await git(['reset', '--hard', base]);
  });

  it('T9: docs-only conservative hit + official empty changeset passes', async () => {
    const base = await git(['rev-parse', 'HEAD']);
    write('packages/core/NOTES.md', 'notes\n');
    write('.changeset/no-release.md', '---\n---\n\nExplicitly no release needed: docs only.\n');
    await commitAll('docs(core): notes');
    const r = await runGuard(base);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('explicit-no-release');
    await git(['reset', '--hard', base]);
  });

  it('T11/C4-1: direct plugin release without installer intent fails', async () => {
    const base = await git(['rev-parse', 'HEAD']);
    write('packages/openclaw-plugin/index.js', "module.exports = 'plugin2';\n");
    write('.changeset/plugin.md', changeset("'principles-disciple': patch"));
    await commitAll('fix(plugin): thing');
    const r = await runGuard(base);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('C4');
    await git(['reset', '--hard', base]);
  });

  it('T12/C4-2: console payload change without installer intent fails; with it passes', async () => {
    const base = await git(['rev-parse', 'HEAD']);
    write('packages/pd-console/index.js', "module.exports = 'console3';\n");
    await commitAll('feat(console): ui');
    const fail = await runGuard(base);
    expect(fail.code).toBe(1);
    expect(fail.stderr).toContain('C4');
    await git(['reset', '--hard', base]);

    write('packages/pd-console/index.js', "module.exports = 'console3';\n");
    write('.changeset/console.md', changeset("'create-principles-disciple': patch"));
    await commitAll('feat(console): ui with installer intent');
    const pass = await runGuard(base);
    expect(pass.code).toBe(0);
    await git(['reset', '--hard', base]);
  });

  it('N-version: hand-edited package version field in a normal PR fails', async () => {
    const base = await git(['rev-parse', 'HEAD']);
    write(
      'packages/core/package.json',
      JSON.stringify({ name: '@principles/core', version: '1.0.1', main: 'index.js' }, null, 2) + '\n',
    );
    await commitAll('chore(core): hand bump');
    const r = await runGuard(base);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('N-version');
    await git(['reset', '--hard', base]);
  });

  it('T13/C4-3: plugin in the final plan via a sibling changeset requires the installer', async () => {
    // Reality check vs the SPEC's wording: under changesets v5 with
    // updateInternalDependencies: "patch", an internal dep release does NOT
    // auto-release dependents — the author adds the plugin changeset next to
    // the core one (that IS the transitive path in practice; a core major
    // additionally requires the manual dependent range update, verified in
    // the T4 test). The C4 guard is plan-based: whatever lands the plugin in
    // the final plan — direct changeset or sibling — demands the installer.
    const base = await git(['rev-parse', 'HEAD']);
    write('.changeset/core.md', changeset("'@principles/core': patch"));
    write('.changeset/plugin.md', changeset("'principles-disciple': patch"));
    await commitAll('chore: core + plugin changesets without installer');
    const r = await runGuard(base);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('C4');
    write('.changeset/installer.md', changeset("'create-principles-disciple': patch"));
    await commitAll('chore: add installer intent');
    const pass = await runGuard(base);
    expect(pass.code).toBe(0);
    await git(['reset', '--hard', base]);
  });
});

describe('version-pr: Version Packages PR contract', () => {
  it('T2/T3/T10/T14/T16/T5/T15: materialization reproduces; independent versions; containment; mirror; ghost untouched', async () => {
    write('.changeset/core.md', changeset("'@principles/core': patch"));
    write('.changeset/plugin.md', changeset("'principles-disciple': minor"));
    write('.changeset/installer.md', changeset("'create-principles-disciple': patch"));
    await commitAll('chore: pending changesets');
    const pre = await git(['rev-parse', 'HEAD']);

    const m = await sh(process.execPath, [MATERIALIZE, '--repo-root', repo], repo, {
      PD_RELEASE_RETRY_DELAY_MS: '1',
    });
    expect(m.code).toBe(0);
    await commitAll('chore: version packages [version-packages]');

    const r = await runGuard(pre);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('mode=version-pr');
    expect(r.stdout).toContain('@principles/core@1.0.1');
    expect(r.stdout).toContain('principles-disciple@1.1.0');
    expect(r.stdout).toContain('create-principles-disciple@1.0.1');

    // T14: root Product Version untouched by the materialization.
    expect(JSON.parse(read('package.json')).version).toBe('1.0.0');
    // T16: approved component mirror synced to the plugin version.
    expect(JSON.parse(read('packages/openclaw-plugin/openclaw.plugin.json')).version).toBe('1.1.0');
    // Changelog was materialized for the bumped packages.
    expect(read('packages/core/CHANGELOG.md')).toContain('1.0.1');
    // T5: ghost nested copy NOT discovered/versioned/modified.
    expect(JSON.parse(read('packages/create-principles-disciple/vendor/core-copy/package.json')).version).toBe(
      '0.0.1-ghost',
    );
    // T15: runtime pin artifact untouched.
    expect(read('packages/create-principles-disciple/release-locks/core.json')).toBe(
      JSON.stringify({ pin: '1.0.0' }, null, 2) + '\n',
    );

    // T10 (negative): a "Version PR" that smuggles a source file fails.
    const materialized = await git(['rev-parse', 'HEAD']);
    write('packages/core/smuggled.js', 'export {};\n');
    await commitAll('chore: version packages plus smuggled source');
    const bad = await runGuard(materialized);
    expect(bad.code).toBe(1);
    await git(['reset', '--hard', materialized]);

    // T10/T15 (negative): a "Version PR" that also touches a runtime pin
    // fails — the pin file is outside the materialization allowlist, so the
    // diff is not reproducible and the version edits then fail N-version.
    // (A normal PR editing ONLY the root Product Version is legitimate —
    // Product Version has its own authority (PRI-849/PRI-853) and is not
    // this guard's business; the pure Version PR itself can never touch it,
    // proven by the reproduction allowlist in the positive case above.)
    await git(['reset', '--hard', pre]);
    const m2 = await sh(process.execPath, [MATERIALIZE, '--repo-root', repo], repo, {
      PD_RELEASE_RETRY_DELAY_MS: '1',
    });
    expect(m2.code).toBe(0);
    write(
      'packages/create-principles-disciple/release-locks/core.json',
      JSON.stringify({ pin: '9.9.9' }, null, 2) + '\n',
    );
    await commitAll('chore: version packages plus runtime pin edit');
    const badPin = await runGuard(pre);
    expect(badPin.code).toBe(1);
    // restore the clean materialized state for the following tests
    await git(['reset', '--hard', materialized]);
  }, 300000);

  it('T4: internal dependency major + manual range update + lockfile materialization + fresh npm ci', async () => {
    // Plan a core MAJOR with the plugin's manual range update in the same PR
    // (patch-mode changesets does not rewrite ranges on internal major
    // bumps — the range edit ships with the PR, SPEC §13.3 acceptance).
    write('.changeset/core-major.md', changeset("'@principles/core': major"));
    const pluginPkg = JSON.parse(read('packages/openclaw-plugin/package.json'));
    pluginPkg.dependencies['@principles/core'] = '^2.0.0';
    write('packages/openclaw-plugin/package.json', JSON.stringify(pluginPkg, null, 2) + '\n');
    write('.changeset/plugin-follow.md', changeset("'principles-disciple': patch"));
    write('.changeset/installer-follow.md', changeset("'create-principles-disciple': patch"));
    await commitAll('feat(core): breaking change + dependent range update');

    const pre = await git(['rev-parse', 'HEAD']);
    const m = await sh(process.execPath, [MATERIALIZE, '--repo-root', repo], repo, { PD_RELEASE_RETRY_DELAY_MS: '1' });
    expect(m.code).toBe(0);
    await commitAll('chore: version packages [version-packages]');

    expect(JSON.parse(read('packages/core/package.json')).version).toBe('2.0.0');
    // The Version PR (with its lockfile diff) reproduces.
    const guardRun = await runGuard(pre);
    expect(guardRun.code).toBe(0);
    expect(guardRun.stdout).toContain('mode=version-pr');

    // Fresh checkout npm ci (fixture has no external deps — offline-safe)
    // and consumer resolution of the new major.
    const fresh = path.join(root, 'fresh-checkout');
    fs.mkdirSync(fresh, { recursive: true });
    const buf = execFileSync('git', ['archive', '--format=tar', 'HEAD'], { cwd: repo, maxBuffer: 512 * 1024 * 1024 });
    fs.writeFileSync(path.join(fresh, 'archive.tar'), buf);
    execFileSync('tar', ['-xf', 'archive.tar'], { cwd: fresh });
    fs.rmSync(path.join(fresh, 'archive.tar'), { force: true });
    const ci = await npmSh(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], fresh);
    expect(ci.code).toBe(0);
    const consumer = await sh(
      process.execPath,
      ['-e', "console.log(require('@principles/core/package.json').version)"],
      path.join(fresh, 'node_modules'),
    );
    expect(consumer.stdout.trim()).toBe('2.0.0');
  }, 300000);
});

describe('cohort: release cohort resolution', () => {
  it('T21/T24: main advancing past a cohort does not change the release SHA; no cohort is a clean no-op', async () => {
    // Plan + materialize a version commit on a branch, then merge it no-ff
    // so main gains a real MERGE commit (the cohort), then advance main
    // with an unrelated feature commit.
    const before = await git(['rev-parse', 'HEAD']);
    write('.changeset/core2.md', changeset("'@principles/core': patch"));
    await commitAll('chore: pending changeset');
    await sh('git', ['checkout', '-b', 'vp-branch'], repo);
    const m = await sh(process.execPath, [MATERIALIZE, '--repo-root', repo], repo, { PD_RELEASE_RETRY_DELAY_MS: '1' });
    expect(m.code).toBe(0);
    await commitAll('chore: version packages [version-packages]');
    await sh('git', ['checkout', 'main'], repo);
    // A real main-only commit between the version plan and the merge (an
    // empty commit would make commitAll fail).
    write('between-plan-and-merge-marker.md', 'marker\n');
    await commitAll('chore: unrelated main commit between version plan and merge');
    const merge = await sh('git', ['merge', '--no-ff', '-m', 'merge version packages', 'vp-branch'], repo);
    expect(merge.code).toBe(0);
    const mergeSha = await git(['rev-parse', 'HEAD']);
    expect(mergeSha).not.toBe(before);

    // Feature B lands AFTER the cohort merge.
    write('packages/core/post-cohort.js', 'export {};\n');
    await commitAll('feat(core): after cohort');

    // Default resolution finds the COHORT merge SHA (not HEAD, not B). The
    // registry check afterwards hits the real registry for fixture-private
    // versions — it cannot succeed, but the cohort SHA is already printed
    // in the log before that point.
    const resolved = await sh(process.execPath, [COHORT, '--repo-root', repo, '--scan-limit', '10'], repo, {
      PD_RELEASE_RETRY_DELAY_MS: '1',
    });
    expect(resolved.stdout + resolved.stderr).toContain(mergeSha.slice(0, 10));
    // The explicit forms prove identity semantics.
    const isCohort = await sh(process.execPath, [COHORT, '--repo-root', repo, '--is-cohort', mergeSha], repo, {
      PD_RELEASE_RETRY_DELAY_MS: '1',
    });
    expect(isCohort.code).toBe(0);
    const notCohort = await sh(process.execPath, [COHORT, '--repo-root', repo, '--is-cohort', before], repo, {
      PD_RELEASE_RETRY_DELAY_MS: '1',
    });
    expect(notCohort.code).toBe(1);

    // T24: a tree with no cohort anywhere resolves to a clean exit-2 no-op.
    const empty = path.join(root, 'empty-repo');
    fs.mkdirSync(empty, { recursive: true });
    await sh('git', ['init', '-b', 'main'], empty);
    await sh('git', ['config', 'user.name', 'test'], empty);
    await sh('git', ['config', 'user.email', 'test@example.com'], empty);
    fs.writeFileSync(path.join(empty, 'README.md'), 'x\n');
    await sh('git', ['add', '-A'], empty);
    await sh('git', ['commit', '-m', 'init', '--no-verify'], empty);
    const noCohort = await sh(process.execPath, [COHORT, '--repo-root', empty], empty);
    expect(noCohort.code).toBe(2);
    expect(noCohort.stdout).toContain('"cohort":false');
  }, 300000);
});

describe('err131: changeset version is install-free (T26)', () => {
  it('mutates no lockfile and creates no node_modules', async () => {
    const lockBefore = read('package-lock.json');
    write('.changeset/t26.md', changeset("'@principles/core': patch"));
    await commitAll('chore: t26 changeset');
    const run = await sh(
      process.execPath,
      [
        '-e',
        `import { runChangesetVersion } from ${JSON.stringify(
          pathToFileURL(path.join(RELEASE_DIR, 'lib', 'version-plan.mjs')).href,
        )}; const r = runChangesetVersion(process.argv[1]); process.exit(r.status ?? 1);`,
      ],
      repo,
    );
    expect(run.code).toBe(0);
    // No install, no lifecycle, no node_modules, no lockfile mutation.
    expect(fs.existsSync(path.join(repo, 'node_modules'))).toBe(false);
    expect(read('package-lock.json')).toBe(lockBefore);
    // ...but the version did land (the run is not a silent no-op).
    // (core is at 2.0.1 after the cohort test's patch; this patch -> 2.0.2)
    expect(JSON.parse(read('packages/core/package.json')).version).toBe('2.0.2');
    // ...and the changeset was consumed.
    expect(fs.existsSync(path.join(repo, '.changeset/t26.md'))).toBe(false);
    await commitAll('chore: t26 materialized');
  }, 120000);
});
