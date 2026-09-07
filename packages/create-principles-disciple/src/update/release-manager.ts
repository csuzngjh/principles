/**
 * ReleaseManager — the deep module behind every update surface (SPEC §6.2).
 *
 * External surface is intentionally small: inspect / check / apply /
 * rollback. The module hides metadata validation, download, extraction,
 * staging, probes, journaling, host control, rollback, and cleanup.
 *
 * PRI-698 Phase 1: `apply()` is the update ORCHESTRATOR. It acquires the
 * signed release payload into the staging area (apply-payload.ts) and hands
 * deployment to the installer — the only direct artifact deployment authority
 * (ADR-0024 §2.1) — as ONE journaled transaction (planned → downloaded →
 * verified by this module; staged → probed → activated → confirmed by the
 * installer's existing cycle, same journal file). This module performs ZERO
 * deployment-side filesystem mutation: no writes under `~/.pd/runtime` or the
 * host extension directories ever originate here. `rollback()` still refuses:
 * rollback migration is Phase 2 and must prove same-version restore before it
 * replaces the legacy rollback.
 *
 * Every refusal carries a stable reason and an Owner-visible next action
 * (rc-9) and is computed BEFORE any installation state is mutated.
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
import type { InstallerJournal } from '../installer.js';
import type { Language } from '../i18n.js';
import type { HostTarget } from '../installers/index.js';
import type { ReleaseChannelName } from './product-identity.js';

export type ReleaseManagerReason =
  | 'shadow_mode_read_only'
  | 'bootstrap_not_installed'
  | 'metadata_refresh_failed'
  | 'release_metadata_unavailable'
  | 'release_metadata_invalid'
  | 'active_record_corrupt'
  | 'legacy_layout_not_supported'
  | 'journal_unavailable'
  | 'apply_failed';

export class ReleaseManagerError extends Error {
  readonly reason: ReleaseManagerReason;
  readonly nextAction: string;
  /**
   * PRI-698 Phase 1 default-on safety net: true when the refusal happened
   * AFTER the apply transaction was opened (planned journaled) — runtime
   * state may include staging writes and a terminal journal tail. False for
   * pre-transaction refusals (layout, metadata, journal-unavailable): the
   * caller can safely fall back to the legacy updater with an explicit
   * reason, because zero side effects exist.
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

/** Caller-supplied deployment context for apply() (PRI-698 Phase 1). */
export interface ApplyOptions {
  /** Workspace the installer re-run operates on (console passes its own). */
  readonly workspaceDir: string;
  /** Installer language; defaults to 'zh' (the installer's default locale). */
  readonly language?: Language;
  /** Host installers to run; defaults to 'openclaw' (matches the legacy full-update sync). */
  readonly host?: HostTarget;
}

export type ApplyOutcome =
  | {
    readonly kind: 'applied';
    readonly productVersion: string;
    readonly transactionId: string;
    readonly journalPath: string;
  }
  | {
    readonly kind: 'no_update';
    /** Why nothing was applied (policy refusal reason or already-current note). */
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
  /** Injected in production from the legacy updater; tests inject fakes. */
  readonly legacyCheck?: (currentVersion: string) => Promise<LegacyUpdaterDecision | null>;
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

  async check(channel: ReleaseChannelName): Promise<UpdateCheck> {
    const now = this.options.now ?? ((): Date => new Date());
    const status = this.inspect();

    const { channelMetadata, trustedTarget } = await this.refreshSignedChannel(channel);
    const releaseMetadata = this.readReleaseMetadataDocument(channelMetadata, now);
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

    const shadowComparison = await this.compareWithLegacyUpdater(status, decision, candidate.productVersion);

    return {
      channel,
      candidate,
      decision,
      trustedTarget,
      shadowComparison,
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
        'Run the official installer once to migrate into the dual-slot layout; the current updater continues to serve this installation until then.',
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
      return { kind: 'no_update', note: `${decision.reason}: ${decision.message}` };
    }

    const transactionId = `update-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const journalPath = path.join(this.paths.transactionsDir, `${transactionId}.jsonl`);
    const journal: InstallerJournal = {
      transactionId,
      journalPath,
      releaseId: releaseMetadata.releaseId,
      productVersion: releaseMetadata.productVersion,
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
      };
    } catch (error) {
      ensureTerminalFailed(
        journal,
        `update failed at '${journal.lastState ?? 'planned'}': ${error instanceof Error ? error.message : String(error)}`,
      );
      // The transaction was opened (planned journaled): mark the refusal so
      // the caller knows runtime-side effects may exist (staging writes +
      // terminal journal tail) and must NOT auto-fallback to the legacy
      // updater over it.
      const mapped = toReleaseManagerError(error);
      throw mapped.transactionOpened
        ? mapped
        : new ReleaseManagerError(mapped.reason, mapped.message, mapped.nextAction, true);
    }
  }

  async rollback(): Promise<never> {
    void this.paths; // reserved: Phase 2 rollback drives this.paths / this.options
    throw new ReleaseManagerError(
      'shadow_mode_read_only',
      'Rollback is not enabled yet: the ReleaseManager runs in read-only shadow mode while the transactional activation system is brought up.',
      'Continue using the current update path. Rollback arrives with the dual-slot transaction rollout.',
    );
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
        'This shadow-mode check only evaluates already-verified metadata. Download arrives with the transactional updater.',
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
