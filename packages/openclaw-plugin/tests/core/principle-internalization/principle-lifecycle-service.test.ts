import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PrincipleLifecycleService } from '../../../src/core/principle-internalization/principle-lifecycle-service.js';
import { appendCandidateArtifactLineageRecord, listArtifactLineageRecords } from '../../../src/core/nocturnal-artifact-lineage.js';
import { getImplementationAssetRoot } from '../../../src/core/code-implementation-storage.js';
import { loadLedger, saveLedger, type LedgerPrinciple, type LedgerRule } from '../../../src/core/principle-tree-ledger.js';
import type { Implementation } from '../../../src/types/principle-tree-schema.js';
import type { ReplayReport } from '../../../src/core/replay-engine.js';
import { createTestContext, safeRmDir } from '../../test-utils.js';

function makePrinciple(overrides: Partial<LedgerPrinciple> = {}): LedgerPrinciple {
  return {
    id: 'P-001',
    version: 1,
    text: 'Prefer cheap safe internalization',
    triggerPattern: 'write',
    action: 'prefer the cheapest viable fix',
    status: 'active',
    priority: 'P1',
    scope: 'general',
    evaluability: 'weak_heuristic',
    valueScore: 0,
    adherenceRate: 0,
    painPreventedCount: 0,
    derivedFromPainIds: [],
    ruleIds: ['R-001'],
    conflictsWithPrincipleIds: [],
    createdAt: '2026-04-08T00:00:00.000Z',
    updatedAt: '2026-04-08T00:00:00.000Z',
    ...overrides,
  };
}

function makeRule(overrides: Partial<LedgerRule> = {}): LedgerRule {
  return {
    id: 'R-001',
    version: 1,
    name: 'Coach cautious writes',
    description: 'Encourage safer writes before escalating to hard boundaries.',
    type: 'skill',
    triggerCondition: 'tool=write',
    enforcement: 'warn',
    action: 'warn before risky write',
    principleId: 'P-001',
    status: 'implemented',
    coverageRate: 0,
    falsePositiveRate: 0,
    implementationIds: ['IMPL-001'],
    createdAt: '2026-04-08T00:00:00.000Z',
    updatedAt: '2026-04-08T00:00:00.000Z',
    ...overrides,
  };
}

function makeImplementation(overrides: Partial<Implementation> = {}): Implementation {
  return {
    id: 'IMPL-001',
    ruleId: 'R-001',
    type: 'code',
    path: 'implementations/IMPL-001/entry.js',
    version: 'v1',
    coversCondition: 'risky write',
    coveragePercentage: 60,
    lifecycleState: 'candidate',
    createdAt: '2026-04-08T00:00:00.000Z',
    updatedAt: '2026-04-08T00:00:00.000Z',
    ...overrides,
  };
}

function makeReplayReport(overrides: Partial<ReplayReport> = {}): ReplayReport {
  return {
    implementationId: 'IMPL-001',
    generatedAt: '2026-04-08T00:00:00.000Z',
    overallDecision: 'needs-review',
    blockers: [],
    sampleFingerprints: ['sample-1', 'sample-2', 'sample-3'],
    replayResults: {
      painNegative: { total: 2, passed: 2, failed: 0, details: [] },
      successPositive: { total: 2, passed: 1, failed: 1, details: [] },
      principleAnchor: { total: 1, passed: 1, failed: 0, details: [] },
    },
    ...overrides,
  };
}

