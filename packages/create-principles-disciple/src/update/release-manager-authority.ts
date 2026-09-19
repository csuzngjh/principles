/** ReleaseManager readiness and failure mapping for the Console. No alternate updater exists. */
import * as fs from 'node:fs';
import {
  ReleaseManager,
  ReleaseManagerError,
  type InstallStatus,
} from './release-manager.js';
import { InstallLayoutError, digestDirectory, readBootstrapManifest, readInstallConfig, resolvePdHomePaths, type InstallConfig } from './install-layout.js';
import { resolveReleaseMetadataSource, type ReleaseMetadataSource } from './release-metadata-source.js';

/** The two Console update operations. */
export const RELEASE_MANAGER_AUTHORITY_KINDS = ['check', 'apply-full'] as const;
export type ReleaseManagerAuthorityKind = (typeof RELEASE_MANAGER_AUTHORITY_KINDS)[number];

export type ReleaseManagerAuthorityReason =
  | 'metadata_source_unconfigured'
  | 'bootstrap_not_installed'
  | 'bootstrap_not_registered'
  | 'bootstrap_manifest_corrupt'
  | 'bootstrap_identity_mismatch'
  | 'install_state_corrupt'
  | 'journal_not_supported';

export interface ReleaseManagerAuthorityReadiness {
  readonly ready: boolean;
  readonly reasons: readonly ReleaseManagerAuthorityReason[];
}

export interface ReleaseManagerAuthorityOptions {
  readonly pdHome: string;
  /** Signed release metadata repository base URL; absent ⇒ not ready (no guessing). */
  readonly metadataBaseUrl: string | undefined;
  readonly openclawHome?: string;
  readonly now?: () => Date;
}

export interface ReleaseManagerAuthority {
  readonly manager: ReleaseManager;
  /** Install status snapshot; null when the install state failed a strict reader. */
  readonly installStatus: InstallStatus | null;
  readonly kinds: Readonly<Record<ReleaseManagerAuthorityKind, ReleaseManagerAuthorityReadiness>>;
  /**
   * PRI-709 P0-1: how the metadata base URL was resolved. `metadataBaseUrl` is
   * `undefined` for `invalid` / `unconfigured` — the same condition that
   * produces the `metadata_source_unconfigured` readiness reason, so an
   * unconfigured install is refused observably.
   */
  readonly metadataSource: ReleaseMetadataSource;
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

  // PRI-709 P0-1: resolve the metadata source BEFORE constructing the manager.
  // `install_config` is the durable tier — an install that was installed with
  // a metadata URL resolves it from ~/.pd/install.json with no env present.
  // A corrupt install.json is reported, not swallowed: it is also the state
  // `manager.inspect()` reads, so both surface as `install_state_corrupt`.
  let installConfig: InstallConfig | null = null;
  try {
    installConfig = readInstallConfig(resolvePdHomePaths(options.pdHome));
  } catch (error) {
    if (error instanceof InstallLayoutError) {
      reasons.add('install_state_corrupt');
    } else {
      throw error;
    }
  }

  const metadataSource = resolveReleaseMetadataSource({
    explicit: options.metadataBaseUrl,
    installConfig,
  });
  if (metadataSource.metadataBaseUrl === undefined) {
    reasons.add('metadata_source_unconfigured');
  }

  const manager = new ReleaseManager({
    pdHome: options.pdHome,
    metadataBaseUrl: metadataSource.metadataBaseUrl ?? '',
    ...(options.openclawHome !== undefined ? { openclawHome: options.openclawHome } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
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
  // PRI-850 (SPEC v0.3 §6.1): a served (non-legacy) installation must carry a
  // bootstrap registration whose digest re-verifies against the deployed
  // executor bytes. Missing / corrupt / mismatched are DISTINCT observable
  // reasons — never collapsed into "bootstrap too old" (the policy gate owns
  // version comparison; this gate owns existence, readability, and identity).
  if (installStatus !== null && installStatus.layout === 'dual-slot') {
    const pdHomePaths = resolvePdHomePaths(options.pdHome);
    let manifest: ReturnType<typeof readBootstrapManifest>;
    try {
      manifest = readBootstrapManifest(pdHomePaths);
    } catch {
      reasons.add('bootstrap_manifest_corrupt');
      manifest = null;
    }
    if (manifest === null) {
      reasons.add('bootstrap_not_registered');
    } else if (manifest.executorDigest === undefined) {
      reasons.add('bootstrap_not_registered');
    } else {
      try {
        const actual = digestDirectory(pdHomePaths.bootstrapExecutorDir);
        if (actual !== manifest.executorDigest) {
          reasons.add('bootstrap_identity_mismatch');
        }
      } catch {
        reasons.add('bootstrap_identity_mismatch');
      }
    }
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
    'apply-full': {
      ready: baseReady,
      reasons: baseReasons,
    },
  } satisfies Readonly<Record<ReleaseManagerAuthorityKind, ReleaseManagerAuthorityReadiness>>;

  return { manager, installStatus, kinds, metadataSource };
}

/** Preserve explicit failure details; never dispatch another writer. */
export function mapReleaseManagerError(error: unknown): {
  reason: string;
  message: string;
  nextAction: string;
  transactionOpened: boolean;
} {
  if (error instanceof ReleaseManagerError) {
    return {
      reason: error.reason,
      message: error.message,
      nextAction: error.nextAction,
      transactionOpened: error.transactionOpened,
    };
  }
  return {
    reason: 'release_manager_failed',
    message: error instanceof Error ? error.message : String(error),
    nextAction: 'Resolve the reported cause, or run the official installer to repair PD, then retry.',
    transactionOpened: false,
  };
}
