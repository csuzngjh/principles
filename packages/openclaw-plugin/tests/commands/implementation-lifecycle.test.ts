import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import { createImplementationAssetDir, getImplementationAssetRoot } from '../../src/core/code-implementation-storage.js';
import {
  loadLedger,
  saveLedger,
  type LedgerPrinciple,
  type LedgerRule,
} from '../../src/core/principle-tree-ledger.js';
import { handlePromoteImplCommand } from '../../src/commands/promote-impl.js';
import { handleDisableImplCommand } from '../../src/commands/disable-impl.js';
import { handleArchiveImplCommand } from '../../src/commands/archive-impl.js';
import { handleRollbackImplCommand } from '../../src/commands/rollback-impl.js';
import type { PluginCommandContext } from '../../src/openclaw-sdk.js';
import type { Implementation } from '../../src/types/principle-tree-schema.js';
import { TrajectoryDatabase, TrajectoryRegistry } from '../../src/core/trajectory.js';
import { registerSample } from '../../src/core/nocturnal-dataset.js';
import { safeRmDir } from '../test-utils.js';

function makePrinciple(): LedgerPrinciple {
  return {
    id: 'P-1',
    version: 1,
    text: 'Prefer explicit principle-backed implementations',
    triggerPattern: 'principle',
    action: 'use implementations safely',
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

function makeRule(implementationIds: string[]): LedgerRule {
  return {
    id: 'R-1',
    version: 1,
    name: 'Guard implementation lifecycle',
    description: 'Tracks implementation state transitions',
    type: 'gate',
    triggerCondition: 'lifecycle',
    enforcement: 'warn',
    action: 'record state safely',
    principleId: 'P-1',
    status: 'implemented',
    coverageRate: 0,
    falsePositiveRate: 0,
    implementationPath: undefined,
    testPath: undefined,
    createdAt: '2026-04-08T00:00:00.000Z',
    updatedAt: '2026-04-08T00:00:00.000Z',
    implementationIds,
  };
}

function makeImplementation(
  id: string,
  lifecycleState: Implementation['lifecycleState'],
  overrides: Partial<Implementation> = {}
): Implementation {
  return {
    id,
    ruleId: 'R-1',
    type: 'code',
    path: path.join('virtual', `${id}.js`),
    version: '1.0.0',
    coversCondition: 'lifecycle',
    coveragePercentage: 100,
    lifecycleState,
    createdAt: '2026-04-08T00:00:00.000Z',
    updatedAt: '2026-04-08T00:00:00.000Z',
    ...overrides,
  };
}

function makeCommandContext(workspaceDir: string, args: string): PluginCommandContext {
  return {
    channel: 'test',
    isAuthorizedSender: true,
    commandBody: args,
    args,
    config: { workspaceDir, language: 'en' },
    workspaceDir,
    sessionId: 'session-1',
  };
}

function writePassingReplayReport(stateDir: string, implementationId: string): void {
  const assetRoot = getImplementationAssetRoot(stateDir, implementationId);
  const reportPath = path.join(assetRoot, 'replays', '2026-04-08T00-00-00.000Z.json');
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        overallDecision: 'pass',
        replayResults: {
          painNegative: { total: 1, passed: 1, failed: 0, details: [] },
          successPositive: { total: 1, passed: 1, failed: 0, details: [] },
          principleAnchor: { total: 1, passed: 1, failed: 0, details: [] },
        },
        blockers: [],
        generatedAt: '2026-04-08T00:00:00.000Z',
        implementationId,
        sampleFingerprints: ['fp-1'],
      },
      null,
      2
    ),
    'utf-8'
  );
}

