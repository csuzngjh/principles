/**
 * Strict Channel Metadata contract (SPEC §4.2).
 *
 * Channel Metadata maps `stable` / `candidate` to a release metadata digest.
 * Promotion changes ONLY this signed pointer; it never rebuilds or mutates a
 * release. The pointer must reference the exact release metadata digest —
 * never an asset digest, never a package version.
 */

import {
  assertSha256Hex,
  isReleaseChannelName,
  parseProductVersion,
  ProductIdentityError,
  type ReleaseChannelName,
} from './product-identity.js';

export const CHANNEL_METADATA_SCHEMA_VERSION = 1;

export interface ChannelMetadata {
  readonly schemaVersion: number;
  readonly channel: ReleaseChannelName;
  /** Monotonic metadata version — must strictly increase per channel. */
  readonly version: number;
  readonly expiresAt: string;
  readonly releaseMetadataDigest: string;
  readonly releaseId: string;
  readonly productVersion: string;
  readonly publicationSequence: number;
}

export class ChannelMetadataError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'ChannelMetadataError';
    this.field = field;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireOwn(record: Record<string, unknown>, field: string): unknown {
  if (!Object.hasOwn(record, field)) {
    throw new ChannelMetadataError(field, `Channel metadata is missing required field "${field}"`);
  }
  return record[field];
}

export function parseChannelMetadata(value: unknown): ChannelMetadata {
  if (!isPlainObject(value)) {
    throw new ChannelMetadataError('root', 'Channel metadata must be a JSON object');
  }
  const { schemaVersion } = { schemaVersion: requireOwn(value, 'schemaVersion') };
  if (schemaVersion !== CHANNEL_METADATA_SCHEMA_VERSION) {
    throw new ChannelMetadataError('schemaVersion', `Unsupported channel metadata schemaVersion: ${JSON.stringify(schemaVersion)}`);
  }
  const channelValue = requireOwn(value, 'channel');
  if (!isReleaseChannelName(channelValue)) {
    throw new ChannelMetadataError('channel', `channel must be "stable" or "candidate", got: ${JSON.stringify(channelValue)}`);
  }
  const version = requireOwn(value, 'version');
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version <= 0) {
    throw new ChannelMetadataError('version', `version must be a positive safe integer, got: ${JSON.stringify(version)}`);
  }
  const expiresAt = requireOwn(value, 'expiresAt');
  if (typeof expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(expiresAt) || Number.isNaN(Date.parse(expiresAt))) {
    throw new ChannelMetadataError('expiresAt', `expiresAt must be an RFC3339 UTC timestamp ending in Z, got: ${JSON.stringify(expiresAt)}`);
  }
  // Identity helpers throw ProductIdentityError; rethrow as channel errors.
  const guarded = <T>(read: () => T): T => {
    try {
      return read();
    } catch (error) {
      if (error instanceof ProductIdentityError) {
        throw new ChannelMetadataError(error.field, error.message);
      }
      throw error;
    }
  };
  const releaseMetadataDigest = guarded(() => assertSha256Hex(requireOwn(value, 'releaseMetadataDigest'), 'releaseMetadataDigest'));
  const releaseId = guarded(() => assertSha256Hex(requireOwn(value, 'releaseId'), 'releaseId'));
  const { productVersion } = guarded(() => parseProductVersion(requireOwn(value, 'productVersion')));
  const publicationSequence = requireOwn(value, 'publicationSequence');
  if (typeof publicationSequence !== 'number' || !Number.isSafeInteger(publicationSequence) || publicationSequence <= 0) {
    throw new ChannelMetadataError('publicationSequence', `publicationSequence must be a positive safe integer, got: ${JSON.stringify(publicationSequence)}`);
  }
  const knownKeys = new Set([
    'schemaVersion', 'channel', 'version', 'expiresAt', 'releaseMetadataDigest',
    'releaseId', 'productVersion', 'publicationSequence',
  ]);
  for (const key of Object.keys(value)) {
    if (!knownKeys.has(key)) {
      throw new ChannelMetadataError(key, `Channel metadata contains unknown field "${key}"`);
    }
  }
  return {
    schemaVersion,
    channel: channelValue,
    version,
    expiresAt,
    releaseMetadataDigest,
    releaseId,
    productVersion,
    publicationSequence,
  };
}

export function isChannelMetadataExpired(metadata: ChannelMetadata, now: Date = new Date()): boolean {
  return Date.parse(metadata.expiresAt) <= now.getTime();
}
