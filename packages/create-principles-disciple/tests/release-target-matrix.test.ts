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
    expect(publishWorkflow).toMatch(/release-reproducibility:\s+[\s\S]*needs: detect\s+[\s\S]*if: needs\.detect\.outputs\.matrix != '\[\]'/);
    expect(publishWorkflow).toContain('needs: [detect, release-reproducibility]');
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

    for (const component of ['core', 'host-runtime', 'plugin', 'pd-cli', 'console', 'install-layout']) {
      const materialization = new RegExp(`installBundledRuntimeDependencies\\([^\\n]*'${component}'`, 'g');
      expect(builderScript.match(materialization)).toHaveLength(1);
    }
  });

  it('publishes full-product serially in one job whose step order is the dependency order', () => {
    const publishWorkflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'publish-npm.yml'), 'utf8');
    const actionYml = fs.readFileSync(path.join(repoRoot, '.github', 'actions', 'publish-npm-package', 'action.yml'), 'utf8');

    // The dispatch choice list keeps every single-package option and adds
    // full-product (default unchanged).
    expect(publishWorkflow).toMatch(/type: choice\s+options:\s+[\s\S]*- full-product/);
    expect(publishWorkflow).toMatch(/- principles-disciple\s+[\s\S]*- '@principles\/core'/);
    expect(publishWorkflow).toMatch(/default: 'principles-disciple'/);

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

    expect(serialJob).toMatch(/if: needs\.detect\.outputs\.is_full_product == 'true'/);
    // One job, no matrix scheduling: the steps themselves are the order.
    expect(serialJob).not.toContain('strategy:');
    expect(serialJob).not.toMatch(/^\s*max-parallel:/m);
    // Upstream failure blocks downstream: plain sequential steps with no
    // error tolerance and no always/failure overrides.
    expect(serialJob).not.toContain('continue-on-error');
    expect(serialJob).not.toMatch(/if:\s*(always|failure)\(\)/);
    const serialUsages = serialJob.match(/uses: \.\/\.github\/actions\/publish-npm-package/g) ?? [];
    expect(serialUsages).toHaveLength(7);

    const order = [...serialJob.matchAll(/pkg_dir: ([a-z-]+)\n/g)].map((match) => match[1] ?? '');
    expect(order).toEqual([
      'principles-core',
      'install-layout',
      'host-runtime',
      'codex-adapter',
      'pd-cli',
      'openclaw-plugin',
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
    expect(at('pd-cli')).toBeLessThan(at('openclaw-plugin'));
    // The installer re-bundles the freshly published plugin (lockstep), so
    // it must publish last.
    expect(at('openclaw-plugin')).toBeLessThan(at('create-principles-disciple'));

    // The matrix publish job no longer serves full-product runs: it stays
    // for single-package dispatch / push / schedule only.
    expect(publishWorkflow).toMatch(/publish:\s*[\s\S]{0,900}?if: needs\.detect\.outputs\.matrix != '\[\]' && needs\.detect\.outputs\.is_full_product != 'true'/);
    // detect emits the gate for both dispatch shapes and non-dispatch paths.
    expect(publishWorkflow).toContain('is_full_product=$IS_FULL');
    expect(publishWorkflow).toContain('is_full_product=false');
    expect(publishWorkflow).toMatch(/outputs:\s*[\s\S]{0,200}?is_full_product: \$\{\{ steps\.detect\.outputs\.is_full_product \}\}/);

    // The shared publish action gives host-runtime its own registry
    // preflight for the exact install-layout dependency (fail loud with a
    // next action instead of publishing an uninstallable package).
    expect(actionYml).toMatch(/host-runtime\)[\s\S]{0,600}?check_published "@principles\/install-layout"/);
    // The single-package matrix path carries the same preflight.
    expect(publishWorkflow).toMatch(/"host-runtime" \][\s\S]{0,600}?check_published "@principles\/install-layout"/);

    // Credentials boundary: composite actions cannot read the secrets
    // context, so the action must declare token inputs and the serial job
    // must pass them explicitly on every step (review P1 round 3).
    expect(actionYml).not.toContain('secrets.');
    expect(actionYml).toMatch(/NODE_AUTH_TOKEN: \$\{\{ inputs\.npm_token \}\}/);
    expect(actionYml).toMatch(/GITHUB_TOKEN: \$\{\{ inputs\.github_token \}\}/);
    expect(actionYml).toMatch(/CLAWHUB_TOKEN: \$\{\{ inputs\.clawhub_token \}\}/);
    const tokenProps = ['npm_token', 'github_token', 'clawhub_token'];
    for (const prop of tokenProps) {
      const usages = serialJob.match(new RegExp(`${prop}: \\$\\{\\{ secrets\\.[A-Z_]+ \\}\\}`, 'g')) ?? [];
      expect(usages).toHaveLength(7);
    }

    // Common build order (both publish paths) must build install-layout
    // before host-runtime: a clean `npm ci` leaves install-layout/dist
    // absent, and host-runtime's tsc imports its types entry — building
    // host-runtime first fails with TS2307 before any publish runs
    // (reproduced locally; review P1 round 3).
    const buildOrder = (text) => {
      const core = text.indexOf('Build core');
      const install = text.indexOf('Build install layout');
      const host = text.indexOf('Build host runtime');
      return core >= 0 && core < install && install < host;
    };
    expect(buildOrder(serialJob)).toBe(true);
    expect(buildOrder(publishWorkflow.slice(publishWorkflow.indexOf('  publish:'), publishWorkflow.indexOf('  publish-full-product:')))).toBe(true);

    // Push-path detection order also puts install-layout before host-runtime.
    expect(publishWorkflow).toMatch(/check_and_add "install-layout"[\s\S]{0,300}?check_and_add "host-runtime"/);

    // One release train = one full-matrix verification: the reusable
    // full-matrix workflow is referenced exactly once.
    const fullMatrixReference = 'uses: ./.github/workflows/release-reproducibility-full.yml';
    const fullMatrixUses = publishWorkflow.split(fullMatrixReference).length - 1;
    expect(fullMatrixUses).toBe(1);

    // Single-package dispatch semantics survive: the plugin lockstep case
    // still pairs openclaw-plugin with create-principles-disciple.
    expect(publishWorkflow).toMatch(/"principles-disciple"\)[\s\S]*openclaw-plugin[\s\S]*create-principles-disciple/);
  });
});
