#!/usr/bin/env node
/**
 * Release metadata publisher CLI (PRI-727).
 *
 * Thin wiring only: argv → input verification (archive bytes vs digest
 * sidecar) → src/update/release-metadata-publisher (all identity, signing
 * and monotonicity decisions) → files on disk or a dry-run report.
 *
 * Consumes the outputs of `build-self-contained-release.mjs`:
 *   <output>/asset.tar       deterministic release archive (uncompressed tar)
 *   <output>/asset.tar.sha256  its sha256 sidecar
 * and publishes the GZIP'd artifact as the TUF target
 * `releases/<releaseId>/release-asset-<platform>-<arch>.tar.gz` — the exact
 * byte shape the ReleaseManager downloads and `tar xzf`s (apply-payload.ts).
 *
 * Contract: stdout carries exactly one JSON publication manifest (machine
 * readable); all progress and errors go to stderr. Non-zero exit on any
 * failure with zero files written.
 *
 * Usage:
 *   node scripts/publish-release-metadata.mjs \
 *     --archive <asset.tar> [--digest <asset.tar.sha256>] \
 *     --product-version 1.223.0 --source-commit <40-hex> \
 *     --channel stable --channel-version 5 --publication-sequence 10 \
 *     --expires-at 2026-12-01T00:00:00Z \
 *     --min-bootstrap-version 1.0.0 --data-schema-forward-readable-from 1.220.0 \
 *     --platform linux --arch x64 --node-abi 137 \
 *     --output-dir <dir> [--previous-dir <published-repo>] \
 *     [--signing-key-env PD_RELEASE_SIGNING_KEY] [--ephemeral-key] [--dry-run]
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const BOOLEAN_FLAGS = new Set(['dry-run', 'ephemeral-key']);

function isEnoent(error) {
  return error !== null && typeof error === 'object' && error.code === 'ENOENT';
}

function readArguments(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name?.startsWith('--')) throw new Error(`Unexpected argument: ${String(name)}`);
    const key = name.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      flags.add(key);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    values.set(key, value);
    index += 1;
  }
  return { values, flags };
}

function requireValue(values, key) {
  const value = values.get(key);
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing required --${key} argument`);
  }
  return value;
}

function readTufVersions(previousDir) {
  const readVersion = (fileName) => {
    const filePath = resolve(previousDir, fileName);
    // Read first, classify the error afterwards — no check-then-read window
    // (the file may be replaced between an existsSync and this read).
    let envelope;
    try {
      envelope = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw new Error(`Published ${fileName} is unreadable or invalid JSON at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    // rc-1/rc-2: the published envelope is untrusted input — read only the
    // signed version field through a validated shape.
    const signed = envelope !== null && typeof envelope === 'object' ? envelope.signed : undefined;
    const version = signed !== null && typeof signed === 'object' ? signed.version : undefined;
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version <= 0) {
      throw new Error(`Published ${fileName} has no usable signed version at ${filePath}`);
    }
    return version;
  };
  return {
    root: readVersion('root.json'),
    timestamp: readVersion('timestamp.json'),
    snapshot: readVersion('snapshot.json'),
    targets: readVersion('targets.json'),
  };
}

async function main() {
  const { values, flags } = readArguments(process.argv.slice(2));
  const dryRun = flags.has('dry-run');

  const archivePath = resolve(requireValue(values, 'archive'));
  // Read first, classify the error — no existsSync/statSync pre-check (the
  // file could be swapped between check and read).
  let archiveBytes;
  try {
    archiveBytes = readFileSync(archivePath);
  } catch (error) {
    throw new Error(`Release archive does not exist or is not readable: ${archivePath} (${error instanceof Error ? error.message : String(error)})`);
  }
  const digestPath = resolve(values.get('digest') ?? `${archivePath}.sha256`);
  let digestText;
  try {
    digestText = readFileSync(digestPath, 'utf8');
  } catch (error) {
    throw new Error(`Release archive digest sidecar does not exist or is not readable: ${digestPath} (${error instanceof Error ? error.message : String(error)})`);
  }
  const publisher = await import('../dist/update/release-metadata-publisher.js');
  const declaredDigest = publisher.parseSha256DigestFile(digestText);
  const actualDigest = createHash('sha256').update(archiveBytes).digest('hex');
  if (actualDigest !== declaredDigest) {
    throw new Error(
      `The release archive does not match its digest sidecar (declared ${declaredDigest}, actual ${actualDigest}). Refusing to publish unverified bytes.`,
    );
  }
  // The consumer extracts with `tar xzf` (apply-payload.ts), so the published
  // target bytes are the deterministic gzip of the verified archive; the
  // sidecar digest guards the build output BEFORE that wrapping.
  const publishedBytes = publisher.gzipReleaseArchive(archiveBytes);

  const signingKeyEnv = values.get('signing-key-env') ?? 'PD_RELEASE_SIGNING_KEY';
  let signingKeyPem = process.env[signingKeyEnv] ?? '';
  if (signingKeyPem.trim().length === 0 && flags.has('ephemeral-key')) {
    signingKeyPem = publisher.generateEphemeralSigningKeyPem();
    process.stderr.write('WARNING: signing with an EPHEMERAL key — the output is NOT trusted by any pinned install. Dry-run use only.\n');
  }
  if (signingKeyPem.trim().length === 0) {
    throw new Error(
      `No signing key: set the ${signingKeyEnv} environment variable (ed25519 private key PEM), or pass --ephemeral-key for an untrusted dry-run.`,
    );
  }

  const previousDir = values.has('previous-dir') ? resolve(values.get('previous-dir')) : undefined;
  let previous;
  if (previousDir !== undefined) {
    const channel = requireValue(values, 'channel');
    const previousChannelPath = resolve(previousDir, 'targets', 'channels', `${channel}.json`);
    // Read first, classify the error — ENOENT means "no pointer for this
    // channel", anything else is a corrupt published repository.
    let previousChannelPayload = null;
    try {
      previousChannelPayload = JSON.parse(readFileSync(previousChannelPath, 'utf8'));
    } catch (error) {
      if (!isEnoent(error)) {
        throw new Error(`The published channel pointer is unreadable or invalid JSON at ${previousChannelPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const tufVersions = readTufVersions(previousDir);
    if (previousChannelPayload !== null || tufVersions.timestamp !== undefined) {
      previous = {
        channelPayload: previousChannelPayload,
        tufVersions,
      };
    }
  }

  const publication = publisher.buildReleasePublication({
    productVersion: requireValue(values, 'product-version'),
    sourceCommit: requireValue(values, 'source-commit'),
    channel: requireValue(values, 'channel'),
    channelVersion: Number(requireValue(values, 'channel-version')),
    publicationSequence: Number(requireValue(values, 'publication-sequence')),
    expiresAt: requireValue(values, 'expires-at'),
    minBootstrapVersion: requireValue(values, 'min-bootstrap-version'),
    dataSchemaForwardReadableFrom: requireValue(values, 'data-schema-forward-readable-from'),
    archive: {
      platform: values.get('platform') ?? process.platform,
      arch: values.get('arch') ?? process.arch,
      nodeAbi: values.get('node-abi') ?? process.versions.modules,
      bytes: publishedBytes,
    },
    signingKeyPem,
    previous: previous ?? null,
  });

  if (dryRun) {
    process.stdout.write(`${JSON.stringify({ ...publication.manifest, dryRun: true }, null, 2)}\n`);
    return;
  }

  const outputDir = resolve(requireValue(values, 'output-dir'));
  mkdirSync(outputDir, { recursive: true });
  for (const file of publication.files) {
    const destination = resolve(outputDir, file.path);
    // Read first, classify the error — no existsSync pre-check before the
    // idempotence comparison.
    let existing;
    try {
      existing = readFileSync(destination);
    } catch (error) {
      if (!isEnoent(error)) {
        throw new Error(`Cannot read the existing published file ${destination}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (existing !== undefined) {
      if (!existing.equals(file.bytes)) {
        throw new Error(
          `Refusing to replace published file with different content: ${destination}. The metadata repository is append-and-advance only.`,
        );
      }
      continue;
    }
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, file.bytes);
  }
  process.stdout.write(`${JSON.stringify({ ...publication.manifest, outputDir }, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`publish-release-metadata: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
