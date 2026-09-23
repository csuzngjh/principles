import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  detectLocalMusl,
  findSqlitePrebuildDirs,
  pruneForeignSqlitePrebuilds,
  resolveKeepPrebuildName,
} from '../scripts/sqlite-prebuild-pruning.mjs';

const ALL_PLATFORM_PREBUILDS = [
  'darwin-arm64.node',
  'darwin-x64.node',
  'linux-arm64.node',
  'linux-x64.node',
  'linuxmusl-arm64.node',
  'linuxmusl-x64.node',
  'win32-arm64.node',
  'win32-x64.node',
];

const temporaryDirectories: string[] = [];

function makeTempRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pd-sqlite-prune-${label}-`));
  temporaryDirectories.push(root);
  return root;
}

/**
 * Builds `<root>/<relativeSiteDir>/better-sqlite3/prebuilds/` with all 8
 * platform binaries plus non-binary control files that must survive.
 */
function createPrebuildSite(root: string, relativeSiteDir: string, { omit = [] as string[] } = {}): string {
  const pkgDir = path.join(root, relativeSiteDir, 'better-sqlite3');
  const prebuildsDir = path.join(pkgDir, 'prebuilds');
  fs.mkdirSync(prebuildsDir, { recursive: true });
  for (const name of ALL_PLATFORM_PREBUILDS) {
    if (omit.includes(name)) continue;
    // Distinct sizes so "removed bytes" is verifiable, not just names.
    fs.writeFileSync(path.join(prebuildsDir, name), name.repeat(3));
  }
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'better-sqlite3', version: '13.0.3' }));
  fs.writeFileSync(path.join(pkgDir, 'binding.gyp'), '# must survive');
  fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'lib', 'index.js'), 'loader-must-survive');
  return prebuildsDir;
}

function listFiles(dir: string): string[] {
  return fs.readdirSync(dir).sort();
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('resolveKeepPrebuildName', () => {
  it('mirrors node-gyp-build prebuilds naming for every supported target', () => {
    expect(resolveKeepPrebuildName({ platform: 'win32', arch: 'x64' })).toBe('win32-x64.node');
    expect(resolveKeepPrebuildName({ platform: 'darwin', arch: 'arm64' })).toBe('darwin-arm64.node');
    expect(resolveKeepPrebuildName({ platform: 'linux', arch: 'x64' })).toBe('linux-x64.node');
    expect(resolveKeepPrebuildName({ platform: 'linux', arch: 'x64', musl: true })).toBe('linuxmusl-x64.node');
    expect(resolveKeepPrebuildName({ platform: 'linux', arch: 'arm64', musl: true })).toBe('linuxmusl-arm64.node');
  });

  it('fails loud on an empty target triple (rc-3)', () => {
    expect(() => resolveKeepPrebuildName({ platform: '', arch: 'x64' })).toThrow(/platform and arch/);
    expect(() => resolveKeepPrebuildName({ platform: 'linux', arch: '' })).toThrow(/platform and arch/);
  });
});

describe('detectLocalMusl', () => {
  it('is false on every non-linux platform', () => {
    expect(detectLocalMusl({ platform: 'win32' } as NodeJS.Process)).toBe(false);
    expect(detectLocalMusl({ platform: 'darwin' } as NodeJS.Process)).toBe(false);
  });

  it('linux reports musl only when the runtime report has no glibc version', () => {
    const withGlibc = { platform: 'linux', report: { getReport: () => ({ header: { glibcVersionRuntime: '2.39' } }) } } as unknown as NodeJS.Process;
    const withoutGlibc = { platform: 'linux', report: { getReport: () => ({ header: {} }) } } as unknown as NodeJS.Process;
    const noReport = { platform: 'linux' } as unknown as NodeJS.Process;
    expect(detectLocalMusl(withGlibc)).toBe(false);
    expect(detectLocalMusl(withoutGlibc)).toBe(true);
    expect(detectLocalMusl(noReport)).toBe(false);
  });
});

describe('findSqlitePrebuildDirs', () => {
  it('finds top-level and nested better-sqlite3 copies, nothing else', () => {
    const root = makeTempRoot('find');
    createPrebuildSite(root, path.join('core', 'node_modules'));
    createPrebuildSite(root, path.join('plugin', 'node_modules', '@principles', 'core', 'node_modules'));
    // A prebuilds dir under a different package must not be touched.
    fs.mkdirSync(path.join(root, 'console', 'node_modules', 'other-native', 'prebuilds'), { recursive: true });
    const dirs = findSqlitePrebuildDirs(root);
    expect(dirs).toHaveLength(2);
    expect(dirs.every((d) => d.includes(path.join('better-sqlite3', 'prebuilds')))).toBe(true);
    expect(dirs.some((d) => d.includes(path.join('@principles', 'core')))).toBe(true);
  });
});

describe('pruneForeignSqlitePrebuilds', () => {
  it('keeps only the target binary in every site and leaves non-.node files alone', () => {
    const root = makeTempRoot('prune');
    const topDir = createPrebuildSite(root, path.join('core', 'node_modules'));
    const nestedDir = createPrebuildSite(root, path.join('plugin', 'node_modules', '@principles', 'core', 'node_modules'));
    const summary = pruneForeignSqlitePrebuilds(root, 'win32-x64.node');

    expect(summary.sites).toBe(2);
    expect(summary.removedFiles).toBe(14);
    expect(summary.keptFiles).toBe(2);
    expect(listFiles(topDir)).toEqual(['win32-x64.node']);
    expect(listFiles(nestedDir)).toEqual(['win32-x64.node']);
    const pkgDir = path.join(root, 'core', 'node_modules', 'better-sqlite3');
    expect(fs.existsSync(path.join(pkgDir, 'binding.gyp'))).toBe(true);
    expect(fs.existsSync(path.join(pkgDir, 'lib', 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(pkgDir, 'package.json'))).toBe(true);
    // removedBytes equals the byte-sum of the 7 foreign binaries at each site.
    const foreignBytes = ALL_PLATFORM_PREBUILDS.filter((n) => n !== 'win32-x64.node')
      .reduce((sum, n) => sum + Buffer.byteLength(n.repeat(3)), 0);
    expect(summary.removedBytes).toBe(foreignBytes * 2);
  });

  it('throws naming the site when the keep binary is absent, deleting nothing at that site', () => {
    const root = makeTempRoot('missing-keep');
    const siteDir = createPrebuildSite(root, path.join('core', 'node_modules'), { omit: ['linux-x64.node'] });
    expect(() => pruneForeignSqlitePrebuilds(root, 'linux-x64.node'))
      .toThrow(/no linux-x64\.node \(found: .*darwin-x64\.node.*\)/);
    // Fail loud means fail BEFORE removal: the site is untouched.
    expect(listFiles(siteDir).length).toBe(ALL_PLATFORM_PREBUILDS.length - 1);
  });

  it('returns a zero summary when no better-sqlite3 tree exists (npm-distributed shape)', () => {
    const root = makeTempRoot('no-site');
    fs.mkdirSync(path.join(root, 'install-layout'), { recursive: true });
    expect(pruneForeignSqlitePrebuilds(root, 'win32-x64.node')).toEqual({ sites: 0, removedFiles: 0, removedBytes: 0, keptFiles: 0 });
  });

  it('rejects a malformed keep name before touching the tree', () => {
    const root = makeTempRoot('bad-keep');
    createPrebuildSite(root, 'core');
    expect(() => pruneForeignSqlitePrebuilds(root, 'win32-x64.node ')).toThrow(/invalid keep file name/);
    expect(() => pruneForeignSqlitePrebuilds(root, 'win32-x64.txt')).toThrow(/invalid keep file name/);
    expect(listFiles(path.join(root, 'core', 'better-sqlite3', 'prebuilds')).length).toBe(8);
  });

  it('is deterministic: two identical trees prune to identical digests', () => {
    const a = makeTempRoot('det-a');
    const b = makeTempRoot('det-b');
    for (const [root, site] of [[a, path.join('core', 'node_modules')], [b, path.join('core', 'node_modules')]] as const) {
      createPrebuildSite(root, site);
      pruneForeignSqlitePrebuilds(root, 'darwin-arm64.node');
    }
    const digest = (root: string) => createHash('sha256').update(fs.readFileSync(path.join(root, 'core', 'node_modules', 'better-sqlite3', 'prebuilds', 'darwin-arm64.node'))).digest('hex');
    expect(digest(a)).toBe(digest(b));
  });
});
