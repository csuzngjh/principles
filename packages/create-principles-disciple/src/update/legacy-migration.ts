/**
 * Official legacy-overlay migration (SPEC §15 Phase 5).
 *
 * ONLY an official installer transaction migrates an existing overlay
 * installation (~/.openclaw/extensions/principles-disciple) into the
 * bootstrap + dual-slot layout. The legacy updater must never transform
 * itself in place. Owner data, workspace config, and governance assets are
 * preserved untouched; the overlay directory itself is left in place as
 * read-only legacy diagnostics for a bounded period — never deleted or
 * rewritten by the migration.
 *
 * Dry-run is the default posture (cli-4): the plan describes every resolved
 * target and the exact step list without touching anything.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ensurePdHomeLayout, resolvePdHomePaths } from './install-layout.js';
import { appendJournalTransition, writeActiveRecord, type TransactionState } from './transaction-journal.js';
import { appendHistoryEvent, classifyDirection } from './update-history.js';
import { deriveReleaseId } from './release-identity.js';
import { parseProductVersion, ProductIdentityError } from './product-identity.js';

/** Every path this migration writes must resolve inside the target ~/.pd root. */
function assertWithinPdHome(candidate: string, pdHome: string, label: string): string {
  const resolved = path.resolve(candidate);
  const root = path.resolve(pdHome);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new ProductIdentityError(label, `Migration write escaped ~/.pd (${root}): ${resolved}`);
  }
  return resolved;
}

export type MigrationRefusalReason =
  | 'overlay_missing'
  | 'already_migrated'
  | 'overlay_manifest_invalid'
  | 'bootstrap_write_out_of_scope';

export interface MigrationRefusal {
  readonly migrated: false;
  readonly dryRun: boolean;
  readonly reason: MigrationRefusalReason;
  readonly message: string;
  readonly nextAction: string;
}

export interface MigrationStep {
  readonly description: string;
  readonly resolvedTarget: string;
}

export interface MigrationPlan {
  readonly migrated: true;
  readonly dryRun: boolean;
  readonly overlayDir: string;
  readonly pdHome: string;
  readonly productVersion: string;
  readonly releaseId: string;
  readonly steps: readonly MigrationStep[];
  readonly historyEventPath: string;
}

export type MigrationResult = MigrationPlan | MigrationRefusal;

export interface LegacyMigrationInput {
  readonly homeDir: string;
  readonly openclawHome: string;
  /** Only the official installer sets this — a product release may not write the bootstrap. */
  readonly invokedByOfficialInstaller: boolean;
  readonly dryRun: boolean;
  readonly bootstrapVersion: string;
  readonly transactionId: string;
  readonly now?: () => Date;
}

function overlayPluginDir(openclawHome: string): string {
  return path.join(openclawHome, 'extensions', 'principles-disciple');
}

function readOverlayProductVersion(overlayDir: string): string {
  const manifestPath = path.join(overlayDir, 'plugin', 'package.json');
  if (!fs.existsSync(manifestPath)) {
    throw new ProductIdentityError('overlay', `The overlay installation has no plugin manifest: ${manifestPath}`);
  }
  const value: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProductIdentityError('overlay', 'The overlay plugin manifest is not an object.');
  }
  const {version} = (value as Record<string, unknown>);
  return parseProductVersion(version, 'overlay.plugin.version').productVersion;
}

