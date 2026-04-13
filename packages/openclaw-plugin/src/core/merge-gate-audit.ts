import * as fs from 'fs';
import * as path from 'path';
import { getImplementationAssetRoot } from './code-implementation-storage.js';
import { listDatasetRecords } from './nocturnal-dataset.js';
import { listArtifactLineageRecords } from './nocturnal-artifact-lineage.js';
import { listExports, verifyExportIntegrity } from './nocturnal-export.js';
import { OpenClawTrinityRuntimeAdapter } from './nocturnal-trinity.js';
import { resolvePdPath } from './paths.js';
import type { ReplayReport } from './replay-engine.js';

export type MergeGateAuditStatus = 'pass' | 'block' | 'defer';

export interface MergeGateAuditCheck {
  id: string;
  status: MergeGateAuditStatus;
  summary: string;
  details?: Record<string, unknown>;
}

export interface MergeGateAuditReport {
  overallStatus: MergeGateAuditStatus;
  generatedAt: string;
  workspaceDir: string;
  stateDir: string;
  checks: MergeGateAuditCheck[];
  counts: {
    pass: number;
    block: number;
    defer: number;
  };
}

function isWithinDir(parentDir: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentDir), path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function computeOverallStatus(checks: MergeGateAuditCheck[]): MergeGateAuditStatus {
  if (checks.some((check) => check.status === 'block')) {
    return 'block';
  }
  if (checks.some((check) => check.status === 'defer')) {
    return 'defer';
  }
  return 'pass';
}

function countStatuses(checks: MergeGateAuditCheck[]): MergeGateAuditReport['counts'] {
  const counts = { pass: 0, block: 0, defer: 0 };
  for (const check of checks) {
    counts[check.status] += 1;
  }
  return counts;
}

function auditPainFlagPathContract(workspaceDir: string): MergeGateAuditCheck {
  const painFlagPath = resolvePdPath(workspaceDir, 'PAIN_FLAG');
  const expectedPath = path.join(path.resolve(workspaceDir), '.state', '.pain_flag');
  const normalizedPainFlagPath = path.normalize(painFlagPath);
  const normalizedExpectedPath = path.normalize(expectedPath);

  if (normalizedPainFlagPath !== normalizedExpectedPath) {
    return {
      id: 'pain_flag_path_contract',
      status: 'block',
      summary: 'Canonical pain flag path does not resolve under workspace/.state/.pain_flag.',
      details: {
        resolvedPath: normalizedPainFlagPath,
        expectedPath: normalizedExpectedPath,
      },
    };
  }

  return {
    id: 'pain_flag_path_contract',
    status: 'pass',
    summary: 'Canonical pain flag path resolves to workspace/.state/.pain_flag.',
    details: {
      resolvedPath: normalizedPainFlagPath,
    },
  };
}

function auditQueuePathContract(workspaceDir: string): MergeGateAuditCheck {
  const queuePath = resolvePdPath(workspaceDir, 'EVOLUTION_QUEUE');
  const expectedPath = path.join(path.resolve(workspaceDir), '.state', 'evolution_queue.json');
  const normalizedQueuePath = path.normalize(queuePath);
  const normalizedExpectedPath = path.normalize(expectedPath);

  if (normalizedQueuePath !== normalizedExpectedPath) {
    return {
      id: 'queue_path_contract',
      status: 'block',
      summary: 'Canonical evolution queue path does not resolve under workspace/.state/evolution_queue.json.',
      details: {
        resolvedPath: normalizedQueuePath,
        expectedPath: normalizedExpectedPath,
      },
    };
  }

  return {
    id: 'queue_path_contract',
    status: 'pass',
    summary: 'Canonical evolution queue path resolves to workspace/.state/evolution_queue.json.',
    details: {
      resolvedPath: normalizedQueuePath,
    },
  };
}