describe('principle-lifecycle-service', () => {
  let tempDir: string;
  let workspaceDir: string;
  let stateDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-lifecycle-service-'));
    workspaceDir = path.join(tempDir, 'workspace');
    stateDir = path.join(tempDir, 'state');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    safeRmDir(tempDir);
  });

  function seedWorkspace(): void {
    saveLedger(stateDir, {
      trainingStore: {
        'P-001': {
          principleId: 'P-001',
          evaluability: 'weak_heuristic',
          applicableOpportunityCount: 5,
          observedViolationCount: 2,
          complianceRate: 0.6,
          violationTrend: -0.2,
          generatedSampleCount: 0,
          approvedSampleCount: 0,
          includedTrainRunIds: [],
          deployedCheckpointIds: [],
          internalizationStatus: 'internalized',
        },
      },
      tree: {
        principles: {
          'P-001': makePrinciple(),
        },
        rules: {
          'R-001': makeRule(),
        },
        implementations: {
          'IMPL-001': makeImplementation(),
        },
        metrics: {},
        lastUpdated: '2026-04-08T00:00:00.000Z',
      },
    });

    const replayDir = path.join(getImplementationAssetRoot(stateDir, 'IMPL-001'), 'replays');
    fs.mkdirSync(replayDir, { recursive: true });
    fs.writeFileSync(
      path.join(replayDir, '2026-04-08T00-00-00-000Z.json'),
      JSON.stringify(makeReplayReport(), null, 2),
      'utf-8',
    );

    appendCandidateArtifactLineageRecord(workspaceDir, {
      artifactId: 'artifact-1',
      principleId: 'P-001',
      ruleId: 'R-001',
      sessionId: 'session-1',
      sourceSnapshotRef: 'snapshot-1',
      sourcePainIds: ['pain-1'],
      sourceGateBlockIds: ['gate-1'],
      storagePath: getImplementationAssetRoot(stateDir, 'IMPL-001'),
      implementationId: 'IMPL-001',
      createdAt: '2026-04-08T00:00:00.000Z',
    });
  }

  it('recomputes lifecycle metrics and exposes assessments plus route recommendations through one service', () => {
    seedWorkspace();
    const service = new PrincipleLifecycleService(workspaceDir, stateDir);

    const recomputed = service.recomputeAll();
    const assessments = service.listAssessments();
    const recommendations = service.listRouteRecommendations();
    const ledger = loadLedger(stateDir);

    expect(recomputed).toHaveLength(1);
    expect(recomputed[0].routeRecommendation.route).toBe('skill');
    expect(assessments).toHaveLength(1);
    expect(assessments[0].deprecatedReadiness.status).toBe('not-ready');
    expect(recommendations).toEqual([assessments[0].routeRecommendation]);
    expect(ledger.tree.rules['R-001'].coverageRate).toBeGreaterThan(0);
    expect(ledger.tree.principles['P-001'].adherenceRate).toBeGreaterThan(0);
    expect(ledger.tree.metrics['P-001']).toBeDefined();
  });

  it('surfaces the lifecycle service from WorkspaceContext without breaking existing consumers', () => {
    seedWorkspace();
    const context = createTestContext({ workspaceDir, stateDir });

    expect(context.principleLifecycle).toBeInstanceOf(PrincipleLifecycleService);
    expect(context.principleLifecycle.listAssessments()).toHaveLength(1);
    expect(context.getActivePrincipleSubtrees()).toEqual([]);
  });

  it('keeps replay classifications behavioral-only and preserves candidate lineage semantics', () => {
    seedWorkspace();
    const service = new PrincipleLifecycleService(workspaceDir, stateDir);

    const assessments = service.listAssessments();
    const readModel = service.buildReadModel();
    const lineage = listArtifactLineageRecords(workspaceDir, 'rule-implementation-candidate');
    const latestReport = readModel.principles[0].rules[0].replayEvidence.latestReports[0];

    expect(assessments[0].routeRecommendation.route).toBe('skill');
    expect(Object.keys(latestReport.replayResults)).toEqual([
      'painNegative',
      'successPositive',
      'principleAnchor',
    ]);
    expect(lineage).toHaveLength(1);
    expect(lineage[0]).toMatchObject({
      artifactKind: 'rule-implementation-candidate',
      sourcePainIds: ['pain-1'],
      sourceGateBlockIds: ['gate-1'],
      implementationId: 'IMPL-001',
    });
  });
});
