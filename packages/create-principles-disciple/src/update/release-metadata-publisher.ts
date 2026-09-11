/**
 * Release metadata publisher (PRI-727) — the production supply side of the
 * read contracts in release-metadata-source.ts / trust-metadata.ts.
 *
 * For one release this module emits EXACTLY the byte set ReleaseManager
 * already consumes (see apply-payload.ts and release-manager.ts):
 *
 *   root.json / timestamp.json / snapshot.json / targets.json       TUF chain
 *   targets/channels/<channel>.json                                 signed channel pointer payload
 *   targets/releases/<releaseId>/metadata.json                      release metadata payload
 *   targets/releases/<releaseId>/release-asset-<platform>-<arch>.tar.gz
 *
 * No second release identity: releaseId and the canonical digests come from
 * deriveReleaseId/buildReleaseMetadata, and both produced documents are
 * re-validated with the SAME strict parsers the ReleaseManager uses, so a
 * publisher-side defect fails here instead of at an install. Publication is
 * byte-deterministic: the same identity inputs, the same signing key and the
 * same previous-state TUF versions re-emit identical files (idempotent
 * re-publish of one release is a no-op, not a mutation).
 *
 * Advance discipline: the channel pointer is only produced together with the
 * artifact target whose sha256 is bound into the release metadata — there is
 * no API shape that advances the pointer without the verifiable artifact
 * existing in the same file set. Monotonicity against the currently
 * published channel pointer (`previous`) is enforced here, fail-loud, before
 * any bytes are emitted.
 *
 * Trust material: one ed25519 key signs all four TUF roles — the same
 * single-key shape the ReleaseManager test suite verifies against. The
 * install side pins root.json at install time, so this module never rotates
 * the root (root version stays 1; rotation is separate governance work).
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import {
  Key,
  MetaFile,
  Metadata,
  Root,
  Signature,
  Snapshot,
  TargetFile,
  Targets,
  Timestamp,
} from '@tufjs/models';
import { parseChannelMetadata, type ChannelMetadata } from './channel-metadata.js';
import {
  buildReleaseMetadata,
  type ReleaseMetadata,
} from './release-metadata.js';
import {
  isReleaseChannelName,
  type ReleaseChannelName,
} from './product-identity.js';
import { canonicalJson } from './release-identity.js';

export const RELEASE_PUBLICATION_TUF_SPEC_VERSION = '1.0.31';

export type ReleasePublicationErrorCode =
  | 'invalid_input'
  | 'expires_not_future'
  | 'publication_not_monotonic'
  | 'publication_conflict'
  | 'signing_key_invalid';

export class ReleasePublicationError extends Error {
  readonly code: ReleasePublicationErrorCode;
  readonly field: string;
  readonly nextAction: string;

  // eslint-disable-next-line @typescript-eslint/max-params -- (code, field, message, nextAction) mirrors the four fields of the consumer refusal contract (same shape as ReleaseManagerError / ReleaseTrustError)
  constructor(code: ReleasePublicationErrorCode, field: string, message: string, nextAction: string) {
    super(message);
    this.name = 'ReleasePublicationError';
    this.code = code;
    this.field = field;
    this.nextAction = nextAction;
  }
}

/** Signing identity for the whole TUF repository (single-key shape). */
interface ReleaseSigner {
  readonly keyId: string;
  readonly privateKey: ReturnType<typeof createPrivateKey>;
}

/**
 * The release-asset archive that will be published as the artifact target.
 * `bytes` are the EXACT bytes served at the target path — the sha256 bound
 * into the release metadata is computed over them.
 */
export interface PublicationArchive {
  readonly platform: string;
  readonly arch: string;
  readonly nodeAbi: string;
  readonly bytes: Buffer;
}

/** Previously published state of the metadata repository, when one exists. */
export interface PreviousPublication {
  /** The currently published `targets/channels/<channel>.json` payload. */
  readonly channelPayload: unknown;
  /** TUF metadata versions of the currently published repository. Absent roles start at 1. */
  readonly tufVersions?: {
    readonly root?: number;
    readonly timestamp?: number;
    readonly snapshot?: number;
    readonly targets?: number;
  };
}

