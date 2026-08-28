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

  it('offers a full-product release train that runs the full matrix once and publishes in dependency order', () => {
    const publishWorkflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'publish-npm.yml'), 'utf8');

    // The dispatch choice list keeps every single-package option and adds
    // full-product (default unchanged).
    expect(publishWorkflow).toMatch(/type: choice\s+options:\s+[\s\S]*- full-product/);
    expect(publishWorkflow).toMatch(/- principles-disciple\s+[\s\S]*- '@principles\/core'/);
    expect(publishWorkflow).toMatch(/default: 'principles-disciple'/);

    // Extract the full-product matrix JSON from the dispatch case and pin
    // the exact dependency-ordered publish sequence. Plain string slicing
    // (the workflow is line-oriented; the matrix= payload is single-line
    // JSON ending at the first ] after it).
    const caseStart = publishWorkflow.indexOf('"full-product")');
    const matrixMarker = 'matrix=';
    const matrixStart = publishWorkflow.indexOf(matrixMarker, caseStart);
    const matrixEnd = publishWorkflow.indexOf(']', matrixStart);
    if (caseStart < 0 || matrixStart < 0 || matrixEnd < 0) {
      throw new Error('publish-npm.yml full-product case no longer emits a matrix= JSON entry');
    }
    const matrix: unknown = JSON.parse(publishWorkflow.slice(matrixStart + matrixMarker.length, matrixEnd + 1));
    expect(Array.isArray(matrix)).toBe(true);
    const entries = matrix as Array<Record<string, unknown>>;
    const order = entries.map((entry) => entry.npm_name);
    expect(order).toEqual([
      '@principles/core',
      '@principles/host-runtime',
      '@principles/install-layout',
      '@principles/codex-adapter',
      '@principles/pd-cli',
      'principles-disciple',
      'create-principles-disciple',
    ]);
    // Registry-dependency order: pd-cli depends on host-runtime, codex-adapter
    // and install-layout; the installer re-bundles the freshly published
    // plugin (lockstep), so it must publish last.
    expect(order.indexOf('@principles/pd-cli')).toBeGreaterThan(order.indexOf('@principles/host-runtime'));
    expect(order.indexOf('@principles/pd-cli')).toBeGreaterThan(order.indexOf('@principles/codex-adapter'));
    expect(order.indexOf('@principles/pd-cli')).toBeGreaterThan(order.indexOf('@principles/install-layout'));
    expect(order.indexOf('create-principles-disciple')).toBeGreaterThan(order.indexOf('principles-disciple'));
    expect(entries).toHaveLength(7);

    // One release train = one full-matrix verification: the reusable
    // full-matrix workflow is referenced exactly once (jobs:), and the
    // publish matrix stays sequential so dependencies publish in order.
    const fullMatrixReference = 'uses: ./.github/workflows/release-reproducibility-full.yml';
    const fullMatrixUses = publishWorkflow.split(fullMatrixReference).length - 1;
    expect(fullMatrixUses).toBe(1);
    expect(publishWorkflow).toMatch(/publish:[\s\S]*?strategy:\s*[\s\S]*max-parallel: 1/);

    // Single-package dispatch semantics survive: the plugin lockstep case
    // still pairs openclaw-plugin with create-principles-disciple.
    expect(publishWorkflow).toMatch(/"principles-disciple"\)[\s\S]*openclaw-plugin[\s\S]*create-principles-disciple/);
  });
});
