/**
 * ReleaseManager — the deep module behind every update surface (SPEC §6.2).
 *
 * External surface is intentionally small: inspect / check / apply /
 * rollback. The module hides metadata validation, download, extraction,
 * staging, probes, journaling, host control, rollback, and cleanup. In this
 * phase (shadow mode) apply/rollback refuse read-only: activation lands with
 * the transaction state machine, never by loosening this gate.
 *
 * Every refusal carries a stable reason and an Owner-visible next action
 * (rc-9) and is computed BEFORE any installation state is mutated.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveTrustedReleaseTarget, downloadTrustedReleasePayload, ReleaseTrustError, type TrustedReleaseTarget } from './trust-metadata.js';
import { parseChannelMetadata, type ChannelMetadata } from './channel-metadata.js';
import {
  buildReleaseMetadata,
  isReleaseMetadataExpired,
  parseReleaseMetadata,
  verifyReleaseMetadataIdentity,
  type ReleaseMetadata,
} from './release-metadata.js';
import {
  evaluateReleaseAdvancement,
  type ReleasePolicyDecision,
} from './release-policy.js';
import {
  readBootstrapManifest,
  readInstallConfig,
  resolvePdHomePaths,
  type BootstrapManifest,
  type InstallConfig,
  type PdHomePaths,
} from './install-layout.js';
import type { ReleaseChannelName } from './product-identity.js';

export type ReleaseManagerReason =
  | 'shadow_mode_read_only'
  | 'bootstrap_not_installed'
  | 'metadata_refresh_failed'
  | 'release_metadata_unavailable'
  | 'release_metadata_invalid';

export class ReleaseManagerError extends Error {
  readonly reason: ReleaseManagerReason;
  readonly nextAction: string;

  constructor(reason: ReleaseManagerReason, message: string, nextAction: string) {
    super(message);
    this.name = 'ReleaseManagerError';
    this.reason = reason;
    this.nextAction = nextAction;
  }
}

export type InstallationLayout = 'dual-slot' | 'legacy-overlay' | 'none';

export interface InstallStatus {
  readonly layout: InstallationLayout;
  readonly productVersion: string | null;
  readonly releaseId: string | null;
  readonly generation: number | null;
  readonly bootstrapVersion: string | null;
  readonly channel: ReleaseChannelName;
}

/** What the legacy updater decided for the same question (shadow comparison). */
export interface LegacyUpdaterDecision {
  readonly source: 'legacy-updater';
  readonly latestVersion: string | null;
  readonly updateAvailable: boolean | null;
}

export interface UpdateCheck {
  readonly channel: ReleaseChannelName;
  readonly candidate: {
    readonly productVersion: string;
    readonly releaseId: string;
    readonly publicationSequence: number;
    readonly assets: readonly { platform: string; arch: string; nodeAbi: string }[];
  } | null;
  readonly decision: ReleasePolicyDecision;
  readonly trustedTarget: TrustedReleaseTarget | null;
  readonly shadowComparison: {
    readonly legacy: LegacyUpdaterDecision | null;
    readonly agrees: boolean | null;
    readonly note: string | null;
  };
}

export interface ReleaseManagerOptions {
  readonly pdHome: string;
  readonly metadataBaseUrl: string;
  readonly fetcher?: Parameters<typeof resolveTrustedReleaseTarget>[0]['fetcher'];
  readonly now?: () => Date;
  /** Injected in production from the legacy updater; tests inject fakes. */
  readonly legacyCheck?: (currentVersion: string) => Promise<LegacyUpdaterDecision | null>;
}

interface ActiveRecord {
  readonly generation: number;
  readonly releaseId: string;
  readonly productVersion: string;
}

function readActiveRecord(paths: PdHomePaths): ActiveRecord | null {
  if (!fs.existsSync(paths.activeRecordPath)) return null;
  const value: unknown = JSON.parse(fs.readFileSync(paths.activeRecordPath, 'utf8')) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReleaseManagerError(
      'release_metadata_invalid',
      `active.json is corrupt and must be recovered from the transaction journal: ${paths.activeRecordPath}`,
      'Run the official installer recovery or an explicit update operation; the last journal-confirmed release is selected automatically.',
    );
  }
  const generation: unknown = Reflect.get(value, 'generation');
  const releaseId: unknown = Reflect.get(value, 'releaseId');
  const productVersion: unknown = Reflect.get(value, 'productVersion');
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1
    || typeof releaseId !== 'string' || releaseId.length === 0
    || typeof productVersion !== 'string' || productVersion.length === 0) {
    throw new ReleaseManagerError(
      'release_metadata_invalid',
      `active.json is malformed and must be recovered from the transaction journal: ${paths.activeRecordPath}`,
      'Run the official installer recovery or an explicit update operation; the last journal-confirmed generation is selected automatically.',
    );
  }
  return { generation, releaseId, productVersion };
}