export interface ReleasePublicationInput {
  readonly productVersion: string;
  readonly sourceCommit: string;
  readonly channel: ReleaseChannelName;
  /** Monotonic channel pointer version — must strictly increase per advance. */
  readonly channelVersion: number;
  /** Monotonic publication sequence — must strictly increase per advance. */
  readonly publicationSequence: number;
  /** RFC3339 UTC (`...Z`) expiry for the channel, release metadata and TUF roles. */
  readonly expiresAt: string;
  readonly minBootstrapVersion: string;
  readonly dataSchemaForwardReadableFrom: string;
  readonly archive: PublicationArchive;
  /** PEM-encoded ed25519 PRIVATE key signing the whole repository. */
  readonly signingKeyPem: string;
  readonly previous?: PreviousPublication | null;
}

export interface PublicationFile {
  /** Repository-relative path as served at the metadata base URL. */
  readonly path: string;
  readonly bytes: Buffer;
}

export interface ReleasePublicationManifest {
  readonly releaseId: string;
  readonly productVersion: string;
  readonly channel: ReleaseChannelName;
  readonly platform: string;
  readonly arch: string;
  readonly nodeAbi: string;
  readonly sourceCommit: string;
  readonly artifactSha256: string;
  readonly artifactSizeBytes: number;
  readonly artifactTargetPath: string;
  readonly keyId: string;
  readonly signingScheme: 'ed25519';
  readonly publicationSequence: number;
  readonly channelVersion: number;
  readonly expiresAt: string;
  readonly files: readonly { readonly path: string; readonly sha256: string; readonly sizeBytes: number }[];
}

export interface ReleasePublication {
  readonly manifest: ReleasePublicationManifest;
  readonly releaseMetadata: ReleaseMetadata;
  readonly channelPayload: ChannelMetadata;
  /** The complete served-repository content, ready to publish as-is. */
  readonly files: readonly PublicationFile[];
}

const RFC3339_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ReleasePublicationError(
      'invalid_input',
      field,
      `${field} must be a positive safe integer, got: ${JSON.stringify(value)}`,
      'Pass an explicit monotonic value and retry the publication.',
    );
  }
  return value;
}

function requireExpiresAt(value: unknown): string {
  if (typeof value !== 'string' || !RFC3339_UTC_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ReleasePublicationError(
      'invalid_input',
      'expiresAt',
      `expiresAt must be an RFC3339 UTC timestamp ending in Z, got: ${JSON.stringify(value)}`,
      'Pass an explicit expiry (for example 2026-12-01T00:00:00Z); implicit defaults would break reproducible re-publication.',
    );
  }
  if (Date.parse(value) <= Date.now()) {
    throw new ReleasePublicationError(
      'expires_not_future',
      'expiresAt',
      `expiresAt must be in the future, got: ${value}`,
      'Publish with an expiry ahead of the release window; clients refuse expired metadata.',
    );
  }
  return value;
}

function requireSigner(signingKeyPem: string): ReleaseSigner {
  if (typeof signingKeyPem !== 'string' || signingKeyPem.trim().length === 0) {
    throw new ReleasePublicationError(
      'signing_key_invalid',
      'signingKeyPem',
      'The release signing key is empty.',
      'Provide the ed25519 private key PEM (CI secret) that matches the pinned trust root.',
    );
  }
  let privateKey: ReturnType<typeof createPrivateKey>;
  try {
    privateKey = createPrivateKey(signingKeyPem);
  } catch (error) {
    throw new ReleasePublicationError(
      'signing_key_invalid',
      'signingKeyPem',
      `The release signing key is not a parseable private key: ${error instanceof Error ? error.message : String(error)}`,
      'Provide a PEM-encoded ed25519 private key.',
    );
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new ReleasePublicationError(
      'signing_key_invalid',
      'signingKeyPem',
      `The release signing key must be an ed25519 key, got: ${String(privateKey.asymmetricKeyType)}`,
      'Generate an ed25519 key for the release trust material.',
    );
  }
  const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  // Deterministic key id derived from the public key material, so the same
  // key always produces the same root.json bytes (reproducibility).
  const keyId = createHash('sha256').update(publicKeyPem).digest('hex');
  return { keyId, privateKey };
}

function signedTufMetadata<T extends Root | Snapshot | Targets | Timestamp>(signed: T, signer: ReleaseSigner): Buffer {
  const metadata = new Metadata(signed);
  metadata.sign(
    (data) => new Signature({ keyID: signer.keyId, sig: cryptoSign(null, data, signer.privateKey).toString('hex') }),
    false,
  );
  return Buffer.from(JSON.stringify(metadata.toJSON()), 'utf8');
}

function deterministicJsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function withFileDigests(files: readonly PublicationFile[]): ReleasePublicationManifest['files'] {
  return files.map((file) => ({ path: file.path, sha256: sha256Hex(file.bytes), sizeBytes: file.bytes.length }));
}

/**
 * Gzip wrapper for a built release archive. Node's zlib emits a deterministic
 * gzip header (no embedded mtime or file name), so the same archive bytes
 * always produce the same published artifact bytes — the CLI `gzip` would not
 * (it stores name + mtime in the header).
 */
export function gzipReleaseArchive(archiveBytes: Buffer): Buffer {
  return gzipSync(archiveBytes);
}

/**
 * Parses a `sha256sum`-style digest file (`<hex>` or `<hex>  <name>`) into
 * the lowercase hex digest, failing loud on anything else.
 */
export function parseSha256DigestFile(content: string): string {
  const firstToken = content.trim().split(/\s+/, 1)[0] ?? '';
  if (!/^[a-f0-9]{64}$/i.test(firstToken)) {
    throw new ReleasePublicationError(
      'invalid_input',
      'digestFile',
      `The release archive digest file does not contain a sha256 hex digest: ${JSON.stringify(firstToken.slice(0, 72))}`,
      'Regenerate the release asset so its .sha256 sidecar exists, then retry.',
    );
  }
  return firstToken.toLowerCase();
}

/**
 * True when the input is a syntactically valid RFC3339 UTC timestamp
 * (`...Z`). Exported for CLI argument validation before any IO happens.
 */