function auditRuntimeAdapterContract(): MergeGateAuditCheck {
  // Check the prototype surface only — do NOT instantiate the adapter.
  // Instantiation triggers cleanupStaleTempDirs() which scans os.tmpdir()
  // and could have side effects (removing stale temp dirs of other processes).
  const hasSurface =
    typeof OpenClawTrinityRuntimeAdapter.prototype.isRuntimeAvailable === 'function' &&
    typeof OpenClawTrinityRuntimeAdapter.prototype.getLastFailureReason === 'function';

  if (!hasSurface) {
    return {
      id: 'runtime_adapter_contract',
      status: 'block',
      summary: 'OpenClaw runtime adapter does not expose the expected contract-check surface.',
    };
  }

  return {
    id: 'runtime_adapter_contract',
    status: 'pass',
    summary: 'OpenClaw runtime adapter exposes the expected contract-check surface (isRuntimeAvailable, getLastFailureReason).',
  };
}

function auditDatasetArtifactIntegrity(workspaceDir: string): MergeGateAuditCheck {
  const records = listDatasetRecords(workspaceDir);
  if (records.length === 0) {
    return {
      id: 'dataset_artifact_integrity',
      status: 'defer',
      summary: 'No dataset records found. Dataset artifact integrity cannot be verified yet.',
    };
  }

  const missingArtifacts: string[] = [];
  const outOfWorkspaceArtifacts: string[] = [];

  for (const record of records) {
    if (!fs.existsSync(record.artifactPath)) {
      missingArtifacts.push(record.sampleFingerprint);
      continue;
    }
    if (!isWithinDir(workspaceDir, record.artifactPath)) {
      outOfWorkspaceArtifacts.push(record.sampleFingerprint);
    }
  }

  if (missingArtifacts.length > 0 || outOfWorkspaceArtifacts.length > 0) {
    return {
      id: 'dataset_artifact_integrity',
      status: 'block',
      summary: 'Dataset registry points to missing artifacts or paths outside the workspace boundary.',
      details: {
        recordCount: records.length,
        missingArtifacts,
        outOfWorkspaceArtifacts,
      },
    };
  }

  return {
    id: 'dataset_artifact_integrity',
    status: 'pass',
    summary: 'All dataset artifacts exist and remain inside the workspace boundary.',
    details: {
      recordCount: records.length,
    },
  };
}

function auditArtifactLineageIntegrity(workspaceDir: string): MergeGateAuditCheck {
  const records = listArtifactLineageRecords(workspaceDir);
  if (records.length === 0) {
    return {
      id: 'artifact_lineage_integrity',
      status: 'defer',
      summary: 'No artifact lineage records found. Lineage integrity cannot be verified yet.',
    };
  }

  const missingStoragePaths: string[] = [];
  const outOfWorkspaceStoragePaths: string[] = [];

  for (const record of records) {
    if (!fs.existsSync(record.storagePath)) {
      missingStoragePaths.push(record.artifactId);
      continue;
    }
    if (!isWithinDir(workspaceDir, record.storagePath)) {
      outOfWorkspaceStoragePaths.push(record.artifactId);
    }
  }

  if (missingStoragePaths.length > 0 || outOfWorkspaceStoragePaths.length > 0) {
    return {
      id: 'artifact_lineage_integrity',
      status: 'block',
      summary: 'Artifact lineage points to missing files or paths outside the workspace boundary.',
      details: {
        recordCount: records.length,
        missingStoragePaths,
        outOfWorkspaceStoragePaths,
      },
    };
  }

  return {
    id: 'artifact_lineage_integrity',
    status: 'pass',
    summary: 'All lineage storage paths exist and remain inside the workspace boundary.',
    details: {
      recordCount: records.length,
    },
  };
}

