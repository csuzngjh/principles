import { type Fetcher, Updater } from 'tuf-js';
// tuf-js publishes no `exports` map, so these are the only reachable paths to
// the classes its own loader matches on: `Updater#loadRoot` treats a root
// probe as "absent" ONLY for a `DownloadHTTPError` whose statusCode is 403/404,
// and every other error is rethrown (PRI-1219).
import { DownloadHTTPError } from 'tuf-js/dist/error.js';
import { DefaultFetcher } from 'tuf-js/dist/fetcher.js';

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

/**
 * TUF client workflow 5.3.3 makes every refresh probe `<current+1>.root.json`
 * and defines ONLY 403/404 as "the trusted root is already the newest one".
 * A carrier that answers a non-existent object with 5xx therefore fails the
 * whole refresh even though the signed chain is intact (PRI-1219: GitHub Pages
 * served `503 / Server: Varnish` for `2.root.json`, and every update check on
 * a healthy 2.8.5 install reported a trust failure that never happened).
 *
 * A persistent 5xx on that OPTIONAL probe carries no information about whether
 * a newer root exists, so it is read as "no newer root" here. The root that
 * stays pinned is the one the install ALREADY trusts, so this never widens what
 * is trusted — but it DEFERS a rotation instead of evaluating it, and the two
 * rotation shapes behave differently:
 *   - rotation to a key the held root does not name still fails closed: tuf-js
 *     rejects the new timestamp/snapshot/targets signatures;
 *   - a version-only rotation, or one that revokes a key while keeping the
 *     signing key, is NOT detected here — the held root keeps accepting the
 *     signatures it names until the carrier answers the probe again.
 * That gap is why every suppression is reported on the resolved target through
 * `retainedTrustAnchor` instead of disappearing.
 *
 * A transient 5xx is not evidence of an outage either, so the default fetcher
 * retries a bounded number of times before the probe is read as absent or the
 * failure is reported.
 */
const ROOT_ROTATION_PROBE_PATTERN = /\/\d+\.root\.json$/;
const TRUST_FETCH_RETRIES = 2;
const TRUST_FETCH_MIN_TIMEOUT_MS = 250;
const TRUST_FETCH_MAX_TIMEOUT_MS = 2_000;

/**
 * The most recent failed download of the CURRENT refresh step. tuf-js throws
 * status-only errors (`DownloadHTTPError` carries `statusCode`, never the URL)
 * and wraps some of them in a `RuntimeError` that drops the cause, so the
 * failing URL/status is recorded while it is still known instead of being
 * recovered from the thrown value. Reset on every download, so a recorded
 * failure can only ever describe the attempt that threw.
 */
interface TrustDownloadFailure {
  url: string;
  statusCode?: number;
}

/**
 * Report attached to a SUCCESSFUL resolution when the refresh could not confirm
 * whether a newer trusted root exists. Without it, a permanently broken root
 * probe silently freezes the install on its current anchor and nothing on the
 * Owner-facing surface can tell that root rotation stopped propagating.
 */
export interface RetainedTrustAnchor {
  /** URL probed for a newer trusted root. */
  probeUrl: string;
  /** Status the carrier answered instead of 403/404. */
  statusCode: number;
  message: string;
  nextAction: string;
}

function isServerErrorStatus(statusCode: number): boolean {
  return statusCode >= 500 && statusCode <= 599;
}

function isRootRotationProbe(url: string): boolean {
  return ROOT_ROTATION_PROBE_PATTERN.test(url);
}

function describeMetadataObject(url: string): string {
  const name = url.slice(url.lastIndexOf('/') + 1);
  if (/^\d+\.root\.json$/.test(name)) return 'trusted-root rotation probe';
  if (name === 'timestamp.json') return 'timestamp document';
  if (name === 'snapshot.json') return 'snapshot document';
  if (name === 'targets.json') return 'targets document';
  return `metadata object ${name}`;
}

