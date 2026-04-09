/**
 * Nocturnal ORPO Export — Approved Dataset to Decision-Point JSONL
 * =================================================================
 *
 * PURPOSE: Export approved nocturnal samples as ORPO-formatted decision-point
 * training JSONL, strictly separated from legacy correction export.
 *
 * ARCHITECTURE:
 *   - Export output: .state/exports/orpo/{exportId}.jsonl
 *   - Export manifest: .state/exports/orpo/{exportId}-manifest.json
 *   - Legacy corrections: untouched, separate path
 *
 * ORPO FORMAT (each line):
 *   {
 *     sampleFingerprint: string,
 *     artifactId: string,
 *     sessionId: string,
 *     principleId: string,
 *     targetModelFamily: string,
 *     prompt: string,        // badDecision (the wrong choice)
 *     chosen: string,        // betterDecision (the right choice)
 *     rejected: string,       // badDecision (for ORPO)
 *     rationale: string,
 *     datasetMetadata: {
 *       sampleFingerprint: string,
 *       artifactPath: string,
 *       createdAt: string,
 *       exportedAt: string,
 *       exportId: string,
 *       datasetFingerprint: string
 *     }
 *   }
 *
 * EXPORT GATING (fail-closed):
 *   - reviewStatus === 'approved_for_training'
 *   - targetModelFamily matches requested target (or any if not specified)
 *   - Lineage fields complete (sampleFingerprint, artifactId, sessionId, principleId)
 *   - Source artifact file exists and is approved
 *
 * DESIGN CONSTRAINTS:
 *   - No trainer invocation
 *   - No automatic training
 *   - No checkpoint deploy
 *   - Export is read-only from dataset perspective
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  listDatasetRecords,
  readDatasetArtifact,
  type NocturnalDatasetRecord,
} from './nocturnal-dataset.js';
import { NocturnalPathResolver } from './nocturnal-paths.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single ORPO training sample in JSONL format.
 */
export interface ORPOSample {
  sampleFingerprint: string;
  artifactId: string;
  sessionId: string;
  principleId: string;
  targetModelFamily: string;
  /** The suboptimal decision (what the agent did wrong) */
  prompt: string;
  /** The correct decision (what should have been done) */
  chosen: string;
  /** The suboptimal decision (same as prompt, for ORPO structure) */
  rejected: string;
  rationale: string;
  datasetMetadata: {
    sampleFingerprint: string;
    artifactPath: string;
    createdAt: string;
    exportedAt: string;
    exportId: string;
    datasetFingerprint: string;
  };
}

/**
 * Export manifest containing metadata about the entire export.
 */
export interface ORPOExportManifest {
  exportId: string;
  createdAt: string;
  sampleCount: number;
  targetModelFamily: string;
  /** SHA-256 of all sample fingerprints, sorted — for reproducibility */
  datasetFingerprint: string;
  exportPath: string;
  manifestPath: string;
  samples: {
    sampleFingerprint: string;
    artifactId: string;
    sessionId: string;
    principleId: string;
  }[];
}

/**
 * Result of an export operation.
 */
export interface ExportResult {
  success: boolean;
  manifest?: ORPOExportManifest;
  error?: string;
  emptyReason?: 'no_approved_samples' | 'family_mismatch' | 'all_samples_missing_artifacts';
}

// ---------------------------------------------------------------------------
// Dataset Fingerprint (for reproducibility)
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic dataset fingerprint from a sorted list of sample fingerprints.
 * This allows reproducible exports — same dataset always produces same fingerprint.
 */
