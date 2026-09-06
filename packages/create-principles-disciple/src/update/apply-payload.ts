/**
 * PRI-698 Phase 1 — apply payload acquisition for the ReleaseManager.
 *
 * Bridges the signed metadata world (TUF-verified release metadata + artifact
 * target) and the installer's deployment contract (a local, extracted,
 * self-contained release-asset directory). Owns ONLY acquisition-side writes,
 * strictly bounded to the ReleaseManager staging area:
 *
 *   ~/.pd/staging/<transactionId>/release-asset.tar.gz   (verified download)
 *   ~/.pd/staging/<transactionId>/payload/               (extracted payload)
 *
 * Deployment writes (~/.pd/runtime, host extension dirs) belong exclusively
 * to the installer; this module never touches them (ADR-0023 Decision 1,
 * ADR-0024 §2.1). release-manager.ts itself stays free of filesystem
 * mutation: it orchestrates, this helper acquires.
 *
 * Import-graph constraint: this module is reachable from the console's
 * dynamically-imported authority module, so `installer.js` (the heavy CLI
 * graph) is loaded via dynamic import at acquisition time only — the
 * governed check path never pays for it.
 *
 * Artifact target convention (Phase 1, see
 * docs/architecture/PRI-698-phase4-preflight-analysis.md §4): the release
 * pipeline publishes each release asset as TUF target
 *
 *   releases/<releaseId>/release-asset-<platform>-<arch>.tar.gz
 *
 * with TUF `custom` identity {releaseId, channel, platform} and tarball
 * contents = the release-asset directory at its root (no wrapping component
 * directory). The pipeline does not publish these targets yet; the flag
 * stays off in production until it does.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  resolveTrustedReleaseTarget,
  downloadTrustedReleasePayload,
  type TrustedReleaseTarget,
} from './trust-metadata.js';
import type { ReleaseMetadata } from './release-metadata.js';
import type { ReleaseChannelName } from './product-identity.js';
import type { PdHomePaths } from './install-layout.js';

type TrustFetcher = NonNullable<Parameters<typeof resolveTrustedReleaseTarget>[0]['fetcher']>;

/** Acquisition failure with a stable reason; release-manager.ts maps it onto the ReleaseManagerError contract. */
export class ApplyPayloadError extends Error {
  readonly reason: 'metadata_refresh_failed' | 'release_metadata_invalid';
  readonly nextAction: string;

  constructor(reason: 'metadata_refresh_failed' | 'release_metadata_invalid', message: string, nextAction: string) {
    super(message);
    this.name = 'ApplyPayloadError';
    this.reason = reason;
    this.nextAction = nextAction;
  }
}

/**
 * Select the release asset matching THIS runtime (platform + arch + node ABI)
 * from the signed release metadata. A payload built for a different node ABI
 * can break native modules after the swap, so a mismatch is a refusal, never
 * a warning (rc-3: fail loud before any mutation).
 */
export function selectReleaseAsset(releaseMetadata: ReleaseMetadata): ReleaseMetadata['assets'][number] {
  const {platform} = process;
  const {arch} = process;
  const nodeAbi = process.versions.modules;
  const asset = releaseMetadata.assets.find((a) => a.platform === platform && a.arch === arch);
  if (asset === undefined) {
    throw new ApplyPayloadError(
      'release_metadata_invalid',
      `Release ${releaseMetadata.productVersion} declares no asset for this platform (${platform}/${arch}); declared: ${releaseMetadata.assets.map((a) => `${a.platform}/${a.arch}`).join(', ') || 'none'}.`,
      'Wait for a release asset covering this platform, or update from a supported host.',
    );
  }
  if (asset.nodeAbi !== nodeAbi) {
    throw new ApplyPayloadError(
      'release_metadata_invalid',
      `Release ${releaseMetadata.productVersion} asset for ${platform}/${arch} targets node ABI ${asset.nodeAbi}, but this runtime is ABI ${nodeAbi}.`,
      'Upgrade the bootstrap runtime first, or publish a release asset built for this node ABI.',
    );
  }
  return asset;
}

/** TUF target path of the release asset for THIS platform (Phase 1 convention). */
export function releaseAssetTargetPath(releaseId: string): string {
  return `releases/${releaseId}/release-asset-${process.platform}-${process.arch}.tar.gz`;
}

export interface DownloadReleaseAssetOptions {
  readonly paths: PdHomePaths;
  readonly metadataBaseUrl: string;
  readonly fetcher?: TrustFetcher;
  readonly releaseMetadata: ReleaseMetadata;
  readonly channel: ReleaseChannelName;
  /** Transaction the acquisition is journaled under; scopes the staging dir. */
  readonly transactionId: string;
}

export interface DownloadedReleaseAsset {
  readonly transactionDir: string;
  readonly archivePath: string;
  readonly trustedTarget: TrustedReleaseTarget;
}

/**
 * Resolve the signed artifact target, cross-check the TUF identity and digest
 * against the signed release metadata (rc-6), and download it with in-flight
 * sha256 verification into `~/.pd/staging/<transactionId>/`.
 * Zero writes happen before every identity check has passed.
 */
