// Production-path tests for the immutable installer candidate step.
// The test executes the exact run block parsed from the composite action;
// it does not duplicate the packaging implementation in a test helper.

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
const candidateStep = action.runs?.steps?.find((step) => step.name === 'Pack and verify immutable installer candidate');
const publishStep = action.runs?.steps?.find((step) => step.name === 'Publish exact committed version');
if (!candidateStep?.run) throw new Error('immutable installer candidate step is missing its production run block');
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

type FixtureOptions = {
  gitHead?: string;
  includeStamp?: boolean;
  stampSourceCommit?: string;
};

function createFixture(root: string, options: FixtureOptions = {}) {
  const packageDir = path.join(root, 'package');
  const releaseDir = path.join(packageDir, '_release');
  const packageJsonPath = path.join(packageDir, 'package.json');
  const packCounter = path.join(root, 'prepack-count.txt');
  const publishCounter = path.join(root, 'prepublish-only-count.txt');

  fs.mkdirSync(releaseDir, { recursive: true });
  const packageJson: Record<string, unknown> = {
    name: 'create-principles-disciple',
    version: PACKAGE_VERSION,
    files: ['README.md', '_release/product-identity.json'],
    scripts: {
      prepack: "node -e \"require('node:fs').appendFileSync(process.env.PACK_COUNTER, 'x')\"",
      prepublishOnly: "node -e \"require('node:fs').appendFileSync(process.env.PUBLISH_COUNTER, 'x')\"",
    },
  };
  if (options.gitHead !== undefined) packageJson.gitHead = options.gitHead;

  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
  fs.writeFileSync(path.join(packageDir, 'README.md'), 'candidate fixture payload\n');
  if (options.includeStamp !== false) {
    fs.writeFileSync(
      path.join(releaseDir, 'product-identity.json'),
      JSON.stringify({
        schemaVersion: 1,
        productVersion: PRODUCT_VERSION,
        sourceCommit: options.stampSourceCommit ?? COHORT,
      }, null, 2) + '\n',
    );
  }

  return { packageDir, packageJsonPath, packCounter, publishCounter };
}

