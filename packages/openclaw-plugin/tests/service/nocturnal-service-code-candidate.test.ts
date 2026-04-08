import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { executeNocturnalReflection } from '../../src/service/nocturnal-service.js';
import { createNocturnalTrajectoryExtractor } from '../../src/core/nocturnal-trajectory-extractor.js';
import { getDatasetRecordByArtifactId, listDatasetRecords } from '../../src/core/nocturnal-dataset.js';
import { listArtifactLineageRecords } from '../../src/core/nocturnal-artifact-lineage.js';
import {
  listImplementationsForRule,
  saveLedger,
  type LedgerPrinciple,
  type LedgerRule,
} from '../../src/core/principle-tree-ledger.js';
import {
  getImplementationAssetRoot,
  loadEntrySource,
  loadManifest,
} from '../../src/core/code-implementation-storage.js';
import { TrajectoryDatabase, TrajectoryRegistry } from '../../src/core/trajectory.js';
import { clearSession, listSessions, seedSessionForTest } from '../../src/core/session-tracker.js';
import { safeRmDir } from '../test-utils.js';

function makePrinciple(overrides: Partial<LedgerPrinciple> = {}): LedgerPrinciple {
  return {
    id: 'T-08',
    version: 1,
    text: 'Pain as Signal',
    triggerPattern: 'pain',
    action: 'Diagnose before repeating failures',
    status: 'active',
    priority: 'P1',
    scope: 'general',
    evaluability: 'deterministic',
    valueScore: 0,
    adherenceRate: 80,
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
    name: 'Protect risky write',
    description: 'Require approval for risky write operations.',
    type: 'gate',
    triggerCondition: 'risky write',
    enforcement: 'block',
    action: 'require approval for risky write',
    principleId: 'T-08',
    status: 'implemented',
    coverageRate: 0,
    falsePositiveRate: 0,
    implementationIds: [],
    createdAt: '2026-04-08T00:00:00.000Z',
    updatedAt: '2026-04-08T00:00:00.000Z',
    ...overrides,
  };
}

function makeBehavioralArtifact(sessionId: string) {
  return {
    artifactId:
      sessionId === 'session-skip'
        ? '11111111-1111-4111-8111-111111111111'
        : sessionId === 'session-success'
          ? '22222222-2222-4222-8222-222222222222'
          : sessionId === 'session-invalid'
            ? '33333333-3333-4333-8333-333333333333'
            : '44444444-4444-4444-8444-444444444444',
    sessionId,
    principleId: 'T-08',
    sourceSnapshotRef: `snapshot-${sessionId}`,
    badDecision: 'Retried a failing write operation without first checking the approval requirements',
    betterDecision:
      'Read docs/gateblocks.md to confirm the approval requirements before retrying the write operation',
    rationale: 'Checking the gate guidance first prevents repeated blocked writes and preserves operator review boundaries',
    createdAt: '2026-04-08T00:00:00.000Z',
  };
}

