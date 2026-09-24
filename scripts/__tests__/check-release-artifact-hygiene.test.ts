// PRI-918 Phase 5: the release-artifact hygiene gate must fail loud on
// injected test artifacts, pass on production shapes, and never flag the
// ERR-149 documented false-positive red lines.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyArtifactViolation } from '../build/test-artifacts.mjs';
import { scanArtifactTree, scanTarballEntries } from '../check-release-artifact-hygiene.mjs';

const temps = [];
afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

function makeTree(files) {
  const root = mkdtempSync(join(tmpdir(), 'pd-hygiene-'));
  temps.push(root);
  for (const rel of files) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, 'x\n');
  }
  return root;
}

describe('classifyArtifactViolation — Phase 1 contract', () => {
  it('flags compiled and source test file shapes', () => {
    for (const p of ['foo.test.js', 'foo.test.ts', 'foo.spec.js', 'foo.spec.ts', 'foo.snap', 'nested/dir/bar.test.d.ts']) {
      expect(classifyArtifactViolation(p), p).toBe('NO_TEST_FILES');
    }
  });

  it('flags test-owned directory segments (mission Phase 1 list)', () => {
    for (const p of [
      'tests/', 'tests/fixture.json', '__tests__/a.js', 'fixtures/seed.json',
      '__fixtures__/a.js', 'coverage/lcov.info', '.vitest/cache.json',
      'snapshots/a.txt', 'deep/inner/tests/x.js',
    ]) {
      expect(classifyArtifactViolation(p), p).toBe('NO_TEST_DIRECTORIES');
    }
  });

  it('does NOT flag production shapes (ERR-149 red lines + samples)', () => {
    for (const p of [
      'runtime-v2/internalization/golden-dogfood-fixtures.js',
      'runtime-v2/adapter/split-pipeline-fixtures.js',
      'runtime-v2/adapter/test-double-runtime-adapter.js',
      'samples/example.json', 'samples/fixtures-readme.md',
      'trust/root.json', '_release/product-identity.json',
      'index.js', 'codec/index.d.ts',
    ]) {
      expect(classifyArtifactViolation(p), p).toBeNull();
    }
  });
});

describe('scanArtifactTree — PASS / injection matrix (mission Phase 5)', () => {
  it('1. clean production artifact passes', () => {
    const root = makeTree([
      'index.js', 'codec/index.d.ts', 'runtime-v2/adapter/test-double-runtime-adapter.js',
      'samples/example.json', 'package.json',
    ]);
    const { violations, scanned } = scanArtifactTree('pkg/dist', root);
    expect(violations).toEqual([]);
    expect(scanned).toBe(5);
  });

  it('2. injected foo.test.js fails with NO_TEST_FILES', () => {
    const root = makeTree(['index.js', 'foo.test.js']);
    const { violations } = scanArtifactTree('packages/core/dist', root);
    expect(violations).toEqual([
      { artifact: 'packages/core/dist/foo.test.js', rule: 'NO_TEST_FILES' },
    ]);
  });

  it('3. injected tests/fixture.json fails', () => {
    const root = makeTree(['tests/fixture.json']);
    const { violations } = scanArtifactTree('payload/core', root);
    expect(violations.map((v) => v.rule)).toContain('NO_TEST_DIRECTORIES');
    expect(violations.some((v) => v.artifact.includes('tests/fixture.json'))).toBe(true);
  });

  it('4. legitimate samples/example.json passes', () => {
    const root = makeTree(['samples/example.json']);
    expect(scanArtifactTree('payload/plugin', root).violations).toEqual([]);
  });

  it('never descends into vendored node_modules', () => {
    const root = makeTree(['node_modules/left-pad/foo.test.js', 'index.js']);
    const { violations, scanned } = scanArtifactTree('pkg/dist', root);
    expect(violations).toEqual([]);
    expect(scanned).toBe(1);
  });
});

describe('scanTarballEntries — npm pack listing leg', () => {
  it('flags test shapes inside a tarball listing', () => {
    const { violations } = scanTarballEntries('tarball:@principles/core@1.0.0', [
      { path: 'package.json' },
      { path: 'dist/index.js' },
      { path: 'dist/foo.test.js' },
      { path: 'tests/fixture.json' },
    ]);
    expect(violations).toEqual([
      { artifact: 'tarball:@principles/core@1.0.0!/dist/foo.test.js', rule: 'NO_TEST_FILES' },
      { artifact: 'tarball:@principles/core@1.0.0!/tests/fixture.json', rule: 'NO_TEST_DIRECTORIES' },
    ]);
  });

  it('accepts a realistic clean publish surface', () => {
    const { violations, scanned } = scanTarballEntries('tarball:create-principles-disciple@1.0.0', [
      { path: 'package.json' },
      { path: 'dist/installer.js' },
      { path: 'trust/root.json' },
      { path: '_release/product-identity.json' },
      { path: 'core/package.json' },
      { path: 'core/dist/index.js' },
    ]);
    expect(violations).toEqual([]);
    expect(scanned).toBe(6);
  });
});
