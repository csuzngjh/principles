/**
 * Channel promotion (SPEC §4.2, §13, §18-8).
 *
 * Promotion changes ONLY the signed channel pointer: the next channel
 * document references an already-published release's exact metadata digest.
 * It never rebuilds, rewrites, or even reads release ASSETS — that is the
 * structural separation-of-duties guarantee this module embodies. Release
 * publication and channel promotion are separate permissions; a promotion
 * credential must not be able to alter a published asset.
 */

import type { ChannelMetadata } from './channel-metadata.js';
import type { ReleaseMetadata } from './release-metadata.js';
import type { ReleaseChannelName } from './product-identity.js';

export type PromotionRefusalReason =
  | 'channel_mismatch'
  | 'sequence_not_advancing'
  | 'channel_version_regression';

export interface PromotionRefusal {
  readonly promoted: false;
  readonly reason: PromotionRefusalReason;
  readonly message: string;
}

export interface PromotionResult {
  readonly promoted: true;
  readonly channel: ReleaseChannelName;
  readonly previousVersion: number | null;
  readonly next: ChannelMetadata;
}

export interface PromotionPlanInput {
  readonly channel: ReleaseChannelName;
  readonly release: ReleaseMetadata;
  readonly current: ChannelMetadata | null;
  /** Bumped by exactly one per promotion (monotonic metadata version). */
  readonly expiresAt: string;
}

/**
 * Plans the next signed channel document. Pure: no I/O, no asset access.
 * The output is what a promotion signer signs — the signature step lives in
 * the release pipeline, never here.
 */
export function planChannelPromotion(input: PromotionPlanInput): PromotionResult | PromotionRefusal {
  const { channel, release, current } = input;

  if (current !== null && current.channel !== channel) {
    return {
      promoted: false,
      reason: 'channel_mismatch',
      message: `The current channel document is for "${current.channel}", not "${channel}".`,
    };
  }
  if (current !== null && release.publicationSequence < current.publicationSequence) {
    return {
      promoted: false,
      reason: 'sequence_not_advancing',
      message: `Promoting release ${release.productVersion} (sequence ${release.publicationSequence}) would move the ${channel} channel backwards from sequence ${current.publicationSequence}.`,
    };
  }

  const previousVersion = current !== null ? current.version : null;
  const nextVersion = (previousVersion ?? 0) + 1;

  const next: ChannelMetadata = {
    schemaVersion: 1,
    channel,
    version: nextVersion,
    expiresAt: input.expiresAt,
    // The pointer triple — the ONLY release facts a promotion may state, and
    // all three come verbatim from the published release metadata.
    releaseMetadataDigest: release.metadataDigest,
    releaseId: release.releaseId,
    productVersion: release.productVersion,
    publicationSequence: release.publicationSequence,
  };

  if (nextVersion <= (previousVersion ?? 0)) {
    return {
      promoted: false,
      reason: 'channel_version_regression',
      message: `Channel version must strictly increase (${previousVersion ?? 0} -> ${nextVersion}).`,
    };
  }

  return { promoted: true, channel, previousVersion, next };
}
