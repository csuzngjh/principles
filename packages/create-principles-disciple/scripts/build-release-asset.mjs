#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';

const REQUIRED_COMPONENTS = ['plugin', 'console', 'core', 'pd-cli', 'host-runtime', 'install-layout'];

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
  paths.sort((left, right) => left.relative.localeCompare(right.relative));

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
  const inputDirectory = resolve(args.input);
  const outputDirectory = resolve(args.output);
  const inPlace = args['in-place'] === 'true';
  if (!existsSync(inputDirectory) || !lstatSync(inputDirectory).isDirectory()) {
    throw new Error(`Release input directory does not exist: ${inputDirectory}`);
  }
  if ((!inPlace && inputDirectory === outputDirectory) || outputDirectory.startsWith(`${inputDirectory}${sep}`)) {
    throw new Error('Release output must not be inside the input directory');
  }
  if (inPlace && inputDirectory !== outputDirectory) {
    throw new Error('In-place release verification requires identical input and output directories');
  }
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
  process.stdout.write(`${JSON.stringify({ assetDirectory: outputDirectory, files: manifest.files.length, platform: `${args.platform}-${args.arch}-abi${args['node-abi']}` })}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
