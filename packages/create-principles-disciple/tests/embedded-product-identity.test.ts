/**
 * SPEC §12 embedded product identity — real round trip.
 *
 * Stamp (build-release-asset.mjs, BEFORE the archive bytes are hashed)
 *   → install-side adoption (beginInstallerJournal prefers the embedded
 *     productVersion/sourceCommit over the stale package-manifest fallback)
 *   → durable journal + active.json carry the validated provenance
 *   → strict readers round-trip it; legacy absence stays visibly unavailable;
 *     present-but-malformed stamps fail closed BEFORE any install mutation.
 *
 * Real filesystem and real journal reader throughout (no fs mocks); HOME is
 * pinned to a temp dir so `~/.pd` stays hermetic.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseEmbeddedProductIdentity, ProductIdentityError } from '../src/update/product-identity.js';
import {
  readActiveRecord,
  readTransactionJournal,
  writeActiveRecord,
} from '../src/update/transaction-journal.js';
import { beginInstallerJournal, commitInstallerActiveRecord, journalInstallerTransition } from '../src/installer.js';

const SOURCE_COMMIT = 'a'.repeat(40);
const OTHER_SOURCE_COMMIT = 'b'.repeat(40);
const PRODUCT_VERSION = '1.76.1';

const temporaryDirectories: string[] = [];
let savedHome: string | undefined;

function createFixture(): { inputDir: string; workDir: string } {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-embedded-identity-'));
  temporaryDirectories.push(workDir);
  return { inputDir: createFixtureInto(workDir).inputDir, workDir };
}

function runAssetBuild(inputDir: string, outputDir: string, extraArgs: string[] = []): void {
  const script = path.resolve(__dirname, '..', 'scripts', 'build-release-asset.mjs');
  execFileSync(process.execPath, [
    script, '--input', inputDir, '--output', outputDir,
    '--platform', 'win32', '--arch', 'x64', '--node-abi', '127',
    ...extraArgs,
  ], { stdio: 'pipe', env: { ...process.env, SOURCE_DATE_EPOCH: '1700000000' } });
}

/** Legacy npm-shaped payload: component manifests only, no `_release` stamp. */
function createLegacyPayload(workDir: string, versions: { plugin?: string; pdCli?: string }): string {
  const pluginDir = path.join(workDir, 'legacy-bundle');
  fs.mkdirSync(path.join(pluginDir, 'pd-cli'), { recursive: true });
  if (versions.plugin !== undefined) {
    fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ name: 'principles-disciple', version: versions.plugin }));
  }
  if (versions.pdCli !== undefined) {
    fs.writeFileSync(path.join(pluginDir, 'pd-cli', 'package.json'), JSON.stringify({ name: '@principles/pd-cli', version: versions.pdCli }));
  }
  return pluginDir;
}

function buildStampedAsset(workDir: string, commit: string = SOURCE_COMMIT): string {
  const { inputDir } = createFixtureInto(workDir);
  const outputDir = path.join(workDir, 'asset');
  runAssetBuild(inputDir, outputDir, ['--product-version', PRODUCT_VERSION, '--source-commit', commit]);
  return outputDir;
}

function createFixtureInto(workDir: string): { inputDir: string } {
  const inputDir = path.join(workDir, 'input');
  // Mirrors REQUIRED_COMPONENTS in build-release-asset.mjs.
  for (const component of ['plugin', 'console', 'core', 'pd-cli', 'host-runtime', 'install-layout', 'release-manager', 'codex-adapter']) {
    fs.mkdirSync(path.join(inputDir, component, 'node_modules', 'runtime-dependency'), { recursive: true });
    fs.writeFileSync(path.join(inputDir, component, 'package.json'), JSON.stringify({
      name: component,
      dependencies: { 'runtime-dependency': '1.0.0' },
    }));
    fs.writeFileSync(path.join(inputDir, component, 'node_modules', 'runtime-dependency', 'index.js'), 'module.exports = true;');
  }
  return { inputDir };
}

