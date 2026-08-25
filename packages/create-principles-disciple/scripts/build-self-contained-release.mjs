#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { assertSupportedLocalReleaseTarget } from './release-target-matrix.mjs';
import { parseSourceDateEpoch } from './deterministic-release-archive.mjs';

function readOption(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

// Windows can transiently deny directory renames with EPERM/EACCES while
// antivirus or the search indexer still holds handles from the build that
// just wrote the payload. Each rename attempt is still one atomic syscall —
// only the attempt is retried, and the immutable-destination rule is
// re-checked before every retry. After the bounded window the build fails
// loud instead of publishing by any non-atomic fallback.
function publishDirectoryAtomically(source, destination) {
  const retryableCodes = new Set(['EPERM', 'EACCES', 'EAGAIN']);
  const attempts = [
    250, 500, 1000, 2000, 4000, 4000, 4000, 4000,
  ];
  for (let attempt = 0; ; attempt += 1) {
    if (existsSync(destination)) {
      throw new Error(`Release output appeared during the build and cannot be replaced: ${destination}`);
    }
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      const code = typeof error === 'object' && error !== null && Object.hasOwn(error, 'code')
        ? String(Reflect.get(error, 'code'))
        : 'unknown';
      const delayMs = attempts[attempt];
      if (!retryableCodes.has(code) || delayMs === undefined) {
        throw new Error(`Failed to publish the release directory atomically (${code}): ${source} -> ${destination}. Next action: rerun the build into a fresh output directory; if this persists on Windows, temporarily exclude the build parent directory from real-time antivirus scanning.`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
}

const output = readOption('--output');
if (!output) {
  throw new Error('Usage: build-self-contained-release --output <directory> [--platform <platform>] [--arch <arch>] [--node-abi <abi>]');
}

const targetPlatform = readOption('--platform', process.platform);
const targetArch = readOption('--arch', process.arch);
const targetNodeAbi = readOption('--node-abi', process.versions.modules);
const targetNodeMajor = Number(readOption('--node-major', process.versions.node.split('.')[0]));
const runtimeNodeMajor = Number(process.versions.node.split('.')[0]);
assertSupportedLocalReleaseTarget(
  { platform: targetPlatform, arch: targetArch, nodeMajor: targetNodeMajor, nodeAbi: targetNodeAbi },
  { platform: process.platform, arch: process.arch, nodeMajor: runtimeNodeMajor, nodeAbi: process.versions.modules },
);

const outputDirectory = resolve(output);
if (outputDirectory === parse(outputDirectory).root) {
  throw new Error('Release output must not be a filesystem root');
}
if (existsSync(outputDirectory)) {
  throw new Error(`Release output already exists and immutable assets cannot be replaced: ${outputDirectory}`);
}
parseSourceDateEpoch(process.env.SOURCE_DATE_EPOCH);
const outputParent = dirname(outputDirectory);
mkdirSync(outputParent, { recursive: true });
const publicationLock = `${outputDirectory}.publishing`;
const stagingRoot = mkdtempSync(join(outputParent, '.pd-release-staging-'));
const payloadDirectory = join(stagingRoot, 'payload');
const stagingArchive = join(stagingRoot, 'asset.tar');
const stagingDigest = join(stagingRoot, 'asset.tar.sha256');
let publicationLockDescriptor;
try {
  publicationLockDescriptor = openSync(publicationLock, 'wx');
  execFileSync(process.execPath, [
    fileURLToPath(new URL('./bundle-plugin.mjs', import.meta.url)),
    '--self-contained',
    '--output-root', payloadDirectory,
  ], { stdio: 'inherit' });
  execFileSync(process.execPath, [
    fileURLToPath(new URL('./build-release-asset.mjs', import.meta.url)),
    '--input', payloadDirectory,
    '--output', payloadDirectory,
    '--in-place', 'true',
    '--platform', targetPlatform,
    '--arch', targetArch,
    '--node-abi', targetNodeAbi,
    '--archive', stagingArchive,
    '--digest-output', stagingDigest,
  ], { stdio: 'inherit' });
  if (existsSync(outputDirectory)) {
    throw new Error(`Release output appeared during the build and cannot be replaced: ${outputDirectory}`);
  }
  publishDirectoryAtomically(stagingRoot, outputDirectory);
} finally {
  if (publicationLockDescriptor !== undefined) {
    closeSync(publicationLockDescriptor);
    rmSync(publicationLock, { force: true });
  }
  rmSync(stagingRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
