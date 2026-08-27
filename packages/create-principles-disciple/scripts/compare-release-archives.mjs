#!/usr/bin/env node

// Byte-compares two release archives produced by build-self-contained-release
// from the same source commit and SOURCE_DATE_EPOCH. Exit 0 only when both
// archives are the same size, their streamed SHA-256 digests are identical,
// and each detached digest sidecar matches its own archive. Memory stays
// bounded: archives are hashed as streams, never loaded whole.

import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function readSidecarDigest(archivePath) {
  return readFileSync(`${archivePath}.sha256`, 'utf8').trim();
}

const [firstArchive, secondArchive] = process.argv.slice(2);
if (!firstArchive || !secondArchive) {
  process.stderr.write(`Usage: compare-release-archives <archive-1> <archive-2>\nThe .sha256 sidecar of each archive must sit next to it: ${join(dirname(firstArchive ?? '.'), '<archive>.sha256')}\n`);
  process.exitCode = 2;
} else {
  const firstSize = statSync(firstArchive).size;
  const secondSize = statSync(secondArchive).size;
  if (firstSize !== secondSize) {
    fail(`Release archives differ in size: ${firstArchive} (${firstSize} bytes) vs ${secondArchive} (${secondSize} bytes)`);
  } else {
    const [firstDigest, secondDigest] = await Promise.all([sha256File(firstArchive), sha256File(secondArchive)]);
    const firstSidecar = readSidecarDigest(firstArchive);
    const secondSidecar = readSidecarDigest(secondArchive);
    if (!/^[a-f0-9]{64}$/.test(firstSidecar) || firstSidecar !== firstDigest) {
      fail(`Detached digest sidecar does not match its archive: ${firstArchive}.sha256`);
    } else if (!/^[a-f0-9]{64}$/.test(secondSidecar) || secondSidecar !== secondDigest) {
      fail(`Detached digest sidecar does not match its archive: ${secondArchive}.sha256`);
    } else if (firstDigest !== secondDigest) {
      fail(`Release archives are not byte-identical: ${firstDigest} vs ${secondDigest}`);
    } else {
      process.stdout.write(`${firstDigest}  byte-identical\n`);
    }
  }
}
