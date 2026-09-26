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
 * A verified download is published onto the first path by rename: the bytes
 * first land in a private `release-asset-<uuid>-<releaseId>.tar.gz.part`
 * candidate in that same directory (PRI-927), which never outlives the call.
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
import { createHash, randomUUID } from 'node:crypto';
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

/**
 * PRI-927: the transport for signed ASSET bytes, injectable for tests.
 *
 * It is fetch-shaped rather than the tuf-js `Fetcher` the metadata branch uses,
 * because the bounded-retry policy reads the HTTP status to tell a stable
 * refusal (404) from a transient one (408/429/5xx) — a download-by-bytes
 * interface cannot report that. Production never injects it: the default is
 * `globalThis.fetch`. Tests use it to drive the transport classes
 * deterministically; it is NOT a way around the protocol gate, which runs on
 * the URL before the transport is ever called.
 */
export type AssetFetcher = (url: string, init?: { readonly redirect?: 'follow' }) => Promise<Response>;

/** Acquisition failure with a stable reason; release-manager.ts maps it onto the ReleaseManagerError contract. */
export class ApplyPayloadError extends Error {
  readonly reason: 'metadata_refresh_failed' | 'release_metadata_invalid' | 'runtime_not_supported';
  readonly nextAction: string;

  constructor(reason: 'metadata_refresh_failed' | 'release_metadata_invalid' | 'runtime_not_supported', message: string, nextAction: string) {
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
  // PRI-852 review fix: select on the FULL triple platform+arch+ABI. A
  // first-match on platform/arch alone would pick another runtime's asset and
  // then fail its own ABI check — exactly the multi-ABI gap this closes.
  const asset = releaseMetadata.assets.find((a) => a.platform === platform && a.arch === arch && a.nodeAbi === nodeAbi);
  if (asset === undefined) {
    const platformAssets = releaseMetadata.assets.filter((a) => a.platform === platform && a.arch === arch);
    if (platformAssets.length > 0) {
      throw new ApplyPayloadError(
        'runtime_not_supported',
        `Release ${releaseMetadata.productVersion} has ${platform}/${arch} assets for Node ABI ${platformAssets.map((a) => a.nodeAbi).join(', ')}, but this runtime is ABI ${nodeAbi}.`,
        'Current runtime is not supported by this release yet. PD has not been updated.',
      );
    }
    throw new ApplyPayloadError(
      'release_metadata_invalid',
      `Release ${releaseMetadata.productVersion} declares no asset for this platform (${platform}/${arch}); declared: ${releaseMetadata.assets.map((a) => `${a.platform}/${a.arch}`).join(', ') || 'none'}.`,
      'Wait for a release asset covering this platform, or update from a supported host.',
    );
  }
  return asset;
}

/**
 * TUF target path of the release asset for THIS platform (PRI-850/ABI
 * convention: the Node ABI is part of the asset identity, so two runtimes on
 * one platform never share a file name). `legacyReleaseAssetTargetPath`
 * returns the pre-ABI name for releases published before the matrix gained
 * the ABI axis — both names resolve only through signed targets, so the
 * fallback is cryptographically safe.
 */
export function releaseAssetTargetPath(releaseId: string, asset: { platform: string; arch: string; nodeAbi: string }): string {
  return `releases/${releaseId}/release-asset-${asset.platform}-${asset.arch}-abi${asset.nodeAbi}.tar.gz`;
}

export function legacyReleaseAssetTargetPath(releaseId: string, asset: { platform: string; arch: string }): string {
  return `releases/${releaseId}/release-asset-${asset.platform}-${asset.arch}.tar.gz`;
}

export interface DownloadReleaseAssetOptions {
  readonly paths: PdHomePaths;
  readonly metadataBaseUrl: string;
  readonly fetcher?: TrustFetcher;
  /**
   * PRI-927: transport for the url branch only. The two branches have two
   * genuinely different transports (the TUF client takes a `Fetcher` object,
   * the asset carrier takes fetch), so the seams stay named separately rather
   * than unioned. Unset in production.
   */
  readonly assetFetcher?: AssetFetcher;
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
 * PRI-854 (option A): fetch the asset from its signed delivery URL and verify
 * the sha256 (and declared size) BEFORE the bytes are considered acquired.
 * PRI-927: only an **https** URL is accepted, and verified bytes are published
 * to the canonical name by an atomic rename out of a private candidate file —
 * see the two Owner-decision notes inside.
 *
 * PRI-924: the acquisition is a transport with a bounded retry, not a
 * single-shot gamble. A ~200MB asset over a CDN that resets connections was
 * killing apply at 'planned' with zero recovery attempts. Retry policy is a
 * transport/HTTP-5xx-or-408/429-or-network-throw classification ONLY — a
 * signed sha256/size disagreement (the trust anchor) aborts immediately, so a
 * corrupt or substituted candidate is never re-drawn until it looks right.
 */
const ASSET_DOWNLOAD_ATTEMPTS = 3;

function isRetriableHttpStatus(status: number): boolean {
  // 4xx = the carrier refuses on its face (404: not published) — retrying
  // re-asks a stable answer. Server-side and rate-limit codes are transient.
  return status === 408 || status === 429 || status >= 500;
}

/** Undefined for a value no transport could resolve; the caller refuses those. */
function parseAssetUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

export async function downloadAndVerifyAssetFile(input: {
  url: string;
  destinationPath: string;
  expectedSha256: string;
  expectedSizeBytes?: number;
  releaseId: string;
  /** Test seam for the transport (PRI-927); production uses global fetch. */
  fetcher?: AssetFetcher;
  /** Test seam: backoff between attempts (default 2000ms × attempt). */
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  // PRI-927 (Owner decision): HTTPS-only, no warning mode and no insecure
  // override. The signed sha256+size below is the trust anchor, so a plaintext
  // carrier cannot substitute bytes — but it can corrupt every delivery and
  // turn the update into a permanent, unrecoverable failure. Refusing the
  // protocol is the availability fix, and it runs BEFORE any transport call.
  //
  // The test lives in THIS scope, on the URL object the transport is handed,
  // not behind a shared helper: an insecure carrier has to be refused where it
  // would actually be opened, which is also where the analyzer watching this
  // boundary looks (CodeQL js/insecure-download reported the fetch call itself
  // while the policy sat in a cross-module predicate). The signed-document
  // parser applies the same 'https:' policy to the same field before this
  // function can be reached; both sides are pinned by their own tests.
  const assetUrl = parseAssetUrl(input.url);
  if (assetUrl === undefined || assetUrl.protocol !== 'https:') {
    throw new ApplyPayloadError('release_metadata_invalid', `Asset URL must be an https URL: ${input.url}`, 'Do not install this release. The signed release metadata names a non-HTTPS asset URL; refresh it from the official repository.');
  }
  const fetchAsset = input.fetcher ?? globalThis.fetch;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  fs.mkdirSync(path.dirname(input.destinationPath), { recursive: true });
  let bytes: Buffer | undefined;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetchAsset(assetUrl.href, { redirect: 'follow' });
      if (!response.ok) {
        // A rejected response is not the payload: release its connection now
        // instead of parking it until GC, or three attempts per call across
        // repeated applies would accumulate sockets.
        await response.body?.cancel();
        const detail = `Asset download failed: HTTP ${response.status} for ${input.url}`;
        if (!isRetriableHttpStatus(response.status) || attempt >= ASSET_DOWNLOAD_ATTEMPTS) {
          throw new ApplyPayloadError('metadata_refresh_failed', detail, 'Verify that the release pipeline published this release asset, then retry.');
        }
      } else {
        bytes = Buffer.from(await response.arrayBuffer());
        break;
      }
    } catch (error) {
      // Trust-anchor refusals and terminal transport verdicts escape as-is.
      if (error instanceof ApplyPayloadError) throw error;
      if (attempt >= ASSET_DOWNLOAD_ATTEMPTS) {
        throw new ApplyPayloadError(
          'metadata_refresh_failed',
          `Asset download failed after ${ASSET_DOWNLOAD_ATTEMPTS} attempts: ${input.url} (${error instanceof Error ? error.message : String(error)})`,
          'Check network access to the release asset carrier and retry; nothing was deployed.',
        );
      }
    }
    await sleep(2000 * attempt);
  }
  const size = bytes.length;
  const hash = createHash('sha256');
  hash.update(bytes);
  // Case-normalize: upstream digest casing must never flip the verdict.
  if (hash.digest('hex') !== input.expectedSha256.toLowerCase()) {
    throw new ApplyPayloadError('release_metadata_invalid', `Asset bytes do not match the signed sha256 for release ${input.releaseId}.`, 'Do not install this release. Re-fetch the signed metadata and retry.');
  }
  if (input.expectedSizeBytes !== undefined && size !== input.expectedSizeBytes) {
    throw new ApplyPayloadError('release_metadata_invalid', `Asset size ${size} disagrees with the signed size ${input.expectedSizeBytes}.`, 'The release repository is inconsistent; wait for refreshed signed metadata.');
  }
  // PRI-927 (Owner decision: fix, do not dismiss): network bytes never reach
  // the canonical name in an unverified or predictable form. The verified bytes
  // go to an unguessable, exclusively-created candidate in the SAME staging
  // transaction directory (same filesystem, so the publish step below is an
  // atomic rename), and only that candidate is renamed onto the canonical
  // path. This is the discipline the TUF branch already followed
  // (trust-metadata.ts downloadTrustedReleasePayload), reused rather than
  // reinvented; the size re-check is on the file that actually landed, so a
  // short write can never be published. Every failure removes the candidate.
  const candidatePath = path.join(
    path.dirname(input.destinationPath),
    `release-asset-${randomUUID()}-${input.releaseId.slice(0, 12)}.tar.gz.part`,
  );
  try {
    fs.writeFileSync(candidatePath, bytes, { mode: 0o600, flag: 'wx' });
    const landedBytes = fs.statSync(candidatePath).size;
    if (input.expectedSizeBytes !== undefined && landedBytes !== input.expectedSizeBytes) {
      throw new ApplyPayloadError(
        'metadata_refresh_failed',
        `The staged asset file is ${landedBytes} bytes, disagreeing with the signed size ${input.expectedSizeBytes}.`,
        'Nothing was deployed; the runtime is unchanged. Retry the update.',
      );
    }
    fs.renameSync(candidatePath, input.destinationPath);
  } catch (error) {
    // The candidate is garbage the moment anything below it fails; staging
    // recycle (PRI-924) owns the directory, this owns only its own file.
    // Windows can hold a just-written file (EBUSY/EPERM, ERR-071), and a
    // cleanup error must never replace the acquisition error: the leftover
    // keeps an unguessable name inside a directory this transaction owns.
    try {
      fs.rmSync(candidatePath, { force: true });
    } catch {
      /* ignored on purpose — the real failure is the one being reported */
    }
    if (error instanceof ApplyPayloadError) throw error;
    throw new ApplyPayloadError(
      'metadata_refresh_failed',
      `The verified release asset could not be staged: ${error instanceof Error ? error.message : String(error)}`,
      'Nothing was deployed; the runtime is unchanged. Check disk space and permissions under the PD staging area, then retry.',
    );
  }
}

/**
 * Acquires the release asset for THIS runtime (PRI-854, two transports):
 *  - url branch: the signed metadata names the byte carrier (Release
 *    attachment) — download once, verify signed sha256+size, done.
 *  - legacy branch: resolve the signed TUF target (ABI name + pre-ABI
 *    fallback), cross-check identity/digest against the metadata (rc-6),
 *    download through the trusted payload path.
 * Zero deployment writes happen before every identity check has passed.
 */
export async function downloadReleaseAsset(options: DownloadReleaseAssetOptions): Promise<DownloadedReleaseAsset> {
  const { paths, metadataBaseUrl, fetcher, assetFetcher, releaseMetadata, channel, transactionId } = options;
  const asset = selectReleaseAsset(releaseMetadata);

  // PRI-854 (option A): the signed metadata carries the asset's delivery URL —
  // fetch it directly and enforce the signed sha256+size. The digest check is
  // the trust anchor (the URL only says where, the metadata says what).
  if (asset.url !== undefined) {
    const transactionDir = path.join(paths.stagingDir, transactionId);
    const archivePath = path.join(transactionDir, 'release-asset.tar.gz');
    await downloadAndVerifyAssetFile({
      url: asset.url,
      destinationPath: archivePath,
      expectedSha256: asset.archiveSha256,
      expectedSizeBytes: asset.archiveSizeBytes,
      releaseId: releaseMetadata.releaseId,
      fetcher: assetFetcher,
    });
    const syntheticTarget: TrustedReleaseTarget = {
      artifactSha256: asset.archiveSha256,
      artifactSize: asset.archiveSizeBytes,
      channel,
      platform: asset.platform,
      releaseId: releaseMetadata.releaseId,
      targetPath: asset.url,
    };
    return { transactionDir, archivePath, trustedTarget: syntheticTarget };
  }

  // Legacy path (pre-url releases): the bytes live at the signed TUF target in
  // the metadata repository. ABI-suffixed name first; the legacy pre-ABI name
  // is the fallback for releases published before the ABI axis. Either way the
  // target only resolves through signed targets, so the fallback cannot
  // substitute untrusted bytes.
  let trustedTarget: TrustedReleaseTarget;
  try {
    trustedTarget = await resolveTrustedReleaseTarget({
      metadataDir: paths.trustDir,
      metadataBaseUrl,
      targetPath: releaseAssetTargetPath(releaseMetadata.releaseId, asset),
      expectedChannel: channel,
      expectedPlatform: process.platform,
      fetcher,
    });
  } catch (primaryError) {
    try {
      trustedTarget = await resolveTrustedReleaseTarget({
        metadataDir: paths.trustDir,
        metadataBaseUrl,
        targetPath: legacyReleaseAssetTargetPath(releaseMetadata.releaseId, asset),
        expectedChannel: channel,
        expectedPlatform: process.platform,
        fetcher,
      });
    } catch {
      throw new ApplyPayloadError(
        'metadata_refresh_failed',
        `The signed artifact target for release ${releaseMetadata.releaseId} could not be resolved: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}`,
        'Verify that the release pipeline published this release asset to the signed repository, then retry.',
      );
    }
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
      targetPath: trustedTarget.targetPath,
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
