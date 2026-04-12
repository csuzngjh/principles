/**
 * Nocturnal ORPO Export — Approved Dataset to Principle-Review JSONL
 * =================================================================
 *
 * PURPOSE: Export approved nocturnal samples as ORPO-formatted principle-review
 * training JSONL. The format teaches models to review agent behavior against principles.
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
 *     messages: [           // Full conversation trajectory
 *       {role: "system", content: "You are a principle reviewer..."},
 *       {role: "user", content: "## Principle P_001\n## Session Context\n## Agent Behavior\nReview..."}
 *     ],
 *     chosen: string,       // Correct principle review (from betterDecision + rationale)
 *     rejected: string,     // Incorrect principle review (from badDecision)
 *     rationale: string,
 *     datasetMetadata: {...}
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
 * A single message in the conversation trajectory.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * A single ORPO training sample in principle-review JSONL format.
 * Teaches models to review agent behavior against principles.
 */
export interface ORPOSample {
  sampleFingerprint: string;
  artifactId: string;
  sessionId: string;
  principleId: string;
  targetModelFamily: string;
  /** Full conversation trajectory: system → user prompt → (chosen or rejected) */
  messages: ChatMessage[];
  /** The correct principle review (teaches model what "good" looks like) */
  chosen: string;
  /** The incorrect principle review (teaches model what "bad" looks like) */
  rejected: string;
  rationale: string;
  /** @deprecated Use messages instead. Kept for backward compatibility. */
  prompt?: string;
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
// Helper Functions: Build Review Components
// ---------------------------------------------------------------------------

/**
 * Build the user message for a principle review task.
 * Contains: principle definition + session context + agent behavior summary.
 * Omits session IDs to prevent overfitting.
 */
function buildReviewUserMessage(
  artifact: ReturnType<typeof readDatasetArtifact>
): string {
  const sections: string[] = [];

  // Section 1: Principle
  sections.push(`## Principle ${artifact.principleId}`);
  sections.push(``);

  // Section 2: Session context (aggregate stats only, no raw text)
  sections.push(`## Session Context`);
  sections.push(`- Tool calls: multiple operations on workspace files`);
  sections.push(`- Failures: at least one tool operation failed`);
  sections.push(`- Pain signals: at least one pain signal detected (score ≥ 50)`);
  sections.push(``);

  // Section 3: Agent behavior summary (from badDecision — what the agent actually did)
  sections.push(`## Agent Behavior`);
  // Strip session IDs from the badDecision text to prevent overfitting
  const sanitizedBadDecision = artifact.badDecision
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[session-id]')
    .replace(/session [a-f0-9-]+/gi, 'session [id]');
  sections.push(`The agent: ${sanitizedBadDecision}`);
  sections.push(``);

  // Section 4: Review task
  sections.push(`## Task`);
  sections.push(`Review whether the agent followed principle ${artifact.principleId} in this session.`);
  sections.push(`Identify specific violations and propose concrete, actionable improvements.`);

  return sections.join('\n');
}

/**
 * Build the "chosen" response — the correct principle review.
 * Derived from betterDecision + rationale + boundedAction.
 */
function buildReviewChosen(
  artifact: ReturnType<typeof readDatasetArtifact>
): string {
  const parts: string[] = [];

  // Verdict
  parts.push(`The agent did NOT follow principle ${artifact.principleId} correctly.`);
  parts.push('');

  // Specific violation (from rationale, stripped of session IDs)
  const sanitizedRationale = artifact.rationale
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[session-id]')
    .replace(/session [a-f0-9-]+/gi, 'session [id]');
  parts.push(`**Violation**: ${sanitizedRationale}`);
  parts.push('');

  // Correct action (from betterDecision, stripped of session IDs)
  const sanitizedBetter = artifact.betterDecision
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[session-id]')
    .replace(/session [a-f0-9-]+/gi, 'session [id]');
  parts.push(`**Correct action**: ${sanitizedBetter}`);

  return parts.join('\n');
}

/**
 * Build the "rejected" response — a plausible but incorrect principle review.
 * Derived from badDecision, framed as a review that ignores the violation.
 */
function buildReviewRejected(
  artifact: ReturnType<typeof readDatasetArtifact>
): string {
  const parts: string[] = [];

  // Verdict (reversed from reality)
  parts.push(`The agent's behavior was acceptable under principle ${artifact.principleId}.`);
  parts.push('');

  // Plausible but wrong justification (from badDecision, reframed)
  const sanitizedBad = artifact.badDecision
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[session-id]')
    .replace(/session [a-f0-9-]+/gi, 'session [id]');
  parts.push(`**Justification**: ${sanitizedBad} This is a reasonable response given the circumstances.`);

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Individual Sample Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a single dataset record + artifact to ORPO principle-review JSONL line.
 * Caller guarantees record.targetModelFamily is non-null.
 */
function serializeORPOSample(
  record: NocturnalDatasetRecord,
  artifact: ReturnType<typeof readDatasetArtifact>,
  exportId: string,
  datasetFingerprint: string
): ORPOSample {
  const now = new Date().toISOString();

  // Build conversation trajectory
  const systemMessage: ChatMessage = {
    role: 'system',
    content: `You are a principle reviewer. Your task is to review whether an agent's behavior followed a given principle. Provide specific violation identification and actionable improvement suggestions.`,
  };

  const userMessage: ChatMessage = {
    role: 'user',
    content: buildReviewUserMessage(artifact),
  };

  const messages: ChatMessage[] = [systemMessage, userMessage];

  return {
    sampleFingerprint: record.sampleFingerprint,
    artifactId: record.artifactId,
    sessionId: record.sessionId,
    principleId: record.principleId,
    targetModelFamily: record.targetModelFamily as string,
    messages,
    chosen: buildReviewChosen(artifact),
    rejected: buildReviewRejected(artifact),
    rationale: artifact.rationale,
    prompt: artifact.badDecision, // @deprecated: kept for backward compatibility
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
  _options: Record<string, never> = {}  
): ExportResult {
  const exportId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Step 1: Collect eligible records
  // Use listDatasetRecords directly to have full control over the family filter
  // (listExportReadyRecords uses ?? which maps null→undefined, losing the null distinction)
  const allApprovedRecords = listDatasetRecords(workspaceDir, {
    reviewStatus: 'approved_for_training',
  });

   
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