beforeEach(() => {
  savedHome = process.env.HOME;
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-embedded-home-'));
  temporaryDirectories.push(process.env.HOME);
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

describe('embedded product identity stamp (build side)', () => {
  it('stamps _release/product-identity.json that the authoritative parser accepts', () => {
    const { workDir } = createFixture();
    const outputDir = buildStampedAsset(workDir);

    const stampPath = path.join(outputDir, '_release', 'product-identity.json');
    const stamp: unknown = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
    expect(parseEmbeddedProductIdentity(stamp)).toEqual({
      schemaVersion: 1,
      productVersion: PRODUCT_VERSION,
      sourceCommit: SOURCE_COMMIT,
    });
    // The stamp is written together with (before hashing of) the archive.
    expect(fs.existsSync(path.join(outputDir, '_release', 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, '_release', 'asset.json'))).toBe(true);
  });

  it('covers the stamp with the artifact digest: a different sourceCommit yields a different archive digest', () => {
    const digestFor = (sourceCommit: string): string => {
      const { inputDir, workDir } = createFixture();
      const outputDir = path.join(workDir, 'asset');
      const archive = path.join(workDir, 'release.tar.gz');
      const digest = `${archive}.sha256`;
      runAssetBuild(inputDir, outputDir, [
        '--product-version', PRODUCT_VERSION, '--source-commit', sourceCommit,
        '--archive', archive, '--digest-output', digest,
      ]);
      return fs.readFileSync(digest, 'utf8').trim().split(/\s+/)[0] ?? '';
    };

    const commitADigest = digestFor(SOURCE_COMMIT);
    const commitBDigest = digestFor(OTHER_SOURCE_COMMIT);
    expect(commitADigest).toMatch(/^[a-f0-9]{64}$/);
    // The only difference between the two payloads is the embedded stamp —
    // different digests prove the stamp is INSIDE the hashed bytes.
    expect(commitBDigest).not.toBe(commitADigest);
  });

  it('refuses a malformed stamp argument before writing any output', () => {
    const { inputDir, workDir } = createFixture();
    const outputDir = path.join(workDir, 'asset');
    expect(() => runAssetBuild(inputDir, outputDir, ['--product-version', 'not-a-version', '--source-commit', SOURCE_COMMIT])).toThrow();
    expect(() => runAssetBuild(inputDir, outputDir, ['--product-version', PRODUCT_VERSION, '--source-commit', 'zz'.repeat(20)])).toThrow();
    expect(() => runAssetBuild(inputDir, outputDir, ['--product-version', PRODUCT_VERSION])).toThrow(/together/);
    expect(fs.existsSync(outputDir)).toBe(false);
  });
});

describe('embedded product identity adoption (install side)', () => {
  it('beginInstallerJournal prefers the embedded stamp over the package-manifest fallback', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-embedded-adopt-'));
    temporaryDirectories.push(workDir);
    const assetDir = buildStampedAsset(workDir);
    // A stale, DIFFERENT plugin package version must lose against the stamp.
    fs.writeFileSync(path.join(assetDir, 'package.json'), JSON.stringify({ name: 'principles-disciple', version: '0.0.1' }));

    const journal = beginInstallerJournal(assetDir);
    expect(journal.productVersion).toBe(PRODUCT_VERSION);
    expect(journal.sourceCommit).toBe(SOURCE_COMMIT);
    expect(journal.productVersionSource).toBe('embedded');
    expect(journal.releaseId).toBe(`bundled-${PRODUCT_VERSION}-${journal.releaseMetadataDigest.slice(0, 12)}`);
    expect(journal.releaseMetadataDigestSource).toBe('manifest');
  });

  it('fails closed on a present-but-malformed stamp BEFORE any journal or install mutation', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-embedded-bad-'));
    temporaryDirectories.push(workDir);
    const assetDir = buildStampedAsset(workDir);

    for (const malformed of [
      JSON.stringify({ schemaVersion: 1, productVersion: '1.2.3.4', sourceCommit: SOURCE_COMMIT }),
      JSON.stringify({ schemaVersion: 1, productVersion: PRODUCT_VERSION, sourceCommit: 'nope' }),
      JSON.stringify({ schemaVersion: 2, productVersion: PRODUCT_VERSION, sourceCommit: SOURCE_COMMIT }),
      'not json at all',
    ]) {
      fs.writeFileSync(path.join(assetDir, '_release', 'product-identity.json'), malformed);
      const transactionsDir = path.join(process.env.HOME as string, '.pd', 'transactions');
      expect(() => beginInstallerJournal(assetDir)).toThrow(ProductIdentityError);
      // beginInstallerJournal only computes the path; the file appears on the
      // first append. No append may have happened for a refused payload.
      if (fs.existsSync(transactionsDir)) {
        expect(fs.readdirSync(transactionsDir)).toEqual([]);
      }
    }
  });

  it('keeps the legacy payload readable with provenance visibly unavailable', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-embedded-legacy-'));
    temporaryDirectories.push(workDir);
    const pluginDir = createLegacyPayload(workDir, { plugin: '1.230.2', pdCli: '1.147.5' });

    const journal = beginInstallerJournal(pluginDir);
    expect(journal.productVersion).toBe('1.230.2');
    expect(journal.sourceCommit).toBeNull();
    expect(journal.productVersionSource).toBe('package_manifest');
  });
});