function runCandidateStep(root: string, fixture: ReturnType<typeof createFixture>, suffix: string) {
  const runnerTemp = path.join(root, 'runner-' + suffix);
  const githubOutput = path.join(root, 'github-output-' + suffix + '.txt');
  fs.mkdirSync(runnerTemp, { recursive: true });
  fs.writeFileSync(githubOutput, '');

  const result = spawnSync('bash', ['--noprofile', '--norc', '-euo', 'pipefail', '-c', candidateStep.run!], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      TOOLS_DIR: REPO_ROOT,
      PACKAGE_DIR: fixture.packageDir,
      COHORT,
      PACKAGE_VERSION,
      PRODUCT_VERSION,
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

function runPublishDryRun(tarball: string, sha512Hex: string, fakeNpmBin: string) {
  const result = spawnSync('bash', ['--noprofile', '--norc', '-euo', 'pipefail', '-c', publishStep!.run!], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      PATH: fakeNpmBin + path.delimiter + (process.env.PATH ?? ''),
      TOOLS_DIR: REPO_ROOT,
      COHORT,
      NAME: 'create-principles-disciple',
      VERSION: PACKAGE_VERSION,
      PKG_DIR: 'create-principles-disciple',
      DRY_RUN: 'true',
      CANDIDATE_TARBALL: tarball,
      CANDIDATE_SHA512_HEX: sha512Hex,
      NODE_AUTH_TOKEN: '',
    },
  });
  return result;
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

describeWithGnuTools('immutable installer candidate production path', () => {
  it('runs one prepack, overlays cohort gitHead only in the candidate, and repacks deterministically', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-g31-candidate-positive-'));
    try {
      const fixture = createFixture(root);
      const sourceManifestBefore = fs.readFileSync(fixture.packageJsonPath);
      const first = runCandidateStep(root, fixture, 'first');

      expect(first.result.status, String(first.result.stderr)).toBe(0);
      expect(first.tarball).toBeTruthy();
      expect(first.sha512Hex).toMatch(/^[a-f0-9]{128}$/);
      expect(fs.existsSync(first.tarball!)).toBe(true);
      expect(fs.readFileSync(fixture.packCounter, 'utf8')).toBe('x');
      expect(fs.existsSync(fixture.publishCounter)).toBe(false);
      expect(fs.readFileSync(fixture.packageJsonPath)).toEqual(sourceManifestBefore);

      const manifest = readTarJson(first.tarball!, 'package/package.json');
      const stamp = readTarJson(first.tarball!, 'package/_release/product-identity.json');
      expect(manifest.name).toBe('create-principles-disciple');
      expect(manifest.version).toBe(PACKAGE_VERSION);
      expect(manifest.gitHead).toBe(COHORT);
      expect(stamp).toEqual({
        schemaVersion: 1,
        productVersion: PRODUCT_VERSION,
        sourceCommit: COHORT,
      });
      expect(createHash('sha512').update(fs.readFileSync(first.tarball!)).digest('hex')).toBe(first.sha512Hex);

      const fakeNpmBin = path.join(root, 'fake-npm-bin');
      const fakeNpmMarker = path.join(root, 'npm-publish-must-not-run.txt');
      fs.mkdirSync(fakeNpmBin);
      const fakeNpm = path.join(fakeNpmBin, 'npm');
      fs.writeFileSync(fakeNpm, '#!/bin/sh\nprintf called > "' + fakeNpmMarker + '"\nexit 97\n');
      fs.chmodSync(fakeNpm, 0o755);
      const publishDryRun = runPublishDryRun(first.tarball!, first.sha512Hex!, fakeNpmBin);
      expect(publishDryRun.status, String(publishDryRun.stderr)).toBe(0);
      expect(String(publishDryRun.stdout)).toContain('the real npm upload is SKIPPED');
      expect(fs.existsSync(fakeNpmMarker)).toBe(false);

      const tamperedTarball = path.join(root, 'tampered-candidate.tgz');
      const tamperedBytes = fs.readFileSync(first.tarball!);
      tamperedBytes[0] ^= 0xff;
      fs.writeFileSync(tamperedTarball, tamperedBytes);
      const tamperedPublish = runPublishDryRun(tamperedTarball, first.sha512Hex!, fakeNpmBin);
      expect(tamperedPublish.status).not.toBe(0);
      expect(String(tamperedPublish.stderr) + String(tamperedPublish.stdout)).toContain('changed after verification');
      expect(fs.existsSync(fakeNpmMarker)).toBe(false);

      const second = runCandidateStep(root, fixture, 'second');
      expect(second.result.status, String(second.result.stderr)).toBe(0);
      expect(second.sha512Hex).toBe(first.sha512Hex);
      expect(fs.readFileSync(fixture.packCounter, 'utf8')).toBe('xx');
      expect(fs.existsSync(fixture.publishCounter)).toBe(false);
      expect(fs.readFileSync(fixture.packageJsonPath)).toEqual(sourceManifestBefore);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('accepts a pre-existing gitHead only when it already equals the cohort', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-g31-candidate-matching-'));
    try {
      const fixture = createFixture(root, { gitHead: COHORT });
      const sourceManifestBefore = fs.readFileSync(fixture.packageJsonPath);
      const result = runCandidateStep(root, fixture, 'matching');

      expect(result.result.status, String(result.result.stderr)).toBe(0);
      expect(readTarJson(result.tarball!, 'package/package.json').gitHead).toBe(COHORT);
      expect(fs.readFileSync(fixture.packageJsonPath)).toEqual(sourceManifestBefore);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('fails closed on a conflicting pre-existing gitHead before emitting a publishable candidate', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-g31-candidate-conflict-'));
    try {
      const fixture = createFixture(root, { gitHead: OTHER_COHORT });
      const result = runCandidateStep(root, fixture, 'conflict');

      expect(result.result.status).not.toBe(0);
      expect(String(result.result.stderr)).toContain('existing gitHead conflicts');
      expect(result.output).not.toContain('tarball=');
      expect(listFilesRecursively(result.runnerTemp).filter((file) => file.endsWith('.tgz'))).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('fails closed when the packed product identity stamp is missing or belongs to another cohort', () => {
    const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-g31-candidate-no-stamp-'));
    const wrongRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-g31-candidate-wrong-stamp-'));
    try {
      const missing = runCandidateStep(missingRoot, createFixture(missingRoot, { includeStamp: false }), 'missing');
      expect(missing.result.status).not.toBe(0);
      expect(String(missing.result.stderr)).toContain('product-identity.json');

      const wrong = runCandidateStep(wrongRoot, createFixture(wrongRoot, { stampSourceCommit: OTHER_COHORT }), 'wrong');
      expect(wrong.result.status).not.toBe(0);
      expect(String(wrong.result.stderr)).toContain('product identity stamp does not match');
      expect(wrong.output).not.toContain('tarball=');
    } finally {
      fs.rmSync(missingRoot, { recursive: true, force: true });
      fs.rmSync(wrongRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