describe('implementation lifecycle commands', () => {
  let tempDir: string;
  let workspaceDir: string;
  let stateDir: string;
  let trajectory: TrajectoryDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-impl-cmd-'));
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

    WorkspaceContext.clearCache();
    const workspaceContext = WorkspaceContext.fromHookContext({ workspaceDir, stateDir });
    vi.spyOn(WorkspaceContext, 'fromHookContext').mockReturnValue(workspaceContext);
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
    vi.restoreAllMocks();
    WorkspaceContext.clearCache();
    safeRmDir(tempDir);
  });

  function seedLedger(implementations: Implementation[]): void {
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
        principles: {
          'P-1': makePrinciple(),
        },
        rules: {
          'R-1': makeRule(implementations.map((impl) => impl.id)),
        },
        implementations: Object.fromEntries(implementations.map((impl) => [impl.id, impl])),
        metrics: {},
        lastUpdated: '2026-04-08T00:00:00.000Z',
      },
    });
  }

  function seedReplaySample(sessionId: string, artifactId: string): void {
    trajectory.recordSession({
      sessionId,
      startedAt: '2026-04-08T00:00:00.000Z',
    });
    trajectory.recordToolCall({
      sessionId,
      toolName: 'write',
      outcome: 'blocked',
      errorMessage: 'risky write requires approval',
      paramsJson: { filePath: 'src/app.ts' },
      createdAt: '2026-04-08T00:01:00.000Z',
    });
    trajectory.recordPainEvent({
      sessionId,
      source: 'gate',
      score: 75,
      reason: 'risky write requires approval',
      createdAt: '2026-04-08T00:01:01.000Z',
    });
    trajectory.recordGateBlock({
      sessionId,
      toolName: 'write',
      filePath: 'src/app.ts',
      reason: 'risky write requires approval',
      planStatus: 'NONE',
      createdAt: '2026-04-08T00:01:02.000Z',
    });

    const artifactPath = path.join(stateDir, 'nocturnal', 'samples', `${artifactId}.json`);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(
      artifactPath,
      JSON.stringify(
        {
          artifactId,
          sessionId,
          principleId: 'P-1',
          sourceSnapshotRef: `snapshot-${sessionId}`,
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
        artifactId,
        sessionId,
        principleId: 'P-1',
        sourceSnapshotRef: `snapshot-${sessionId}`,
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

  it('promote preserves the legacy training store while activating the candidate', () => {
    seedLedger([makeImplementation('IMPL-CAND', 'candidate')]);
    createImplementationAssetDir(stateDir, 'IMPL-CAND', '1.0.0');
    writePassingReplayReport(stateDir, 'IMPL-CAND');

    const result = handlePromoteImplCommand(makeCommandContext(workspaceDir, 'IMPL-CAND'));

    expect(result.text).toContain('Implementation promoted');
    expect(loadLedger(stateDir).tree.implementations['IMPL-CAND'].lifecycleState).toBe('active');

    const raw = JSON.parse(
      fs.readFileSync(path.join(stateDir, 'principle_training_state.json'), 'utf-8')
    ) as Record<string, unknown>;
    expect(raw['P-1']).toBeDefined();
    expect(raw._tree).toBeDefined();
  });

  it('eval generates a replay report for a candidate implementation before promotion', () => {
    seedLedger([makeImplementation('IMPL-CAND', 'candidate')]);
    createImplementationAssetDir(stateDir, 'IMPL-CAND', '1.0.0', {
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
    seedReplaySample('session-eval', 'artifact-eval');

    const result = handlePromoteImplCommand(makeCommandContext(workspaceDir, 'eval IMPL-CAND'));

    expect(result.text).toContain('Replay Evaluation Report');
    expect(result.text).toContain('Overall Decision: [PASS]');
    expect(
      fs.readdirSync(path.join(getImplementationAssetRoot(stateDir, 'IMPL-CAND'), 'replays')).length,
    ).toBeGreaterThan(0);
  });

  it('disable preserves the legacy training store while recording disable metadata', () => {
    seedLedger([makeImplementation('IMPL-ACTIVE', 'active')]);

    const result = handleDisableImplCommand(
      makeCommandContext(workspaceDir, 'IMPL-ACTIVE --reason "manual disable"')
    );

    expect(result.text).toContain('Implementation disabled');
    const updated = loadLedger(stateDir).tree.implementations['IMPL-ACTIVE'];
    expect(updated.lifecycleState).toBe('disabled');
    expect(updated.disabledReason).toBe('manual disable');

    const raw = JSON.parse(
      fs.readFileSync(path.join(stateDir, 'principle_training_state.json'), 'utf-8')
    ) as Record<string, unknown>;
    expect(raw['P-1']).toBeDefined();
  });

  it('archive preserves the legacy training store while archiving a candidate', () => {
    seedLedger([makeImplementation('IMPL-CAND', 'candidate')]);

    const result = handleArchiveImplCommand(makeCommandContext(workspaceDir, 'IMPL-CAND'));

    expect(result.text).toContain('Implementation archived');
    expect(loadLedger(stateDir).tree.implementations['IMPL-CAND'].lifecycleState).toBe('archived');

    const raw = JSON.parse(
      fs.readFileSync(path.join(stateDir, 'principle_training_state.json'), 'utf-8')
    ) as Record<string, unknown>;
    expect(raw['P-1']).toBeDefined();
  });

  it('rollback preserves the legacy training store while restoring the previous active implementation', () => {
    seedLedger([
      makeImplementation('IMPL-CURRENT', 'active', { previousActive: 'IMPL-PREV' }),
      makeImplementation('IMPL-PREV', 'disabled'),
    ]);

    const result = handleRollbackImplCommand(
      makeCommandContext(workspaceDir, 'IMPL-CURRENT --reason "rollback"')
    );

    expect(result.text).toContain('Rollback complete');

    const ledger = loadLedger(stateDir);
    expect(ledger.tree.implementations['IMPL-CURRENT'].lifecycleState).toBe('disabled');
    expect(ledger.tree.implementations['IMPL-PREV'].lifecycleState).toBe('active');

    const raw = JSON.parse(
      fs.readFileSync(path.join(stateDir, 'principle_training_state.json'), 'utf-8')
    ) as Record<string, unknown>;
    expect(raw['P-1']).toBeDefined();
  });
});
