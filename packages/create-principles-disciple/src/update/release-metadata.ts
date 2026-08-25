/**
 * Strict Release Metadata contract (SPEC §4.2).
 *
 * Release Metadata is immutable after publication. It records product
 * version, release ID, source commit, asset digests, supported platforms,
 * minimum bootstrap version, compatibility constraints, and the publication
 * sequence. Signed envelopes arrive as `unknown`; nothing is trusted until
 * this validator accepts it. Required fields fail loud (rc-3), elements are
 * validated (rc-4), and own-property access is used throughout (rc-5).
 */

import {
  assertGitCommit,
  assertSha256Hex,
  isSha256Hex,
  parseProductVersion,
  ProductIdentityError,
} from './product-identity.js';
import {
  canonicalJson,
  computeReleaseContentDigest,
  deriveReleaseId,
  type ReleaseAssetIdentity,
} from './release-identity.js';

export const RELEASE_METADATA_SCHEMA_VERSION = 1;

export interface ReleaseMetadata {
  readonly schemaVersion: number;
  readonly productVersion: string;
  readonly releaseId: string;
  readonly sourceCommit: string;
  readonly metadataDigest: string;
  readonly minBootstrapVersion: string;
  readonly publicationSequence: number;
  readonly expiresAt: string;
  readonly assets: readonly ReleaseAssetIdentity[];
  readonly compatibility: {
    readonly dataSchemaForwardReadableFrom: string;
  };
}

export type ReleaseMetadataErrorCode =
  | 'release_metadata_invalid'
  | 'release_metadata_identity_mismatch';

export class ReleaseMetadataError extends Error {
  readonly code: ReleaseMetadataErrorCode;
  readonly field: string;

  constructor(code: ReleaseMetadataErrorCode, field: string, message: string) {
    super(message);
    this.name = 'ReleaseMetadataError';
    this.code = code;
    this.field = field;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireOwn(record: Record<string, unknown>, field: string): unknown {
  if (!Object.hasOwn(record, field)) {
    throw new ReleaseMetadataError('release_metadata_invalid', field, `Release metadata is missing required field "${field}"`);
  }
  return record[field];
}

function parseRfc3339Utc(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) {
    throw new ReleaseMetadataError('release_metadata_invalid', field, `${field} must be an RFC3339 UTC timestamp ending in Z, got: ${JSON.stringify(value)}`);
  }
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    throw new ReleaseMetadataError('release_metadata_invalid', field, `${field} is not a valid date: ${JSON.stringify(value)}`);
  }
  return value;
}

function parsePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ReleaseMetadataError('release_metadata_invalid', field, `${field} must be a positive safe integer, got: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Field-by-field strict parse. Rejects unknown top-level fields so a future
 * schema change fails loud instead of silently dropping meaning.
 */
export function parseReleaseMetadata(value: unknown): ReleaseMetadata {
  if (!isPlainObject(value)) {
    throw new ReleaseMetadataError('release_metadata_invalid', 'root', 'Release metadata must be a JSON object');
  }
  const record = value;
  const schemaVersion = requireOwn(record, 'schemaVersion');
  if (schemaVersion !== RELEASE_METADATA_SCHEMA_VERSION) {
    throw new ReleaseMetadataError('release_metadata_invalid', 'schemaVersion', `Unsupported release metadata schemaVersion: ${JSON.stringify(schemaVersion)}`);
  }

  const {productVersion} = parseProductVersion(requireOwn(record, 'productVersion'));
  const minBootstrapVersion = parseProductVersion(requireOwn(record, 'minBootstrapVersion'), 'minBootstrapVersion').productVersion;
  const sourceCommit = assertGitCommit(requireOwn(record, 'sourceCommit'), 'sourceCommit');
  const releaseId = assertSha256Hex(requireOwn(record, 'releaseId'), 'releaseId');
  const metadataDigest = assertSha256Hex(requireOwn(record, 'metadataDigest'), 'metadataDigest');
  const publicationSequence = parsePositiveInteger(requireOwn(record, 'publicationSequence'), 'publicationSequence');
  const expiresAt = parseRfc3339Utc(requireOwn(record, 'expiresAt'), 'expiresAt');

  const assetsValue = requireOwn(record, 'assets');
  if (!Array.isArray(assetsValue) || assetsValue.length === 0) {
    throw new ReleaseMetadataError('release_metadata_invalid', 'assets', 'assets must be a non-empty array');
  }

  const compatibilityValue = requireOwn(record, 'compatibility');
  if (!isPlainObject(compatibilityValue)) {
    throw new ReleaseMetadataError('release_metadata_invalid', 'compatibility', 'compatibility must be an object');
  }
  const dataSchemaForwardReadableFrom = requireOwn(compatibilityValue, 'dataSchemaForwardReadableFrom');
  parseProductVersion(dataSchemaForwardReadableFrom, 'compatibility.dataSchemaForwardReadableFrom');

  const knownKeys = new Set([
    'schemaVersion', 'productVersion', 'releaseId', 'sourceCommit', 'metadataDigest',
    'minBootstrapVersion', 'publicationSequence', 'expiresAt', 'assets', 'compatibility',
  ]);
  for (const key of Object.keys(record)) {
    if (!knownKeys.has(key)) {
      throw new ReleaseMetadataError('release_metadata_invalid', key, `Release metadata contains unknown field "${key}"`);
    }
  }

  const assets = assetsValue.map((asset, index) => {
    if (!isPlainObject(asset)) {
      throw new ReleaseMetadataError('release_metadata_invalid', 'assets', `assets[${index}] must be an object`);
    }
    const assetKeys = new Set(['platform', 'arch', 'nodeAbi', 'archiveSha256', 'archiveSizeBytes']);
    for (const key of Object.keys(asset)) {
      if (!assetKeys.has(key)) {
        throw new ReleaseMetadataError('release_metadata_invalid', 'assets', `assets[${index}] contains unknown field "${key}"`);
      }
    }
    return {
      platform: requireOwn(asset, 'platform') as string,
      arch: requireOwn(asset, 'arch') as string,
      nodeAbi: requireOwn(asset, 'nodeAbi') as string,
      archiveSha256: requireOwn(asset, 'archiveSha256') as string,
      archiveSizeBytes: requireOwn(asset, 'archiveSizeBytes') as number,
    };
  });

  // The identity validator inside deriveReleaseId re-checks every asset field
  // strictly (identifier shape, digest hex, size) — reuse it by round-tripping.
  try {
    deriveReleaseId({ productVersion, sourceCommit, minBootstrapVersion, assets });
  } catch (error) {
    if (error instanceof ProductIdentityError) {
      throw new ReleaseMetadataError('release_metadata_invalid', error.field, error.message);
    }
    throw error;
  }

  return {
    schemaVersion,
    productVersion,
    releaseId,
    sourceCommit,
    metadataDigest,
    minBootstrapVersion,
    publicationSequence,
    expiresAt,
    assets,
    compatibility: { dataSchemaForwardReadableFrom: dataSchemaForwardReadableFrom as string },
  };
}

function metadataToJsonValue(metadata: ReleaseMetadata): Record<string, unknown> {
  return JSON.parse(canonicalJson({
    schemaVersion: metadata.schemaVersion,
    productVersion: metadata.productVersion,
    releaseId: metadata.releaseId,
    sourceCommit: metadata.sourceCommit,
    minBootstrapVersion: metadata.minBootstrapVersion,
    publicationSequence: metadata.publicationSequence,
    expiresAt: metadata.expiresAt,
    assets: metadata.assets,
    compatibility: metadata.compatibility,
  })) as Record<string, unknown>;
}

/**
 * Verifies the internal identity chain: recomputing the release ID from the
 * metadata's own content must reproduce `releaseId`, and the canonical
 * document digest must reproduce `metadataDigest`. A metadata document whose
 * identity does not close is refuse-before-activation (SPEC §4.3).
 */
export function verifyReleaseMetadataIdentity(metadata: ReleaseMetadata): void {
  const derivedReleaseId = deriveReleaseId({
    productVersion: metadata.productVersion,
    sourceCommit: metadata.sourceCommit,
    minBootstrapVersion: metadata.minBootstrapVersion,
    assets: metadata.assets,
  });
  if (derivedReleaseId !== metadata.releaseId) {
    throw new ReleaseMetadataError(
      'release_metadata_identity_mismatch',
      'releaseId',
      `Release metadata releaseId ${metadata.releaseId} does not match the identity derived from its own content (${derivedReleaseId})`,
    );
  }
  const documentDigest = computeReleaseContentDigest(metadataToJsonValue(metadata));
  if (documentDigest !== metadata.metadataDigest) {
    throw new ReleaseMetadataError(
      'release_metadata_identity_mismatch',
      'metadataDigest',
      `Release metadata digest ${metadata.metadataDigest} does not match the canonical document digest (${documentDigest})`,
    );
  }
}

export function isReleaseMetadataExpired(metadata: ReleaseMetadata, now: Date = new Date()): boolean {
  return Date.parse(metadata.expiresAt) <= now.getTime();
}

/** Builds a well-formed metadata document from identity inputs (producer side). */
export function buildReleaseMetadata(input: {
  productVersion: string;
  sourceCommit: string;
  minBootstrapVersion: string;
  publicationSequence: number;
  expiresAt: string;
  assets: readonly ReleaseAssetIdentity[];
  dataSchemaForwardReadableFrom: string;
}): ReleaseMetadata {
  const releaseId = deriveReleaseId(input);
  const withoutDigest: Record<string, unknown> = {
    schemaVersion: RELEASE_METADATA_SCHEMA_VERSION,
    productVersion: input.productVersion,
    releaseId,
    sourceCommit: input.sourceCommit,
    minBootstrapVersion: input.minBootstrapVersion,
    publicationSequence: input.publicationSequence,
    expiresAt: input.expiresAt,
    assets: [...input.assets],
    compatibility: { dataSchemaForwardReadableFrom: input.dataSchemaForwardReadableFrom },
  };
  const metadataDigest = computeReleaseContentDigest(withoutDigest);
  const metadata: ReleaseMetadata = {
    ...(withoutDigest as unknown as ReleaseMetadata),
    metadataDigest,
  };
  verifyReleaseMetadataIdentity(metadata);
  return metadata;
}

export function isReleaseMetadata(value: unknown): value is ReleaseMetadata {
  if (!isSha256Hex((value as { releaseId?: unknown })?.releaseId)) return false;
  try {
    parseReleaseMetadata(value);
    return true;
  } catch {
    return false;
  }
}
