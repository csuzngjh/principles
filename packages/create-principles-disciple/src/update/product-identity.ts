/**
 * Canonical product identity (SPEC §4.1, §12).
 *
 * The product has ONE public `productVersion`. Component package versions are
 * diagnostics. This module owns the strict runtime contract every surface
 * (CLI, Console, Companion, manifest) must share so they can never report
 * incompatible meanings of "current version".
 */

export type ReleaseChannelName = 'stable' | 'candidate';

const PRODUCT_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}$/;

export interface CanonicalProductVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly productVersion: string;
}

export class ProductIdentityError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'ProductIdentityError';
    this.field = field;
  }
}

/** Strict `x.y.z` parse — no prerelease/build suffixes in the product version. */
export function parseProductVersion(value: unknown, field = 'productVersion'): CanonicalProductVersion {
  if (typeof value !== 'string' || !PRODUCT_VERSION_PATTERN.test(value)) {
    throw new ProductIdentityError(field, `${field} must be a strict x.y.z version, got: ${JSON.stringify(value)}`);
  }
  const [major, minor, patch] = value.split('.');
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    productVersion: value,
  };
}

/** Total-order comparison; negative when `left` is older than `right`. */
export function compareProductVersions(left: CanonicalProductVersion, right: CanonicalProductVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value);
}

export function assertSha256Hex(value: unknown, field: string): string {
  if (!isSha256Hex(value)) {
    throw new ProductIdentityError(field, `${field} must be a lowercase 64-char sha256 hex digest, got: ${JSON.stringify(value)}`);
  }
  return value;
}

export function assertGitCommit(value: unknown, field: string): string {
  if (typeof value !== 'string' || !GIT_COMMIT_PATTERN.test(value)) {
    throw new ProductIdentityError(field, `${field} must be a 40-char git commit sha, got: ${JSON.stringify(value)}`);
  }
  return value;
}

export function isReleaseChannelName(value: unknown): value is ReleaseChannelName {
  return value === 'stable' || value === 'candidate';
}

/**
 * Product identity stamped INTO a release asset before the asset bytes are
 * hashed (SPEC §12 "embedded identity"): `_release/product-identity.json`.
 *
 * This is the SAME product identity owned by this module — not a second
 * identity. The stamp deliberately excludes `releaseId`: a releaseId derived
 * from artifact hashes can never be embedded into the hashed artifact itself
 * (circular hashing). The canonical releaseId is derived later, downstream,
 * from the stamped artifact's digest via `deriveReleaseId`.
 *
 * Parser contract (rc-2/rc-3): present-but-malformed stamps fail loud — an
 * installer must never guess which facts of a broken identity to trust.
 * Absence is the legacy shape and stays readable (provenance-unavailable).
 */
export interface EmbeddedProductIdentity {
  readonly schemaVersion: 1;
  readonly productVersion: string;
  readonly sourceCommit: string;
}

export function parseEmbeddedProductIdentity(value: unknown): EmbeddedProductIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProductIdentityError('productIdentity', `embedded product identity must be a JSON object, got: ${JSON.stringify(value)}`);
  }
  const record = value as Record<string, unknown>;
  const schemaVersion = Object.hasOwn(record, 'schemaVersion') ? record.schemaVersion : undefined;
  if (schemaVersion !== 1) {
    throw new ProductIdentityError('schemaVersion', `embedded product identity has unsupported schemaVersion: ${JSON.stringify(schemaVersion)}`);
  }
  return {
    schemaVersion: 1,
    productVersion: parseProductVersion(Object.hasOwn(record, 'productVersion') ? record.productVersion : undefined).productVersion,
    sourceCommit: assertGitCommit(Object.hasOwn(record, 'sourceCommit') ? record.sourceCommit : undefined, 'sourceCommit'),
  };
}

/**
 * `pd version --json` report (SPEC §12). Phase 1 defines the contract; the
 * product surfaces fill it in Phase 6. Every field is required so a missing
 * fact fails loud instead of degrading into a partial lie.
 */
export interface VersionReport {
  readonly productVersion: string;
  readonly releaseId: string;
  readonly components: Readonly<Record<string, string>>;
  readonly bootstrapVersion: string;
  readonly channel: ReleaseChannelName;
  readonly source: 'official-installer' | 'official-legacy-overlay' | 'development-checkout' | 'unknown';
  readonly generation: number;
  readonly health: 'healthy' | 'degraded' | 'corrupt';
  readonly lastTransaction: Readonly<{ id: string; kind: string; outcome: string }> | null;
}

/** `pd --version` short stable text contract: `Principles Disciple <version> (<releaseId prefix>)`. */
export function formatShortVersion(report: Pick<VersionReport, 'productVersion' | 'releaseId'>): string {
  return `Principles Disciple ${report.productVersion} (${report.releaseId.slice(0, 12)})`;
}
