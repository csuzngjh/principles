import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReplayEngine } from '../../src/core/replay-engine.js';
import { TrajectoryDatabase, TrajectoryRegistry } from '../../src/core/trajectory.js';
import { registerSample } from '../../src/core/nocturnal-dataset.js';
import { createImplementationAssetDir, getImplementationAssetRoot } from '../../src/core/code-implementation-storage.js';
import { saveLedger, type LedgerPrinciple, type LedgerRule } from '../../src/core/principle-tree-ledger.js';
import type { Implementation } from '../../src/types/principle-tree-schema.js';
import { safeRmDir } from '../test-utils.js';

function makePrinciple(): LedgerPrinciple {
  return {
    id: 'P-1',
    version: 1,
    text: 'Protect risky writes without READY plans',
    triggerPattern: 'write',
    action: 'require approval before risky write',
    status: 'active',
    priority: 'P1',
    scope: 'general',
    evaluability: 'deterministic',
    valueScore: 0,
    adherenceRate: 0,
    painPreventedCount: 0,
    derivedFromPainIds: [],
    ruleIds: ['R-1'],
    conflictsWithPrincipleIds: [],
    createdAt: '2026-04-08T00:00:00.000Z',
    updatedAt: '2026-04-08T00:00:00.000Z',
  };
}

function makeRule(): LedgerRule {
  return {
    id: 'R-1',
    version: 1,
    name: 'Require approval for risky writes',
    description: 'Risky write operations without a READY plan need approval.',
    type: 'gate',
    triggerCondition: 'tool=write',
    enforcement: 'block',
    action: 'require approval for risky write',
    principleId: 'P-1',
    status: 'implemented',
    coverageRate: 0,
    falsePositiveRate: 0,
    implementationIds: ['IMPL-1'],
    createdAt: '2026-04-08T00:00:00.000Z',
    updatedAt: '2026-04-08T00:00:00.000Z',
  };
}

function makeImplementation(): Implementation {
  return {
    id: 'IMPL-1',
    ruleId: 'R-1',
    type: 'code',
    path: path.join('virtual', 'IMPL-1.js'),
    version: '1.0.0',
    coversCondition: 'risky write',
    coveragePercentage: 100,
    lifecycleState: 'candidate',
    createdAt: '2026-04-08T00:00:00.000Z',
    updatedAt: '2026-04-08T00:00:00.000Z',
  };
}

