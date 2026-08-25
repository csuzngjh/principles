import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readdirSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { create as createTar } from 'tar';

export function parseSourceDateEpoch(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error('SOURCE_DATE_EPOCH must be a non-negative integer');
  }
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds > 253402300799) {
    throw new Error('SOURCE_DATE_EPOCH is outside the supported Date range');
  }
  return new Date(seconds * 1000);
}

function listEntries(root) {
  const entries = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      const archivePath = relative(root, absolute).split(sep).join('/');
      if (entry.isSymbolicLink()) throw new Error(`Release archive input contains a symlink: ${archivePath}`);
      if (!entry.isDirectory() && !entry.isFile()) throw new Error(`Release archive input contains a non-file entry: ${archivePath}`);
      entries.push(archivePath);
      if (entry.isDirectory()) visit(absolute);
    }
  };
  visit(root);
  return entries.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function isPathWithin(directory, candidate) {
  const candidateRelativePath = relative(directory, candidate);
  return candidateRelativePath === ''
    || (!isAbsolute(candidateRelativePath) && candidateRelativePath !== '..' && !candidateRelativePath.startsWith(`..${sep}`));
}

function canonicalNewFilePath(filePath) {
  return resolve(realpathSync(dirname(resolve(filePath))), basename(filePath));
}

export async function createDeterministicReleaseArchive({ inputDirectory, outputFile, digestFile, sourceDateEpoch }) {
  const input = realpathSync(resolve(inputDirectory));
  const output = canonicalNewFilePath(outputFile);
  const digest = canonicalNewFilePath(digestFile);
  const mtime = parseSourceDateEpoch(sourceDateEpoch);
  if (!existsSync(input) || !lstatSync(input).isDirectory()) throw new Error(`Release archive input directory does not exist: ${input}`);
  if (output === digest) throw new Error('Release archive and digest outputs must be different files');
  if (isPathWithin(input, output) || isPathWithin(input, digest)) throw new Error('Release archive and digest outputs must be outside the input directory');
  if (existsSync(output)) throw new Error(`Release archive already exists and cannot be replaced: ${output}`);
  if (existsSync(digest)) throw new Error(`Release digest already exists and cannot be replaced: ${digest}`);
  const entries = listEntries(input);
  let ownsOutput = false;
  let ownsDigest = false;
  let outputDescriptor;
  try {
    outputDescriptor = openSync(output, 'wx');
    ownsOutput = true;
    const archiveHash = createHash('sha256');
    const archiveStream = createTar({
      cwd: input,
      mtime,
      noDirRecurse: true,
      portable: true,
      sync: true,
      filter: (_path, stat) => {
        stat.mode = (stat.mode & ~0o777) | (stat.isDirectory() ? 0o755 : 0o644);
        return true;
      },
    }, entries);
    for await (const chunk of archiveStream) {
      archiveHash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        offset += writeSync(outputDescriptor, chunk, offset, chunk.length - offset);
      }
    }
    fsyncSync(outputDescriptor);
    const sha256 = archiveHash.digest('hex');
    const digestDescriptor = openSync(digest, 'wx');
    ownsDigest = true;
    try {
      const digestText = `${sha256}\n`;
      if (writeSync(digestDescriptor, digestText) !== Buffer.byteLength(digestText)) {
        throw new Error('Failed to write the complete detached release digest');
      }
      fsyncSync(digestDescriptor);
    } finally {
      closeSync(digestDescriptor);
    }
    return { archiveFile: output, digestFile: digest, sha256 };
  } catch (error) {
    if (outputDescriptor !== undefined) {
      closeSync(outputDescriptor);
      outputDescriptor = undefined;
    }
    if (ownsDigest) rmSync(digest, { force: true, maxRetries: 10, retryDelay: 200 });
    if (ownsOutput) rmSync(output, { force: true, maxRetries: 10, retryDelay: 200 });
    throw error;
  } finally {
    if (outputDescriptor !== undefined) closeSync(outputDescriptor);
  }
}