/**
 * The signed channel document is fetched from the trusted TUF target
 * `channels/<channel>.json`; its payload is the ChannelMetadata. The release
 * metadata document comes from `releases/<release-id>/metadata.json` —
 * already verified as a trusted target with an exact digest.
 */
export class ReleaseManager {
  private readonly paths: PdHomePaths;
  private readonly options: ReleaseManagerOptions;

  constructor(options: ReleaseManagerOptions) {
    this.options = options;
    this.paths = resolvePdHomePaths(options.pdHome);
  }

  inspect(): InstallStatus {
    const installConfig: InstallConfig = readInstallConfig(this.paths);
    const bootstrap: BootstrapManifest | null = readBootstrapManifest(this.paths);
    const active = readActiveRecord(this.paths);
    const layout: InstallationLayout = active !== null
      ? 'dual-slot'
      : fs.existsSync(this.paths.releasesDir) || fs.existsSync(this.paths.activeRecordPath)
        ? 'dual-slot'
        : fs.existsSync(this.legacyOverlayMarker())
          ? 'legacy-overlay'
          : 'none';
    return {
      layout,
      productVersion: active?.productVersion ?? null,
      releaseId: active?.releaseId ?? null,
      generation: active?.generation ?? null,
      bootstrapVersion: bootstrap?.bootstrapVersion ?? null,
      channel: installConfig.channel,
    };
  }

  async check(channel: ReleaseChannelName): Promise<UpdateCheck> {
    const now = this.options.now ?? ((): Date => new Date());
    const status = this.inspect();
    const channelTargetPath = `channels/${channel}.json`;

    let trustedTarget: TrustedReleaseTarget;
    try {
      trustedTarget = await resolveTrustedReleaseTarget({
        metadataDir: this.paths.trustDir,
        metadataBaseUrl: this.options.metadataBaseUrl,
        targetPath: channelTargetPath,
        expectedChannel: channel,
        expectedPlatform: 'metadata',
        fetcher: this.options.fetcher,
      });
    } catch (error) {
      if (error instanceof ReleaseTrustError) {
        throw new ReleaseManagerError(
          'metadata_refresh_failed',
          error.message,
          error.nextAction,
        );
      }
      throw error;
    }

    // Download the digest-verified channel payload into the installation's
    // channels cache before parsing it (verify-then-trust, never the reverse).
    await downloadTrustedReleasePayload({
      metadataDir: this.paths.trustDir,
      metadataBaseUrl: this.options.metadataBaseUrl,
      targetPath: channelTargetPath,
      destinationPath: path.join(this.paths.channelsDir, `${channel}.json`),
      fetcher: this.options.fetcher,
    });

    const channelMetadata = this.readChannelMetadataPayload(channel);

    const releaseMetadata = this.readReleaseMetadataDocument(channelMetadata, now);

    // Current state for the advancement policy comes from the ACTIVE release's
    // own metadata when a dual-slot installation exists.
    let decision = evaluateReleaseAdvancement({
      channel: channelMetadata,
      candidate: releaseMetadata,
      current: null,
      bootstrapVersion: status.bootstrapVersion ?? '0.0.0',
      now: now(),
    });
    if (status.releaseId !== null && status.productVersion !== null) {
      const activeMetadata = this.readActiveReleaseMetadata(status.releaseId);
      if (activeMetadata !== null) {
        decision = evaluateReleaseAdvancement({
          channel: channelMetadata,
          candidate: releaseMetadata,
          current: {
            productVersion: status.productVersion,
            releaseId: status.releaseId,
            publicationSequence: activeMetadata.publicationSequence,
            bootstrapVersion: status.bootstrapVersion ?? '0.0.0',
            previouslyConfirmedReleaseIds: [status.releaseId],
          },
          bootstrapVersion: status.bootstrapVersion ?? '0.0.0',
          now: now(),
        });
      }
    }

    const candidate = {
      productVersion: releaseMetadata.productVersion,
      releaseId: releaseMetadata.releaseId,
      publicationSequence: releaseMetadata.publicationSequence,
      assets: releaseMetadata.assets.map((asset) => ({
        platform: asset.platform,
        arch: asset.arch,
        nodeAbi: asset.nodeAbi,
      })),
    };

    const shadowComparison = await this.compareWithLegacyUpdater(status, decision, candidate.productVersion);

    return {
      channel,
      candidate,
      decision,
      trustedTarget,
      shadowComparison,
    };
  }

  async apply(): Promise<never> {
    void this.paths; // reserved: Phase 4 activation drives this.paths / this.options
    throw new ReleaseManagerError(
      'shadow_mode_read_only',
      'Release application is not enabled yet: the ReleaseManager runs in read-only shadow mode while the transactional activation system is brought up.',
      'Continue using the current update path. Activation arrives with the dual-slot transaction rollout; this refusal protects against hybrid installations.',
    );
  }

