// Production-path tests for the immutable candidate step.
// The test executes the exact run block parsed from the composite action;
// it does not duplicate the packaging implementation in a test helper.
//
// G3.1-A: the same candidate contract covers EVERY train package. The
// installer additionally carries the product-identity stamp, which is
// requested by passing --product-version.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as jsyamlNs from 'js-yaml';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const ACTION_PATH = path.join(REPO_ROOT, '.github', 'actions', 'publish-npm-package', 'action.yml');

const yamlNamespace = jsyamlNs as unknown as Record<string, unknown>;
const yamlDefault = yamlNamespace.default as Record<string, unknown> | undefined;
const yamlLoad: (text: string) => unknown =
  typeof yamlNamespace.load === 'function'
    ? (yamlNamespace.load as (text: string) => unknown)
    : typeof yamlDefault?.load === 'function'
      ? (yamlDefault.load as (text: string) => unknown)
      : () => {
          throw new Error('js-yaml load export not found');
        };

const action = yamlLoad(fs.readFileSync(ACTION_PATH, 'utf8')) as {
  runs?: { steps?: Array<{ name?: string; run?: string }> };
};
const candidateStep = action.runs?.steps?.find((step) => step.name === 'Pack and verify immutable candidate');
const publishStep = action.runs?.steps?.find((step) => step.name === 'Publish exact committed version');
if (!candidateStep?.run) throw new Error('immutable candidate step is missing its production run block');
if (!publishStep?.run) throw new Error('exact publish step is missing its production run block');

function hasGnuArchiveTools(): boolean {
  try {
    return (
      execFileSync('tar', ['--version'], { encoding: 'utf8' }).startsWith('tar (GNU tar)') &&
      execFileSync('gzip', ['--version'], { encoding: 'utf8' }).startsWith('gzip ') &&
      execFileSync('bash', ['--version'], { encoding: 'utf8' }).startsWith('GNU bash')
    );
  } catch {
    return false;
  }
}

const describeWithGnuTools = hasGnuArchiveTools() ? describe : describe.skip;

const COHORT = 'a'.repeat(40);
const OTHER_COHORT = 'b'.repeat(40);
const PACKAGE_VERSION = '1.2.3';
const PRODUCT_VERSION = '2.3.4';
const INSTALLER_NAME = 'create-principles-disciple';
const CORE_NAME = '@principles/core';

type FixtureOptions = {
  packageName?: string;
  version?: string;
  gitHead?: string;
  includeStamp?: boolean;
  stampSourceCommit?: string;
  prepack?: boolean;
};

type Fixture = ReturnType<typeof createFixture>;

function createFixture(root: string, options: FixtureOptions = {}) {
  const packageDir = path.join(root, 'package');
  const releaseDir = path.join(packageDir, '_release');
  const packageJsonPath = path.join(packageDir, 'package.json');
  const packCounter = path.join(root, 'prepack-count.txt');
  const publishCounter = path.join(root, 'prepublish-only-count.txt');
  const packageName = options.packageName ?? INSTALLER_NAME;
  const version = options.version ?? PACKAGE_VERSION;
  const includeStamp = options.includeStamp ?? packageName === INSTALLER_NAME;

  fs.mkdirSync(releaseDir, { recursive: true });
  const files = ['README.md'];
  const scripts: Record<string, string> = {};
  // The synthetic prepack stands in for the real lifecycle (plugin/pd-cli);
  // the counter is the ground truth for "did pack run the lifecycle?".
  scripts.prepack = "node -e \"require('node:fs').appendFileSync(process.env.PACK_COUNTER, 'x')\"";
  scripts.prepublishOnly = "node -e \"require('node:fs').appendFileSync(process.env.PUBLISH_COUNTER, 'x')\"";
  if (includeStamp) files.push('_release/product-identity.json');

  const packageJson: Record<string, unknown> = { name: packageName, version, files, scripts };
  if (options.gitHead !== undefined) packageJson.gitHead = options.gitHead;

  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
  fs.writeFileSync(path.join(packageDir, 'README.md'), 'candidate fixture payload\n');
  if (includeStamp) {
    fs.writeFileSync(
      path.join(releaseDir, 'product-identity.json'),
      JSON.stringify({
        schemaVersion: 1,
        productVersion: PRODUCT_VERSION,
        sourceCommit: options.stampSourceCommit ?? COHORT,
      }, null, 2) + '\n',
    );
  }

  return { packageDir, packageJsonPath, packCounter, publishCounter, packageName, version };
}