function computeDatasetFingerprint(sampleFingerprints: string[]): string {
  const sorted = [...sampleFingerprints].sort();
  const combined = sorted.join('|');
  return crypto.createHash('sha256').update(combined, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Individual Sample Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a single dataset record + artifact to ORPO JSONL line.
 * Caller guarantees record.targetModelFamily is non-null.
 */
// eslint-disable-next-line @typescript-eslint/max-params -- Reason: serialization requires record + artifact + export info - refactoring would break internal API
function serializeORPOSample(
  record: NocturnalDatasetRecord,
  artifact: ReturnType<typeof readDatasetArtifact>,
  exportId: string,
  datasetFingerprint: string
): ORPOSample {
  const now = new Date().toISOString();

  return {
    sampleFingerprint: record.sampleFingerprint,
    artifactId: record.artifactId,
    sessionId: record.sessionId,
    principleId: record.principleId,
    targetModelFamily: record.targetModelFamily as string, // validated non-null by caller
    // For ORPO: prompt = badDecision, chosen = betterDecision, rejected = badDecision
    // This teaches the model to prefer betterDecision over badDecision
    prompt: artifact.badDecision,
    chosen: artifact.betterDecision,
    rejected: artifact.badDecision,
    rationale: artifact.rationale,
    datasetMetadata: {
      sampleFingerprint: record.sampleFingerprint,
      artifactPath: record.artifactPath,
      createdAt: record.createdAt,
      exportedAt: now,
      exportId,
      datasetFingerprint,
    },
  };
}

// ---------------------------------------------------------------------------
// Core Export Function
// ---------------------------------------------------------------------------

/**
 * Export approved nocturnal samples as ORPO decision-point JSONL.
 *
 * @param workspaceDir - Workspace directory
 * @param targetModelFamily - Specific model family to export, or undefined for all
 * @param options - Additional export options
 * @returns ExportResult
 */
export function exportORPOSamples(
  workspaceDir: string,
  targetModelFamily?: string | null,
  _options: Record<string, never> = {} // eslint-disable-line @typescript-eslint/no-unused-vars -- Reason: options parameter intentionally unused
): ExportResult {
  const exportId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Step 1: Collect eligible records
  // Use listDatasetRecords directly to have full control over the family filter
  // (listExportReadyRecords uses ?? which maps null→undefined, losing the null distinction)
  const allApprovedRecords = listDatasetRecords(workspaceDir, {
    reviewStatus: 'approved_for_training',
  });

  // eslint-disable-next-line @typescript-eslint/init-declarations -- assigned in both if/else branches
  let eligibleRecords: typeof allApprovedRecords;

  if (targetModelFamily !== undefined && targetModelFamily !== null) {
    // Specific family: check if ANY records (regardless of status) have this family
    const allRecords = listDatasetRecords(workspaceDir);
    const hasAnyWithFamily = allRecords.some((r) => r.targetModelFamily === targetModelFamily);
    if (!hasAnyWithFamily) {
      // Family doesn't exist in any record
      return {
        success: false,
        error: 'No samples found for the requested target model family',
        emptyReason: 'family_mismatch',
      };
    }
    // Family exists but none are approved
    eligibleRecords = allApprovedRecords.filter((r) => r.targetModelFamily === targetModelFamily);
  } else {
    // All families
    eligibleRecords = allApprovedRecords;
  }

  // Step 2: Validate we have records
  if (eligibleRecords.length === 0) {
    return {
      success: false,
      error: 'No approved samples found for export',
      emptyReason: 'no_approved_samples',
    };
  }

  // Step 3: Verify lineage completeness and read artifacts
  const orpoSamples: ORPOSample[] = [];
  const failedFingerprints: string[] = [];

  for (const record of eligibleRecords) {
    // Enforce targetModelFamily binding — samples without a family cannot enter training
    if (record.targetModelFamily === null) {
      failedFingerprints.push(record.sampleFingerprint);
      continue;
    }

    // Verify lineage completeness
    if (!record.sampleFingerprint || !record.artifactId || !record.sessionId || !record.principleId) {
      failedFingerprints.push(record.sampleFingerprint);
      continue;
    }

    // Read artifact (throws on error — distinguishes read failure from missing artifact)
    // eslint-disable-next-line @typescript-eslint/init-declarations -- assigned in try, catch continues to next iteration
    let artifact;
    try {
      artifact = readDatasetArtifact(workspaceDir, record.sampleFingerprint);
    } catch {
      failedFingerprints.push(record.sampleFingerprint);
      continue;
    }

    // Serialize
    orpoSamples.push(serializeORPOSample(record, artifact, exportId, ''));
  }

  // Step 4: Fail if all samples failed validation
  if (orpoSamples.length === 0) {
    return {
      success: false,
      error: `All ${eligibleRecords.length} eligible samples failed validation (missing artifacts or lineage)`,
      emptyReason: 'all_samples_missing_artifacts',
    };
  }

  // Step 5: Compute dataset fingerprint for manifest
  const datasetFingerprint = computeDatasetFingerprint(
    orpoSamples.map((s) => s.sampleFingerprint)
  );

  // Step 6: Fill in dataset fingerprint in all samples
  for (const sample of orpoSamples) {
    sample.datasetMetadata.datasetFingerprint = datasetFingerprint;
  }

  // Step 7: Write JSONL file
  const exportsDir = NocturnalPathResolver.exportsDir(workspaceDir);
  const jsonlPath = path.join(exportsDir, `${exportId}.jsonl`);
  const lines = orpoSamples.map((s) => JSON.stringify(s)).join('\n') + '\n';
  fs.writeFileSync(jsonlPath, lines, 'utf-8');

  // Step 8: Write manifest
  const manifest: ORPOExportManifest = {
    exportId,
    createdAt: now,
    sampleCount: orpoSamples.length,
    targetModelFamily: targetModelFamily ?? 'all',
    datasetFingerprint,
    exportPath: jsonlPath,
    manifestPath: path.join(exportsDir, `${exportId}-manifest.json`),
    samples: orpoSamples.map((s) => ({
      sampleFingerprint: s.sampleFingerprint,
      artifactId: s.artifactId,
      sessionId: s.sessionId,
      principleId: s.principleId,
    })),
  };

  fs.writeFileSync(manifest.manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  return {
    success: true,
    manifest,
  };
}

/**
 * Verify an existing export by re-computing its dataset fingerprint.
 * Returns true if the export is intact and reproducible.
 */
export function verifyExportIntegrity(
  workspaceDir: string,
  exportId: string
): { valid: boolean; computedFingerprint: string; manifestFingerprint: string } | null {
  const exportsDir = NocturnalPathResolver.exportsDir(workspaceDir);
  const manifestPath = path.join(exportsDir, `${exportId}-manifest.json`);

  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ORPOExportManifest;
    const computedFingerprint = computeDatasetFingerprint(
      manifest.samples.map((s) => s.sampleFingerprint)
    );

    return {
      valid: computedFingerprint === manifest.datasetFingerprint,
      computedFingerprint,
      manifestFingerprint: manifest.datasetFingerprint,
    };
  } catch {
    return null;
  }
}

/**
 * List all exports in the exports directory.
 */
export function listExports(workspaceDir: string): ORPOExportManifest[] {
  const exportsDir = NocturnalPathResolver.exportsDir(workspaceDir);
  if (!fs.existsSync(exportsDir)) {
    return [];
  }

  try {
    const files = fs.readdirSync(exportsDir);
    const manifests: ORPOExportManifest[] = [];

    for (const file of files) {
      if (!file.endsWith('-manifest.json')) continue;
      try {
        const manifest = JSON.parse(
          fs.readFileSync(path.join(exportsDir, file), 'utf-8')
        ) as ORPOExportManifest;
        manifests.push(manifest);
      } catch {
        // Skip malformed manifest
      }
    }

    return manifests.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  } catch {
    return [];
  }
}

/**
 * Read an export manifest by ID.
 */
export function getExportManifest(
  workspaceDir: string,
  exportId: string
): ORPOExportManifest | null {
  const exportsDir = NocturnalPathResolver.exportsDir(workspaceDir);
  const manifestPath = path.join(exportsDir, `${exportId}-manifest.json`);

  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ORPOExportManifest;
  } catch {
    return null;
  }
}
