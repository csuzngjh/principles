/**
 * Nocturnal Dataset — Sample Lineage Store and Review State Registry
 * =================================================================
 *
 * PURPOSE: Establish each approved nocturnal sample as a first-class auditable
 * data asset with fingerprint, lineage, review state, and model family binding.
 *
 * ARCHITECTURE:
 *   - Registry file: {stateDir}/.state/nocturnal/dataset-registry.json
 *   - One JSON array of NocturnalDatasetRecord
 *   - Each record is immutable except for reviewStatus and reviewReason
 *   - sampleFingerprint is the primary key (deterministic: SHA-256 of artifactId+principleId+sessionId)
 *
 * RELATIONSHIP TO NOCTURNAL ARTIFACTS:
 *   - Artifacts live in: .state/nocturnal/samples/{artifactId}.json
 *   - Dataset records reference artifacts via artifactId and artifactPath
 *   - Artifacts are NOT modified by dataset operations
 *
 * DESIGN CONSTRAINTS:
 *   - No training run registry (Phase 4)
 *   - No checkpoint registry (Phase 4)
 *   - No worker routing changes
 *   - No JSONL export (that's Task 3.2)
 *   - Lineage is append-only for approved records
 *   - reviewStatus transitions are the only state mutations allowed
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { NocturnalPathResolver, resolveNocturnalDir } from './nocturnal-paths.js';
import type { NocturnalArtifact } from './nocturnal-arbiter.js';
import { withLock } from '../utils/file-lock.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Review status for a nocturnal dataset sample.
 * Follows the lifecycle: pending_review → approved_for_training | rejected | superseded
 */
export type NocturnalReviewStatus =
  | 'pending_review'
  | 'approved_for_training'
  | 'rejected'
  | 'superseded';

/**
 * A nocturnal dataset record — the immutable lineage entry for one sample.
 *
 * PRIMARY KEY: sampleFingerprint (deterministic SHA-256)
 * MUTABLE FIELDS: reviewStatus, reviewReason only
 * IMMUTABLE FIELDS: all others
 */
export interface NocturnalDatasetRecord {
  /**
   * Deterministic fingerprint: SHA-256(artifactId + principleId + sessionId).
   * Primary key for dataset operations.
   */
  sampleFingerprint: string;

  /** Reference to the original artifact */
  artifactId: string;

  /** Source session */
  sessionId: string;

  /** Target principle that generated this sample */
  principleId: string;

  /** Reference to the trajectory snapshot used */
  sourceSnapshotRef: string;

  /**
   * Current review state.
   * Only transitions allowed: pending_review → approved_for_training | rejected | superseded
   */
  reviewStatus: NocturnalReviewStatus;

  /**
   * Human-provided reason for the review decision.
   * Required for approved_for_training and rejected; optional for superseded.
   */
  reviewReason?: string;

  /**
   * Target model family this sample is bound to.
   * REQUIRED for export-ready samples.
   * NULL means "not yet assigned" (pending_review defaults to null).
   */
  targetModelFamily: string | null;

  /**
   * When this sample was first registered in the dataset.
   */
  createdAt: string;

  /**
   * Last time reviewStatus or reviewReason was updated.
   */
  updatedAt: string;

  /**
   * Absolute path to the artifact file.
   */
  artifactPath: string;
}

/**
 * Filter options for listing dataset records.
 */
export interface DatasetFilterOptions {
  /**
   * Filter by review status.
   */
  reviewStatus?: NocturnalReviewStatus | NocturnalReviewStatus[];

  /**
   * Filter by target model family.
   * NULL means "any" (including null/unassigned).
   */
  targetModelFamily?: string | null;

  /**
   * Include only export-ready records.
   * An export-ready record must have:
   *   - reviewStatus === 'approved_for_training'
   *   - targetModelFamily !== null
   *   - artifactPath points to an existing file
   */
  exportReadyOnly?: boolean;
}

