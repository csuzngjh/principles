#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeterministicReleaseArchive, parseSourceDateEpoch } from './deterministic-release-archive.mjs';

const REQUIRED_COMPONENTS = ['plugin', 'console', 'core', 'pd-cli', 'host-runtime', 'install-layout'];

function isPathWithin(directory, candidate) {
  const candidateRelativePath = relative(directory, candidate);
  return candidateRelativePath === ''
    || (!isAbsolute(candidateRelativePath) && candidateRelativePath !== '..' && !candidateRelativePath.startsWith(`..${sep}`));
}

// Lexical containment alone is defeated by junction/symlink aliases of the
// input directory, so archive/digest destinations are resolved through the
// realpath of their parent before containment is checked. statSync (which
// follows links) decides whether the parent is a directory — lstatSync would
// report a directory junction/symlink as a non-directory and silently skip
// canonicalization.
function canonicalNewFilePath(requestedPath) {
  const resolved = resolve(requestedPath);
  const parentDirectory = dirname(resolved);
  if (!existsSync(parentDirectory) || !statSync(parentDirectory).isDirectory()) {
    return resolved;
  }
  return join(realpathSync(parentDirectory), basename(resolved));
}

function readArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error('Usage: build-release-asset --input <directory> --output <directory> --platform <platform> --arch <arch> --node-abi <abi>');
    }
    values.set(name.slice(2), value);
  }
  const required = ['input', 'output', 'platform', 'arch', 'node-abi'];
  for (const name of required) {
    if (!values.has(name)) throw new Error(`Missing required --${name} argument`);
  }
  return Object.fromEntries(values);
}

function isBuildOnlyBinPath(rootDirectory, entryPath) {
  const entryRelativePath = relative(rootDirectory, entryPath).split(sep).join('/');
  return /(^|\/)node_modules\/\.bin($|\/)/.test(entryRelativePath);
}

function assertSafeSourceTree(directory, rootDirectory = directory, allowBuildOnlyBin = false) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (allowBuildOnlyBin && isBuildOnlyBinPath(rootDirectory, entryPath)) continue;
    if (entry.isSymbolicLink()) throw new Error(`Release input contains a symlink: ${entryPath}`);
    if (entry.isDirectory()) assertSafeSourceTree(entryPath, rootDirectory, allowBuildOnlyBin);
  }
}

function removeBuildOnlyBinTrees(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name === '.bin' && basename(directory) === 'node_modules') {
      rmSync(entryPath, { recursive: true, force: true });
      continue;
    }
    removeBuildOnlyBinTrees(entryPath);
  }
}

function assertRuntimeDependenciesComplete(component, directory) {
  const packageJsonPath = join(directory, 'package.json');
  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch (error) {
    throw new Error(`Release input has an invalid ${component}/package.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof packageJson !== 'object' || packageJson === null || Array.isArray(packageJson)) {
    throw new Error(`Release input has an invalid ${component}/package.json object`);
  }
  const dependencies = Object.hasOwn(packageJson, 'dependencies') ? packageJson.dependencies : undefined;
  if (dependencies !== undefined && (typeof dependencies !== 'object' || dependencies === null || Array.isArray(dependencies))) {
    throw new Error(`Release input has invalid dependencies in ${component}/package.json`);
  }
  for (const dependency of Object.keys(dependencies ?? {})) {
    if (!existsSync(join(directory, 'node_modules', dependency))) {
      throw new Error(`Release input ${component} is missing declared runtime dependency: ${dependency}`);
    }
  }
}

async function listPayloadFiles(assetDirectory) {
  const paths = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name);
      const entryRelativePath = relative(assetDirectory, entryPath).split(sep).join('/');
      if (entryRelativePath === '_release') continue;
      // Depth-0 node_modules is the PACKAGE'S OWN toolchain install (dev deps
      // of create-principles-disciple itself), not release payload — the
      // shipped components are the six REQUIRED_COMPONENTS trees.
      if (entryRelativePath === 'node_modules') continue;
      if (entry.isSymbolicLink()) throw new Error(`Release asset contains a symlink: ${entryRelativePath}`);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Release asset contains a non-file entry: ${entryRelativePath}`);
      paths.push({ absolute: entryPath, relative: entryRelativePath });
    }
  };
  visit(assetDirectory);
  paths.sort((left, right) => left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0);

  const files = new Array(paths.length);
  const concurrency = Math.min(64, Math.max(1, paths.length));
  let nextIndex = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (nextIndex < paths.length) {
      const index = nextIndex;
      nextIndex += 1;
      const file = paths[index];
      const bytes = await readFile(file.absolute);
      files[index] = {
        path: file.relative,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
      };
    }
  }));
  return files;
}