/**
 * Fetcher used by every TUF refresh in this module unless a caller injects
 * its own. Wraps tuf-js's default fetcher (bounded retry for transient
 * delivery faults) and applies the root-probe rule above.
 */
class ResilientTrustFetcher implements Fetcher {
  private readonly inner: Fetcher;
  private failure: TrustDownloadFailure | undefined;
  // Deliberately NOT reset per download: it describes a policy decision that
  // applies to the whole refresh, so it must survive to the success path.
  private suppressedRootProbe: TrustDownloadFailure | undefined;

  constructor(inner?: Fetcher) {
    // No timeout is configured on purpose: an existing install's check
    // behaviour must not change beyond the retry/root-probe policy.
    this.inner = inner ?? new DefaultFetcher({
      retry: {
        retries: TRUST_FETCH_RETRIES,
        minTimeout: TRUST_FETCH_MIN_TIMEOUT_MS,
        maxTimeout: TRUST_FETCH_MAX_TIMEOUT_MS,
      },
    });
  }

  get lastDownloadFailure(): TrustDownloadFailure | undefined {
    return this.failure;
  }

  get retainedRootProbe(): TrustDownloadFailure | undefined {
    return this.suppressedRootProbe;
  }

  async downloadBytes(url: string, maxLength: number): Promise<Buffer> {
    return this.guard(url, () => this.inner.downloadBytes(url, maxLength));
  }

  async downloadFile<T>(url: string, maxLength: number, handler: (file: string) => Promise<T>): Promise<T> {
    return this.guard(url, () => this.inner.downloadFile(url, maxLength, handler));
  }

  private async guard<T>(url: string, download: () => Promise<T>): Promise<T> {
    this.failure = undefined;
    try {
      return await download();
    } catch (error) {
      this.failure = {
        url,
        statusCode: error instanceof DownloadHTTPError ? error.statusCode : undefined,
      };
      if (
        error instanceof DownloadHTTPError
        && isServerErrorStatus(error.statusCode)
        && isRootRotationProbe(url)
      ) {
        this.suppressedRootProbe = this.failure;
        // Rethrown as the "absent" status `loadRoot` breaks on. The message
        // names the real status so a log never loses the cause.
        throw new DownloadHTTPError(
          `HTTP ${error.statusCode} for ${url} — no newer trusted root could be confirmed, keeping the installed root`,
          404,
        );
      }
      throw error;
    }
  }
}

/**
 * Not exported: a caller-built fetcher would be created OUTSIDE
 * `resolveTrustedReleaseTarget`, whose success path is what reports a retained
 * trust anchor, so its suppressions would silently vanish. Callers that need
 * their own fetcher pass one through `options.fetcher` and accept the reduced
 * diagnosis.
 */
function createTrustMetadataFetcher(): ResilientTrustFetcher {
  return new ResilientTrustFetcher();
}

/**
 * Flattens an error and its `cause` chain. Node's `fetch` reports a transport
 * fault as `TypeError: fetch failed` and puts the actionable text
 * (`connect ECONNREFUSED …`, `getaddrinfo ENOTFOUND …`) one level down, so the
 * top-level message alone is useless to an Owner.
 */
function describeErrorChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current === undefined || current === null) break;
    const message = current instanceof Error ? current.message : String(current);
    if (message.length > 0 && !messages.includes(message)) messages.push(message);
    current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined;
  }
  return messages.length > 0 ? messages.join(' → ') : String(error);
}

/**
 * Turns a failed refresh into an Owner-facing diagnosis. A download fault must
 * never be reported as "could not be verified against the trusted root": that
 * wording sent the reporter of PRI-1219 chasing a trust-root problem (and a
 * VPN) while the metadata carrier was returning 503.
 */
