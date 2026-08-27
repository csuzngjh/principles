/**
 * Release advancement preflight policy (SPEC §4.3, §9, §13).
 *
 * Pure decisions over already-validated metadata: publication sequence
 * monotonicity, the explicit downgrade policy, channel pointer integrity,
 * expiry, and bootstrap compatibility. Every refusal carries a stable reason
 * code and an Owner-visible next action (rc-9) and must happen BEFORE any
 * installation state is mutated (ERR-074 guard placement).
 */

import type { ChannelMetadata } from './channel-metadata.js';
import type { ReleaseMetadata } from './release-metadata.js';
import { isChannelMetadataExpired } from './channel-metadata.js';
import { isReleaseMetadataExpired } from './release-metadata.js';
import { compareProductVersions, parseProductVersion } from './product-identity.js';

export type ReleasePolicyRefusalReason =
  | 'channel_pointer_mismatch'
  | 'release_metadata_expired'
  | 'channel_metadata_expired'
  | 'sequence_regression'
  | 'downgrade_blocked'
  | 'bootstrap_too_old';

export interface ReleasePolicyRefusal {
  readonly allowed: false;
  readonly reason: ReleasePolicyRefusalReason;
  readonly message: string;
  readonly nextAction: string;
}

export interface ReleasePolicyAllowance {
  readonly allowed: true;
  readonly direction: 'update' | 'reinstall' | 'explicit_downgrade';
}

export type ReleasePolicyDecision = ReleasePolicyRefusal | ReleasePolicyAllowance;

export interface CurrentInstallationState {
  readonly productVersion: string;
  readonly releaseId: string;
  readonly publicationSequence: number;
  readonly bootstrapVersion: string;
  /** Releases previously confirmed on this installation (rollback-safe targets). */
  readonly previouslyConfirmedReleaseIds: readonly string[];
}

/**
 * The channel pointer must reference exactly this release metadata document
 * (SPEC §4.3: "Channel Metadata references the exact Release Metadata digest").
 */
export function verifyChannelPointer(channel: ChannelMetadata, release: ReleaseMetadata): ReleasePolicyRefusal | null {
  if (channel.releaseMetadataDigest !== release.metadataDigest || channel.releaseId !== release.releaseId) {
    return {
      allowed: false,
      reason: 'channel_pointer_mismatch',
      message: `The signed ${channel.channel} channel points at release metadata ${channel.releaseMetadataDigest.slice(0, 12)} (${channel.productVersion}), not the presented release ${release.releaseId.slice(0, 12)} (${release.productVersion}).`,
      nextAction: 'Do not install this release. Re-fetch channel metadata and the release it references, then retry.',
    };
  }
  if (channel.publicationSequence !== release.publicationSequence) {
    return {
      allowed: false,
      reason: 'channel_pointer_mismatch',
      message: `The channel publication sequence (${channel.publicationSequence}) disagrees with the release metadata sequence (${release.publicationSequence}).`,
      nextAction: 'Do not install this release. The channel pointer and release metadata must come from the same publication.',
    };
  }
  return null;
}

/**
 * Full advancement decision. `allowExplicitDowngrade` is the Owner's explicit
 * confirmation flag; even with it, the target must be a previously confirmed
 * release — arbitrary downgrades to unseen releases stay refused because their
 * data compatibility window is unproven (SPEC §10).
 */
export function evaluateReleaseAdvancement(input: {
  channel: ChannelMetadata;
  candidate: ReleaseMetadata;
  current: CurrentInstallationState | null;
  bootstrapVersion: string;
  now?: Date;
  allowExplicitDowngrade?: boolean;
}): ReleasePolicyDecision {
  const { channel, candidate, current, bootstrapVersion } = input;
  const now = input.now ?? new Date();

  const pointerFailure = verifyChannelPointer(channel, candidate);
  if (pointerFailure) return pointerFailure;

  if (isReleaseMetadataExpired(candidate, now)) {
    return {
      allowed: false,
      reason: 'release_metadata_expired',
      message: `Release ${candidate.productVersion} metadata expired at ${candidate.expiresAt}.`,
      nextAction: 'Do not install this release. Wait for refreshed signed metadata from the official repository.',
    };
  }
  if (isChannelMetadataExpired(channel, now)) {
    return {
      allowed: false,
      reason: 'channel_metadata_expired',
      message: `The ${channel.channel} channel metadata expired at ${channel.expiresAt}.`,
      nextAction: 'Do not install this release. Refresh the signed channel metadata and retry.',
    };
  }

  const bootstrap = parseProductVersion(bootstrapVersion, 'bootstrapVersion');
  const requiredBootstrap = parseProductVersion(candidate.minBootstrapVersion, 'candidate.minBootstrapVersion');
  if (compareProductVersions(bootstrap, requiredBootstrap) < 0) {
    return {
      allowed: false,
      reason: 'bootstrap_too_old',
      message: `Release ${candidate.productVersion} requires bootstrap >= ${candidate.minBootstrapVersion}; installed bootstrap is ${bootstrapVersion}.`,
      nextAction: 'Do not install this release. Run the official installer once to update the bootstrap, then retry the update.',
    };
  }

  if (current === null) {
    return { allowed: true, direction: 'update' };
  }

  if (candidate.releaseId === current.releaseId) {
    return { allowed: true, direction: 'reinstall' };
  }

  if (candidate.publicationSequence < current.publicationSequence) {
    if (input.allowExplicitDowngrade === true && current.previouslyConfirmedReleaseIds.includes(candidate.releaseId)) {
      return { allowed: true, direction: 'explicit_downgrade' };
    }
    return {
      allowed: false,
      reason: current.publicationSequence > candidate.publicationSequence ? 'downgrade_blocked' : 'sequence_regression',
      message: `Release ${candidate.productVersion} (sequence ${candidate.publicationSequence}) is older than the active ${current.productVersion} (sequence ${current.publicationSequence}).`,
      nextAction: input.allowExplicitDowngrade === true
        ? 'Explicit downgrade is only permitted to releases previously confirmed on this installation. Select a confirmed release or update forward.'
        : 'Downgrades are refused by default. If the Owner explicitly intends this, re-run with downgrade confirmation to a previously confirmed release.',
    };
  }

  if (candidate.publicationSequence === current.publicationSequence && candidate.releaseId !== current.releaseId) {
    return {
      allowed: false,
      reason: 'sequence_regression',
      message: `Two different releases claim publication sequence ${candidate.publicationSequence}; the active release is ${current.releaseId.slice(0, 12)}.`,
      nextAction: 'Do not install this release. Report the conflicting metadata to the repository maintainer.',
    };
  }

  return { allowed: true, direction: 'update' };
}