function overlayComponentDigests(overlayDir: string): { component: string; sha256: string; sizeBytes: number }[] {
  const digests: { component: string; sha256: string; sizeBytes: number }[] = [];
  for (const component of ['plugin', 'console', 'core', 'pd-cli', 'host-runtime', 'install-layout']) {
    const manifestPath = path.join(overlayDir, component, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    const bytes = fs.readFileSync(manifestPath);
    digests.push({
      component,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length,
    });
  }
  return digests;
}

/**
 * Plans (and when dryRun=false, executes) the one-time official migration.
 * The migration: lays down the bootstrap manifest, derives the overlay's
 * canonical release identity, records it as generation 1 of the dual-slot
 * layout, writes install.json defaults, and appends a legacy_migration
 * history event. The overlay tree itself is never modified.
 */
export function migrateLegacyOverlay(input: LegacyMigrationInput): MigrationResult {
  const now = input.now ?? ((): Date => new Date());
  const overlayDir = overlayPluginDir(input.openclawHome);
  const pdHome = path.join(input.homeDir, '.pd');
  const paths = resolvePdHomePaths(pdHome);

  if (!fs.existsSync(overlayDir)) {
    return {
      migrated: false,
      dryRun: input.dryRun,
      reason: 'overlay_missing',
      message: `No legacy overlay installation found at ${overlayDir}.`,
      nextAction: 'Nothing to migrate. Install PD with the official installer for the new layout.',
    };
  }
  if (fs.existsSync(paths.activeRecordPath)) {
    return {
      migrated: false,
      dryRun: input.dryRun,
      reason: 'already_migrated',
      message: `This installation already uses the dual-slot layout (${paths.activeRecordPath} exists).`,
      nextAction: 'Use the normal update flow; do not re-run the legacy migration.',
    };
  }
  if (!input.invokedByOfficialInstaller) {
    return {
      migrated: false,
      dryRun: input.dryRun,
      reason: 'bootstrap_write_out_of_scope',
      message: 'The bootstrap and trust root may only be written by an official installer transaction — a product release or the legacy updater cannot migrate itself in place.',
      nextAction: 'Re-run the official installer, which performs the migration as part of its own transaction.',
    };
  }

  let productVersion: string;
  let componentDigests: { component: string; sha256: string; sizeBytes: number }[];
  try {
    productVersion = readOverlayProductVersion(overlayDir);
    componentDigests = overlayComponentDigests(overlayDir);
  } catch (error) {
    if (error instanceof ProductIdentityError) {
      return {
        migrated: false,
        dryRun: input.dryRun,
        reason: 'overlay_manifest_invalid',
        message: error.message,
        nextAction: 'Reinstall the overlay with the official installer so its manifests are complete, then retry the migration.',
      };
    }
    throw error;
  }

  // The migrated overlay's release identity is derived from the overlay's own
  // component digests — canonical identity, not a checkout package.json.
  const releaseId = deriveReleaseId({
    productVersion,
    sourceCommit: '0'.repeat(40),
    minBootstrapVersion: input.bootstrapVersion,
    assets: componentDigests.map((digest) => ({
      platform: `overlay-${digest.component}`,
      arch: 'x64',
      nodeAbi: '0',
      archiveSha256: digest.sha256,
      archiveSizeBytes: digest.sizeBytes,
    })),
  });

  const steps: MigrationStep[] = [
    { description: 'Create the ~/.pd installation skeleton', resolvedTarget: paths.home },
    { description: `Write the installer-owned bootstrap manifest (v${input.bootstrapVersion})`, resolvedTarget: paths.bootstrapManifestPath },
    { description: `Record the overlay release ${productVersion} as generation 1`, resolvedTarget: path.join(paths.releasesDir, releaseId) },
    { description: 'Write installation defaults (stable channel, automatic checks off)', resolvedTarget: paths.installConfigPath },
    { description: 'Append the legacy_migration history event (overlay remains read-only)', resolvedTarget: path.join(paths.logsDir, 'history.jsonl') },
  ];

  if (input.dryRun) {
    return {
      migrated: true,
      dryRun: true,
      overlayDir,
      pdHome,
      productVersion,
      releaseId,
      steps,
      historyEventPath: path.join(paths.logsDir, 'history.jsonl'),
    };
  }

  const journalPath = assertWithinPdHome(path.join(paths.transactionsDir, `${input.transactionId}.jsonl`), pdHome, 'journal');
  const bootstrapManifestPath = assertWithinPdHome(paths.bootstrapManifestPath, pdHome, 'bootstrap');
  const releaseDir = assertWithinPdHome(path.join(paths.releasesDir, releaseId), pdHome, 'releases');
  const releaseMetadataPath = assertWithinPdHome(path.join(releaseDir, 'metadata.json'), pdHome, 'release-metadata');
  const activeRecordPath = assertWithinPdHome(paths.activeRecordPath, pdHome, 'active-record');
  const previousRecordPath = assertWithinPdHome(paths.previousRecordPath, pdHome, 'previous-record');
  const installConfigPath = assertWithinPdHome(paths.installConfigPath, pdHome, 'install-config');
  const historyPath = assertWithinPdHome(path.join(paths.logsDir, 'history.jsonl'), pdHome, 'history');

  const transition = (from: TransactionState | null, to: TransactionState, detail: string): void => {
    appendJournalTransition(journalPath, {
      at: now().toISOString(),
      from,
      to,
      transactionId: input.transactionId,
      releaseId,
      productVersion,
      releaseMetadataDigest: 'f'.repeat(64),
      generation: 1,
      detail,
    });
  };

  ensurePdHomeLayout(paths);
  transition(null, 'planned', 'official legacy migration planned');

  fs.writeFileSync(bootstrapManifestPath, `${JSON.stringify({
    bootstrapVersion: input.bootstrapVersion,
    installedAt: now().toISOString(),
  }, null, 2)}\n`);
  transition('planned', 'staged', 'bootstrap manifest written by the official installer');

  fs.mkdirSync(releaseDir, { recursive: true });
  fs.writeFileSync(releaseMetadataPath, `${JSON.stringify({
    schemaVersion: 1,
    productVersion,
    releaseId,
    sourceCommit: '0'.repeat(40),
    metadataDigest: 'f'.repeat(64),
    minBootstrapVersion: input.bootstrapVersion,
    publicationSequence: 1,
    expiresAt: '9999-12-31T00:00:00Z',
    assets: componentDigests.map((digest) => ({
      platform: `overlay-${digest.component}`,
      arch: 'x64',
      nodeAbi: '0',
      archiveSha256: digest.sha256,
      archiveSizeBytes: digest.sizeBytes,
    })),
    compatibility: { dataSchemaForwardReadableFrom: productVersion },
  }, null, 2)}\n`);
  transition('staged', 'probed', 'overlay identity recorded as generation 1 release');

  writeActiveRecord(activeRecordPath, {
    generation: 1,
    releaseId,
    releaseMetadataDigest: 'f'.repeat(64),
    previousReleaseId: null,
    transactionId: input.transactionId,
    productVersion,
  });
  fs.copyFileSync(activeRecordPath, previousRecordPath);
  transition('probed', 'activated', 'generation 1 active record written');

  fs.writeFileSync(installConfigPath, `${JSON.stringify({ channel: 'stable', autoCheck: false }, null, 2)}\n`);
  transition('activated', 'confirmed', 'legacy migration confirmed; overlay tree left untouched as read-only diagnostics');

  appendHistoryEvent(historyPath, {
    at: now().toISOString(),
    kind: 'legacy_migration',
    direction: classifyDirection({ kind: 'legacy_migration', releasePublicationSequence: 1, previousPublicationSequence: null }),
    outcome: 'succeeded',
    productVersion,
    releaseId,
    previousReleaseId: null,
    previousRemainsActive: false,
    reason: `Migrated the overlay installation at ${overlayDir} into the dual-slot layout; the overlay tree is preserved read-only.`,
    nextAction: null,
    transactionId: input.transactionId,
  });

  return {
    migrated: true,
    dryRun: false,
    overlayDir,
    pdHome,
    productVersion,
    releaseId,
    steps,
    historyEventPath: historyPath,
  };
}