describe('nocturnal-service code candidates', () => {
  let tempDir: string;
  let workspaceDir: string;
  let stateDir: string;
  let trajectory: TrajectoryDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-nocturnal-code-candidate-'));
    workspaceDir = path.join(tempDir, 'workspace');
    stateDir = path.join(tempDir, 'state');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    trajectory = new TrajectoryDatabase({ workspaceDir });
    createNocturnalTrajectoryExtractor(workspaceDir);

    for (const session of listSessions()) {
      clearSession(session.sessionId);
    }
  });

  afterEach(() => {
    try {
      trajectory.dispose();
    } catch {
      // Best effort cleanup.
    }
    try {
      TrajectoryRegistry.dispose(workspaceDir);
    } catch {
      // Best effort cleanup.
    }
    safeRmDir(tempDir);
  });

  function makeIdleResult() {
    return {
      isIdle: true,
      mostRecentActivityAt: Date.now() - 2 * 60 * 60 * 1000,
      idleForMs: 2 * 60 * 60 * 1000,
      userActiveSessions: 0,
      abandonedSessionIds: [],
      trajectoryGuardrailConfirmsIdle: true,
      reason: 'test override',
    };
  }

  function seedSession(sessionId: string): void {
    const startedAt = new Date().toISOString();
    trajectory.recordSession({ sessionId, startedAt });
    for (let i = 0; i < 2; i += 1) {
      trajectory.recordToolCall({
        sessionId,
        toolName: 'write',
        outcome: 'failure',
        errorMessage: 'risky write blocked',
      });
    }
    trajectory.recordPainEvent({
      sessionId,
      source: 'gate',
      score: 75,
      reason: 'risky write requires approval',
    });
    trajectory.recordGateBlock({
      sessionId,
      toolName: 'write',
      reason: 'risky write requires approval',
      riskLevel: 'medium',
    });
    seedSessionForTest(sessionId, workspaceDir, new Date(startedAt).getTime());
  }

  function seedLedger(singleRule = true): void {
    saveLedger(stateDir, {
      trainingStore: {
        'T-08': {
          principleId: 'T-08',
          evaluability: 'deterministic',
          applicableOpportunityCount: 5,
          observedViolationCount: 3,
          complianceRate: 0.2,
          violationTrend: 1,
          generatedSampleCount: 0,
          approvedSampleCount: 0,
          includedTrainRunIds: [],
          deployedCheckpointIds: [],
          internalizationStatus: 'internalized',
        },
      },
      tree: {
        principles: {
          'T-08': makePrinciple({
            ruleIds: singleRule ? ['R-001'] : ['R-001', 'R-002'],
          }),
        },
        rules: singleRule
          ? {
              'R-001': makeRule(),
            }
          : {
              'R-001': makeRule(),
              'R-002': makeRule({
                id: 'R-002',
                name: 'Protect risky write',
                description: 'Require approval for risky write operations.',
                triggerCondition: 'risky write',
                action: 'require approval for risky write',
              }),
            },
        implementations: {},
        metrics: {},
        lastUpdated: '2026-04-08T00:00:00.000Z',
      },
    });
  }

  it('persists a behavioral artifact only when Artificer routing is skipped', () => {
    seedLedger(false);
    seedSession('session-skip');

    const result = executeNocturnalReflection(workspaceDir, stateDir, {
      idleCheckOverride: makeIdleResult(),
      skipReflector: true,
      reflectorOutputOverride: JSON.stringify(makeBehavioralArtifact('session-skip')),
    });

    expect(result.success).toBe(true);
    expect(result.diagnostics.persisted).toBe(true);
    expect(result.diagnostics.artificer.status).toBe('skipped');
    expect(result.diagnostics.artificer.reason).toBe('no_deterministic_rule');
    expect(listImplementationsForRule(stateDir, 'R-001')).toHaveLength(0);

    const datasetRecord = getDatasetRecordByArtifactId(
      workspaceDir,
      result.artifact!.artifactId
    );
    expect(datasetRecord?.classification).toBeNull();
  });

  it('persists a behavioral artifact and a candidate implementation when Artificer succeeds', () => {
    seedLedger(true);
    seedSession('session-success');

    const result = executeNocturnalReflection(workspaceDir, stateDir, {
      idleCheckOverride: makeIdleResult(),
      skipReflector: true,
      reflectorOutputOverride: JSON.stringify(makeBehavioralArtifact('session-success')),
    });

    expect(result.success).toBe(true);
    expect(result.diagnostics.artificer.status).toBe('persisted_candidate');

    const implementations = listImplementationsForRule(stateDir, 'R-001');
    expect(implementations).toHaveLength(1);
    expect(implementations[0].lifecycleState).toBe('candidate');

    const manifest = loadManifest(stateDir, implementations[0].id);
    expect(manifest?.lineage).toMatchObject({
      principleId: 'T-08',
      ruleId: 'R-001',
      sourceSessionId: 'session-success',
    });
    expect(loadEntrySource(stateDir, implementations[0].id)).toContain(
      'requireApproval'
    );
    expect(fs.existsSync(getImplementationAssetRoot(stateDir, implementations[0].id))).toBe(
      true
    );

    const lineage = listArtifactLineageRecords(workspaceDir);
    expect(
      lineage.some((record) => record.artifactKind === 'behavioral-sample')
    ).toBe(true);
    expect(
      lineage.some(
        (record) =>
          record.artifactKind === 'rule-implementation-candidate' &&
          record.implementationId === implementations[0].id
      )
    ).toBe(true);

    const datasetRecord = getDatasetRecordByArtifactId(
      workspaceDir,
      result.artifact!.artifactId
    );
    expect(datasetRecord?.classification).toBeNull();
  });

  it('preserves the behavioral artifact when Artificer validation fails', () => {
    seedLedger(true);
    seedSession('session-invalid');

    const result = executeNocturnalReflection(workspaceDir, stateDir, {
      idleCheckOverride: makeIdleResult(),
      skipReflector: true,
      reflectorOutputOverride: JSON.stringify(makeBehavioralArtifact('session-invalid')),
      artificerOutputOverride: JSON.stringify({
        ruleId: 'R-001',
        candidateSource:
          'export const meta = { name: "bad", version: "1", ruleId: "R-001", coversCondition: "bad" }; export function evaluate() { eval("1 + 1"); return { decision: "allow", matched: false, reason: "bad" }; }',
        helperUsage: [],
        expectedDecision: 'allow',
        rationale: 'bad candidate',
        lineage: {
          artifactKind: 'rule-implementation-candidate',
          sourceSnapshotRef: 'snapshot-1',
          sourcePainIds: ['pain:1'],
          sourceGateBlockIds: ['gate:1'],
        },
      }),
    });

    expect(result.success).toBe(true);
    expect(result.diagnostics.persisted).toBe(true);
    expect(result.diagnostics.artificer.status).toBe('validation_failed');
    expect(result.diagnostics.artificer.reason).toBe('validator_rejected');
    expect(listImplementationsForRule(stateDir, 'R-001')).toHaveLength(0);
  });

  it('cleans up the candidate when storage fails after ledger creation', () => {
    seedLedger(true);
    seedSession('session-storage-failure');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'principles'), 'not-a-directory', 'utf-8');

    const result = executeNocturnalReflection(workspaceDir, stateDir, {
      idleCheckOverride: makeIdleResult(),
      skipReflector: true,
      reflectorOutputOverride: JSON.stringify(
        makeBehavioralArtifact('session-storage-failure')
      ),
    });

    expect(result.success).toBe(true);
    expect(result.diagnostics.artificer.status).toBe('validation_failed');
    expect(result.diagnostics.artificer.reason).toBe('persistence_failed');
    expect(listImplementationsForRule(stateDir, 'R-001')).toHaveLength(0);
    expect(
      listArtifactLineageRecords(workspaceDir, 'rule-implementation-candidate')
    ).toHaveLength(0);
  });
});
