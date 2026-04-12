import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  formatMergeGateAuditReport,
  runMergeGateAudit,
} from '../../src/core/merge-gate-audit.js';
import type { NocturnalArtifact } from '../../src/core/nocturnal-arbiter.js';
import {
  registerSample,
  updateReviewStatus,
} from '../../src/core/nocturnal-dataset.js';
import { appendArtifactLineageRecord } from '../../src/core/nocturnal-artifact-lineage.js';
import { exportORPOSamples } from '../../src/core/nocturnal-export.js';
import { createImplementationAssetDir, getImplementationAssetRoot } from '../../src/core/code-implementation-storage.js';
import { safeRmDir } from '../test-utils.js';

function makeArtifact(overrides: Partial<NocturnalArtifact> = {}): NocturnalArtifact {
  return {
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    principleId: 'T-08',
    sourceSnapshotRef: 'snapshot-1',
    badDecision: 'Retried without checking state',
    betterDecision: 'Inspect state before retrying',
    rationale: 'Evidence first.',
    createdAt: '2026-04-12T09:00:00.000Z',
    ...overrides,
  };
}

describe('merge-gate-audit', () => {
  let tempDir: string;
  let workspaceDir: string;
  let stateDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-merge-gate-audit-'));
    workspaceDir = path.join(tempDir, 'workspace');
    stateDir = path.join(tempDir, '.state');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    safeRmDir(tempDir);
  });

  function registerApprovedArtifact(artifactId = 'artifact-1'): string {
    const artifact = makeArtifact({ artifactId });
    const artifactPath = path.join(
      workspaceDir,
      '.state',
      'nocturnal',
      'samples',
      `${artifactId}.json`,
    );
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf-8');

    const record = registerSample(workspaceDir, artifact, artifactPath, 'gpt-4').record;
    updateReviewStatus(
      workspaceDir,
      record.sampleFingerprint,
      'approved_for_training',
      'approved for merge gate audit',
    );

    appendArtifactLineageRecord(workspaceDir, {
      artifactKind: 'behavioral-sample',
      artifactId: record.artifactId,
      principleId: record.principleId,
      ruleId: null,
      sessionId: record.sessionId,
      sourceSnapshotRef: record.sourceSnapshotRef,
      sourcePainIds: ['pain-1'],
      sourceGateBlockIds: ['gate-1'],
      storagePath: artifactPath,
      implementationId: null,
      createdAt: record.createdAt,
    });

    return record.sampleFingerprint;
  }

  it('returns defer when audit surfaces are not populated yet', () => {
    const report = runMergeGateAudit(workspaceDir, stateDir);

    expect(report.overallStatus).toBe('defer');
    expect(report.checks.find((check) => check.id === 'pain_flag_path_contract')?.status).toBe('pass');
    expect(report.checks.find((check) => check.id === 'queue_path_contract')?.status).toBe('pass');
    expect(report.checks.find((check) => check.id === 'runtime_adapter_contract')?.status).toBe('pass');
    expect(report.counts.defer).toBeGreaterThan(0);
  });

  it('blocks malformed replay reports that claim pass without evidence', () => {
    createImplementationAssetDir(stateDir, 'IMPL-1', '1.0.0');
    const replayDir = path.join(getImplementationAssetRoot(stateDir, 'IMPL-1'), 'replays');
    fs.mkdirSync(replayDir, { recursive: true });
    fs.writeFileSync(
      path.join(replayDir, 'bad-report.json'),
      JSON.stringify(
        {
          overallDecision: 'pass',
          blockers: [],
          generatedAt: '2026-04-12T09:00:00.000Z',
          implementationId: 'IMPL-1',
          evidenceSummary: {
            evidenceStatus: 'empty',
            totalSamples: 0,
            classifiedCounts: {
              painNegative: 0,
              successPositive: 0,
              principleAnchor: 0,
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const report = runMergeGateAudit(workspaceDir, stateDir);
    const replayCheck = report.checks.find((check) => check.id === 'replay_evidence_integrity');

    expect(report.overallStatus).toBe('block');
    expect(replayCheck?.status).toBe('block');
  });

  it('passes populated dataset, lineage, export, and replay evidence surfaces', () => {
    registerApprovedArtifact('artifact-pass');
    const exportResult = exportORPOSamples(workspaceDir, 'gpt-4');
    expect(exportResult.success).toBe(true);

    createImplementationAssetDir(stateDir, 'IMPL-1', '1.0.0');
    const replayDir = path.join(getImplementationAssetRoot(stateDir, 'IMPL-1'), 'replays');
    fs.mkdirSync(replayDir, { recursive: true });
    fs.writeFileSync(
      path.join(replayDir, 'good-report.json'),
      JSON.stringify(
        {
          overallDecision: 'pass',
          replayResults: {
            painNegative: { total: 1, passed: 1, failed: 0, details: [] },
            successPositive: { total: 0, passed: 0, failed: 0, details: [] },
            principleAnchor: { total: 0, passed: 0, failed: 0, details: [] },
          },
          blockers: [],
          generatedAt: '2026-04-12T09:00:00.000Z',
          implementationId: 'IMPL-1',
          sampleFingerprints: ['sample-1'],
          evidenceSummary: {
            evidenceStatus: 'observed',
            totalSamples: 1,
            classifiedCounts: {
              painNegative: 1,
              successPositive: 0,
              principleAnchor: 0,
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const report = runMergeGateAudit(workspaceDir, stateDir);

    expect(report.overallStatus).toBe('pass');
    expect(report.counts.block).toBe(0);
    expect(report.counts.defer).toBe(0);
    expect(formatMergeGateAuditReport(report)).toContain('Overall Status: PASS');
  });

  it('blocks when dataset artifacts are missing', () => {
    const artifactPath = path.join(
      workspaceDir,
      '.state',
      'nocturnal',
      'samples',
      'artifact-missing.json',
    );
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    const artifact = makeArtifact({ artifactId: 'artifact-missing' });
    fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf-8');

    const record = registerSample(workspaceDir, artifact, artifactPath, 'gpt-4').record;
    updateReviewStatus(workspaceDir, record.sampleFingerprint, 'approved_for_training', 'approved');

    // Append lineage pointing to a real file (so lineage passes)
    appendArtifactLineageRecord(workspaceDir, {
      artifactKind: 'behavioral-sample',
      artifactId: record.artifactId,
      principleId: record.principleId,
      ruleId: null,
      sessionId: record.sessionId,
      sourceSnapshotRef: record.sourceSnapshotRef,
      sourcePainIds: [],
      sourceGateBlockIds: [],
      storagePath: artifactPath,
      implementationId: null,
      createdAt: record.createdAt,
    });

    // Delete the artifact to simulate a missing file
    fs.unlinkSync(artifactPath);

    const report = runMergeGateAudit(workspaceDir, stateDir);
    const datasetCheck = report.checks.find((c) => c.id === 'dataset_artifact_integrity');

    expect(report.overallStatus).toBe('block');
    expect(datasetCheck?.status).toBe('block');
  });

  it('blocks when artifact lineage storage paths are missing', () => {
    const badPath = path.join(workspaceDir, '.state', 'nocturnal', 'samples', 'nonexistent.json');
    appendArtifactLineageRecord(workspaceDir, {
      artifactKind: 'behavioral-sample',
      artifactId: 'lineage-missing',
      principleId: 'T-08',
      ruleId: null,
      sessionId: 'session-1',
      sourceSnapshotRef: 'snap-1',
      sourcePainIds: [],
      sourceGateBlockIds: [],
      storagePath: badPath,
      implementationId: null,
      createdAt: new Date().toISOString(),
    });

    const report = runMergeGateAudit(workspaceDir, stateDir);
    const lineageCheck = report.checks.find((c) => c.id === 'artifact_lineage_integrity');

    expect(report.overallStatus).toBe('block');
    expect(lineageCheck?.status).toBe('block');
  });

  it('blocks when replay reports are malformed', () => {
    createImplementationAssetDir(stateDir, 'IMPL-BAD', '1.0.0');
    const replayDir = path.join(getImplementationAssetRoot(stateDir, 'IMPL-BAD'), 'replays');
    fs.mkdirSync(replayDir, { recursive: true });
    fs.writeFileSync(
      path.join(replayDir, 'malformed.json'),
      '{bad json',
      'utf-8',
    );

    const report = runMergeGateAudit(workspaceDir, stateDir);
    const replayCheck = report.checks.find((c) => c.id === 'replay_evidence_integrity');
    const details = replayCheck?.details as Record<string, string[]> | undefined;

    expect(report.overallStatus).toBe('block');
    expect(replayCheck?.status).toBe('block');
    expect(details?.malformedReports).toHaveLength(1);
  });

  it('blocks when replay reports have invalid evidenceSummary shape', () => {
    createImplementationAssetDir(stateDir, 'IMPL-NOEVID', '1.0.0');
    const replayDir = path.join(getImplementationAssetRoot(stateDir, 'IMPL-NOEVID'), 'replays');
    fs.mkdirSync(replayDir, { recursive: true });
    fs.writeFileSync(
      path.join(replayDir, 'bad-evidence.json'),
      JSON.stringify({
        overallDecision: 'pass',
        blockers: [],
        generatedAt: '2026-04-12T09:00:00.000Z',
        implementationId: 'IMPL-NOEVID',
        evidenceSummary: { evidenceStatus: 'observed' }, // missing totalSamples
      }),
      'utf-8',
    );

    const report = runMergeGateAudit(workspaceDir, stateDir);
    const replayCheck = report.checks.find((c) => c.id === 'replay_evidence_integrity');
    const details = replayCheck?.details as Record<string, string[]> | undefined;

    expect(report.overallStatus).toBe('block');
    expect(replayCheck?.status).toBe('block');
    expect(details?.missingEvidenceSummary).toHaveLength(1);
  });
});
