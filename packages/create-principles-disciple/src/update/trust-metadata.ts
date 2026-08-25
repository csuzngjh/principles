import { type Fetcher, Updater } from 'tuf-js';

export type ReleaseTrustErrorCode =
  | 'invalid_request'
  | 'metadata_refresh_failed'
  | 'target_not_found'
  | 'target_identity_mismatch'
  | 'target_integrity_missing';

interface ReleaseTrustErrorOptions {
  code: ReleaseTrustErrorCode;
  message: string;
  nextAction: string;
  cause?: unknown;
}

export class ReleaseTrustError extends Error {
  readonly code: ReleaseTrustErrorCode;
  readonly nextAction: string;

  constructor(options: ReleaseTrustErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'ReleaseTrustError';
    this.code = options.code;
    this.nextAction = options.nextAction;
  }
}

export interface ResolveTrustedReleaseTargetOptions {
  metadataDir: string;
  metadataBaseUrl: string;
  targetPath: string;
  expectedChannel: string;
  expectedPlatform: string;
  fetcher?: Fetcher;
}

export interface TrustedReleaseTarget {
  artifactSha256: string;
  artifactSize: number;
  channel: string;
  platform: string;
  releaseId: string;
  targetPath: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasRequiredOptions(options: ResolveTrustedReleaseTargetOptions): boolean {
  return isNonEmptyString(options.metadataDir)
    && isNonEmptyString(options.metadataBaseUrl)
    && isNonEmptyString(options.targetPath)
    && isNonEmptyString(options.expectedChannel)
    && isNonEmptyString(options.expectedPlatform);
}

function readSignedIdentity(custom: Record<string, unknown>): {
  channel: string;
  platform: string;
  releaseId: string;
} {
  const releaseId = Object.hasOwn(custom, 'releaseId') ? custom.releaseId : undefined;
  const channel = Object.hasOwn(custom, 'channel') ? custom.channel : undefined;
  const platform = Object.hasOwn(custom, 'platform') ? custom.platform : undefined;
  if (!isNonEmptyString(releaseId) || !isNonEmptyString(channel) || !isNonEmptyString(platform)) {
    throw new ReleaseTrustError({
      code: 'target_identity_mismatch',
      message: 'The signed target is missing a release ID, channel, or platform identity.',
      nextAction: 'Do not install this release. Publish complete signed target metadata and retry.',
    });
  }
  return { releaseId, channel, platform };
}

function readArtifactSha256(hashes: Record<string, string>): string {
  const sha256 = Object.hasOwn(hashes, 'sha256') ? hashes.sha256 : undefined;
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new ReleaseTrustError({
      code: 'target_integrity_missing',
      message: 'The signed target does not contain a valid SHA-256 artifact hash.',
      nextAction: 'Do not install this release. Publish signed target metadata with a SHA-256 hash and retry.',
    });
  }
  return sha256.toLowerCase();
}

/**
 * Resolves a release target only after the official TUF client verifies the
 * trusted-root → timestamp → snapshot → targets metadata chain.
 *
 * This module deliberately does not download or install the target. Phase 1
 * uses it as an independently testable trust boundary before update execution
 * is wired to the new release system.
 */
