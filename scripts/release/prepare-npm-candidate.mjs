#!/usr/bin/env node
/**
 * Build and verify the immutable npm tarball candidate for ONE release leg.
 *
 * npm pack does not add gitHead. The release train overlays the resolved
 * cohort SHA into an unpacked candidate copy, deterministically repacks it,
 * verifies the final archive, and publishes that exact file. The same contract
 * applies to every train package (G3.1-A): the installer additionally carries
 * a product-identity stamp, which `--product-version` opts into.
 *
 * The caller decides who owns the package's preparatory lifecycle:
 *   - default: this script runs ONE `npm pack`, which executes prepack/prepare;
 *   - `--skip-pack-scripts`: the caller has ALREADY executed the equivalent
 *     build (see publish-npm-package/action.yml), so pack runs with
 *     `--ignore-scripts`. That keeps "necessary build happens exactly once"
 *     true for packages whose prepack would otherwise rebuild what the leg
 *     just built (openclaw-plugin, pd-cli).
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  readCommittedComponentVersions,
  verifyInstallerPayloadVersions,
} from './lib/installer-payload-versions.mjs';

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message) {
  throw new Error('Refusing immutable npm candidate: ' + message);
}

const packageDirArg = argValue('--package-dir');
const outputArg = argValue('--output');
const cohort = argValue('--cohort');
const packageNameArg = argValue('--package-name');
const packageVersion = argValue('--package-version');
const productVersion = argValue('--product-version');
const githubOutputArg = argValue('--github-output');
const skipPackScripts = process.argv.includes('--skip-pack-scripts');

const strictVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
if (
  !packageDirArg ||
  !outputArg ||
  !githubOutputArg ||
  !packageNameArg ||
  !/^[a-f0-9]{40}$/.test(cohort ?? '') ||
  !strictVersion.test(packageVersion ?? '') ||
  (productVersion !== undefined && !strictVersion.test(productVersion))
) {
  console.error(
    'usage: prepare-npm-candidate.mjs --package-dir <dir> --package-name <npm-name> --output <absolute-tgz> --cohort <sha> --package-version <x.y.z> [--product-version <x.y.z>] [--skip-pack-scripts] --github-output <path>'
  );
  process.exit(2);
}

const packageDir = resolve(packageDirArg);
const outputPath = resolve(outputArg);
const githubOutputPath = resolve(githubOutputArg);
const packageName = packageNameArg;
const maxBuffer = 64 * 1024 * 1024;
const run = (command, args, encoding = 'utf8') =>
  execFileSync(command, args, { encoding, maxBuffer });

// ERR-045: bare `npm` cannot be spawned directly on Windows (npm.cmd needs a
// shell or PATHEXT resolution). Run npm through the running Node binary and
// npm-cli.js with pure argv arrays — same contract as bundle-plugin.mjs.
function findNpmCliJs() {
  const nodeDir = dirname(process.execPath);
  const prefixDir = dirname(nodeDir);
  return [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(prefixDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(prefixDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find((candidate) => existsSync(candidate));
}

if (!existsSync(join(packageDir, 'package.json'))) fail('package directory has no package.json');
if (!isAbsolute(outputArg) || existsSync(outputPath)) fail('output path must be absolute and must not already exist');
if (!existsSync(dirname(outputPath)) || !existsSync(githubOutputPath)) fail('output directory and GITHUB_OUTPUT must already exist');

const tarVersion = run('tar', ['--version']);
if (!tarVersion.startsWith('tar (GNU tar)')) fail('deterministic repack requires GNU tar');
const gzipVersion = run('gzip', ['--version']);
if (!gzipVersion.startsWith('gzip ')) fail('deterministic repack requires gzip');

function parseObject(raw, label) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    fail(label + ' is not valid JSON: ' + error.message);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(label + ' must be a JSON object');
  }
  return value;
}

function listArchiveFiles(archive) {
  // `archive` is a path RELATIVE to tempRoot — see the tarInWork note below.
  const raw = execFileSync('tar', ['-tzf', archive], { cwd: tempRoot, encoding: 'utf8', maxBuffer }).split(/\r?\n/).filter(Boolean);
  if (raw.length === 0) fail('tarball has no entries');
  const entries = raw.map((entry) => {
    const normalized = entry.replace(/\/+$/, '');
    const parts = normalized.split('/');
    if (
      !normalized ||
      normalized.startsWith('/') ||
      /^[A-Za-z]:/.test(normalized) ||
      normalized.includes('\\') ||
      parts.some((part) => !part || part === '.' || part === '..') ||
      (normalized !== 'package' && !normalized.startsWith('package/'))
    ) {
      fail('unsafe or unexpected tar entry: ' + JSON.stringify(entry));
    }
    return normalized;
  });
  if (new Set(entries).size !== entries.length) fail('tarball contains duplicate paths');
  const requiredEntries = ['package/package.json'];
  if (productVersion !== undefined) requiredEntries.push('package/_release/product-identity.json');
  for (const required of requiredEntries) {
    if (!entries.includes(required)) fail('tarball is missing required entry ' + required);
  }
  const verbose = execFileSync('tar', ['-tvzf', archive], { cwd: tempRoot, encoding: 'utf8', maxBuffer }).split(/\r?\n/).filter(Boolean);
  if (verbose.some((line) => line[0] !== '-' && line[0] !== 'd')) {
    fail('tarball contains a symlink, hardlink, or special file');
  }
  return entries.filter((entry, index) => !raw[index].endsWith('/')).sort();
}

const tempRoot = mkdtempSync(join(dirname(outputPath), '.pd-candidate-work-'));
const tempFinal = join(tempRoot, 'candidate.final.tgz');
// Every tar/gzip invocation runs with cwd=tempRoot and RELATIVE paths only.
// GNU tar mangles any argument that contains a Windows drive colon (`D:\...`
// → remote-host syntax), including -C directories; relative paths behave
// identically on the ubuntu release runner and on Windows dev machines.
const tarInWork = (args, { encoding } = {}) =>
  execFileSync('tar', args, { cwd: tempRoot, stdio: 'pipe', maxBuffer, ...(encoding ? { encoding } : {}) });
try {
  const packDir = join(tempRoot, 'pack');
  const sourceDir = join(tempRoot, 'source');
  const rawTar = 'candidate.tar';
  mkdirSync(packDir);
  mkdirSync(sourceDir);

  // This is the one and only pack for this leg. When the leg has already
  // executed the package's preparatory build (--skip-pack-scripts), pack must
  // not repeat that lifecycle work; otherwise pack IS the lifecycle-bearing
  // pack (prepack/prepare) and publish must never pack again.
  const npmCliJs = findNpmCliJs();
  if (!npmCliJs) fail('npm-cli.js not found next to the running Node binary');
  execFileSync(
    process.execPath,
    [npmCliJs, 'pack', '--pack-destination', packDir, ...(skipPackScripts ? ['--ignore-scripts'] : [])],
    { cwd: packageDir, stdio: 'inherit' }
  );
  const packed = readdirSync(packDir).filter((name) => name.endsWith('.tgz'));
  if (packed.length !== 1) fail('expected exactly one npm pack tarball, found ' + JSON.stringify(packed));
  const rawTarball = 'pack/' + packed[0];
  const originalFiles = listArchiveFiles(rawTarball);

  tarInWork(['--no-same-owner', '-xzf', rawTarball, '-C', 'source']);
  const packageRoot = join(sourceDir, 'package');
  const manifestPath = join(packageRoot, 'package.json');
  const manifest = parseObject(readFileSync(manifestPath, 'utf8'), 'package/package.json');
  if (manifest.name !== packageName || manifest.version !== packageVersion) {
    fail('packed package name/version do not match the exact release leg');
  }

  // Only the installer opts into the product-identity stamp contract.
  let stamp;
  if (productVersion !== undefined) {
    const stampPath = join(packageRoot, '_release', 'product-identity.json');
    stamp = parseObject(readFileSync(stampPath, 'utf8'), 'product identity stamp');
    if (stamp.schemaVersion !== 1 || stamp.productVersion !== productVersion || stamp.sourceCommit !== cohort) {
      fail('product identity stamp does not match the resolved product version and cohort');
    }

    // Fail closed on the packed payload, before the deterministic repack and
    // publish. Release 1.150.1 shipped pd-cli 2.1.0 here while the cohort
    // committed 2.2.0 because the bundle stamped the movable registry latest;
    // a payload version that differs from the cohort is never publishable.
    const committed = readCommittedComponentVersions({
      repoRoot: resolve(packageDir, '..', '..'),
      cohort,
    });
    const verified = verifyInstallerPayloadVersions({
      committed,
      readPayloadManifest: (payloadPath) => readFileSync(join(packageRoot, payloadPath), 'utf8'),
    });
    console.log(
      'Installer payload component versions match cohort ' +
        cohort.slice(0, 10) +
        ': ' +
        verified.components.map((component) => component.label + '=' + component.version).join(', '),
    );
  }

  const expectedManifest = { ...manifest };
  if (Object.hasOwn(manifest, 'gitHead')) {
    if (manifest.gitHead !== cohort) fail('existing gitHead conflicts with the resolved cohort');
  } else {
    expectedManifest.gitHead = cohort;
    writeFileSync(manifestPath, JSON.stringify(expectedManifest, null, 2) + '\n');
  }

  const overlaidManifest = parseObject(readFileSync(manifestPath, 'utf8'), 'overlaid package/package.json');
  if (!isDeepStrictEqual(overlaidManifest, expectedManifest)) {
    fail('gitHead overlay changed package manifest fields other than gitHead');
  }

  // GNU tar normalizes order, mtime and ownership; gzip -n removes filename
  // and timestamp from the gzip header. No source package files are touched.
  tarInWork([
    '--sort=name',
    '--mtime=@0',
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '-cf',
    rawTar,
    '-C',
    'source',
    'package',
  ]);
  const outputFd = openSync(tempFinal, 'wx');
  let gzipResult;
  try {
    gzipResult = spawnSync('gzip', ['-n', '-c', rawTar], {
      cwd: tempRoot,
      stdio: ['ignore', outputFd, 'inherit'],
    });
  } finally {
    closeSync(outputFd);
  }
  if (gzipResult.error) throw gzipResult.error;
  if (gzipResult.status !== 0) fail('gzip failed while creating the final candidate tarball');

  const finalFiles = listArchiveFiles('candidate.final.tgz');
  if (!isDeepStrictEqual(originalFiles, finalFiles)) fail('deterministic repack changed the packaged file set');

  const finalManifest = parseObject(
    tarInWork(['-xOf', 'candidate.final.tgz', 'package/package.json'], { encoding: 'utf8' }),
    'final tarball package.json',
  );
  if (!isDeepStrictEqual(finalManifest, expectedManifest) || finalManifest.gitHead !== cohort) {
    fail('final tarball manifest identity verification failed');
  }
  if (productVersion !== undefined) {
    const finalStamp = parseObject(
      tarInWork(['-xOf', 'candidate.final.tgz', 'package/_release/product-identity.json'], { encoding: 'utf8' }),
      'final tarball product identity stamp',
    );
    if (!isDeepStrictEqual(finalStamp, stamp)) fail('final tarball product identity stamp changed during repack');
  }

  const hash = createHash('sha512');
  for await (const chunk of createReadStream(tempFinal)) hash.update(chunk);
  const sha512Hex = hash.digest('hex');
  renameSync(tempFinal, outputPath);
  appendFileSync(githubOutputPath, 'tarball=' + outputPath + '\nsha512_hex=' + sha512Hex + '\n');
  console.log('Immutable npm candidate verified: ' + outputPath);
  console.log('Candidate SHA-512 (hex): ' + sha512Hex);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
