import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReplayEngine } from '../../src/core/replay-engine.js';
import { createImplementationAssetDir, getImplementationAssetRoot } from '../../src/core/code-implementation-storage.js';
import { safeRmDir } from '../test-utils.js';

describe('ReplayEngine', () => {
  let tempDir: string;
  let workspaceDir: string;
  let stateDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-replay-engine-'));
    workspaceDir = path.join(tempDir, 'workspace');
    stateDir = path.join(tempDir, '.state');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    safeRmDir(tempDir);
  });

  it('listReports returns empty array when no replays exist', () => {
    const engine = new ReplayEngine(workspaceDir, stateDir);
    expect(engine.listReports('IMPL-1')).toEqual([]);
  });

  it('listReports returns persisted replay reports sorted by name descending', () => {
    createImplementationAssetDir(stateDir, 'IMPL-1', '1.0.0');
    const replayDir = path.join(getImplementationAssetRoot(stateDir, 'IMPL-1'), 'replays');
    fs.mkdirSync(replayDir, { recursive: true });

    const report1 = {
      implementationId: 'IMPL-1',
      generatedAt: '2026-04-08T00:00:00.000Z',
      overallDecision: 'needs-review',
      blockers: [],
      sampleFingerprints: [],
      replayResults: {
        painNegative: { total: 0, passed: 0, failed: 0, details: [] },
        successPositive: { total: 0, passed: 0, failed: 0, details: [] },
        principleAnchor: { total: 0, passed: 0, failed: 0, details: [] },
      },
      evidenceSummary: {
        evidenceStatus: 'empty',
        totalSamples: 0,
        classifiedCounts: { painNegative: 0, successPositive: 0, principleAnchor: 0 },
      },
    };

    const report2 = {
      ...report1,
      generatedAt: '2026-04-09T00:00:00.000Z',
      overallDecision: 'pass',
    };

    fs.writeFileSync(path.join(replayDir, '2026-04-08T00-00-00-000Z.json'), JSON.stringify(report1, null, 2), 'utf-8');
    fs.writeFileSync(path.join(replayDir, '2026-04-09T00-00-00-000Z.json'), JSON.stringify(report2, null, 2), 'utf-8');

    const engine = new ReplayEngine(workspaceDir, stateDir);
    const reports = engine.listReports('IMPL-1');

    expect(reports).toHaveLength(2);
    expect(reports[0].overallDecision).toBe('pass');
    expect(reports[1].overallDecision).toBe('needs-review');
  });

  it('getLatestReport returns the most recent report', () => {
    createImplementationAssetDir(stateDir, 'IMPL-1', '1.0.0');
    const replayDir = path.join(getImplementationAssetRoot(stateDir, 'IMPL-1'), 'replays');
    fs.mkdirSync(replayDir, { recursive: true });

    const report = {
      implementationId: 'IMPL-1',
      generatedAt: '2026-04-08T00:00:00.000Z',
      overallDecision: 'pass',
      blockers: [],
      sampleFingerprints: [],
      replayResults: {
        painNegative: { total: 1, passed: 1, failed: 0, details: [] },
        successPositive: { total: 0, passed: 0, failed: 0, details: [] },
        principleAnchor: { total: 0, passed: 0, failed: 0, details: [] },
      },
      evidenceSummary: {
        evidenceStatus: 'observed',
        totalSamples: 1,
        classifiedCounts: { painNegative: 1, successPositive: 0, principleAnchor: 0 },
      },
    };

    fs.writeFileSync(path.join(replayDir, '2026-04-08T00-00-00-000Z.json'), JSON.stringify(report, null, 2), 'utf-8');

    const engine = new ReplayEngine(workspaceDir, stateDir);
    const latest = engine.getLatestReport('IMPL-1');

    expect(latest).not.toBeNull();
    expect(latest!.overallDecision).toBe('pass');
  });

  it('getLatestReport returns null when no reports exist', () => {
    const engine = new ReplayEngine(workspaceDir, stateDir);
    expect(engine.getLatestReport('IMPL-1')).toBeNull();
  });

  it('hasPassingReport returns true when a passing report exists', () => {
    createImplementationAssetDir(stateDir, 'IMPL-1', '1.0.0');
    const replayDir = path.join(getImplementationAssetRoot(stateDir, 'IMPL-1'), 'replays');
    fs.mkdirSync(replayDir, { recursive: true });

    const report = {
      implementationId: 'IMPL-1',
      generatedAt: '2026-04-08T00:00:00.000Z',
      overallDecision: 'pass',
      blockers: [],
      sampleFingerprints: [],
      replayResults: {
        painNegative: { total: 1, passed: 1, failed: 0, details: [] },
        successPositive: { total: 0, passed: 0, failed: 0, details: [] },
        principleAnchor: { total: 0, passed: 0, failed: 0, details: [] },
      },
      evidenceSummary: {
        evidenceStatus: 'observed',
        totalSamples: 1,
        classifiedCounts: { painNegative: 1, successPositive: 0, principleAnchor: 0 },
      },
    };

    fs.writeFileSync(path.join(replayDir, '2026-04-08T00-00-00-000Z.json'), JSON.stringify(report, null, 2), 'utf-8');

    const engine = new ReplayEngine(workspaceDir, stateDir);
    expect(engine.hasPassingReport('IMPL-1')).toBe(true);
  });

  it('hasPassingReport returns false when no passing report exists', () => {
    createImplementationAssetDir(stateDir, 'IMPL-1', '1.0.0');
    const replayDir = path.join(getImplementationAssetRoot(stateDir, 'IMPL-1'), 'replays');
    fs.mkdirSync(replayDir, { recursive: true });

    const report = {
      implementationId: 'IMPL-1',
      generatedAt: '2026-04-08T00:00:00.000Z',
      overallDecision: 'needs-review',
      blockers: ['NO REPLAY EVIDENCE'],
      sampleFingerprints: [],
      replayResults: {
        painNegative: { total: 0, passed: 0, failed: 0, details: [] },
        successPositive: { total: 0, passed: 0, failed: 0, details: [] },
        principleAnchor: { total: 0, passed: 0, failed: 0, details: [] },
      },
      evidenceSummary: {
        evidenceStatus: 'empty',
        totalSamples: 0,
        classifiedCounts: { painNegative: 0, successPositive: 0, principleAnchor: 0 },
      },
    };

    fs.writeFileSync(path.join(replayDir, '2026-04-08T00-00-00-000Z.json'), JSON.stringify(report, null, 2), 'utf-8');

    const engine = new ReplayEngine(workspaceDir, stateDir);
    expect(engine.hasPassingReport('IMPL-1')).toBe(false);
  });
});