export async function resolveTrustedReleaseTarget(
  options: ResolveTrustedReleaseTargetOptions,
): Promise<TrustedReleaseTarget> {
  if (!hasRequiredOptions(options)) {
    throw new ReleaseTrustError({
      code: 'invalid_request',
      message: 'Trusted release verification requires metadata storage, a repository URL, target path, channel, and platform.',
      nextAction: 'Correct the release verification request before retrying.',
    });
  }

  let target;
  try {
    const updater = new Updater({
      metadataDir: options.metadataDir,
      metadataBaseUrl: options.metadataBaseUrl,
      fetcher: options.fetcher,
    });
    await updater.refresh();
    target = await updater.getTargetInfo(options.targetPath);
  } catch (error) {
    throw new ReleaseTrustError({
      code: 'metadata_refresh_failed',
      message: 'Release metadata could not be verified against the trusted root.',
      nextAction: 'Do not install this release. Check the signed release repository and retry after the metadata issue is resolved.',
      cause: error,
    });
  }

  if (!target) {
    throw new ReleaseTrustError({
      code: 'target_not_found',
      message: `No signed target exists for ${options.targetPath}.`,
      nextAction: 'Do not install this release. Publish the target in signed metadata or select a supported channel and platform.',
    });
  }

  const identity = readSignedIdentity(target.custom);
  if (identity.channel !== options.expectedChannel || identity.platform !== options.expectedPlatform) {
    throw new ReleaseTrustError({
      code: 'target_identity_mismatch',
      message: `The signed target identity (${identity.channel}/${identity.platform}) does not match the requested channel and platform (${options.expectedChannel}/${options.expectedPlatform}).`,
      nextAction: 'Do not install this release. Select the matching signed channel and platform target.',
    });
  }

  return {
    artifactSha256: readArtifactSha256(target.hashes),
    artifactSize: target.length,
    channel: identity.channel,
    platform: identity.platform,
    releaseId: identity.releaseId,
    targetPath: target.path,
  };
}

function destinationDirOf(destinationPath: string): string {
  const lastSeparator = Math.max(destinationPath.lastIndexOf('/'), destinationPath.lastIndexOf('\\'));
  return lastSeparator === -1 ? '.' : destinationPath.slice(0, lastSeparator);
}

export interface DownloadTrustedReleasePayloadOptions {
  metadataDir: string;
  metadataBaseUrl: string;
  targetPath: string;
  destinationPath: string;
  fetcher?: Fetcher;
}

/**
 * Downloads a trusted target to an exact destination path. The TUF client
 * verifies length + digest DURING the download; a mismatch aborts and the
 * partial file never reaches the destination. The destination is replaced
 * atomically only after verification (temp file + rename in the same
 * directory).
 */
export async function downloadTrustedReleasePayload(
  options: DownloadTrustedReleasePayloadOptions,
): Promise<void> {
  for (const field of ['metadataDir', 'metadataBaseUrl', 'targetPath', 'destinationPath'] as const) {
    if (typeof options[field] !== 'string' || options[field].trim().length === 0) {
      throw new ReleaseTrustError({
        code: 'invalid_request',
        message: `Trusted payload download requires ${field}.`,
        nextAction: 'Correct the download request before retrying.',
      });
    }
  }
  let downloaded: string | undefined;
  try {
    const updater = new Updater({
      metadataDir: options.metadataDir,
      metadataBaseUrl: options.metadataBaseUrl,
      targetBaseUrl: `${options.metadataBaseUrl.replace(/\/+$/, '')}/targets`,
      fetcher: options.fetcher,
    });
    await updater.refresh();
    const target = await updater.getTargetInfo(options.targetPath);
    if (!target) {
      throw new Error(`target not found: ${options.targetPath}`);
    }
    const destinationDirectory = destinationDirOf(options.destinationPath);
    const { mkdirSync, renameSync, existsSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    mkdirSync(destinationDirectory, { recursive: true });
    const stagingPath = join(destinationDirectory, `.pd-payload-download-${process.pid}-${Date.now()}`);
    downloaded = await updater.downloadTarget(target, stagingPath);
    if (!existsSync(downloaded)) {
      throw new Error(`verified download did not materialize: ${downloaded}`);
    }
    renameSync(downloaded, options.destinationPath);
    downloaded = undefined;
    void dirname;
  } catch (error) {
    const causeMessage = error instanceof Error ? error.message : String(error);
    throw new ReleaseTrustError({
      code: 'metadata_refresh_failed',
      message: `The trusted release payload could not be downloaded and verified (${options.targetPath}): ${causeMessage}`,
      nextAction: 'Do not use this payload. Check the signed release repository and retry.',
      cause: error,
    });
  } finally {
    if (downloaded !== undefined) {
      const { rmSync } = await import('node:fs');
      rmSync(downloaded, { force: true });
    }
  }
}