type CandidateOptions = {
  pkgDir?: string;
  packageName?: string;
  productVersion?: string;
  version?: string;
};

function runCandidateStep(root: string, fixture: Fixture, suffix: string, options: CandidateOptions = {}) {
  const runnerTemp = path.join(root, 'runner-' + suffix);
  const githubOutput = path.join(root, 'github-output-' + suffix + '.txt');
  fs.mkdirSync(runnerTemp, { recursive: true });
  fs.writeFileSync(githubOutput, '');

  // The action step derives --skip-pack-scripts from PKG_DIR (the same
  // production mapping), so the test exercises the real wiring too.
  const result = spawnSync('bash', ['--noprofile', '--norc', '-euo', 'pipefail', '-c', candidateStep.run!], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      TOOLS_DIR: REPO_ROOT,
      PACKAGE_DIR: fixture.packageDir,
      PKG_DIR: options.pkgDir ?? 'create-principles-disciple',
      PACKAGE_NAME: options.packageName ?? fixture.packageName,
      COHORT,
      PACKAGE_VERSION: options.version ?? PACKAGE_VERSION,
      PRODUCT_VERSION: options.productVersion ?? '',
      RUNNER_TEMP: runnerTemp,
      GITHUB_OUTPUT: githubOutput,
      PACK_COUNTER: fixture.packCounter,
      PUBLISH_COUNTER: fixture.publishCounter,
    },
  });

  const output = fs.readFileSync(githubOutput, 'utf8');
  const tarball = output.match(/^tarball=(.+)$/m)?.[1];
  const sha512Hex = output.match(/^sha512_hex=([a-f0-9]{128})$/m)?.[1];
  return { result, output, tarball, sha512Hex, runnerTemp };
}

function createFakeNpm(root: string) {
  const fakeNpmBin = path.join(root, 'fake-npm-bin');
  const fakeNpmMarker = path.join(root, 'npm-publish-must-not-run.txt');
  const fakeNpmArgs = path.join(root, 'npm-publish-args.txt');
  fs.mkdirSync(fakeNpmBin, { recursive: true });
  const fakeNpm = path.join(fakeNpmBin, 'npm');
  fs.writeFileSync(
    fakeNpm,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "' + fakeNpmArgs + '"\nprintf called > "' + fakeNpmMarker + '"\nexit 0\n',
  );
  fs.chmodSync(fakeNpm, 0o755);
  return { fakeNpmBin, fakeNpmMarker, fakeNpmArgs };
}

function runPublishStep(
  tarball: string,
  sha512Hex: string,
  fake: ReturnType<typeof createFakeNpm>,
  options: { dryRun: boolean; pkgDir: string; name: string; cohort?: string },
) {
  return spawnSync('bash', ['--noprofile', '--norc', '-euo', 'pipefail', '-c', publishStep!.run!], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      PATH: fake.fakeNpmBin + path.delimiter + (process.env.PATH ?? ''),
      TOOLS_DIR: REPO_ROOT,
      COHORT: options.cohort ?? COHORT,
      NAME: options.name,
      VERSION: PACKAGE_VERSION,
      DRY_RUN: options.dryRun ? 'true' : 'false',
      CANDIDATE_TARBALL: tarball,
      CANDIDATE_SHA512_HEX: sha512Hex,
      NODE_AUTH_TOKEN: '',
    },
  });
}