async function main() {
  const args = readArguments(process.argv.slice(2));
  const requestedInputDirectory = resolve(args.input);
  const requestedOutputDirectory = resolve(args.output);
  if (!existsSync(requestedInputDirectory) || !lstatSync(requestedInputDirectory).isDirectory()) {
    throw new Error(`Release input directory does not exist: ${requestedInputDirectory}`);
  }
  const inputDirectory = realpathSync(requestedInputDirectory);
  const outputParent = realpathSync(dirname(requestedOutputDirectory));
  const outputDirectory = resolve(outputParent, basename(requestedOutputDirectory));
  const inPlace = args['in-place'] === 'true';
  const requestedArchiveFile = args.archive ? resolve(args.archive) : undefined;
  const requestedDigestFile = args['digest-output'] ? resolve(args['digest-output']) : undefined;
  if ((requestedArchiveFile === undefined) !== (requestedDigestFile === undefined)) {
    throw new Error('--archive and --digest-output must be provided together');
  }
  if (requestedArchiveFile !== undefined && requestedArchiveFile === requestedDigestFile) {
    throw new Error('Release archive and digest outputs must be different files');
  }
  const archiveFile = requestedArchiveFile !== undefined ? canonicalNewFilePath(requestedArchiveFile) : undefined;
  const digestFile = requestedDigestFile !== undefined ? canonicalNewFilePath(requestedDigestFile) : undefined;
  if ((archiveFile && (isPathWithin(inputDirectory, archiveFile) || isPathWithin(outputDirectory, archiveFile)))
    || (digestFile && (isPathWithin(inputDirectory, digestFile) || isPathWithin(outputDirectory, digestFile)))) {
    throw new Error('Release archive and digest outputs must be outside the input and asset directories');
  }
  if (archiveFile || digestFile) {
    if (existsSync(archiveFile)) throw new Error(`Release archive already exists and cannot be replaced: ${archiveFile}`);
    if (existsSync(digestFile)) throw new Error(`Release digest already exists and cannot be replaced: ${digestFile}`);
    parseSourceDateEpoch(process.env.SOURCE_DATE_EPOCH);
  }
  if (!inPlace && isPathWithin(inputDirectory, outputDirectory)) {
    throw new Error('Release output must not be inside the input directory');
  }
  if (inPlace && inputDirectory !== outputDirectory) {
    throw new Error('In-place release verification requires identical input and output directories');
  }
  // Source-tree immutability guard: this script lives inside
  // create-principles-disciple, so its own package root IS the repository
  // source package. In-place stamping writes _release/ plus component trees
  // and must only ever target isolated staging directories.
  const thisPackageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  if (inPlace && inputDirectory === thisPackageRoot) {
    throw new Error('Refusing to stamp a self-contained release asset into the repository source package. Use an isolated staging directory.');
  }
  let ownsOutput = false;
  try {
  for (const component of REQUIRED_COMPONENTS) {
    const source = join(inputDirectory, component);
    if (!existsSync(source) || !lstatSync(source).isDirectory()) {
      throw new Error(`Release input is missing required component: ${component}`);
    }
    if (inPlace) removeBuildOnlyBinTrees(source);
    assertSafeSourceTree(source, source, !inPlace);
    assertRuntimeDependenciesComplete(component, source);
  }
  if (!inPlace) {
    if (existsSync(outputDirectory)) {
      throw new Error(`Release output already exists and immutable assets cannot be replaced: ${outputDirectory}`);
    }
    mkdirSync(outputDirectory, { recursive: true });
    ownsOutput = true;
    for (const component of REQUIRED_COMPONENTS) {
      cpSync(join(inputDirectory, component), join(outputDirectory, component), { recursive: true, dereference: false });
    }
  }
  for (const component of REQUIRED_COMPONENTS) {
    const outputComponent = join(outputDirectory, component);
    removeBuildOnlyBinTrees(outputComponent);
    assertSafeSourceTree(outputComponent);
  }
  const manifest = { schemaVersion: 1, files: await listPayloadFiles(outputDirectory) };
  const releaseDirectory = join(outputDirectory, '_release');
  mkdirSync(releaseDirectory, { recursive: true });
  writeFileSync(join(releaseDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(releaseDirectory, 'asset.json'), `${JSON.stringify({
    arch: args.arch,
    nodeAbi: args['node-abi'],
    platform: args.platform,
    schemaVersion: 1,
  }, null, 2)}\n`);
  const archive = archiveFile && digestFile ? await createDeterministicReleaseArchive({
    inputDirectory: outputDirectory,
    outputFile: archiveFile,
    digestFile,
    sourceDateEpoch: process.env.SOURCE_DATE_EPOCH,
  }) : undefined;
  process.stdout.write(`${JSON.stringify({ assetDirectory: outputDirectory, archive, files: manifest.files.length, platform: `${args.platform}-${args.arch}-abi${args['node-abi']}` })}\n`);
  } catch (error) {
    if (ownsOutput) rmSync(outputDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    throw error;
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