export async function downloadReleaseAsset(options: DownloadReleaseAssetOptions): Promise<DownloadedReleaseAsset> {
  const { paths, metadataBaseUrl, fetcher, releaseMetadata, channel, transactionId } = options;
  const asset = selectReleaseAsset(releaseMetadata);
  const targetPath = releaseAssetTargetPath(releaseMetadata.releaseId);

  let trustedTarget: TrustedReleaseTarget;
  try {
    trustedTarget = await resolveTrustedReleaseTarget({
      metadataDir: paths.trustDir,
      metadataBaseUrl,
      targetPath,
      expectedChannel: channel,
      expectedPlatform: process.platform,
      fetcher,
    });
  } catch (error) {
    throw new ApplyPayloadError(
      'metadata_refresh_failed',
      `The signed artifact target for release ${releaseMetadata.releaseId} could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
      'Verify that the release pipeline published this release asset to the signed repository, then retry.',
    );
  }
  // rc-6: the TUF-signed identity and the release metadata must name the same
  // release and the same bytes — a mismatch means the channel points at
  // metadata the artifact repo does not answer for. Refuse before any write.
  if (trustedTarget.releaseId !== releaseMetadata.releaseId) {
    throw new ApplyPayloadError(
      'release_metadata_invalid',
      `Signed artifact target names release ${trustedTarget.releaseId}, but the channel metadata names ${releaseMetadata.releaseId}.`,
      'The release repository is inconsistent; wait for refreshed signed metadata. Nothing was modified.',
    );
  }
  if (trustedTarget.artifactSha256 !== asset.archiveSha256) {
    throw new ApplyPayloadError(
      'release_metadata_invalid',
      'The signed artifact digest disagrees with the digest in the signed release metadata.',
      'The release repository is inconsistent; wait for refreshed signed metadata. Nothing was modified.',
    );
  }

  const transactionDir = path.join(paths.stagingDir, transactionId);
  const archivePath = path.join(transactionDir, 'release-asset.tar.gz');
  fs.mkdirSync(transactionDir, { recursive: true });
  try {
    await downloadTrustedReleasePayload({
      metadataDir: paths.trustDir,
      metadataBaseUrl,
      targetPath,
      destinationPath: archivePath,
      fetcher,
    });
  } catch (error) {
    throw new ApplyPayloadError(
      'metadata_refresh_failed',
      `The signed release asset could not be downloaded: ${error instanceof Error ? error.message : String(error)}`,
      'Check network access to the release repository and retry; nothing was deployed.',
    );
  }
  return { transactionDir, archivePath, trustedTarget };
}

export interface ExtractAndVerifyOptions {
  readonly transactionDir: string;
  readonly archivePath: string;
}

/**
 * Extract the release-asset tarball with the same discipline as the legacy
 * console updater (EP-08): spawn tar via an argv array so paths stay data,
 * and use cwd + RELATIVE archive/dir paths — Git Bash GNU tar on Windows
 * misparses `D:\...` as a remote host (ERR: "Cannot connect to C:"), while
 * Windows System32 bsdtar does not support GNU's --force-local. Relative is
 * the universal form.
 */
function extractReleaseAssetArchive(transactionDir: string, payloadDir: string): void {
  execFileSync('tar', ['xzf', 'release-asset.tar.gz', '-C', 'payload'], {
    cwd: transactionDir,
    stdio: 'pipe',
  });
  if (!fs.existsSync(path.join(payloadDir, '_release', 'manifest.json'))) {
    throw new Error(
      'the artifact tarball does not contain a self-contained release asset at its root (missing _release/manifest.json)',
    );
  }
}

/**
 * Extract the verified archive inside the staging transaction dir and run the
 * installer's own self-contained asset preflight (the same verification gate
 * a manual `npx create-principles-disciple` run of this payload would face).
 * Every write stays inside the staging transaction dir.
 */
export async function extractAndVerifyReleaseAsset(options: ExtractAndVerifyOptions): Promise<{ payloadDir: string }> {
  const { transactionDir, archivePath } = options;
  if (!fs.existsSync(archivePath)) {
    throw new ApplyPayloadError(
      'release_metadata_invalid',
      `The verified release archive is missing from staging: ${archivePath}`,
      'Nothing was deployed; the runtime is unchanged. Retry the update.',
    );
  }
  const payloadDir = path.join(transactionDir, 'payload');
  try {
    fs.mkdirSync(payloadDir, { recursive: true });
    extractReleaseAssetArchive(transactionDir, payloadDir);
    // Dynamic import: keeps installer.js (and its CLI dependency graph) out
    // of the module graph until a real acquisition needs it — the governed
    // check path never pays for it.
    const { preflightSelfContainedReleaseAsset } = await import('../installer.js');
    await preflightSelfContainedReleaseAsset(payloadDir);
  } catch (error) {
    if (error instanceof ApplyPayloadError) throw error;
    throw new ApplyPayloadError(
      'release_metadata_invalid',
      `The downloaded release payload failed verification: ${error instanceof Error ? error.message : String(error)}`,
      'Nothing was deployed; the runtime is unchanged. Retry the update after the release repository issue is resolved.',
    );
  }
  return { payloadDir };
}