  async rollback(): Promise<never> {
    void this.paths; // reserved: Phase 4 rollback drives this.paths / this.options
    throw new ReleaseManagerError(
      'shadow_mode_read_only',
      'Rollback is not enabled yet: the ReleaseManager runs in read-only shadow mode while the transactional activation system is brought up.',
      'Continue using the current update path. Rollback arrives with the dual-slot transaction rollout.',
    );
  }

  private legacyOverlayMarker(): string {
    return path.join(this.paths.home, '..', '.openclaw', 'extensions', 'principles-disciple');
  }

  private readChannelMetadataPayload(channel: ReleaseChannelName): ChannelMetadata {
    // The channel payload was downloaded and digest-verified by the TUF chain
    // before this reader parses it (verify-then-trust).
    const payloadPath = path.join(this.paths.channelsDir, `${channel}.json`);
    if (!fs.existsSync(payloadPath)) {
      throw new ReleaseManagerError(
        'release_metadata_unavailable',
        `The signed channel payload is not cached locally: ${payloadPath}`,
        'Re-run the update check so the verified channel payload is stored, then retry.',
      );
    }
    const payload: unknown = JSON.parse(fs.readFileSync(payloadPath, 'utf8')) as unknown;
    return parseChannelMetadata(payload);
  }

  private readActiveReleaseMetadata(releaseId: string): ReleaseMetadata | null {
    const metadataPath = path.join(this.paths.releasesDir, releaseId, 'metadata.json');
    if (!fs.existsSync(metadataPath)) return null;
    const document: unknown = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as unknown;
    const metadata = parseReleaseMetadata(document);
    verifyReleaseMetadataIdentity(metadata);
    return metadata;
  }

  private readReleaseMetadataDocument(
    channel: ChannelMetadata,
    now: () => Date,
  ): ReleaseMetadata {
    const releaseDir = path.join(this.paths.releasesDir, channel.releaseId);
    const metadataPath = path.join(releaseDir, 'metadata.json');
    if (!fs.existsSync(metadataPath)) {
      throw new ReleaseManagerError(
        'release_metadata_unavailable',
        `Release metadata for ${channel.productVersion} is not available locally: ${metadataPath}`,
        'This shadow-mode check only evaluates already-verified metadata. Download arrives with the transactional updater.',
      );
    }
    const document: unknown = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as unknown;
    const metadata = parseReleaseMetadata(document);
    verifyReleaseMetadataIdentity(metadata);
    if (isReleaseMetadataExpired(metadata, now())) {
      throw new ReleaseManagerError(
        'release_metadata_invalid',
        `Release metadata for ${metadata.productVersion} expired at ${metadata.expiresAt}.`,
        'Wait for refreshed signed metadata from the official repository.',
      );
    }
    if (metadata.metadataDigest !== channel.releaseMetadataDigest) {
      throw new ReleaseManagerError(
        'release_metadata_invalid',
        'The cached release metadata does not match the digest the signed channel points at.',
        'Re-run the update check to re-verify metadata, then retry.',
      );
    }
    return metadata;
  }

  private async compareWithLegacyUpdater(
    status: InstallStatus,
    decision: ReleasePolicyDecision,
    candidateVersion: string,
  ): Promise<UpdateCheck['shadowComparison']> {
    if (this.options.legacyCheck === undefined || status.productVersion === null) {
      return { legacy: null, agrees: null, note: 'legacy comparison unavailable (no legacy updater or no active release)' };
    }
    let failureNote: string | null = null;
    const legacy = await this.options.legacyCheck(status.productVersion).catch((error: unknown) => {
      failureNote = `legacy updater failed: ${error instanceof Error ? error.message : String(error)}`;
      return null;
    });
    if (failureNote !== null) {
      return { legacy: null, agrees: null, note: failureNote };
    }
    if (legacy === null) {
      return { legacy: null, agrees: null, note: 'legacy updater returned no decision' };
    }
    const newWouldAdvance = decision.allowed && decision.direction !== 'reinstall';
    const legacyWouldAdvance = legacy.updateAvailable === true
      && legacy.latestVersion !== null
      && legacy.latestVersion !== status.productVersion;
    const agrees = newWouldAdvance === legacyWouldAdvance;
    return {
      legacy,
      agrees,
      note: agrees ? null : `decision mismatch: new=${newWouldAdvance ? 'advance' : 'no-advance'} (${candidateVersion}) legacy=${legacyWouldAdvance ? 'advance' : 'no-advance'} (${legacy.latestVersion ?? 'unknown'})`,
    };
  }
}

/** Producer helper re-exported for the publication pipeline. */
export { buildReleaseMetadata };