describe('ReplayEngine', () => {
  let tempDir: string;
  let workspaceDir: string;
  let stateDir: string;
  let trajectory: TrajectoryDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-replay-engine-'));
    workspaceDir = path.join(tempDir, 'workspace');
    stateDir = path.join(tempDir, '.state');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'PROFILE.json'),
      JSON.stringify({ risk_paths: ['src/**'] }, null, 2),
      'utf-8',
    );
    trajectory = new TrajectoryDatabase({ workspaceDir });
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

  function seedLedgerAndImplementation(): void {
    saveLedger(stateDir, {
      trainingStore: {
        'P-1': {
          principleId: 'P-1',
          evaluability: 'deterministic',
          applicableOpportunityCount: 1,
          observedViolationCount: 0,
          complianceRate: 1,
          violationTrend: 0,
          generatedSampleCount: 0,
          approvedSampleCount: 0,
          includedTrainRunIds: [],
          deployedCheckpointIds: [],
          internalizationStatus: 'internalized',
        },
      },
      tree: {
        principles: { 'P-1': makePrinciple() },
        rules: { 'R-1': makeRule() },
        implementations: { 'IMPL-1': makeImplementation() },
        metrics: {},
        lastUpdated: '2026-04-08T00:00:00.000Z',
      },
    });

    createImplementationAssetDir(stateDir, 'IMPL-1', '1.0.0', {
      entrySource: [
        'export const meta = {',
        '  name: "risky-write-guard",',
        '  version: "1.0.0",',
        '  ruleId: "R-1",',
        '  coversCondition: "risky write",',
        '};',
        'export function evaluate(input, helpers) {',
        "  if (helpers.isRiskPath() && helpers.getToolName() === 'write' && helpers.getPlanStatus() !== 'READY') {",
        "    return { decision: 'requireApproval', matched: true, reason: 'plan required' };",
        '  }',
        "  return { decision: 'allow', matched: false, reason: 'not-applicable' };",
        '}',
      ].join('\n'),
    });
  }

  function seedPainNegativeSample(): void {
    trajectory.recordSession({
      sessionId: 'session-1',
      startedAt: '2026-04-08T00:00:00.000Z',
    });
    trajectory.recordToolCall({
      sessionId: 'session-1',
      toolName: 'write',
      outcome: 'blocked',
      errorMessage: 'risky write requires approval',
      paramsJson: { filePath: 'src/app.ts' },
      createdAt: '2026-04-08T00:01:00.000Z',
    });
    trajectory.recordPainEvent({
      sessionId: 'session-1',
      source: 'gate',
      score: 75,
      reason: 'risky write requires approval',
      createdAt: '2026-04-08T00:01:01.000Z',
    });
    trajectory.recordGateBlock({
      sessionId: 'session-1',
      toolName: 'write',
      filePath: 'src/app.ts',
      reason: 'risky write requires approval',
      planStatus: 'NONE',
      createdAt: '2026-04-08T00:01:02.000Z',
    });

    const artifactPath = path.join(stateDir, 'nocturnal', 'samples', 'artifact-1.json');
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(
      artifactPath,
      JSON.stringify(
        {
          artifactId: 'artifact-1',
          sessionId: 'session-1',
          principleId: 'P-1',
          sourceSnapshotRef: 'snapshot-session-1',
          badDecision: 'Retried the write without checking approval requirements',
          betterDecision: 'Check the approval requirements before writing',
          rationale: 'Riskiest paths should not be written without a plan',
          createdAt: '2026-04-08T00:02:00.000Z',
        },
        null,
        2,
      ),
      'utf-8',
    );

    registerSample(
      workspaceDir,
      {
        artifactId: 'artifact-1',
        sessionId: 'session-1',
        principleId: 'P-1',
        sourceSnapshotRef: 'snapshot-session-1',
        badDecision: 'Retried the write without checking approval requirements',
        betterDecision: 'Check the approval requirements before writing',
        rationale: 'Riskiest paths should not be written without a plan',
        createdAt: '2026-04-08T00:02:00.000Z',
      },
      artifactPath,
      null,
      'pain-negative',
    );
  }

  it('persists replay reports under the implementation asset root', () => {
    seedLedgerAndImplementation();
    seedPainNegativeSample();

    const engine = new ReplayEngine(workspaceDir, stateDir);
    const report = engine.runReplayForImplementation('IMPL-1', ['pain-negative']);

    expect(report.overallDecision).toBe('pass');
    expect(report.replayResults.painNegative.passed).toBe(1);
    expect(report.replayResults.painNegative.failed).toBe(0);

    const reportDir = path.join(
      getImplementationAssetRoot(stateDir, 'IMPL-1'),
      'replays',
    );
    expect(fs.existsSync(reportDir)).toBe(true);
    expect(fs.readdirSync(reportDir).some((file) => file.endsWith('.json'))).toBe(true);
  });

  it('marks empty replay evidence as needs-review instead of pass', () => {
    seedLedgerAndImplementation();

    const engine = new ReplayEngine(workspaceDir, stateDir);
    const report = engine.runReplayForImplementation('IMPL-1', ['pain-negative']);

    expect(report.overallDecision).toBe('needs-review');
    expect(report.evidenceSummary).toEqual({
      evidenceStatus: 'empty',
      totalSamples: 0,
      classifiedCounts: {
        painNegative: 0,
        successPositive: 0,
        principleAnchor: 0,
      },
    });
    expect(report.blockers[0]).toContain('NO REPLAY EVIDENCE');
  });
});