/**
 * Result of registering a sample.
 */
export interface RegisterSampleResult {
  /** The registered record */
  record: NocturnalDatasetRecord;
  /** Whether this was a new registration (true) or duplicate link (false) */
  isNew: boolean;
  /**
   * If isNew === false, this points to the existing record.
   */
  existingRecord?: NocturnalDatasetRecord;
}

// ---------------------------------------------------------------------------
// Fingerprint Generation
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic sample fingerprint from an artifact.
 *
 * FINGERPRINT = SHA-256(artifactId || principleId || sessionId)
 *
 * The fingerprint is deterministic so the same sample always produces
 * the same fingerprint, enabling duplicate detection.
 */
export function generateSampleFingerprint(
  artifactId: string,
  principleId: string,
  sessionId: string
): string {
  const input = `${artifactId}|${principleId}|${sessionId}`;
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Generate a fingerprint from an existing NocturnalArtifact.
 */
export function generateFingerprintFromArtifact(artifact: NocturnalArtifact): string {
  return generateSampleFingerprint(
    artifact.artifactId,
    artifact.principleId,
    artifact.sessionId
  );
}

// ---------------------------------------------------------------------------
// Registry Path
// ---------------------------------------------------------------------------

/**
 * Path to the dataset registry file.
 */
function getRegistryPath(workspaceDir: string): string {
  // Registry lives in .state/nocturnal/dataset-registry.json
  const nocturnalRoot = resolveNocturnalDir(workspaceDir, 'ROOT');
  return path.join(nocturnalRoot, 'dataset-registry.json');
}

/**
 * Ensure the registry directory exists.
 */
function ensureRegistryDir(workspaceDir: string): void {
  const registryPath = getRegistryPath(workspaceDir);
  const dir = path.dirname(registryPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Read the registry file. Returns empty array if missing.
 */
function readRegistry(workspaceDir: string): NocturnalDatasetRecord[] {
  const registryPath = getRegistryPath(workspaceDir);
  if (!fs.existsSync(registryPath)) {
    return [];
  }
  try {
    const content = fs.readFileSync(registryPath, 'utf-8');
    return JSON.parse(content) as NocturnalDatasetRecord[];
  } catch {
    // Corrupted registry — fail-safe to empty array
    return [];
  }
}

/**
 * Write the registry file atomically (write-then-rename for atomicity).
 * Caller must hold the registry lock (via withRegistryLock).
 */
function writeRegistry(workspaceDir: string, records: NocturnalDatasetRecord[]): void {
  ensureRegistryDir(workspaceDir);
  const registryPath = getRegistryPath(workspaceDir);
  const tmpPath = `${registryPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(records, null, 2), 'utf-8');
  fs.renameSync(tmpPath, registryPath);
}

// ---------------------------------------------------------------------------
// Core Operations
// ---------------------------------------------------------------------------

/**
 * Execute a read-modify-write on the registry under an exclusive lock.
 * This prevents concurrent writers from racing on the same file.
 */
function withRegistryLock<T>(workspaceDir: string, fn: (records: NocturnalDatasetRecord[]) => T): T {
  const registryPath = getRegistryPath(workspaceDir);
  return withLock(registryPath, () => {
    const records = readRegistry(workspaceDir);
    return fn(records);
  });
}

/**
 * Register an approved nocturnal artifact in the dataset registry.
 *
 * DUPLICATE HANDLING:
 *   - If a record with the same sampleFingerprint already exists, returns
 *     existingRecord (isNew === false) instead of creating a duplicate.
 *   - The original artifact file is never modified.
 *
 * @param workspaceDir - Workspace directory
 * @param artifact - The approved NocturnalArtifact
 * @param artifactPath - Absolute path where the artifact file is stored
 * @param targetModelFamily - Model family binding (required for export-ready)
 * @returns RegisterSampleResult
 */
export function registerSample(
  workspaceDir: string,
  artifact: NocturnalArtifact,
  artifactPath: string,
  targetModelFamily: string | null = null
): RegisterSampleResult {
  const fingerprint = generateFingerprintFromArtifact(artifact);
  const now = new Date().toISOString();

  return withRegistryLock(workspaceDir, (records) => {
    const existing = records.find((r) => r.sampleFingerprint === fingerprint);
    if (existing) {
      return {
        record: existing,
        isNew: false,
        existingRecord: existing,
      };
    }

    const record: NocturnalDatasetRecord = {
      sampleFingerprint: fingerprint,
      artifactId: artifact.artifactId,
      sessionId: artifact.sessionId,
      principleId: artifact.principleId,
      sourceSnapshotRef: artifact.sourceSnapshotRef,
      reviewStatus: 'pending_review',
      reviewReason: undefined,
      targetModelFamily,
      createdAt: now,
      updatedAt: now,
      artifactPath: path.normalize(artifactPath),
    };

    records.push(record);
    writeRegistry(workspaceDir, records);

    return { record, isNew: true };
  });
}

/**
 * Get a dataset record by fingerprint.
 */
export function getDatasetRecord(
  workspaceDir: string,
  sampleFingerprint: string
): NocturnalDatasetRecord | null {
  const records = readRegistry(workspaceDir);
  return records.find((r) => r.sampleFingerprint === sampleFingerprint) ?? null;
}

/**
 * Get a dataset record by artifactId.
 */
export function getDatasetRecordByArtifactId(
  workspaceDir: string,
  artifactId: string
): NocturnalDatasetRecord | null {
  const records = readRegistry(workspaceDir);
  return records.find((r) => r.artifactId === artifactId) ?? null;
}

/**
 * List dataset records with optional filtering.
 *
 * @param workspaceDir - Workspace directory
 * @param filter - Optional filter criteria
 * @returns Filtered records sorted by createdAt descending
 */
export function listDatasetRecords(
  workspaceDir: string,
  filter?: DatasetFilterOptions
): NocturnalDatasetRecord[] {
  let records = readRegistry(workspaceDir);

  if (!filter) {
    return records.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  // Filter by reviewStatus
  if (filter.reviewStatus !== undefined) {
    const statuses = Array.isArray(filter.reviewStatus)
      ? filter.reviewStatus
      : [filter.reviewStatus];
    records = records.filter((r) => statuses.includes(r.reviewStatus));
  }

  // Filter by targetModelFamily
  if (filter.targetModelFamily !== undefined) {
    if (filter.targetModelFamily === null) {
      // Include only null/unassigned
      records = records.filter((r) => r.targetModelFamily === null);
    } else {
      records = records.filter((r) => r.targetModelFamily === filter.targetModelFamily);
    }
  }

  // Filter export-ready only
  if (filter.exportReadyOnly === true) {
    records = records.filter((r) => {
      if (r.reviewStatus !== 'approved_for_training') return false;
      if (r.targetModelFamily === null) return false;
      // Verify artifact file exists
      if (!fs.existsSync(r.artifactPath)) return false;
      return true;
    });
  }

  return records.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

/**
 * Valid review status transitions.
 *pending_review → approved_for_training | rejected | superseded
 * approved_for_training → superseded (if a better sample replaces it)
 * rejected → pending_review (if re-review is requested)
 * superseded → (terminal state, no transitions)
 */
const VALID_TRANSITIONS: Record<NocturnalReviewStatus, NocturnalReviewStatus[]> = {
  pending_review: ['approved_for_training', 'rejected', 'superseded'],
  approved_for_training: ['superseded'],
  rejected: ['pending_review', 'superseded'],
  superseded: [], // terminal
};

/**
 * Update the review status of a dataset record.
 *
 * @param workspaceDir - Workspace directory
 * @param sampleFingerprint - The fingerprint of the record to update
 * @param newStatus - The new review status
 * @param reason - Optional reason (required for approved/rejected per spec)
 * @returns Updated record, or null if not found
 * @throws Error if transition is invalid
 */
export function updateReviewStatus(
  workspaceDir: string,
  sampleFingerprint: string,
  newStatus: NocturnalReviewStatus,
  reason?: string
): NocturnalDatasetRecord {
  return withRegistryLock(workspaceDir, (records) => {
    const idx = records.findIndex((r) => r.sampleFingerprint === sampleFingerprint);

    if (idx === -1) {
      throw new Error(`Dataset record not found: ${sampleFingerprint}`);
    }

    const record = records[idx];

    // Validate transition
    const allowed = VALID_TRANSITIONS[record.reviewStatus];
    if (!allowed.includes(newStatus)) {
      throw new Error(
        `Invalid review status transition: ${record.reviewStatus} → ${newStatus}. ` +
          `Allowed transitions from ${record.reviewStatus}: ${allowed.join(', ') || 'none'}`
      );
    }

    // Enforce reason requirement for approved/rejected
    if (
      (newStatus === 'approved_for_training' || newStatus === 'rejected') &&
      !reason
    ) {
      throw new Error(
        `reviewReason is required when transitioning to ${newStatus}`
      );
    }

    // Apply update
    records[idx] = {
      ...record,
      reviewStatus: newStatus,
      reviewReason: reason ?? record.reviewReason,
      updatedAt: new Date().toISOString(),
    };

    writeRegistry(workspaceDir, records);
    return records[idx];
  });
}

/**
 * Update the target model family binding.
 */
export function updateTargetModelFamily(
  workspaceDir: string,
  sampleFingerprint: string,
  targetModelFamily: string | null
): NocturnalDatasetRecord {
  return withRegistryLock(workspaceDir, (records) => {
    const idx = records.findIndex((r) => r.sampleFingerprint === sampleFingerprint);

    if (idx === -1) {
      throw new Error(`Dataset record not found: ${sampleFingerprint}`);
    }

    records[idx] = {
      ...records[idx],
      targetModelFamily,
      updatedAt: new Date().toISOString(),
    };

    writeRegistry(workspaceDir, records);
    return records[idx];
  });
}

/**
 * Check if a sample is export-ready.
 *
 * EXPORT-READY means:
 *   - reviewStatus === 'approved_for_training'
 *   - targetModelFamily !== null
 *   - artifact file exists
 *   - lineage fields are complete
 */
export function isExportReady(
  workspaceDir: string,
  sampleFingerprint: string
): boolean {
  const record = getDatasetRecord(workspaceDir, sampleFingerprint);
  if (!record) return false;
  if (record.reviewStatus !== 'approved_for_training') return false;
  if (record.targetModelFamily === null) return false;
  if (!fs.existsSync(record.artifactPath)) return false;
  return true;
}

/**
 * List all export-ready records for a specific target model family.
 */
export function listExportReadyRecords(
  workspaceDir: string,
  targetModelFamily?: string | null
): NocturnalDatasetRecord[] {
  return listDatasetRecords(workspaceDir, {
    exportReadyOnly: true,
    targetModelFamily: targetModelFamily ?? undefined,
  });
}

/**
 * Get the artifact path for a dataset record.
 * Verifies the file exists before returning.
 */
export function getArtifactPath(
  workspaceDir: string,
  sampleFingerprint: string
): string | null {
  const record = getDatasetRecord(workspaceDir, sampleFingerprint);
  if (!record) return null;
  if (!fs.existsSync(record.artifactPath)) return null;
  return record.artifactPath;
}

/**
 * Read the artifact file for a dataset record.
 * @throws Error if record not found, artifact file missing, or unreadable
 */
export function readDatasetArtifact(
  workspaceDir: string,
  sampleFingerprint: string
): NocturnalArtifact {
  const artifactPath = getArtifactPath(workspaceDir, sampleFingerprint);
  if (!artifactPath) {
    throw new Error(`Artifact file not found for sample ${sampleFingerprint}`);
  }

  const content = fs.readFileSync(artifactPath, 'utf-8');
  const parsed = JSON.parse(content);
  // Return only the NocturnalArtifact fields (not the extended sample record)
  return {
    artifactId: parsed.artifactId,
    sessionId: parsed.sessionId,
    principleId: parsed.principleId,
    sourceSnapshotRef: parsed.sourceSnapshotRef,
    badDecision: parsed.badDecision,
    betterDecision: parsed.betterDecision,
    rationale: parsed.rationale,
    createdAt: parsed.createdAt,
  } as NocturnalArtifact;
}

/**
 * Count records by status for dashboard purposes.
 */
export function getDatasetStats(
  workspaceDir: string
): {
  total: number;
  pendingReview: number;
  approvedForTraining: number;
  rejected: number;
  superseded: number;
  exportReadyByFamily: Record<string, number>;
} {
  const records = readRegistry(workspaceDir);

  const counts = {
    total: records.length,
    pendingReview: 0,
    approvedForTraining: 0,
    rejected: 0,
    superseded: 0,
    exportReadyByFamily: {} as Record<string, number>,
  };

  for (const record of records) {
    switch (record.reviewStatus) {
      case 'pending_review':
        counts.pendingReview++;
        break;
      case 'approved_for_training':
        counts.approvedForTraining++;
        break;
      case 'rejected':
        counts.rejected++;
        break;
      case 'superseded':
        counts.superseded++;
        break;
    }

    // Count export-ready by family
    if (
      record.reviewStatus === 'approved_for_training' &&
      record.targetModelFamily !== null &&
      fs.existsSync(record.artifactPath)
    ) {
      const family = record.targetModelFamily;
      counts.exportReadyByFamily[family] = (counts.exportReadyByFamily[family] || 0) + 1;
    }
  }

  return counts;
}

// ---------------------------------------------------------------------------
// Auto-registration from persisted samples
// ---------------------------------------------------------------------------

/**
 * Scan the samples directory and register any approved artifacts
 * that are not yet in the dataset registry.
 *
 * This is used for:
 *   1. Initial migration of Phase 2 artifacts to Phase 3 dataset
 *   2. Recovering from registry corruption
 *
 * @param workspaceDir - Workspace directory
 * @param targetModelFamily - Default target family for migrated samples
 * @returns Number of newly registered samples
 */
export function migrateSampleArtifacts(
  workspaceDir: string,
  targetModelFamily: string | null = null
): number {
  const samplePaths = NocturnalPathResolver.listSamples(workspaceDir);
  let newCount = 0;

  for (const samplePath of samplePaths) {
    try {
      const content = fs.readFileSync(samplePath, 'utf-8');
      const sample = JSON.parse(content);

      // Only process approved samples
      if (sample.status !== 'approved') continue;
      if (!sample.artifactId || !sample.sessionId || !sample.principleId) continue;

      // Skip if already in registry
      const fingerprint = generateSampleFingerprint(
        sample.artifactId,
        sample.principleId,
        sample.sessionId
      );
      const existing = getDatasetRecord(workspaceDir, fingerprint);
      if (existing) continue;

      // Register the artifact
      const artifact: NocturnalArtifact = {
        artifactId: sample.artifactId,
        sessionId: sample.sessionId,
        principleId: sample.principleId,
        sourceSnapshotRef: sample.sourceSnapshotRef || '',
        badDecision: sample.badDecision || '',
        betterDecision: sample.betterDecision || '',
        rationale: sample.rationale || '',
        createdAt: sample.createdAt || new Date().toISOString(),
      };

      registerSample(workspaceDir, artifact, samplePath, targetModelFamily);
      newCount++;
    } catch {
      // Skip malformed files
    }
  }

  return newCount;
}
