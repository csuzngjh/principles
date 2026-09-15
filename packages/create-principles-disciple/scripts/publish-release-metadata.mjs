#!/usr/bin/env node
/**
 * Release metadata publisher CLI (PRI-727; PRI-733 multi-platform matrix).
 *
 * Thin wiring only: argv → input verification (per-platform archive bytes vs
 * digest sidecar, plus an asset.json cross-check that the tar really contains
 * what the sidecar directory claims) → src/update/release-metadata-publisher
 * (all identity, signing and monotonicity decisions) → files on disk or a
 * dry-run report.
 *
 * Consumes the outputs of `build-self-contained-release.mjs` as assembled by
 * the CI matrix (one subdirectory per platform):
 *   <assets-dir>/<platform>-<arch>/asset.tar           deterministic archive
 *   <assets-dir>/<platform>-<arch>/asset.tar.sha256    its sha256 sidecar
 *   <assets-dir>/<platform>-<arch>/asset-meta.json     {platform, arch, nodeAbi}
 * and publishes the GZIP'd artifact as the TUF target
 * `releases/<releaseId>/release-asset-<platform>-<arch>.tar.gz` — the exact
 * byte shape the ReleaseManager downloads and `tar xzf`s (apply-payload.ts).
 *
 * Matrix编排（runner 选择、fan-in、排序）全部在 release-metadata.yml；
 * 这里只接收"一个 release 的 N 个 archive 输入"，publisher 保持纯函数、
 * 单 release 输入 → 确定性输出（PRI-733 边界 3 合规）。
 *
 * Contract: stdout carries exactly one JSON publication manifest (machine
 * readable); all progress and errors go to stderr. Non-zero exit on any
 * failure with zero files written.
 *
 * Usage:
 *   node scripts/publish-release-metadata.mjs \
 *     --assets-dir <dir> \
 *     --product-version 1.223.0 --source-commit <40-hex> \
 *     --channel stable --channel-version 5 --publication-sequence 10 \
 *     --expires-at 2026-12-01T00:00:00Z \
 *     --min-bootstrap-version 1.0.0 --data-schema-forward-readable-from 1.220.0 \
 *     --output-dir <dir> [--previous-dir <published-repo>] \
 *     [--signing-key-env PD_RELEASE_SIGNING_KEY] [--ephemeral-key] [--dry-run]
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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

/**
 * Read and verify every platform archive under --assets-dir.
 *
 * Directory contract (written by the CI matrix assemble job):
 *   <assets-dir>/<platform>-<arch>/asset.tar
 *   <assets-dir>/<platform>-<arch>/asset.tar.sha256
 *   <assets-dir>/<platform>-<arch>/asset-meta.json  {platform, arch, nodeAbi}
 *
 * Three verification layers per platform (all untrusted input, rc-1/rc-2):
 *  1. asset-meta.json parses to a well-formed triple;
 *  2. asset.tar bytes match the .sha256 sidecar (guards build output);
 *  3. the tar really contains _release/asset.json with the SAME triple
 *     (guards matrix mis-assembly: a linux tar labeled as win32 must fail
 *     loud instead of publishing lying metadata).
 */
