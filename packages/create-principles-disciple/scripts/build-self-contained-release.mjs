#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function readOption(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const output = readOption('--output');
if (!output) {
  throw new Error('Usage: build-self-contained-release --output <directory> [--platform <platform>] [--arch <arch>] [--node-abi <abi>]');
}

const targetPlatform = readOption('--platform', process.platform);
const targetArch = readOption('--arch', process.arch);
const targetNodeAbi = readOption('--node-abi', process.versions.modules);
if (targetPlatform !== process.platform || targetArch !== process.arch || targetNodeAbi !== process.versions.modules) {
  throw new Error(`Local release builds can only target ${process.platform}/${process.arch}/abi${process.versions.modules}; requested ${targetPlatform}/${targetArch}/abi${targetNodeAbi}`);
}

const outputDirectory = resolve(output);
if (outputDirectory === parse(outputDirectory).root) {
  throw new Error('Release output must not be a filesystem root');
}
if (existsSync(outputDirectory)) {
  throw new Error(`Release output already exists and immutable assets cannot be replaced: ${outputDirectory}`);
}
const outputParent = dirname(outputDirectory);
mkdirSync(outputParent, { recursive: true });
const stagingRoot = mkdtempSync(join(outputParent, '.pd-release-staging-'));
try {
  execFileSync(process.execPath, [
    fileURLToPath(new URL('./bundle-plugin.mjs', import.meta.url)),
    '--self-contained',
    '--output-root', stagingRoot,
  ], { stdio: 'inherit' });
  execFileSync(process.execPath, [
    fileURLToPath(new URL('./build-release-asset.mjs', import.meta.url)),
    '--input', stagingRoot,
    '--output', stagingRoot,
    '--in-place', 'true',
    '--platform', targetPlatform,
    '--arch', targetArch,
    '--node-abi', targetNodeAbi,
  ], { stdio: 'inherit' });
  renameSync(stagingRoot, outputDirectory);
} finally {
  rmSync(stagingRoot, { recursive: true, force: true });
}
