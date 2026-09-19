/**
 * ReleaseManager — the sole update authority (PRI-738).
 *
 * inspect / check / apply only. apply() orchestrates installer deployment as
 * ONE journaled transaction; this module performs ZERO deployment-side
 * filesystem mutation. Automatic previous-release restore stays inside the
 * installer on transaction failure. Every refusal carries a stable reason
 * and an Owner-visible next action (rc-9), computed BEFORE any mutation.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
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
import {
  appendJournalTransition,
  readActiveRecord,
  TransactionJournalError,
  type TransactionState,
} from './transaction-journal.js';
import { downloadReleaseAsset, extractAndVerifyReleaseAsset, ApplyPayloadError } from './apply-payload.js';
import { evaluateDataCompatibility } from './data-compatibility.js';
import type { InstallerJournal } from '../installer.js';
import type { Language } from '../i18n.js';
import type { HostTarget } from '../installers/index.js';
import { compareProductVersions, parseProductVersion, type ReleaseChannelName } from './product-identity.js';

export type ReleaseManagerReason =
  | 'bootstrap_not_installed'
  | 'metadata_refresh_failed'
  | 'release_metadata_unavailable'
  | 'release_metadata_invalid'
  | 'runtime_not_supported'
  | 'active_record_corrupt'
  | 'legacy_layout_not_supported'
  | 'journal_unavailable'
  | 'apply_failed';

export class ReleaseManagerError extends Error {
  readonly reason: ReleaseManagerReason;
  readonly nextAction: string;
  /**
   * True when the refusal happened AFTER the apply transaction was opened
   * (planned journaled) — runtime state may include staging writes and a
   * terminal journal tail. False for pre-transaction refusals.
   */
  readonly transactionOpened: boolean;

  // eslint-disable-next-line @typescript-eslint/max-params -- (reason, message, nextAction, transactionOpened) mirrors the four fields of the refusal contract; the 4th is an optional PRI-698 default-on safety-net marker
  constructor(reason: ReleaseManagerReason, message: string, nextAction: string, transactionOpened = false) {
    super(message);
    this.name = 'ReleaseManagerError';
    this.reason = reason;
    this.nextAction = nextAction;
    this.transactionOpened = transactionOpened;
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

}

/** Caller-supplied deployment context for apply() (PRI-698 Phase 1). */
export interface ApplyOptions {
  /** Workspace the installer re-run operates on (console passes its own). */
  readonly workspaceDir: string;
  /** Installer language; defaults to 'zh' (the installer's default locale). */
  readonly language?: Language;
  /** Host installers to run; defaults to 'openclaw' (matches the prior full-update sync). */
  readonly host?: HostTarget;
  /**
   * PRI-850 (SPEC §6.1/§12.1): caller-generated transaction id so the bootstrap
   * executor's initiator can query the journal while the executor keeps running
   * detached. Must match the journal id shape when present; otherwise the
   * manager generates one as before.
   */
  readonly transactionId?: string;
}

export type ApplyOutcome =
  | {
    readonly kind: 'applied';
    readonly productVersion: string;
    readonly transactionId: string;
    readonly journalPath: string;
    /** PRI-726: degraded-success notice propagated VERBATIM from the
     * installer's InstallResult — the payload committed but the OpenClaw
     * gateway restart failed. Undefined on a healthy restart; the Console
     * is served verbatim on the update response (PRI-726 contract). */
    readonly gatewayNotice?: string;
  }
  | {
    readonly kind: 'no_update';
    /** Stable machine-readable reason: a release-policy refusal reason code. */
    readonly reason: string;
    /** Owner-facing explanation of why nothing was applied. */
    readonly note: string;
  };

/** Terminal journal states (mirrors transaction-journal.ts TERMINAL_STATES semantics). */
const APPLY_TERMINAL_STATES: ReadonlySet<TransactionState> = new Set<TransactionState>([
  'confirmed', 'rolled_back', 'refused', 'failed',
]);

/**
 * Append one transition to the apply transaction's journal file (journal-first
 * append+fsync, same discipline and format as the installer's writer — one
 * JSONL file per transaction under ~/.pd/transactions/, ADR-0024 D-2/D-6).
 * The installer continues THIS file when it takes over deployment.
 */
function appendApplyTransition(journal: InstallerJournal, to: TransactionState, detail: string): void {
  appendJournalTransition(journal.journalPath, {
    at: new Date().toISOString(),
    from: journal.lastState,
    to,
    transactionId: journal.transactionId,
    releaseId: journal.releaseId,
    productVersion: journal.productVersion,
    releaseMetadataDigest: journal.releaseMetadataDigest,
    releaseMetadataDigestSource: journal.releaseMetadataDigestSource,
    generation: journal.generation,
    detail,
  });
  journal.lastState = to;
}