function auditOrpoExportIntegrity(workspaceDir: string): MergeGateAuditCheck {
  const exports = listExports(workspaceDir);
  if (exports.length === 0) {
    return {
      id: 'orpo_export_integrity',
      status: 'defer',
      summary: 'No ORPO exports found. Export integrity cannot be verified yet.',
    };
  }

  const invalidExportIds: string[] = [];
  const missingExportFiles: string[] = [];

  for (const manifest of exports) {
    if (!fs.existsSync(manifest.exportPath)) {
      missingExportFiles.push(manifest.exportId);
      continue;
    }

    const integrity = verifyExportIntegrity(workspaceDir, manifest.exportId);
    if (!integrity || !integrity.valid) {
      invalidExportIds.push(manifest.exportId);
    }
  }

  if (invalidExportIds.length > 0 || missingExportFiles.length > 0) {
    return {
      id: 'orpo_export_integrity',
      status: 'block',
      summary: 'ORPO export manifests or payloads failed integrity verification.',
      details: {
        exportCount: exports.length,
        invalidExportIds,
        missingExportFiles,
      },
    };
  }

  return {
    id: 'orpo_export_integrity',
    status: 'pass',
    summary: 'All ORPO exports pass manifest fingerprint verification.',
    details: {
      exportCount: exports.length,
    },
  };
}

function isReplayReportShape(value: unknown): value is ReplayReport {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const report = value as Partial<ReplayReport>;
  return (
    typeof report.overallDecision === 'string' &&
    typeof report.generatedAt === 'string' &&
    typeof report.implementationId === 'string' &&
    report.evidenceSummary !== undefined &&
    Array.isArray(report.blockers)
  );
}

/**
 * Collect all replay report file paths under the implementations directory.
 */