function readPlatformArchives(values, publisher) {
  const assetsDir = resolve(requireValue(values, 'assets-dir'));
  let entries;
  try {
    entries = readdirSync(assetsDir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Release assets directory does not exist or is not readable: ${assetsDir} (${error instanceof Error ? error.message : String(error)})`);
  }
  const platformDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (platformDirs.length === 0) {
    throw new Error(`Release assets directory contains no platform subdirectories: ${assetsDir}. Next action: run the CI matrix build jobs first.`);
  }
  return platformDirs.map((dirName) => readOnePlatformArchive(assetsDir, dirName, publisher));
}

function readOnePlatformArchive(assetsDir, dirName, publisher) {
  const platformDir = join(assetsDir, dirName);
  const metaPath = join(platformDir, 'asset-meta.json');
  let metaText;
  try {
    metaText = readFileSync(metaPath, 'utf8');
  } catch (error) {
    throw new Error(`Release asset metadata is missing or unreadable: ${metaPath} (${error instanceof Error ? error.message : String(error)})`);
  }
  let meta;
  try {
    meta = JSON.parse(metaText);
  } catch (error) {
    throw new Error(`Release asset metadata is not valid JSON at ${metaPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new Error(`Release asset metadata must be a JSON object at ${metaPath}`);
  }
  const { platform, arch, nodeAbi } = meta;
  for (const [field, value] of [['platform', platform], ['arch', arch]]) {
    if (typeof value !== 'string' || value.length === 0 || !/^[a-z0-9-]+$/.test(value)) {
      throw new Error(`Release asset metadata field "${field}" must be a non-empty lowercase identifier at ${metaPath}, got: ${JSON.stringify(value)}`);
    }
  }
  if (typeof nodeAbi !== 'string' || !/^\d+$/.test(nodeAbi)) {
    throw new Error(`Release asset metadata field "nodeAbi" must be a numeric Node ABI string at ${metaPath}, got: ${JSON.stringify(nodeAbi)}`);
  }

  const archivePath = join(platformDir, 'asset.tar');
  let archiveBytes;
  try {
    archiveBytes = readFileSync(archivePath);
  } catch (error) {
    throw new Error(`Release archive does not exist or is not readable: ${archivePath} (${error instanceof Error ? error.message : String(error)})`);
  }
  const digestPath = join(platformDir, 'asset.tar.sha256');
  let digestText;
  try {
    digestText = readFileSync(digestPath, 'utf8');
  } catch (error) {
    throw new Error(`Release archive digest sidecar does not exist or is not readable: ${digestPath} (${error instanceof Error ? error.message : String(error)})`);
  }
  const declaredDigest = publisher.parseSha256DigestFile(digestText);
  const actualDigest = createHash('sha256').update(archiveBytes).digest('hex');
  if (actualDigest !== declaredDigest) {
    throw new Error(
      `The release archive does not match its digest sidecar in ${dirName} (declared ${declaredDigest}, actual ${actualDigest}). Refusing to publish unverified bytes.`,
    );
  }

  assertArchiveIdentityMatchesMeta(archivePath, dirName, { platform, arch, nodeAbi });

  // The consumer extracts with `tar xzf` (apply-payload.ts), so the published
  // target bytes are the deterministic gzip of the verified archive; the
  // sidecar digest guards the build output BEFORE that wrapping.
  return { platform, arch, nodeAbi, bytes: publisher.gzipReleaseArchive(archiveBytes) };
}

/** Extract `_release/asset.json` from the tar without unpacking it, via argv array. */
function assertArchiveIdentityMatchesMeta(archivePath, dirName, meta) {
  let stampedText;
  try {
    stampedText = execFileSync('tar', ['-xOf', archivePath, '_release/asset.json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
  } catch (error) {
    throw new Error(
      `The release archive in ${dirName} does not contain a stamped _release/asset.json (${error instanceof Error ? error.message : String(error)}). Next action: rebuild the asset with build-self-contained-release.mjs.`,
    );
  }
  let stamped;
  try {
    stamped = JSON.parse(stampedText);
  } catch (error) {
    throw new Error(`The stamped _release/asset.json in ${dirName} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const field of ['platform', 'arch', 'nodeAbi']) {
    if (stamped?.[field] !== meta[field]) {
      throw new Error(
        `The release archive in ${dirName} is stamped for ${String(stamped?.platform)}/${String(stamped?.arch)}/abi${String(stamped?.nodeAbi)} but its directory claims ${meta.platform}/${meta.arch}/abi${meta.nodeAbi}. Refusing to publish mis-assembled bytes.`,
      );
    }
  }
}

async function main() {
  const { values, flags } = readArguments(process.argv.slice(2));
  const dryRun = flags.has('dry-run');

  const publisher = await import('../dist/update/release-metadata-publisher.js');
  const archives = readPlatformArchives(values, publisher);

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
    archives,
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