function describeRefreshFailure(
  error: unknown,
  failure: TrustDownloadFailure | undefined,
): { message: string; nextAction: string } {
  const cause = describeErrorChain(error);
  const detail = cause.length > 300 ? `${cause.slice(0, 297)}...` : cause;
  if (failure !== undefined) {
    const object = describeMetadataObject(failure.url);
    // A transport failure has no status code. Say so AND keep the underlying
    // message: "no HTTP response" alone would hide a DNS/TLS/socket error that
    // the Owner needs to tell a dead network apart from a dead repository.
    const status = failure.statusCode === undefined
      ? `no HTTP response (${detail})`
      : `HTTP ${failure.statusCode}`;
    return {
      message: `Release metadata refresh failed while downloading the ${object}: ${status} from ${failure.url}. The signed chain could not be fully evaluated — this is a delivery failure on the metadata carrier, not a signature or trust-root failure.`,
      nextAction: `Retry the update check. If the metadata carrier keeps failing for ${failure.url}, the release repository is unhealthy and needs repair; re-pinning the trust root would not help.`,
    };
  }
  return {
    message: `Release metadata could not be verified against the trusted root: ${detail}`,
    nextAction: 'Do not install this release. Check the signed release repository and retry after the metadata issue is resolved.',
  };
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
  /**
   * Present when the refresh kept the installed trusted root because the
   * rotation probe could not be answered (PRI-1219). The release itself IS
   * verified against that root — this field exists so a carrier that never
   * recovers does not silently stop root rotation from propagating.
   */
  retainedTrustAnchor?: RetainedTrustAnchor;
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
 * Reports a suppressed root-rotation probe on the SUCCESS path. Absent when the
 * caller injected its own fetcher (no suppression is observable there).
 */
function retainedAnchorReport(fetcher: Fetcher): { retainedTrustAnchor?: RetainedTrustAnchor } {
  if (!(fetcher instanceof ResilientTrustFetcher)) return {};
  const probe = fetcher.retainedRootProbe;
  if (probe === undefined || probe.statusCode === undefined) return {};
  return {
    retainedTrustAnchor: {
      probeUrl: probe.url,
      statusCode: probe.statusCode,
      message: `The ${describeMetadataObject(probe.url)} answered HTTP ${probe.statusCode}, so the installed trusted root was kept without checking for a newer one. This release is still verified against that root, but a root rotation or key revocation published meanwhile has NOT been applied.`,
      nextAction: `Repair the metadata carrier so ${probe.url} answers 403/404 when no newer root exists. Until then, keep publishing under the installed root and do not rely on root rotation reaching existing installs.`,
    },
  };
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
  const fetcher = options.fetcher ?? createTrustMetadataFetcher();
  try {
    const updater = new Updater({
      metadataDir: options.metadataDir,
      metadataBaseUrl: options.metadataBaseUrl,
      fetcher,
    });
    await updater.refresh();
    target = await updater.getTargetInfo(options.targetPath);
  } catch (error) {
    const failure = fetcher instanceof ResilientTrustFetcher ? fetcher.lastDownloadFailure : undefined;
    const diagnosis = describeRefreshFailure(error, failure);
    throw new ReleaseTrustError({
      code: 'metadata_refresh_failed',
      message: diagnosis.message,
      nextAction: diagnosis.nextAction,
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
    ...retainedAnchorReport(fetcher),
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
      fetcher: options.fetcher ?? createTrustMetadataFetcher(),
    });
    await updater.refresh();
    const target = await updater.getTargetInfo(options.targetPath);
    if (!target) {
      throw new Error(`target not found: ${options.targetPath}`);
    }
    const destinationDirectory = destinationDirOf(options.destinationPath);
    const { mkdirSync, renameSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { randomUUID } = await import('node:crypto');
    mkdirSync(destinationDirectory, { recursive: true });
    // UUID-named staging path: pid+timestamp collides when two downloads
    // land in the same millisecond and the verifier would overwrite a
    // concurrent verified payload.
    const stagingPath = join(destinationDirectory, `.pd-payload-download-${randomUUID()}`);
    downloaded = await updater.downloadTarget(target, stagingPath);
    if (!existsSync(downloaded)) {
      throw new Error(`verified download did not materialize: ${downloaded}`);
    }
    renameSync(downloaded, options.destinationPath);
    downloaded = undefined;
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
