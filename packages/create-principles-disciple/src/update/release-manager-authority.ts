/**
 * ReleaseManager mutation authority surface (PRI-672 — the "PRI-661" adoption task).
 *
 * This module is the narrow seam between the Console's MutationController
 * (PRI-659 migration boundary) and the ReleaseManager deep module. It exposes:
 *
 *   - `createReleaseManagerAuthority()` — constructs the ReleaseManager for a
 *     pdHome and reports per-mutation-kind readiness with stable, structured
 *     reason codes (ADR-0024 §2.4: refusal over silent degradation);
 *   - `mapReleaseManagerErrorToFallback()` — maps ReleaseManager refusals onto
 *     the explicit-fallback reason vocabulary the console surfaces in the
 *     `X-PD-Mutation-Fallback-Reason` response header.
 *
 * Boundary (ADR-0024 §2.1): the authority module DECIDES; it never deploys.
 * Artifact deployment stays with the installer; the transaction journal stays
 * the single source of truth for runtime mutations. Readiness probing performs
 * zero filesystem writes. The governed shadow check (kind `check`) refreshes
 * only ReleaseManager-owned verified-metadata caches under `~/.pd/trust` and
 * `~/.pd/channels` — never `~/.pd/runtime`, never the extension directory.
 *
 * apply/apply-full/rollback stay structurally not-ready until the Phase 4
 * activation rollout opens the `shadow_mode_read_only` gate (its own go/no-go);
 * until then these kinds explicitly fall back to the legacy console updater.
 */

import * as fs from 'node:fs';
import {
  ReleaseManager,
  ReleaseManagerError,
  type InstallStatus,
  type LegacyUpdaterDecision,
} from './release-manager.js';
import { InstallLayoutError, resolvePdHomePaths } from './install-layout.js';

/** Mutation kinds the console MutationController routes (PRI-659 contract). */
export const RELEASE_MANAGER_AUTHORITY_KINDS = ['check', 'apply', 'apply-full', 'rollback'] as const;
export type ReleaseManagerAuthorityKind = (typeof RELEASE_MANAGER_AUTHORITY_KINDS)[number];

export type ReleaseManagerAuthorityReason =
  | 'metadata_source_unconfigured'
  | 'bootstrap_not_installed'
  | 'install_state_corrupt'
  | 'journal_not_supported'
  | 'rollback_not_available';

export interface ReleaseManagerAuthorityReadiness {
  readonly ready: boolean;
  readonly reasons: readonly ReleaseManagerAuthorityReason[];
}

/** Structural gate: activation/rollback arrive with the Phase 4 transaction rollout. */
const ACTIVATION_AVAILABLE = false;

export interface ReleaseManagerAuthorityOptions {
  readonly pdHome: string;
  /** Signed release metadata repository base URL; absent ⇒ not ready (no guessing). */
  readonly metadataBaseUrl: string | undefined;
  readonly openclawHome?: string;
  readonly now?: () => Date;
  /** Legacy-updater decision source for the shadow comparison (console-computed). */
  readonly legacyCheck?: (currentVersion: string) => Promise<LegacyUpdaterDecision | null>;
}

export interface ReleaseManagerAuthority {
  readonly manager: ReleaseManager;
  /** Install status snapshot; null when the install state failed a strict reader. */
  readonly installStatus: InstallStatus | null;
  readonly kinds: Readonly<Record<ReleaseManagerAuthorityKind, ReleaseManagerAuthorityReadiness>>;
}

/**
 * Probe the transactions directory WITHOUT writing: an existing directory must
 * be writable (the journal is a mandatory mutation contract, ADR-0024 D-2), a
 * missing directory means the installer has not journaled on this installation
 * yet — reported, never created from here.
 */
function probeTransactionJournalDir(pdHome: string): boolean {
  const { transactionsDir } = resolvePdHomePaths(pdHome);
  try {
    fs.accessSync(transactionsDir, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function createReleaseManagerAuthority(
  options: ReleaseManagerAuthorityOptions,
): ReleaseManagerAuthority {
  const reasons = new Set<ReleaseManagerAuthorityReason>();

  if (options.metadataBaseUrl === undefined || options.metadataBaseUrl.length === 0) {
    reasons.add('metadata_source_unconfigured');
  }

  const manager = new ReleaseManager({
    pdHome: options.pdHome,
    metadataBaseUrl: options.metadataBaseUrl ?? '',
    ...(options.openclawHome !== undefined ? { openclawHome: options.openclawHome } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.legacyCheck !== undefined ? { legacyCheck: options.legacyCheck } : {}),
  });

  let installStatus: InstallStatus | null = null;
  try {
    installStatus = manager.inspect();
  } catch (error) {
    // rc-3: corrupt installation state is surfaced, never silently skipped.
    if (error instanceof InstallLayoutError || error instanceof ReleaseManagerError) {
      reasons.add('install_state_corrupt');
    } else {
      throw error;
    }
  }
  if (installStatus !== null && installStatus.layout === 'none') {
    reasons.add('bootstrap_not_installed');
  }
  if (!probeTransactionJournalDir(options.pdHome)) {
    reasons.add('journal_not_supported');
  }

  const baseReady = reasons.size === 0;
  const baseReasons = [...reasons] as const;
  const kinds = {
    check: {
      ready: baseReady,
      reasons: baseReasons,
    },
    apply: {
      ready: false,
      reasons: ACTIVATION_AVAILABLE ? baseReasons : ([...baseReasons, 'rollback_not_available'] as const),
    },
    'apply-full': {
      ready: false,
      reasons: ACTIVATION_AVAILABLE ? baseReasons : ([...baseReasons, 'rollback_not_available'] as const),
    },
    rollback: {
      ready: false,
      reasons: ACTIVATION_AVAILABLE ? baseReasons : ([...baseReasons, 'rollback_not_available'] as const),
    },
  } satisfies Readonly<Record<ReleaseManagerAuthorityKind, ReleaseManagerAuthorityReadiness>>;

  return { manager, installStatus, kinds };
}

/**
 * Map a ReleaseManager refusal onto the console's explicit-fallback reason
 * vocabulary (rc-9: degradation must be observable with a stable reason).
 */
export function mapReleaseManagerErrorToFallback(error: unknown): {
  reason: string;
  message: string;
  nextAction: string | null;
} {
  if (error instanceof ReleaseManagerError) {
    return { reason: error.reason, message: error.message, nextAction: error.nextAction };
  }
  return {
    reason: 'release_manager_check_failed',
    message: error instanceof Error ? error.message : String(error),
    nextAction: null,
  };
}