describe('journal + active.json round trip with embedded provenance', () => {
  it('appends sourceCommit transitions the strict reader accepts and commitInstallerActiveRecord persists', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-embedded-roundtrip-'));
    temporaryDirectories.push(workDir);
    const assetDir = buildStampedAsset(workDir);

    const journal = beginInstallerJournal(assetDir);
    journalInstallerTransition(journal, null, 'planned', 'round trip');
    journalInstallerTransition(journal, 'planned', 'confirmed', 'round trip complete');

    const transitions = readTransactionJournal(journal.journalPath);
    expect(transitions).toHaveLength(2);
    for (const transition of transitions) {
      expect(transition.sourceCommit).toBe(SOURCE_COMMIT);
      expect(transition.productVersion).toBe(PRODUCT_VERSION);
    }

    const result = commitInstallerActiveRecord(journal);
    expect(result.written).toBe(true);
    const recordPath = path.join(process.env.HOME as string, '.pd', 'active.json');
    const record = readActiveRecord(recordPath);
    expect(record?.sourceCommit).toBe(SOURCE_COMMIT);
    expect(record?.productVersion).toBe(PRODUCT_VERSION);
    // Exact file shape: sourceCommit present, no placeholder values.
    const rawRecord = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
    expect(rawRecord.sourceCommit).toBe(SOURCE_COMMIT);
  });

  it('writes NO sourceCommit field for legacy payloads and still reads legacy records and journals', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-embedded-legacyrt-'));
    temporaryDirectories.push(workDir);
    const pluginDir = createLegacyPayload(workDir, { plugin: '1.230.2', pdCli: '1.147.5' });

    const journal = beginInstallerJournal(pluginDir);
    journalInstallerTransition(journal, null, 'planned', 'legacy');
    const transitions = readTransactionJournal(journal.journalPath);
    expect(transitions[0]?.sourceCommit).toBeUndefined();

    const result = commitInstallerActiveRecord(journal);
    expect(result.written).toBe(true);
    const recordPath = path.join(process.env.HOME as string, '.pd', 'active.json');
    const rawRecord = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
    expect(Object.hasOwn(rawRecord, 'sourceCommit')).toBe(false);
    expect(readActiveRecord(recordPath)?.sourceCommit).toBeUndefined();

    // A hand-written legacy active record (pre-embedding) still reads.
    const legacyPath = path.join(workDir, 'legacy-active.json');
    writeActiveRecord(legacyPath, {
      generation: 3,
      releaseId: 'bundled-1.74.1-abcdef012345',
      releaseMetadataDigest: 'c'.repeat(64),
      previousReleaseId: null,
      transactionId: 'install-legacy',
      productVersion: '1.74.1',
    });
    expect(readActiveRecord(legacyPath)?.sourceCommit).toBeUndefined();

    // A malformed sourceCommit in a record fails the strict reader.
    const corruptPath = path.join(workDir, 'corrupt-active.json');
    fs.writeFileSync(corruptPath, `${JSON.stringify({
      schemaVersion: 1, generation: 3, releaseId: 'bundled-1.74.1-abcdef012345',
      releaseMetadataDigest: 'c'.repeat(64), previousReleaseId: null,
      transactionId: 'install-legacy', productVersion: '1.74.1',
      sourceCommit: 'NOT_A_COMMIT',
    }, null, 2)}\n`);
    expect(() => readActiveRecord(corruptPath)).toThrow(/sourceCommit/);
  });
});
