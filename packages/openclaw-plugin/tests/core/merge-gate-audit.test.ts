import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  formatMergeGateAuditReport,
  runMergeGateAudit,
} from '../../src/core/merge-gate-audit.js';
import { createImplementationAssetDir, getImplementationAssetRoot } from '../../src/core/code-implementation-storage.js';
import { safeRmDir } from '../test-utils.js';

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

  it('returns defer when audit surfaces are not populated yet', () => {
    const report = runMergeGateAudit(workspaceDir, stateDir);

    expect(report.overallStatus).toBe('defer');
    expect(report.checks.find((check) => check.id === 'pain_flag_path_contract')?.status).toBe('pass');
    expect(report.checks.find((check) => check.id === 'queue_path_contract')?.status).toBe('pass');
    expect(report.checks.find((check) => check.id === 'replay_evidence_integrity')?.status).toBe('defer');
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
        evidenceSummary: { evidenceStatus: 'observed' },
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