/**
 * Close the apply transaction with a terminal `failed` state when the flow
 * dies before the installer reached one. The installer's own catch path
 * appends rolled_back/failed for failures inside deployment; this covers
 * acquisition-phase failures and unexpected throws so a journal never ends
 * mid-chain (the strict reader rejects transitions after a terminal state,
 * and a non-terminal tail means "unfinished" for Phase 3 recovery).
 * The append itself is best-effort: if even the failure record cannot be
 * written, the on-disk journal stays where it stopped and the thrown error
 * still reports the failure (observable degradation, rc-9).
 */
function ensureTerminalFailed(journal: InstallerJournal, detail: string): void {
  if (journal.lastState !== null && APPLY_TERMINAL_STATES.has(journal.lastState)) return;
  try {
    appendApplyTransition(journal, 'failed', detail);
  } catch (appendError) {
    // Tier-2 degradation (same policy as installer.ts): the transaction stays
    // partially journaled; the backup/restore safety net inside the installer
    // does not depend on the journal.
    void appendError;
  }
}

function toReleaseManagerError(error: unknown): ReleaseManagerError {
  if (error instanceof ReleaseManagerError) return error;
  if (error instanceof ApplyPayloadError) {
    return new ReleaseManagerError(error.reason, error.message, error.nextAction);
  }
  if (error instanceof ReleaseTrustError) {
    return new ReleaseManagerError('metadata_refresh_failed', error.message, error.nextAction);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ReleaseManagerError(
    'apply_failed',
    `Release application failed: ${message}`,
    'The runtime was left on the previous release (installer backup/restore). Retry the update; if it fails again, run the official installer to repair.',
  );
}

export interface ReleaseManagerOptions {
  readonly pdHome: string;
  readonly metadataBaseUrl: string;
  readonly fetcher?: Parameters<typeof resolveTrustedReleaseTarget>[0]['fetcher'];
  readonly now?: () => Date;
  /**
   * Explicit OpenClaw home directory for legacy-overlay detection.  When
   * omitted, falls back to `~/.openclaw` relative to the OS home — correct
   * for standard installs but WRONG for custom pdHome roots (test dirs,
   * enterprise installs, containers).  Callers that pass a custom pdHome
   * MUST also pass the matching openclawHome.
   */
  readonly openclawHome?: string;
}

/**
 * Single authority for active.json: the transaction journal's strict reader
 * (schemaVersion + full field set). This adapter only maps its corruption
 * error onto the ReleaseManager surface contract — it must never re-parse or
 * re-validate the file with a second, weaker schema.
 */
function readActiveReleaseRecord(paths: PdHomePaths): ReturnType<typeof readActiveRecord> {
  try {
    return readActiveRecord(paths.activeRecordPath);
  } catch (error) {
    if (error instanceof TransactionJournalError) {
      throw new ReleaseManagerError(
        'active_record_corrupt',
        `active.json is corrupt and must be recovered from the transaction journal: ${paths.activeRecordPath} (${error.message})`,
        'Run the official installer recovery or an explicit update operation; the last journal-confirmed release is selected automatically.',
      );
    }
    throw error;
  }
}

/**
 * Reads a cached TUF-verified document, mapping corrupt JSON to the
 * ReleaseManager error contract instead of leaking a bare SyntaxError
 * (rc-3/rc-9: corrupted required state fails loud with a next action).
 */
function parseCachedJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch (error) {
    throw new ReleaseManagerError(
      'release_metadata_invalid',
      `A cached verified metadata document is not valid JSON (${filePath}): ${error instanceof Error ? error.message : String(error)}`,
      'The cached document disagrees with its verified digest chain. Re-run the update check to re-verify and replace it.',
    );
  }
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
    const active = readActiveReleaseRecord(this.paths);
    // readActiveRecord returns null only when active.json is absent, so the
    // releases/ skeleton alone distinguishes a pre-activation dual-slot root.
    const layout: InstallationLayout = active !== null
      ? 'dual-slot'
      : fs.existsSync(this.paths.releasesDir)
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

  /**
   * PRI-853 review fix: the signed metadata of an installed release identity
   * (`releases/<releaseId>/metadata.json`), or null when the file is absent
   * or unreadable. Callers decide whether null is acceptable — for the data
   * compatibility preflight it is NOT (refuse install_identity_unverifiable).
   */
  private readReleaseMetadataByIdentity(releaseId: string): ReleaseMetadata | null {
    try {
      const metadataPath = path.join(this.paths.releasesDir, releaseId, 'metadata.json');
      if (!fs.existsSync(metadataPath)) return null;
      return parseReleaseMetadata(JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as unknown);
    } catch {
      return null;
    }
  }

  async check(channel: ReleaseChannelName): Promise<UpdateCheck> {
    const now = this.options.now ?? ((): Date => new Date());
    const status = this.inspect();

    const { channelMetadata, trustedTarget } = await this.refreshSignedChannel(channel);
    const releaseMetadata = await this.ensureReleaseMetadataDocument(channelMetadata);
    const decision = this.evaluateCandidateDecision({ channelMetadata, releaseMetadata, status, now: now() });

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

    return {
      channel,
      candidate,
      decision,
      trustedTarget,
    };
  }

  /**
   * PRI-698 Phase 1: the update orchestrator. Readiness → signed candidate
   * resolution → payload acquisition into staging (journaled) → deployment
   * through the installer (the only direct artifact deployment authority,
   * ADR-0024 §2.1) as ONE transaction. Every failure leaves the runtime on
   * the previous release and the journal at a terminal state.
   */
  async apply(options: ApplyOptions): Promise<ApplyOutcome> {
    const status = this.inspect();
    if (status.layout === 'none') {
      throw new ReleaseManagerError(
        'bootstrap_not_installed',
        'No PD installation was found under this PD home; there is nothing to update.',
        'Run the official installer (npx create-principles-disciple) first.',
      );
    }
    if (status.layout === 'legacy-overlay') {
      throw new ReleaseManagerError(
        'legacy_layout_not_supported',
        'This installation uses the legacy overlay layout, which the transactional updater does not serve.',
        'Run the official installer to repair this installation into the supported layout, then retry.',
      );
    }

    // Pre-transaction resolution phase: no side effects have happened, so any
    // refusal here is a clean, unjournaled refusal — still mapped onto the
    // typed ReleaseManagerError contract (rc-9), never a raw transport error.
    let channelMetadata: ChannelMetadata;
    let releaseMetadata: ReleaseMetadata;
    try {
      const { channelMetadata: refreshedChannel } = await this.refreshSignedChannel(status.channel);
      channelMetadata = refreshedChannel;
      releaseMetadata = await this.ensureReleaseMetadataDocument(channelMetadata);
    } catch (error) {
      throw toReleaseManagerError(error);
    }
    const now = this.options.now ?? ((): Date => new Date());
    const decision = this.evaluateCandidateDecision({ channelMetadata, releaseMetadata, status, now: now() });
    if (!decision.allowed) {
      // PRI-848: the reason travels structured — the Console must map refusal
      // states from a reason code, never by parsing the note string.
      return { kind: 'no_update', reason: decision.reason, note: decision.message };
    }

    // PRI-853 (SPEC §10 wired, review fix P1): data compatibility preflight
    // runs against the CURRENTLY ACTIVE release — the release whose data must
    // remain readable so the pre-update state can be restored. Not
    // previous.json: a first-ever update has no retained previous, and that
    // absence must never silently disable the check. If the active identity
    // or its metadata is missing/unreadable, the update refuses with
    // install_identity_unverifiable — absence is never treated as "compatible".
    const activeIdentityForCompat = readActiveRecord(this.paths.activeRecordPath);
    if (activeIdentityForCompat === null) {
      return {
        kind: 'no_update',
        reason: 'install_identity_unverifiable',
        note: 'The installation has no readable active release record, so its data compatibility cannot be proven.',
      };
    }
    const activeMetadata = this.readReleaseMetadataByIdentity(activeIdentityForCompat.releaseId);
    if (activeMetadata === null) {
      return {
        kind: 'no_update',
        reason: 'install_identity_unverifiable',
        note: `The installed release ${activeIdentityForCompat.releaseId} has no readable signed metadata, so data compatibility cannot be proven.`,
      };
    }
    const dataCompatibility = evaluateDataCompatibility({
      candidate: releaseMetadata,
      previous: activeMetadata,
    });
    if (!dataCompatibility.eligible) {
      return { kind: 'no_update', reason: dataCompatibility.reason, note: dataCompatibility.message };
    }

    // PRI-850: honor a caller-generated transaction id (bootstrap executor
    // flow — the initiator must be able to query the journal while the
    // executor keeps running detached). Same strict shape as the generated
    // ids; anything malformed falls back to a generated id (never a guessed
    // journal file name).
    const callerTransactionId = options.transactionId;
    const transactionId = callerTransactionId !== undefined && /^update-[0-9]+-[a-z0-9]{8}$/.test(callerTransactionId)
      ? callerTransactionId
      : `update-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const journalPath = path.join(this.paths.transactionsDir, `${transactionId}.jsonl`);
    const journal: InstallerJournal = {
      transactionId,
      journalPath,
      releaseId: releaseMetadata.releaseId,
      productVersion: releaseMetadata.productVersion,
      // The signed release metadata is the ReleaseManager's identity authority;
      // its validated sourceCommit becomes the journal/active provenance.
      sourceCommit: releaseMetadata.sourceCommit,
      productVersionSource: 'signed_channel',
      releaseMetadataDigest: releaseMetadata.metadataDigest,
      releaseMetadataDigestSource: 'signed_channel',
      generation: (status.generation ?? 0) + 1,
      degraded: false,
      lastState: null,
    };

    // Journal-first (ADR-0024 D-2, installer Tier-1 policy): record the
    // transaction BEFORE the first side effect. If even 'planned' cannot be
    // written, refuse with zero side effects.
    try {
      appendApplyTransition(journal, 'planned', `host=${options.host ?? 'openclaw'} mode=smart source=release-manager`);
    } catch (error) {
      throw new ReleaseManagerError(
        'journal_unavailable',
        `The transaction journal could not be written — refusing to update unjournaled (ADR-0024 D-2): ${error instanceof Error ? error.message : String(error)}`,
        'Resolve write access to ~/.pd/transactions (disk space / permissions), then retry. No changes were made.',
      );
    }

    try {
      const { install } = await import('../installer.js');
      const downloaded = await downloadReleaseAsset({
        paths: this.paths,
        metadataBaseUrl: this.options.metadataBaseUrl,
        fetcher: this.options.fetcher,
        releaseMetadata,
        channel: status.channel,
        transactionId,
      });
      appendApplyTransition(journal, 'downloaded', `artifact sha256=${downloaded.trustedTarget.artifactSha256} target=${downloaded.trustedTarget.targetPath}`);

      const { payloadDir } = await extractAndVerifyReleaseAsset({
        transactionDir: downloaded.transactionDir,
        archivePath: downloaded.archivePath,
      });
      appendApplyTransition(journal, 'verified', 'release-asset preflight passed (identity + whole-payload digest)');

      // Deployment is the installer's job, byte for byte the same cycle a
      // manual run performs: digest preflight → backup rename-swap → component
      // deploy → console probe → host installers → commit (backup cleanup).
      // The transaction handle keeps ONE journal file for the whole update.
      const installResult = await install(
        {
          language: options.language ?? 'zh',
          mode: 'smart',
          workspaceDir: options.workspaceDir,
          channels: [],
          overwriteConfig: false,
          host: options.host ?? 'openclaw',
          stopGateway: true,
        },
        payloadDir,
        { quiet: true, nonInteractive: true },
        journal,
      );
      if (!installResult.success) {
        ensureTerminalFailed(
          journal,
          `installer reported failure before deploying (no runtime mutation): ${installResult.error ?? installResult.reason ?? 'unknown'}`,
        );
        throw new ReleaseManagerError(
          'apply_failed',
          `The installer refused or failed the update: ${installResult.error ?? installResult.reason ?? 'unknown'}`,
          installResult.nextAction ?? 'The runtime is unchanged. Resolve the reported cause and retry.',
        );
      }
      if (journal.lastState !== 'confirmed') {
        // rc-7: never claim success from a non-terminal journal — the state
        // the installer left behind is what recovery will reason about.
        ensureTerminalFailed(journal, `installer reported success but the transaction ended at '${journal.lastState ?? 'nothing'}'`);
        throw new ReleaseManagerError(
          'apply_failed',
          `The installer reported success but the transaction journal ended at '${journal.lastState ?? 'nothing'}' instead of 'confirmed'.`,
          'Treat the update as NOT applied. Inspect the transaction journal and re-run the installer to reach a consistent state.',
        );
      }
      return {
        kind: 'applied',
        productVersion: releaseMetadata.productVersion,
        transactionId,
        journalPath,
        // PRI-726: pure field propagation — the installer is the only
        // authority on the gateway restart outcome (rc-9); this layer must
        // not re-derive, parse, or drop it.
        gatewayNotice: installResult.gatewayNotice,
      };
    } catch (error) {
      ensureTerminalFailed(
        journal,
        `update failed at '${journal.lastState ?? 'planned'}': ${error instanceof Error ? error.message : String(error)}`,
      );
      // The transaction was opened (planned journaled): mark the refusal so
      // the caller knows runtime-side effects may exist (staging writes +
      // terminal journal tail) and must NOT be reported as a pre-transaction
      // refusal.
      const mapped = toReleaseManagerError(error);
      throw mapped.transactionOpened
        ? mapped
        : new ReleaseManagerError(mapped.reason, mapped.message, mapped.nextAction, true);
    }
  }

  /**
   * Resolve + digest-verify + cache the signed channel document (shared by
   * check() and apply(); writes stay inside the RM-owned channels cache).
   */
  private async refreshSignedChannel(channel: ReleaseChannelName): Promise<{ channelMetadata: ChannelMetadata; trustedTarget: TrustedReleaseTarget }> {
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

    return { channelMetadata: this.readChannelMetadataPayload(channel), trustedTarget };
  }

  /**
   * evaluateReleaseAdvancement with the ACTIVE release's own metadata as the
   * current state when a dual-slot installation records one (shared by
   * check() and apply()).
   */
  private evaluateCandidateDecision(input: {
    channelMetadata: ChannelMetadata;
    releaseMetadata: ReleaseMetadata;
    status: InstallStatus;
    now: Date;
  }): ReleasePolicyDecision {
    const { channelMetadata, releaseMetadata, status, now } = input;
    let decision = evaluateReleaseAdvancement({
      channel: channelMetadata,
      candidate: releaseMetadata,
      current: null,
      bootstrapVersion: status.bootstrapVersion ?? '0.0.0',
      now,
    });
    if (status.releaseId !== null && status.productVersion !== null) {
      const activeMetadata = this.readActiveReleaseMetadata(status.releaseId);
      // Bundled installs carry an authoritative active product version but no
      // publication metadata. Do not mistake that for an empty installation.
      // Never invent a publication sequence or overwrite the installed identity.
      if (activeMetadata === null && decision.allowed && compareProductVersions(
        parseProductVersion(releaseMetadata.productVersion), parseProductVersion(status.productVersion),
      ) <= 0) {
        return {
          allowed: false,
          reason: 'downgrade_blocked',
          message: `Signed release ${releaseMetadata.productVersion} does not advance installed ${status.productVersion}.`,
          nextAction: 'No runtime change was made. Retry when a newer signed product version is published.',
        };
      }
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
          now,
        });
      }
    }
    return decision;
  }

  /**
   * The release metadata document names the bytes to deploy. check() only
   * evaluates already-cached documents; apply() is the "transactional updater"
   * that finally downloads it: TUF target `releases/<releaseId>/metadata.json`
   * (Phase 1 convention, custom identity {releaseId, channel, platform:
   * 'metadata'}) fetched digest-verified into the releases cache, then read
   * back through the SAME strict validation path (identity + expiry + channel
   * digest binding). A pre-seeded local document is still accepted unchanged,
   * so check()-time behavior is untouched.
   */
  private async ensureReleaseMetadataDocument(channel: ChannelMetadata): Promise<ReleaseMetadata> {
    const now = this.options.now ?? ((): Date => new Date());
    try {
      return this.readReleaseMetadataDocument(channel, now);
    } catch (error) {
      if (!(error instanceof ReleaseManagerError) || error.reason !== 'release_metadata_unavailable') {
        throw error;
      }
      await downloadTrustedReleasePayload({
        metadataDir: this.paths.trustDir,
        metadataBaseUrl: this.options.metadataBaseUrl,
        targetPath: `releases/${channel.releaseId}/metadata.json`,
        destinationPath: path.join(this.paths.releasesDir, channel.releaseId, 'metadata.json'),
        fetcher: this.options.fetcher,
      });
      return this.readReleaseMetadataDocument(channel, now);
    }
  }

  private legacyOverlayMarker(): string {
    const openclawRoot = this.options.openclawHome
      ?? path.join(os.homedir(), '.openclaw');
    return path.join(openclawRoot, 'extensions', 'principles-disciple');
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
    const payload: unknown = parseCachedJson(payloadPath);
    return parseChannelMetadata(payload);
  }

  private readActiveReleaseMetadata(releaseId: string): ReleaseMetadata | null {
    const metadataPath = path.join(this.paths.releasesDir, releaseId, 'metadata.json');
    if (!fs.existsSync(metadataPath)) return null;
    const document: unknown = parseCachedJson(metadataPath);
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
        'Retry the update check to download the signed release metadata.',
      );
    }
    const document: unknown = parseCachedJson(metadataPath);
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


}

/** Producer helper re-exported for the publication pipeline. */
export { buildReleaseMetadata };