export function isRfc3339UtcTimestamp(value: unknown): value is string {
  return typeof value === 'string' && RFC3339_UTC_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

interface ResolvedPreviousState {
  readonly previousChannel: ChannelMetadata | null;
  readonly versions: { root: number; timestamp: number; snapshot: number; targets: number };
}

function resolvePreviousState(input: ReleasePublicationInput, channelPayload: ChannelMetadata): ResolvedPreviousState {
  const { previous } = input;
  if (previous === undefined || previous === null) {
    return { previousChannel: null, versions: { root: 1, timestamp: 1, snapshot: 1, targets: 1 } };
  }
  if (previous.channelPayload !== undefined && previous.channelPayload !== null) {
    if (!isPlainObject(previous.channelPayload)) {
      throw new ReleasePublicationError(
        'invalid_input',
        'previous.channelPayload',
        'The previously published channel payload is not a JSON object.',
        'Inspect the published metadata repository; a corrupt pointer must be repaired before publishing.',
      );
    }
    // A published pointer without its TUF versions would let this publication
    // emit metadata versions the published repository already superseded —
    // a rollback clients must reject. Require the full previous state.
    const versions = previous.tufVersions;
    if (versions === undefined || versions.root === undefined || versions.timestamp === undefined
      || versions.snapshot === undefined || versions.targets === undefined) {
      throw new ReleasePublicationError(
        'invalid_input',
        'previous.tufVersions',
        'Publishing over an existing metadata repository requires the published TUF metadata versions (root/timestamp/snapshot/targets).',
        'Read the versions from the currently published repository and pass them as the previous state.',
      );
    }
    // Strict parse: a corrupt previous pointer fails the publication instead
    // of being silently treated as absent (rc-3).
    const previousChannel = parseChannelMetadata(previous.channelPayload);
    if (previousChannel.channel !== input.channel) {
      throw new ReleasePublicationError(
        'invalid_input',
        'previous.channelPayload',
        `The previously published pointer is for channel "${previousChannel.channel}", not "${input.channel}".`,
        'Read the previous state of the channel being published.',
      );
    }
    const sameRelease = previousChannel.releaseId === channelPayload.releaseId;
    if (sameRelease) {
      // Re-publishing one release is only legitimate as an exact no-op: any
      // content change (sequence, pointer version, expiry) would mutate an
      // immutable release identity. Equality is checked on the canonical
      // channel payload so formatting cannot fake or break it.
      if (canonicalJson(previous.channelPayload) !== canonicalJson(channelPayload)) {
        throw new ReleasePublicationError(
          'publication_conflict',
          'releaseId',
          `Release ${channelPayload.releaseId.slice(0, 12)} is already published with different pointer content (publicationSequence ${previousChannel.publicationSequence} vs ${channelPayload.publicationSequence}, pointer version ${previousChannel.version} vs ${channelPayload.version}).`,
          'Re-publish with the identical inputs that produced the published release, or publish a NEW release with a strictly higher publication sequence.',
        );
      }
    } else {
      if (channelPayload.publicationSequence <= previousChannel.publicationSequence) {
        throw new ReleasePublicationError(
          'publication_not_monotonic',
          'publicationSequence',
          `The new publicationSequence (${channelPayload.publicationSequence}) must be strictly greater than the published one (${previousChannel.publicationSequence}).`,
          'Advance the publication sequence; the channel pointer must never move backwards.',
        );
      }
      if (channelPayload.version <= previousChannel.version) {
        throw new ReleasePublicationError(
          'publication_not_monotonic',
          'channelVersion',
          `The new channel pointer version (${channelPayload.version}) must be strictly greater than the published one (${previousChannel.version}).`,
          'Advance the channel pointer version; signed pointer versions must never repeat or regress.',
        );
      }
    }
    return {
      previousChannel,
      versions: {
        root: versions.root,
        // An identical re-publish keeps the SAME TUF metadata versions (the
        // emitted bytes must stay identical); an advance bumps every
        // non-root role so clients see fresh metadata.
        timestamp: sameRelease ? versions.timestamp : versions.timestamp + 1,
        snapshot: sameRelease ? versions.snapshot : versions.snapshot + 1,
        targets: sameRelease ? versions.targets : versions.targets + 1,
      },
    };
  }
  const versions = previous.tufVersions ?? {};
  return {
    previousChannel: null,
    versions: { root: versions.root ?? 1, timestamp: (versions.timestamp ?? 0) + 1, snapshot: (versions.snapshot ?? 0) + 1, targets: (versions.targets ?? 0) + 1 },
  };
}

/**
 * Builds the complete signed release publication. Pure: no filesystem or
 * network IO — callers (the publish script / CI) own byte transport.
 */
export function buildReleasePublication(input: ReleasePublicationInput): ReleasePublication {
  if (!isReleaseChannelName(input.channel)) {
    throw new ReleasePublicationError(
      'invalid_input',
      'channel',
      `channel must be "stable" or "candidate", got: ${JSON.stringify(input.channel)}`,
      'Publish to a configured release channel.',
    );
  }
  requirePositiveInteger(input.channelVersion, 'channelVersion');
  requirePositiveInteger(input.publicationSequence, 'publicationSequence');
  requireExpiresAt(input.expiresAt);
  if (!Buffer.isBuffer(input.archive.bytes) || input.archive.bytes.length === 0) {
    throw new ReleasePublicationError(
      'invalid_input',
      'archive.bytes',
      'The release archive is empty or missing.',
      'Build the self-contained release asset first; nothing is published without the artifact bytes.',
    );
  }
  const signer = requireSigner(input.signingKeyPem);

  const artifactBytes = input.archive.bytes;
  const artifactSha256 = sha256Hex(artifactBytes);
  // Artifact bytes are finalized FIRST: the release metadata binds their
  // digest, the channel binds the metadata digest. By construction the
  // emitted channel pointer can never reference an artifact that is not part
  // of the same publication.
  const releaseMetadata = buildReleaseMetadata({
    productVersion: input.productVersion,
    sourceCommit: input.sourceCommit,
    minBootstrapVersion: input.minBootstrapVersion,
    publicationSequence: input.publicationSequence,
    expiresAt: input.expiresAt,
    assets: [{
      platform: input.archive.platform,
      arch: input.archive.arch,
      nodeAbi: input.archive.nodeAbi,
      archiveSha256: artifactSha256,
      archiveSizeBytes: artifactBytes.length,
    }],
    dataSchemaForwardReadableFrom: input.dataSchemaForwardReadableFrom,
  });

  const channelPayload: ChannelMetadata = {
    schemaVersion: 1,
    channel: input.channel,
    version: input.channelVersion,
    expiresAt: input.expiresAt,
    releaseMetadataDigest: releaseMetadata.metadataDigest,
    releaseId: releaseMetadata.releaseId,
    productVersion: releaseMetadata.productVersion,
    publicationSequence: releaseMetadata.publicationSequence,
  };
  // Consume-side strict re-validation: if the publisher ever produces a
  // document the ReleaseManager would refuse, refuse here instead.
  parseChannelMetadata(channelPayload);

  const { versions } = resolvePreviousState(input, channelPayload);

  const channelTargetPath = `channels/${input.channel}.json`;
  const metadataTargetPath = `releases/${releaseMetadata.releaseId}/metadata.json`;
  const artifactTargetPath = `releases/${releaseMetadata.releaseId}/release-asset-${input.archive.platform}-${input.archive.arch}.tar.gz`;
  const channelPayloadBytes = deterministicJsonBytes(channelPayload);
  const releaseMetadataBytes = deterministicJsonBytes(releaseMetadata);

  const targets = new Targets({
    version: versions.targets,
    specVersion: RELEASE_PUBLICATION_TUF_SPEC_VERSION,
    expires: input.expiresAt,
    targets: {
      [channelTargetPath]: new TargetFile({
        path: channelTargetPath,
        length: channelPayloadBytes.length,
        hashes: { sha256: sha256Hex(channelPayloadBytes) },
        unrecognizedFields: {
          custom: { releaseId: releaseMetadata.releaseId, channel: input.channel, platform: 'metadata' },
        },
      }),
      [metadataTargetPath]: new TargetFile({
        path: metadataTargetPath,
        length: releaseMetadataBytes.length,
        hashes: { sha256: sha256Hex(releaseMetadataBytes) },
        unrecognizedFields: {
          custom: { releaseId: releaseMetadata.releaseId, channel: input.channel, platform: 'metadata' },
        },
      }),
      [artifactTargetPath]: new TargetFile({
        path: artifactTargetPath,
        length: artifactBytes.length,
        hashes: { sha256: artifactSha256 },
        unrecognizedFields: {
          custom: { releaseId: releaseMetadata.releaseId, channel: input.channel, platform: input.archive.platform },
        },
      }),
    },
  });
  const root = new Root({
    version: versions.root,
    specVersion: RELEASE_PUBLICATION_TUF_SPEC_VERSION,
    expires: input.expiresAt,
    consistentSnapshot: false,
  });
  const signingKey = new Key({
    keyID: signer.keyId,
    keyType: 'ed25519',
    scheme: 'ed25519',
    keyVal: { public: createPublicKey(signer.privateKey).export({ type: 'spki', format: 'pem' }).toString() },
  });
  for (const role of ['root', 'timestamp', 'snapshot', 'targets']) root.addKey(signingKey, role);

  const files: PublicationFile[] = [
    { path: 'root.json', bytes: signedTufMetadata(root, signer) },
    { path: 'timestamp.json', bytes: signedTufMetadata(new Timestamp({
      version: versions.timestamp,
      specVersion: RELEASE_PUBLICATION_TUF_SPEC_VERSION,
      expires: input.expiresAt,
      snapshotMeta: new MetaFile({ version: versions.snapshot }),
    }), signer) },
    { path: 'snapshot.json', bytes: signedTufMetadata(new Snapshot({
      version: versions.snapshot,
      specVersion: RELEASE_PUBLICATION_TUF_SPEC_VERSION,
      expires: input.expiresAt,
      meta: { 'targets.json': new MetaFile({ version: versions.targets }) },
    }), signer) },
    { path: 'targets.json', bytes: signedTufMetadata(targets, signer) },
    { path: `targets/${channelTargetPath}`, bytes: channelPayloadBytes },
    { path: `targets/${metadataTargetPath}`, bytes: releaseMetadataBytes },
    { path: `targets/${artifactTargetPath}`, bytes: artifactBytes },
  ];

  const manifest: ReleasePublicationManifest = {
    releaseId: releaseMetadata.releaseId,
    productVersion: releaseMetadata.productVersion,
    channel: input.channel,
    platform: input.archive.platform,
    arch: input.archive.arch,
    nodeAbi: input.archive.nodeAbi,
    sourceCommit: input.sourceCommit,
    artifactSha256,
    artifactSizeBytes: artifactBytes.length,
    artifactTargetPath,
    keyId: signer.keyId,
    signingScheme: 'ed25519',
    publicationSequence: input.publicationSequence,
    channelVersion: input.channelVersion,
    expiresAt: input.expiresAt,
    files: withFileDigests(files),
  };
  return { manifest, releaseMetadata, channelPayload, files };
}

/** Ephemeral ed25519 key PEM for dry-run pipelines without configured trust material. */
export function generateEphemeralSigningKeyPem(): string {
  return generateKeyPairSync('ed25519')
    .privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();
}
