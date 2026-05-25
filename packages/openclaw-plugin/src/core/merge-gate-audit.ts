import * as fs from 'fs';
import * as path from 'path';
import { getImplementationAssetRoot } from './code-implementation-storage.js';
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

type ReplayValidationCategory =
  | 'io_error'
  | 'malformed'
  | 'missing_evidence_summary'
  | 'unsupported_pass'
  | 'empty_needs_review'
  | 'valid';

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