function collectReplayReportPaths(stateDir: string): string[] {
  const implementationsRoot = path.join(stateDir, 'principles', 'implementations');
  if (!fs.existsSync(implementationsRoot)) return [];

  const implementationIds = fs
    .readdirSync(implementationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const paths: string[] = [];
  for (const id of implementationIds) {
    const replaysDir = path.join(getImplementationAssetRoot(stateDir, id), 'replays');
    if (!fs.existsSync(replaysDir)) continue;

    const files = fs
      .readdirSync(replaysDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.join(replaysDir, entry.name));
    paths.push(...files);
  }
  return paths;
}

/**
 * Result of validating a single replay report file.
 */
type ReplayValidationCategory =
  | 'io_error'
  | 'malformed'
  | 'missing_evidence_summary'
  | 'unsupported_pass'
  | 'empty_needs_review'
  | 'valid';

/**
 * Check if the parsed replay report has a valid evidenceSummary shape.
 */
function hasValidEvidenceSummary(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object') return false;
  const report = parsed as Partial<ReplayReport>;
  const summary = report.evidenceSummary;
  if (!summary) return false;
  if (typeof (summary as Partial<ReplayReport['evidenceSummary']>).evidenceStatus !== 'string') {
    return false;
  }
  return typeof (summary as Partial<ReplayReport['evidenceSummary']>).totalSamples === 'number';
}

/**
 * Validate a single replay report file and return its category.
 */
function validateSingleReplayReport(reportPath: string): ReplayValidationCategory {
  let rawContent: string;
  try {
    rawContent = fs.readFileSync(reportPath, 'utf-8');
  } catch {
    return 'io_error';
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return 'malformed';
  }

  if (!isReplayReportShape(parsed)) {
    return 'malformed';
  }

  if (!hasValidEvidenceSummary(parsed)) {
    return 'missing_evidence_summary';
  }

  const evidenceSummary = parsed.evidenceSummary;
  if (parsed.overallDecision === 'pass' && evidenceSummary.totalSamples === 0) {
    return 'unsupported_pass';
  }

  if (parsed.overallDecision === 'needs-review' && evidenceSummary.totalSamples === 0) {
    return 'empty_needs_review';
  }

  return 'valid';
}

/**
 * Categorize all replay report files by validation outcome.
 */
interface ReplayValidationResults {
  ioErrorReports: string[];
  malformedReports: string[];
  missingEvidenceSummary: string[];
  unsupportedPassingReports: string[];
  emptyEvidenceNeedsReview: string[];
}

function categorizeReplayReports(reportPaths: string[]): ReplayValidationResults {
  const results: ReplayValidationResults = {
    ioErrorReports: [],
    malformedReports: [],
    missingEvidenceSummary: [],
    unsupportedPassingReports: [],
    emptyEvidenceNeedsReview: [],
  };

  for (const reportPath of reportPaths) {
    const category = validateSingleReplayReport(reportPath);
    switch (category) {
      case 'io_error':
        results.ioErrorReports.push(reportPath);
        break;
      case 'malformed':
        results.malformedReports.push(reportPath);
        break;
      case 'missing_evidence_summary':
        results.missingEvidenceSummary.push(reportPath);
        break;
      case 'unsupported_pass':
        results.unsupportedPassingReports.push(reportPath);
        break;
      case 'empty_needs_review':
        results.emptyEvidenceNeedsReview.push(reportPath);
        break;
      // 'valid' — no action needed
    }
  }

  return results;
}

function hasValidationFailures(results: ReplayValidationResults): boolean {
  return (
    results.malformedReports.length > 0 ||
    results.ioErrorReports.length > 0 ||
    results.missingEvidenceSummary.length > 0 ||
    results.unsupportedPassingReports.length > 0 ||
    results.emptyEvidenceNeedsReview.length > 0
  );
}

function auditReplayEvidenceIntegrity(stateDir: string): MergeGateAuditCheck {
  const replayReportPaths = collectReplayReportPaths(stateDir);

  if (replayReportPaths.length === 0) {
    return {
      id: 'replay_evidence_integrity',
      status: 'defer',
      summary: 'No replay reports found. Replay evidence integrity cannot be verified yet.',
    };
  }

  const results = categorizeReplayReports(replayReportPaths);

  if (hasValidationFailures(results)) {
    return {
      id: 'replay_evidence_integrity',
      status: 'block',
      summary: 'Replay reports contain malformed payloads, I/O errors, empty-evidence passes, or zero-evidence needs-review verdicts.',
      details: {
        reportCount: replayReportPaths.length,
        ...results,
      },
    };
  }

  return {
    id: 'replay_evidence_integrity',
    status: 'pass',
    summary: 'Replay reports include evidence summaries and no empty-evidence unsafe verdicts.',
    details: {
      reportCount: replayReportPaths.length,
    },
  };
}

export function runMergeGateAudit(workspaceDir: string, stateDir: string): MergeGateAuditReport {
  const checks: MergeGateAuditCheck[] = [
    auditPainFlagPathContract(workspaceDir),
    auditQueuePathContract(workspaceDir),
    auditRuntimeAdapterContract(),
    auditDatasetArtifactIntegrity(workspaceDir),
    auditArtifactLineageIntegrity(workspaceDir),
    auditOrpoExportIntegrity(workspaceDir),
    auditReplayEvidenceIntegrity(stateDir),
  ];

  return {
    overallStatus: computeOverallStatus(checks),
    generatedAt: new Date().toISOString(),
    workspaceDir: path.resolve(workspaceDir),
    stateDir: path.resolve(stateDir),
    checks,
    counts: countStatuses(checks),
  };
}

export function formatMergeGateAuditReport(report: MergeGateAuditReport): string {
  const lines: string[] = [
    '=== Merge Gate Audit ===',
    `Overall Status: ${report.overallStatus.toUpperCase()}`,
    `Generated At: ${report.generatedAt}`,
    `Workspace: ${report.workspaceDir}`,
    `State Dir: ${report.stateDir}`,
    `Counts: pass=${report.counts.pass}, block=${report.counts.block}, defer=${report.counts.defer}`,
    '',
  ];

  for (const check of report.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.id}: ${check.summary}`);
  }

  return `${lines.join('\n')}\n`;
}