function readTarJson(tarball: string, entry: string): Record<string, unknown> {
  // --force-local: GNU tar reads `D:\...` archive paths as remote host specs.
  return JSON.parse(execFileSync('tar', ['--force-local', '-xOf', tarball, entry], { encoding: 'utf8' })) as Record<string, unknown>;
}

function listFilesRecursively(root: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...listFilesRecursively(absolute));
    else found.push(absolute);
  }
  return found;
}

describeWithGnuTools('immutable candidate production path', () => {
  it('installer: runs one prepack, overlays cohort gitHead only in the candidate, and repacks deterministically', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-g31a-candidate-installer-'));
    try {
      const fixture = createFixture(root);
      const sourceManifestBefore = fs.readFileSync(fixture.packageJsonPath);
      const first = runCandidateStep(root, fixture, 'first', { productVersion: PRODUCT_VERSION });

      expect(first.result.status, String(first.result.stderr)).toBe(0);
      expect(first.tarball).toBeTruthy();
      expect(first.sha512Hex).toMatch(/^[a-f0-9]{128}$/);
      expect(fs.existsSync(first.tarball!)).toBe(true);
      expect(fs.readFileSync(fixture.packCounter, 'utf8')).toBe('x');
      expect(fs.existsSync(fixture.publishCounter)).toBe(false);
      expect(fs.readFileSync(fixture.packageJsonPath)).toEqual(sourceManifestBefore);

      const manifest = readTarJson(first.tarball!, 'package/package.json');
      const stamp = readTarJson(first.tarball!, 'package/_release/product-identity.json');
      expect(manifest.name).toBe(INSTALLER_NAME);
      expect(manifest.version).toBe(PACKAGE_VERSION);
      expect(manifest.gitHead).toBe(COHORT);
      expect(stamp).toEqual({ schemaVersion: 1, productVersion: PRODUCT_VERSION, sourceCommit: COHORT });
      expect(createHash('sha512').update(fs.readFileSync(first.tarball!)).digest('hex')).toBe(first.sha512Hex);

      const fake = createFakeNpm(root);
      const publishDryRun = runPublishStep(first.tarball!, first.sha512Hex!, fake, {
        dryRun: true,
        pkgDir: 'create-principles-disciple',
        name: INSTALLER_NAME,
      });
      expect(publishDryRun.status, String(publishDryRun.stderr)).toBe(0);
      expect(String(publishDryRun.stdout)).toContain('the real npm upload is SKIPPED');
      expect(fs.existsSync(fake.fakeNpmMarker)).toBe(false);

      const tamperedTarball = path.join(root, 'tampered-candidate.tgz');
      const tamperedBytes = fs.readFileSync(first.tarball!);
      tamperedBytes[0] ^= 0xff;
      fs.writeFileSync(tamperedTarball, tamperedBytes);
      const tamperedPublish = runPublishStep(tamperedTarball, first.sha512Hex!, fake, {
        dryRun: true,
        pkgDir: 'create-principles-disciple',
        name: INSTALLER_NAME,
      });
      expect(tamperedPublish.status).not.toBe(0);
      expect(String(tamperedPublish.stderr) + String(tamperedPublish.stdout)).toContain('changed after verification');
      expect(fs.existsSync(fake.fakeNpmMarker)).toBe(false);

      const second = runCandidateStep(root, fixture, 'second', { productVersion: PRODUCT_VERSION });
      expect(second.result.status, String(second.result.stderr)).toBe(0);
      expect(second.sha512Hex).toBe(first.sha512Hex);
      expect(fs.readFileSync(fixture.packCounter, 'utf8')).toBe('xx');
      expect(fs.existsSync(fixture.publishCounter)).toBe(false);
      expect(fs.readFileSync(fixture.packageJsonPath)).toEqual(sourceManifestBefore);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('non-installer: packs one lifecycle-bearing candidate, injects gitHead, and publishes that exact tarball', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-g31a-candidate-core-'));
    try {
      const fixture = createFixture(root, { packageName: CORE_NAME });
      const sourceManifestBefore = fs.readFileSync(fixture.packageJsonPath);
      const candidate = runCandidateStep(root, fixture, 'core', {
        pkgDir: 'principles-core',
        packageName: CORE_NAME,
      });

      expect(candidate.result.status, String(candidate.result.stderr)).toBe(0);
      expect(fs.readFileSync(fixture.packCounter, 'utf8')).toBe('x');
      expect(fs.readFileSync(fixture.packageJsonPath)).toEqual(sourceManifestBefore);
      const manifest = readTarJson(candidate.tarball!, 'package/package.json');
      expect(manifest.name).toBe(CORE_NAME);
      expect(manifest.version).toBe(PACKAGE_VERSION);
      expect(manifest.gitHead).toBe(COHORT);
      expect(createHash('sha512').update(fs.readFileSync(candidate.tarball!)).digest('hex')).toBe(candidate.sha512Hex);

      // Rehearsal must never call npm publish.
      const fake = createFakeNpm(root);
      const dry = runPublishStep(candidate.tarball!, candidate.sha512Hex!, fake, {
        dryRun: true,
        pkgDir: 'principles-core',
        name: CORE_NAME,
      });
      expect(dry.status, String(dry.stderr)).toBe(0);
      expect(fs.existsSync(fake.fakeNpmMarker)).toBe(false);

      // Production path: npm receives the VERIFIED TARBALL, never a directory.
      const real = runPublishStep(candidate.tarball!, candidate.sha512Hex!, fake, {
        dryRun: false,
        pkgDir: 'principles-core',
        name: CORE_NAME,
      });
      expect(real.status, String(real.stderr)).toBe(0);
      const publishedArgs = fs.readFileSync(fake.fakeNpmArgs, 'utf8').trim().split(/\r?\n/);
      expect(publishedArgs).toContain('publish');
      expect(publishedArgs).toContain(candidate.tarball!);
      expect(publishedArgs).toContain('--provenance');
      expect(publishedArgs.join(' ')).not.toContain('packages/principles-core');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('prepack-owned legs (plugin, pd-cli) pack with --ignore-scripts: the lifecycle runs zero times in pack', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-g31a-candidate-skip-'));
    try {
      const fixture = createFixture(root, { packageName: 'principles-disciple' });
      // The action's build step is the one owner of the payload for these
      // legs; its existence is what the candidate step verifies.
      fs.mkdirSync(path.join(fixture.packageDir, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(fixture.packageDir, 'dist', 'index.js'), 'export default 1;\n');
      fs.writeFileSync(fixture.packCounter, '');
      const candidate = runCandidateStep(root, fixture, 'plugin', {
        pkgDir: 'openclaw-plugin',
        packageName: 'principles-disciple',
      });
      expect(candidate.result.status, String(candidate.result.stderr)).toBe(0);
      expect(fs.readFileSync(fixture.packCounter, 'utf8')).toBe('');
      expect(readTarJson(candidate.tarball!, 'package/package.json').gitHead).toBe(COHORT);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('prepack-owned legs fail closed when their payload was never built', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-g31a-candidate-skip-nodist-'));
    try {
      const fixture = createFixture(root, { packageName: '@principles/pd-cli' });
      const candidate = runCandidateStep(root, fixture, 'pdcli-nodist', {
        pkgDir: 'pd-cli',
        packageName: '@principles/pd-cli',
      });
      expect(candidate.result.status).not.toBe(0);
      expect(String(candidate.result.stdout) + String(candidate.result.stderr)).toContain('dist/index.js is missing');
      expect(candidate.output).not.toContain('tarball=');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('accepts a pre-existing gitHead only when it already equals the cohort', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-g31a-candidate-matching-'));
    try {
      const fixture = createFixture(root, { gitHead: COHORT });
      const sourceManifestBefore = fs.readFileSync(fixture.packageJsonPath);
      const result = runCandidateStep(root, fixture, 'matching', { productVersion: PRODUCT_VERSION });

      expect(result.result.status, String(result.result.stderr)).toBe(0);
      expect(readTarJson(result.tarball!, 'package/package.json').gitHead).toBe(COHORT);
      expect(fs.readFileSync(fixture.packageJsonPath)).toEqual(sourceManifestBefore);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('fails closed on a conflicting pre-existing gitHead before emitting a publishable candidate', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-g31a-candidate-conflict-'));
    try {
      const fixture = createFixture(root, { gitHead: OTHER_COHORT });
      const result = runCandidateStep(root, fixture, 'conflict', { productVersion: PRODUCT_VERSION });

      expect(result.result.status).not.toBe(0);
      expect(String(result.result.stderr)).toContain('existing gitHead conflicts');
      expect(result.output).not.toContain('tarball=');
      expect(listFilesRecursively(result.runnerTemp).filter((file) => file.endsWith('.tgz'))).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('fails closed when the packed product identity stamp is missing or belongs to another cohort', () => {
    const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-g31a-candidate-no-stamp-'));
    const wrongRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-g31a-candidate-wrong-stamp-'));
    try {
      const missing = runCandidateStep(missingRoot, createFixture(missingRoot, { includeStamp: false }), 'missing', {
        productVersion: PRODUCT_VERSION,
      });
      expect(missing.result.status).not.toBe(0);
      expect(String(missing.result.stderr)).toContain('product-identity.json');

      const wrong = runCandidateStep(wrongRoot, createFixture(wrongRoot, { stampSourceCommit: OTHER_COHORT }), 'wrong', {
        productVersion: PRODUCT_VERSION,
      });
      expect(wrong.result.status).not.toBe(0);
      expect(String(wrong.result.stderr)).toContain('product identity stamp does not match');
      expect(wrong.output).not.toContain('tarball=');
    } finally {
      fs.rmSync(missingRoot, { recursive: true, force: true });
      fs.rmSync(wrongRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it('fails closed on a package name or version that is not the exact release identity', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-g31a-candidate-identity-'));
    try {
      const fixture = createFixture(root, { packageName: CORE_NAME });
      const wrongName = runCandidateStep(root, fixture, 'wrong-name', {
        pkgDir: 'principles-core',
        packageName: 'principles-disciple',
      });
      expect(wrongName.result.status).not.toBe(0);
      expect(String(wrongName.result.stderr)).toContain('name/version do not match');
      expect(wrongName.output).not.toContain('tarball=');

      const wrongVersion = runCandidateStep(root, fixture, 'wrong-version', {
        pkgDir: 'principles-core',
        packageName: CORE_NAME,
        version: '9.9.9',
      });
      expect(wrongVersion.result.status).not.toBe(0);
      expect(String(wrongVersion.result.stderr)).toContain('name/version do not match');
      expect(wrongVersion.output).not.toContain('tarball=');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('non-installer publish refuses a candidate tampered after verification', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-g31a-candidate-tamper-core-'));
    try {
      const fixture = createFixture(root, { packageName: CORE_NAME });
      const candidate = runCandidateStep(root, fixture, 'core', { pkgDir: 'principles-core', packageName: CORE_NAME });
      expect(candidate.result.status, String(candidate.result.stderr)).toBe(0);

      const fake = createFakeNpm(root);
      const tampered = path.join(root, 'tampered.tgz');
      const bytes = fs.readFileSync(candidate.tarball!);
      bytes[0] ^= 0xff;
      fs.writeFileSync(tampered, bytes);
      const result = runPublishStep(tampered, candidate.sha512Hex!, fake, {
        dryRun: false,
        pkgDir: 'principles-core',
        name: CORE_NAME,
      });
      expect(result.status).not.toBe(0);
      expect(String(result.stderr) + String(result.stdout)).toContain('changed after verification');
      expect(fs.existsSync(fake.fakeNpmMarker)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
