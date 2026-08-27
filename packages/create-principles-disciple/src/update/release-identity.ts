/**
 * Immutable release identity derivation (SPEC §4.1, §4.3).
 *
 * releaseId = sha256 over the canonical identity inputs: product version,
 * source commit, the sorted platform asset identities, the minimum bootstrap
 * version, and the digest of the metadata content that excludes releaseId
 * itself (avoiding circular hashing, per SPEC §4.2's detached-digest rule).
 * Informational build time is never an identity input.
 */

import { createHash } from 'node:crypto';
import {
  assertGitCommit,
  assertSha256Hex,
  parseProductVersion,
  ProductIdentityError,
} from './product-identity.js';

export interface ReleaseAssetIdentity {
  readonly platform: string;
  readonly arch: string;
  readonly nodeAbi: string;
  readonly archiveSha256: string;
  readonly archiveSizeBytes: number;
}

export interface ReleaseIdentityInputs {
  readonly productVersion: string;
  readonly sourceCommit: string;
  readonly minBootstrapVersion: string;
  readonly assets: readonly ReleaseAssetIdentity[];
}

/** Deterministic JSON: sorted keys, no insignificant whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validateAssetIdentity(asset: unknown, index: number): ReleaseAssetIdentity {
  if (typeof asset !== 'object' || asset === null || Array.isArray(asset)) {
    throw new ProductIdentityError('assets', `assets[${index}] must be an object`);
  }
  const record = asset as Record<string, unknown>;
  const {platform} = record;
  const {arch} = record;
  const {nodeAbi} = record;
  const {archiveSha256} = record;
  const {archiveSizeBytes} = record;
  for (const [field, value] of [['platform', platform], ['arch', arch], ['nodeAbi', nodeAbi]] as const) {
    if (typeof value !== 'string' || value.length === 0 || !/^[a-z0-9-]+$/.test(value)) {
      throw new ProductIdentityError('assets', `assets[${index}].${field} must be a non-empty lowercase identifier, got: ${JSON.stringify(value)}`);
    }
  }
  if (typeof nodeAbi !== 'string' || !/^\d+$/.test(nodeAbi)) {
    throw new ProductIdentityError('assets', `assets[${index}].nodeAbi must be a numeric Node ABI string (e.g. "147"), got: ${JSON.stringify(nodeAbi)}`);
  }
  if (typeof archiveSizeBytes !== 'number' || !Number.isSafeInteger(archiveSizeBytes) || archiveSizeBytes <= 0) {
    throw new ProductIdentityError('assets', `assets[${index}].archiveSizeBytes must be a positive safe integer, got: ${JSON.stringify(archiveSizeBytes)}`);
  }
  return {
    platform,
    arch,
    nodeAbi,
    archiveSha256: assertSha256Hex(archiveSha256, `assets[${index}].archiveSha256`),
    archiveSizeBytes,
  } as ReleaseAssetIdentity;
}

/** Content digest of the identity-relevant metadata, with `releaseId` removed. */
export function computeReleaseContentDigest(contentWithoutReleaseId: unknown): string {
  return createHash('sha256').update(canonicalJson(contentWithoutReleaseId), 'utf8').digest('hex');
}

/**
 * Derives the immutable release ID. Same source + same declared inputs MUST
 * produce the same ID; any input change produces a different ID. Deterministic
 * across platforms (canonical JSON, sorted assets, LF strings).
 */
export function deriveReleaseId(inputs: ReleaseIdentityInputs): string {
  const productVersion = parseProductVersion(inputs.productVersion);
  parseProductVersion(inputs.minBootstrapVersion, 'minBootstrapVersion');
  assertGitCommit(inputs.sourceCommit, 'sourceCommit');
  if (!Array.isArray(inputs.assets) || inputs.assets.length === 0) {
    throw new ProductIdentityError('assets', 'a release must declare at least one platform asset');
  }
  const assets = inputs.assets.map(validateAssetIdentity);
  // Duplicate detection runs BEFORE sorting as an explicit pass — sort
  // comparators are not guaranteed to compare every element pair, so a
  // duplicate key could slip into the identity input unnoticed.
  const seenKeys = new Set<string>();
  for (const asset of assets) {
    const key = `${asset.platform}/${asset.arch}/abi${asset.nodeAbi}`;
    if (seenKeys.has(key)) {
      throw new ProductIdentityError('assets', `duplicate platform asset declared: ${key}`);
    }
    seenKeys.add(key);
  }
  const sortedAssets = [...assets].sort((a, b) => {
    const keyA = `${a.platform}/${a.arch}/abi${a.nodeAbi}`;
    const keyB = `${b.platform}/${b.arch}/abi${b.nodeAbi}`;
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });

  const identityContent = {
    kind: 'pd-release-identity-v1',
    productVersion: productVersion.productVersion,
    sourceCommit: inputs.sourceCommit,
    minBootstrapVersion: inputs.minBootstrapVersion,
    assets: sortedAssets.map((asset) => ({
      platform: asset.platform,
      arch: asset.arch,
      nodeAbi: asset.nodeAbi,
      archiveSha256: asset.archiveSha256,
      archiveSizeBytes: asset.archiveSizeBytes,
    })),
  };
  const contentDigest = computeReleaseContentDigest(identityContent);
  // The SPEC's "release metadata digest" input is the digest of the identity
  // content above — hashed again with the kind tag so releaseId ≠ any
  // intermediate digest.
  return createHash('sha256')
    .update(`pd-release-id-v1:${contentDigest}`, 'utf8')
    .digest('hex');
}
