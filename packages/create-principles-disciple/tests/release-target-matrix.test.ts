import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  assertSupportedLocalReleaseTarget,
  NATIVE_RUNTIME_DEPENDENCY,
  SUPPORTED_NATIVE_TARGETS,
} from '../scripts/release-target-matrix.mjs';

const require = createRequire(import.meta.url);
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..', '..');

describe('native release target matrix', () => {
  it('captures the supported platform, architecture, Node major, and exact ABI combinations', () => {
    expect(NATIVE_RUNTIME_DEPENDENCY).toEqual({ name: 'better-sqlite3', version: '13.0.3', nodeEngine: '>=22' });
    // Resolve through the module system instead of hardcoding ../../..
    const betterSqlite3Manifest = require.resolve('better-sqlite3/package.json', { paths: [path.resolve(thisDir, '..', '..', '..')] });
    const packageMetadata: unknown = JSON.parse(fs.readFileSync(betterSqlite3Manifest, 'utf8'));
    expect(packageMetadata).toMatchObject({ name: NATIVE_RUNTIME_DEPENDENCY.name, version: NATIVE_RUNTIME_DEPENDENCY.version, engines: { node: NATIVE_RUNTIME_DEPENDENCY.nodeEngine } });
    expect(SUPPORTED_NATIVE_TARGETS).toEqual({
      platforms: {
        darwin: ['arm64', 'x64'],
        linux: ['arm64', 'x64'],
        win32: ['x64'],
      },
      nodeAbis: { 22: '127', 24: '137', 26: '147' },
    });
  });

  it('accepts only the exact local supported target', () => {
    const runtime = { platform: 'linux', arch: 'arm64', nodeMajor: 24, nodeAbi: '137' };
    expect(() => assertSupportedLocalReleaseTarget(runtime, runtime)).not.toThrow();
    expect(() => assertSupportedLocalReleaseTarget({ ...runtime, arch: 's390x' }, runtime)).toThrow(/unsupported/i);
    expect(() => assertSupportedLocalReleaseTarget({ ...runtime, nodeMajor: 23 }, runtime)).toThrow(/unsupported/i);
    expect(() => assertSupportedLocalReleaseTarget({ ...runtime, nodeAbi: '999' }, runtime)).toThrow(/ABI/i);
    expect(() => assertSupportedLocalReleaseTarget({ ...runtime, platform: 'darwin' }, runtime)).toThrow(/local release builds/i);
    expect(() => assertSupportedLocalReleaseTarget({ ...runtime, platform: '__proto__' }, runtime)).toThrow(/unsupported native release target/i);
    expect(() => assertSupportedLocalReleaseTarget({ ...runtime, platform: 'constructor' }, runtime)).toThrow(/unsupported native release target/i);
  });

  it('gates publication on the complete supported matrix while keeping PR verification single-tier', () => {
    const fullWorkflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'release-reproducibility-full.yml'), 'utf8');
    const quickWorkflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'release-reproducibility.yml'), 'utf8');
    const publishWorkflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'publish-npm.yml'), 'utf8');

    expect(fullWorkflow).toContain("node: ['22.22.2', '24.12.0', '26.7.0']");
    expect(fullWorkflow).toContain('workflow_call:');
    expect(publishWorkflow).toMatch(/release-reproducibility:\s+[\s\S]*uses: \.\/\.github\/workflows\/release-reproducibility-full\.yml/);
    // Changesets cutover: the gate keys on the release COHORT (needs
    // resolve-cohort), not on the deleted change-detection matrix, and
    // verifies the cohort SHA via the reusable workflow's ref input.
    expect(publishWorkflow).toMatch(/release-reproducibility:\s+[\s\S]*needs: resolve-cohort\s+[\s\S]*if: needs\.resolve-cohort\.outputs\.has_cohort == 'true'/);
    expect(publishWorkflow).toMatch(/release-reproducibility:\s+[\s\S]*ref: \$\{\{ needs\.resolve-cohort\.outputs\.cohort_sha \}\}/);
    // PRI-886: the train needs either the full matrix OR the programmatically
    // verified reused validation evidence (exactly one of them runs).
    expect(publishWorkflow).toContain('needs: [resolve-cohort, release-reproducibility, verify-reused-validation]');
    for (const payloadPath of [
      'packages/create-principles-disciple/src/**',
      'packages/openclaw-plugin/**',
      'packages/pd-cli/**',
      'packages/pd-console/**',
      'packages/principles-core/**',
      'packages/host-runtime/**',
      'packages/install-layout/**',
    ]) {
      expect(quickWorkflow).toContain(`- '${payloadPath}'`);
    }
  });

  it('publishes one multi-platform release from a native matrix with a single assemble', () => {
    const metadataWorkflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'release-metadata.yml'), 'utf8');

    // Three native legs (PRI-733 MVP): linux/x64, win32/x64, darwin/arm64 on
    // Node 24. Each leg builds on its own runner because local-target builds
    // can only target the runner they run on.
    for (const [platform, runner] of [
      ['platform: linux', 'ubuntu-latest'],
      ['platform: win32', 'windows-latest'],
      ['platform: darwin', 'macos-latest'],
    ] as const) {
      expect(metadataWorkflow).toContain(platform);
      expect(metadataWorkflow).toContain(runner);
    }
    expect(metadataWorkflow).toContain('arch: arm64');

    // Exactly one assemble job consumes all legs; the channel pointer is
    // derived once in resolve-inputs (no per-leg sequence advancement).
    expect(metadataWorkflow).toContain('assemble-publish:');
    expect(metadataWorkflow).toContain('needs: [resolve-inputs, build-asset]');
    expect(metadataWorkflow).toContain('--assets-dir');
    expect(metadataWorkflow).not.toContain('--archive ');
    expect(metadataWorkflow).not.toContain('--platform linux');

    // Every downstream job builds/publishes the EXACT commit resolve-inputs
    // measured: its version gate and source_epoch are only truthful for that
    // SHA, so re-resolving a mutable branch ref here would publish metadata
    // naming a different source commit than the verified one (rc-6).
    const pinnedCheckouts = metadataWorkflow.match(/ref: \$\{\{ needs\.resolve-inputs\.outputs\.commit \}\}/g) ?? [];
    expect(pinnedCheckouts).toHaveLength(2);
    // The resolving job itself is the ONLY place allowed to read the mutable
    // input ref (it is what produces the commit the other jobs pin to).
    expect(metadataWorkflow.match(/github\.event\.inputs\.ref/g) ?? []).toHaveLength(1);

    // The artifact-uploading build legs must NOT persist the checkout token:
    // they never push, and a token left in .git/config can end up inside
    // uploaded artifacts (zizmor "artipacked"). assemble-publish is the one
    // job that DOES push gh-pages, so it keeps the default credential.
    const buildAssetJob = metadataWorkflow.slice(
      metadataWorkflow.indexOf('build-asset:'),
      metadataWorkflow.indexOf('assemble-publish:'),
    );
    expect(buildAssetJob).toContain('persist-credentials: false');
    expect(buildAssetJob).not.toContain('git push');

    // The signing-key SECRET lives ONLY in the assemble job — build legs never
    // see it (header comments mention the secret name; only one real usage).
    const secretUsages = metadataWorkflow.match(/secrets\.PD_RELEASE_SIGNING_KEY/g) ?? [];
    expect(secretUsages.length).toBe(1);
    expect(metadataWorkflow.indexOf('assemble-publish:')).toBeLessThan(metadataWorkflow.indexOf('secrets.PD_RELEASE_SIGNING_KEY'));

    // Single-channel concurrency: one publication owns the sequence at a time.
    expect(metadataWorkflow).toContain("group: release-metadata-${{ github.event.inputs.channel || 'stable' }}");

    // Manual workflow only: PR merge CI must not pay for the matrix.
    expect(metadataWorkflow).toContain('workflow_dispatch:');
    expect(metadataWorkflow).not.toContain('pull_request:');
  });

  it('publishes every declared Node ABI on every platform the asset matrix covers', () => {
    const metadataWorkflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'release-metadata.yml'), 'utf8');
    const buildAssetJob = metadataWorkflow.slice(
      metadataWorkflow.indexOf('build-asset:'),
      metadataWorkflow.indexOf('assemble-publish:'),
    );

    // Read the declaration (three fields per leg, in the order the workflow
    // writes them), not the rendered matrix.
    const legs = [...buildAssetJob.matchAll(/- platform: (\S+)\n\s+arch: (\S+)\n\s+node: '(\d+)'/g)]
      .map((match) => ({ platform: match[1] ?? '', arch: match[2] ?? '', nodeMajor: Number(match[3]) }));
    expect(legs.length).toBeGreaterThan(0);

    const declaredMajors = Object.keys(SUPPORTED_NATIVE_TARGETS.nodeAbis).map(Number).sort((a, b) => a - b);

    const byTarget = new Map<string, number[]>();
    for (const leg of legs) {
      const key = `${leg.platform}/${leg.arch}`;
      byTarget.set(key, [...(byTarget.get(key) ?? []), leg.nodeMajor]);
    }
    expect(byTarget.size).toBeGreaterThan(0);

    for (const [target, majors] of byTarget) {
      // A runtime is updateable ONLY when its exact (platform, arch, nodeAbi)
      // triple is published — selectReleaseAsset refuses with
      // `runtime_not_supported` otherwise. `engines.node` is `>= 22`
      // (better-sqlite3's own floor), so a Node 22 host (ABI 127) is
      // declared-supported and must not be the one runtime with no asset.
      // PRI-852 added Node 26 for exactly this reason and left Node 22 behind;
      // Node 22 hosts then had no updateable release at all. A published
      // platform therefore carries the FULL declared ABI axis.
      expect([...majors].sort((a, b) => a - b), `${target} ABI coverage`).toEqual(declaredMajors);
    }

    // One build per asset identity: a duplicated (platform, arch, node) leg
    // would stage two uploads with the same artifact name.
    const identities = legs.map((leg) => `${leg.platform}/${leg.arch}/node${leg.nodeMajor}`);
    expect(new Set(identities).size).toBe(identities.length);
  });

  it('keeps the PR quick-check bounded and materializes each release lock once', () => {
    const quickWorkflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'release-reproducibility.yml'), 'utf8');
    const builderScript = fs.readFileSync(path.join(repoRoot, 'packages', 'create-principles-disciple', 'scripts', 'bundle-plugin.mjs'), 'utf8');

    expect(quickWorkflow).toContain('timeout-minutes: 15');
    expect(quickWorkflow).not.toContain('check:release-locks');
    expect(quickWorkflow.match(/\bnpm ci\b/g)).toHaveLength(1);
    expect(quickWorkflow.match(/build-self-contained-release\.mjs/g)).toHaveLength(1);
    expect(quickWorkflow).toContain("QUICK_CHECK_WARNING_SECONDS: '480'");
    expect(quickWorkflow).toContain('QUICK_CHECK_STARTED_AT');
    expect(quickWorkflow).toContain('::warning title=Release reproducibility quick-check is slow');

    for (const component of ['core', 'host-runtime', 'plugin', 'pd-cli', 'console', 'install-layout', 'release-manager', 'codex-adapter']) {
      const materialization = new RegExp(`installBundledRuntimeDependencies\\([^\\n]*'${component}'`, 'g');
      expect(builderScript.match(materialization)).toHaveLength(1);
    }
  });

  it('publishes the release cohort serially in one job whose step order is the dependency order', () => {
    const publishWorkflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'publish-npm.yml'), 'utf8');
    const actionYml = fs.readFileSync(path.join(repoRoot, '.github', 'actions', 'publish-npm-package', 'action.yml'), 'utf8');

    // Changesets cutover (SPEC v1.2): the per-package dispatch choice list
    // is GONE — the train has no authority to pick a package or invent a
    // version. It is dispatched with a cohort_sha (the Version Packages PR
    // merge SHA) or auto-detects the latest cohort; the weekly window is
    // reconciliation-only.
    expect(publishWorkflow).not.toMatch(/type: choice/);
    expect(publishWorkflow).toMatch(/cohort_sha/);
    expect(publishWorkflow).toMatch(/cron: '0 4 \* \* 5'/);
    // Every train step receives the cohort SHA (exact-version provenance).
    const cohortUsages = publishWorkflow.match(/cohort_sha: \$\{\{ needs\.resolve-cohort\.outputs\.cohort_sha \}\}/g) ?? [];
    expect(cohortUsages.length).toBeGreaterThanOrEqual(7);

    // --- The REAL execution order: the publish-full-product job's step
    // sequence. A single job runs steps strictly in order and a failed
    // step stops the job, so upstream publish failures block every
    // downstream package — unlike matrix entries, whose declaration order
    // is NOT an execution guarantee (max-parallel only caps concurrency;
    // review P1 round 2, 2026-08-28).
    const serialStart = publishWorkflow.indexOf('publish-full-product:');
    if (serialStart < 0) {
      throw new Error('publish-npm.yml is missing the publish-full-product job');
    }
    const serialBodyStart = publishWorkflow.indexOf('\n', serialStart) + 1;
    const serialRest = publishWorkflow.slice(serialBodyStart);
    const nextJobOffset = serialRest.search(/^[a-zA-Z][a-zA-Z0-9-]*:$/m);
    const serialJob = nextJobOffset >= 0 ? serialRest.slice(0, nextJobOffset) : serialRest;

    // The train checks out THE cohort SHA — never the main HEAD at
    // execution time (SPEC §17.1).
    expect(serialJob).toMatch(/ref: \$\{\{ needs\.resolve-cohort\.outputs\.cohort_sha \}\}/);
    // One job, no matrix scheduling: the steps themselves are the order.
    expect(serialJob).not.toContain('strategy:');
    expect(serialJob).not.toMatch(/^\s*max-parallel:/m);
    // Upstream failure blocks downstream: plain sequential steps with no
    // error tolerance and no always/failure overrides.
    expect(serialJob).not.toContain('continue-on-error');
    expect(serialJob).not.toMatch(/if:\s*(always|failure)\(\)/);
    // PRI-886: the publish action is loaded FROM the tools checkout, not
    // the cohort workspace — tooling fixes must never require a new cohort.
    const serialUsages =
      serialJob.match(/uses: \.\/release-tools\/\.github\/actions\/publish-npm-package/g) ?? [];
    expect(serialUsages).toHaveLength(7);

    const order = [...serialJob.matchAll(/pkg_dir: ([a-z-]+)\n/g)].map((match) => match[1] ?? '');
    expect(order).toEqual([
      'principles-core',
      'install-layout',
      'host-runtime',
      'codex-adapter',
      'openclaw-plugin',
      'pd-cli',
      'create-principles-disciple',
    ]);
    const at = (name: string): number => order.indexOf(name);
    // install-layout precedes host-runtime: host-runtime declares an EXACT
    // runtime dependency on @principles/install-layout@0.1.0 (currently
    // unpublished on npm), so publishing host-runtime first would ship a
    // package whose dependency cannot resolve.
    expect(at('install-layout')).toBeLessThan(at('host-runtime'));
    expect(at('host-runtime')).toBeLessThan(at('codex-adapter'));
    expect(at('codex-adapter')).toBeLessThan(at('pd-cli'));
    // openclaw-plugin precedes pd-cli: @principles/pd-cli declares a runtime
    // dependency on principles-disciple (the plugin, ^2.0.2 at the cohort).
    // Publishing pd-cli first makes its `check_resolvable` preflight fail
    // against a not-yet-published plugin version, aborting the train. The
    // reversed edge (pd-cli before plugin) contradicts this test's own
    // "dependency order" contract and the real package graph (2026-09-21).
    expect(at('openclaw-plugin')).toBeLessThan(at('pd-cli'));
    // The installer re-bundles the freshly published plugin (lockstep), so
    // it must publish last.
    expect(at('openclaw-plugin')).toBeLessThan(at('create-principles-disciple'));

    // Changesets cutover (SPEC v1.2 Phase 4): the single-package matrix
    // publish job, its detect-driven conditions and the push-path
    // change-detection are DELETED — the cohort train above is the only
    // publish path. What replaces each guarantee:
    expect(publishWorkflow).not.toMatch(/^\s{2}publish:/m);
    expect(publishWorkflow).not.toContain('is_full_product=');
    expect(publishWorkflow).not.toMatch(/check_and_add/);

    // PRI-886: the dependency preflight is the tools-checkout
    // deps-preflight script (classified bounded wait; the legacy
    // check_resolvable bash gate is deleted).
    expect(actionYml).toMatch(/deps-preflight\.mjs/);
    expect(actionYml).toMatch(/registry-exact\.mjs/);

    // Credentials boundary: composite actions cannot read the secrets
    // context, so the action must declare token inputs and the serial job
    // must pass them explicitly on every step (review P1 round 3).
    expect(actionYml).not.toContain('secrets.');
    expect(actionYml).toMatch(/NODE_AUTH_TOKEN: \$\{\{ inputs\.npm_token \}\}/);
    // Closing steps (gh CLI release creation via GH_TOKEN, ClawHub sync)
    // moved to the isolated finalize action + job (PRI-886).
    const finalizeYml = fs.readFileSync(
      path.join(repoRoot, '.github', 'actions', 'finalize-npm-release', 'action.yml'),
      'utf8',
    );
    expect(finalizeYml).toMatch(/GH_TOKEN: \$\{\{ inputs\.github_token \}\}/);
    expect(finalizeYml).toMatch(/CLAWHUB_TOKEN: \$\{\{ inputs\.clawhub_token \}\}/);
    const npmTokenUsages = serialJob.match(/npm_token: \$\{\{ secrets\.NPM_TOKEN \}\}/g) ?? [];
    expect(npmTokenUsages).toHaveLength(7);
    const finalizeJobStart = publishWorkflow.indexOf('publish-finalize:');
    expect(finalizeJobStart).toBeGreaterThan(0);
    const finalizeJob = publishWorkflow.slice(finalizeJobStart);
    expect(finalizeJob).toMatch(/github_token: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
    expect(finalizeJob).toMatch(/clawhub_token: \$\{\{ secrets\.CLAWHUB_TOKEN \}\}/);

    // Common build order must build install-layout before host-runtime: a
    // clean `npm ci` leaves install-layout/dist absent, and host-runtime's
    // tsc imports its types entry — building host-runtime first fails with
    // TS2307 before any publish runs (reproduced locally; review P1 round 3).
    const buildOrder = (text) => {
      const core = text.indexOf('Build core');
      const install = text.indexOf('Build install layout');
      const host = text.indexOf('Build host runtime');
      return core >= 0 && core < install && install < host;
    };
    expect(buildOrder(serialJob)).toBe(true);

    // One release train = one full-matrix verification: the reusable
    // full-matrix workflow is referenced exactly once.
    const fullMatrixReference = 'uses: ./.github/workflows/release-reproducibility-full.yml';
    const fullMatrixUses = publishWorkflow.split(fullMatrixReference).length - 1;
    expect(fullMatrixUses).toBe(1);

    // Plugin→installer lockstep survives the cutover as the C4 release-plan
    // guard (a plugin release requires an installer release — enforced on
    // every PR and on the Version PR itself), not as dispatch-case wiring.
    const guardScript = fs.readFileSync(path.join(repoRoot, 'scripts', 'release', 'lib', 'workspace.mjs'), 'utf8');
    expect(guardScript).toContain("when: 'principles-disciple', requires: 'create-principles-disciple'");
    expect(guardScript).toContain("path: 'packages/pd-console/', requires: 'create-principles-disciple'");
  });
});
