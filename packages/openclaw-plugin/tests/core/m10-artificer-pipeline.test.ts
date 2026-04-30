import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  executeNocturnalReflectionAsync,
  type NocturnalServiceOptions,
} from '../../src/service/nocturnal-service.js';
import type {
  TrinityConfig,
  TrinityRuntimeAdapter,
  TrinityTelemetry,
} from '../../src/core/nocturnal-trinity.js';
import type {
  DreamerOutput,
  PhilosopherOutput,
  TrinityDraftArtifact,
} from '../../src/core/nocturnal-trinity-types.js';
import {
  loadLedger,
  saveLedger,
  type LedgerPrinciple,
  type LedgerRule,
  listImplementationsForRule,
} from '../../src/core/principle-tree-ledger.js';
import {
  createNocturnalTrajectoryExtractor,
  type NocturnalSessionSnapshot,
} from '../../src/core/nocturnal-trajectory-extractor.js';
import { TrajectoryDatabase, TrajectoryRegistry } from '../../src/core/trajectory.js';
import { PrincipleLifecycleService } from '../../src/core/principle-internalization/principle-lifecycle-service.js';
import { safeRmDir } from '../test-utils.js';

const VALID_CANDIDATE_SOURCE = [
  'export const meta = {',
  '  name: "test-rule",',
  '  version: "1.0.0",',
  '  ruleId: "R-001",',
  '  coversCondition: "toolName === write && riskPath && planStatus !== READY",',
  '};',
  '',
  'export function evaluate(input, helpers) {',
  '  const toolName = helpers.getToolName();',
  '  const riskPath = helpers.isRiskPath();',
  '  const planStatus = helpers.getPlanStatus();',
  '  if (toolName === "write" && riskPath && planStatus !== "READY") {',
  '    return {',
  '      decision: "block",',
  '      matched: true,',
  '      reason: "Plan required for high-risk writes",',
  '    };',
  '  }',
  '  return {',
  '    decision: "allow",',
  '    matched: false,',
  '    reason: "Conditions not met",',
  '  };',
  '}',
].join('\n');

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
    adherenceRate: 0,
    painPreventedCount: 0,
    derivedFromPainIds: [],
    ruleIds: ['R-001'],
    conflictsWithPrincipleIds: [],
    createdAt: '2026-04-30T00:00:00.000Z',
    updatedAt: '2026-04-30T00:00:00.000Z',
    ...overrides,
  };
}

function makeRule(overrides: Partial<LedgerRule> = {}): LedgerRule {
  return {
    id: 'R-001',
    version: 1,
    name: 'Protect risky write',
    description: 'Require approval before risky write operations.',
    type: 'gate',
    triggerCondition: 'toolName === write && riskPath',
    enforcement: 'block',
    action: 'require approval for risky write',
    principleId: 'T-08',
    status: 'implemented',
    coverageRate: 0,
    falsePositiveRate: 0,
    implementationIds: [],
    createdAt: '2026-04-30T00:00:00.000Z',
    updatedAt: '2026-04-30T00:00:00.000Z',
    ...overrides,
  };
}

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

function seedLedger(stateDir: string): void {
  saveLedger(stateDir, {
    trainingStore: {
      'T-08': {
        principleId: 'T-08',
        evaluability: 'deterministic',
        applicableOpportunityCount: 6,
        observedViolationCount: 4,
        complianceRate: 0.33,
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
        'T-08': makePrinciple(),
      },
      rules: {
        'R-001': makeRule(),
      },
      implementations: {},
      metrics: {},
      lastUpdated: '2026-04-30T00:00:00.000Z',
    },
  });
}

function seedTrajectorySession(trajectory: TrajectoryDatabase, sessionId: string): void {
  const startedAt = '2026-04-30T00:00:00.000Z';
  trajectory.recordSession({ sessionId, startedAt });
  trajectory.recordToolCall({
    sessionId,
    toolName: 'write',
    outcome: 'failure',
    errorMessage: 'risky write blocked',
    errorType: 'GateBlock',
    createdAt: '2026-04-30T00:00:01.000Z',
  });
  trajectory.recordToolCall({
    sessionId,
    toolName: 'write',
    outcome: 'failure',
    errorMessage: 'approval missing for risky write',
    errorType: 'GateBlock',
    createdAt: '2026-04-30T00:00:02.000Z',
  });
  trajectory.recordPainEvent({
    sessionId,
    source: 'gate',
    score: 75,
    severity: 'high',
    reason: 'risky write requires approval',
    createdAt: '2026-04-30T00:00:03.000Z',
  });
  trajectory.recordGateBlock({
    sessionId,
    toolName: 'write',
    filePath: 'src/risk.ts',
    reason: 'risky write requires approval',
    riskLevel: 'high',
    planStatus: 'DRAFT',
    createdAt: '2026-04-30T00:00:04.000Z',
  });
}

function getSeededSnapshot(workspaceDir: string, sessionId: string): NocturnalSessionSnapshot {
  const extractor = createNocturnalTrajectoryExtractor(workspaceDir);
  const snapshot = extractor.getNocturnalSessionSnapshot(sessionId);
  expect(snapshot).not.toBeNull();
  return snapshot as NocturnalSessionSnapshot;
}

function createDreamerOutput(): DreamerOutput {
  return {
    valid: true,
    candidates: [
      {
        candidateIndex: 0,
        badDecision:
          'Attempted risky write on src/risk.ts without approval after the gate blocked it',
        betterDecision:
          'Check PLAN.md and review the risky write approval requirements for src/risk.ts before retrying the write',
        rationale: 'This keeps the agent aligned with T-08 by treating gate pain as a signal to pause and verify.',
        confidence: 0.96,
        riskLevel: 'low',
        strategicPerspective: 'conservative_fix',
      },
      {
        candidateIndex: 1,
        badDecision:
          'Retried the blocked risky write without understanding the approval boundary for src/risk.ts',
        betterDecision:
          'Review the gate rule and inspect src/risk.ts before attempting any more risky writes',
        rationale: 'Inspecting the rule boundary first prevents repeated gate pain and unreviewed changes.',
        confidence: 0.82,
        riskLevel: 'medium',
        strategicPerspective: 'structural_improvement',
      },
    ],
    generatedAt: '2026-04-30T00:05:00.000Z',
  };
}

function createPhilosopherOutput(): PhilosopherOutput {
  return {
    valid: true,
    judgments: [
      {
        candidateIndex: 0,
        critique: 'Grounded in the gate block and directly prevents another risky write retry.',
        principleAligned: true,
        score: 0.97,
        rank: 1,
        scores: {
          principleAlignment: 0.98,
          specificity: 0.94,
          actionability: 0.96,
          executability: 0.98,
          safetyImpact: 0.97,
          uxImpact: 0.9,
        },
        risks: {
          falsePositiveEstimate: 0.05,
          implementationComplexity: 'low',
          breakingChangeRisk: false,
        },
      },
      {
        candidateIndex: 1,
        critique: 'Useful but less direct because it expands scope before resolving the blocked write.',
        principleAligned: true,
        score: 0.79,
        rank: 2,
        scores: {
          principleAlignment: 0.82,
          specificity: 0.78,
          actionability: 0.8,
          executability: 0.78,
          safetyImpact: 0.81,
          uxImpact: 0.74,
        },
        risks: {
          falsePositiveEstimate: 0.14,
          implementationComplexity: 'medium',
          breakingChangeRisk: false,
        },
      },
    ],
    overallAssessment: 'Candidate 0 best matches the observed gate and pain signals.',
    generatedAt: '2026-04-30T00:05:10.000Z',
  };
}

function createScribeOutput(
  snapshot: NocturnalSessionSnapshot,
  principleId: string,
  telemetry: TrinityTelemetry,
): TrinityDraftArtifact {
  return {
    selectedCandidateIndex: 0,
    badDecision:
      'Attempted risky write on src/risk.ts without approval after the gate blocked it',
    betterDecision:
      'Check PLAN.md and review the risky write approval requirements for src/risk.ts before retrying the write',
    rationale: 'Treating the gate block as a signal prevents repeated risky writes and preserves review boundaries.',
    sessionId: snapshot.sessionId,
    principleId,
    sourceSnapshotRef: `snapshot-${snapshot.sessionId}`,
    telemetry: {
      ...telemetry,
      chainMode: 'trinity',
      usedStubs: false,
      dreamerPassed: true,
      philosopherPassed: true,
      scribePassed: true,
      candidateCount: 2,
      selectedCandidateIndex: 0,
      stageFailures: [],
    },
    rejectedAnalysis: {
      whyRejected: 'The runner-up widened scope before resolving the active gate block.',
      warningSignals: ['repeated blocked write', 'missing approval'],
      correctiveThinking: 'Resolve the approval boundary first, then consider wider cleanup.',
    },
    chosenJustification: {
      whyChosen: 'It directly addresses the blocked write pattern with the smallest safe next step.',
      keyInsights: ['Read the gate first', 'Use PLAN.md as the approval anchor'],
      limitations: ['Does not apply to non-risk writes'],
    },
    contrastiveAnalysis: {
      criticalDifference: 'The winner pauses at the gate instead of broadening the change set.',
      decisionTrigger: 'When a risky write is blocked, inspect the approval requirement before retrying.',
      preventionStrategy: 'Require a PLAN.md check before any repeat write attempt on a risk path.',
    },
  };
}

function createMockAdapter(artificerResponse: string | null): TrinityRuntimeAdapter {
  return {
    isRuntimeAvailable: () => true,
    getLastFailureReason: () => null,
    invokeDreamer: async () => createDreamerOutput(),
    invokePhilosopher: async () => createPhilosopherOutput(),
    invokeScribe: async (
      _dreamerOutput,
      _philosopherOutput,
      snapshot,
      principleId,
      telemetry,
      _config,
    ) => createScribeOutput(snapshot, principleId, telemetry),
    invokeArtificer: async (
      _input,
      _ruleContext,
      _telemetry,
      _config,
    ) => artificerResponse,
    close: async () => {},
  };
}

async function runAsyncPipeline(
  workspaceDir: string,
  stateDir: string,
  snapshot: NocturnalSessionSnapshot,
  runtimeAdapter: TrinityRuntimeAdapter,
): Promise<Awaited<ReturnType<typeof executeNocturnalReflectionAsync>>> {
  const options: NocturnalServiceOptions = {
    idleCheckOverride: makeIdleResult(),
    principleIdOverride: 'T-08',
    snapshotOverride: snapshot,
    runtimeAdapter,
    trinityConfig: {
      useTrinity: true,
      useStubs: false,
      maxCandidates: 3,
    },
  };

  return executeNocturnalReflectionAsync(workspaceDir, stateDir, options);
}

describe('m10 artificer pipeline', () => {
  let tempDir: string;
  let workspaceDir: string;
  let stateDir: string;
  let trajectory: TrajectoryDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-m10-artificer-pipeline-'));
    workspaceDir = path.join(tempDir, 'workspace');
    stateDir = path.join(tempDir, 'state');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    trajectory = new TrajectoryDatabase({ workspaceDir });
    seedLedger(stateDir);
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

  it('executeNocturnalReflectionAsync with runtimeAdapter invokes Artificer and persists candidate', async () => {
    seedTrajectorySession(trajectory, 'session-artificer-success');
    const snapshot = getSeededSnapshot(workspaceDir, 'session-artificer-success');
    const result = await runAsyncPipeline(
      workspaceDir,
      stateDir,
      snapshot,
      createMockAdapter(
        JSON.stringify({
          ruleId: 'R-001',
          implementationType: 'code',
          candidateSource: VALID_CANDIDATE_SOURCE,
          helperUsage: ['getToolName', 'isRiskPath', 'getPlanStatus'],
          expectedDecision: 'block',
          rationale: 'Test rationale',
          lineage: {
            artifactKind: 'rule-implementation-candidate',
            sourceSnapshotRef: 'snapshot-session-artificer-success',
            sourcePainIds: ['pain-1'],
            sourceGateBlockIds: ['gate-1'],
          },
        }),
      ),
    );

    expect(result.success).toBe(true);
    expect(result.diagnostics.artificer.status).toBe('persisted_candidate');
    expect(result.diagnostics.artificer.ruleId).toBe('R-001');
    expect(result.diagnostics.artificer.persistedPath).toBeDefined();

    const persistedPath = result.diagnostics.artificer.persistedPath!;
    expect(fs.existsSync(path.join(persistedPath, 'entry.js'))).toBe(true);

    const implementations = listImplementationsForRule(stateDir, 'R-001');
    expect(implementations).toHaveLength(1);
    expect(implementations[0].lifecycleState).toBe('candidate');

    const persistedSource = fs.readFileSync(path.join(persistedPath, 'entry.js'), 'utf-8');
    expect(persistedSource).toContain('Plan required for high-risk writes');
  });

  it('Artificer LLM failure skips candidate generation (DD-04)', async () => {
    seedTrajectorySession(trajectory, 'session-artificer-fallback');
    const snapshot = getSeededSnapshot(workspaceDir, 'session-artificer-fallback');
    const result = await runAsyncPipeline(
      workspaceDir,
      stateDir,
      snapshot,
      createMockAdapter(null),
    );

    expect(result.success).toBe(true);
    // DD-04: "No candidate is better than a bad candidate" - LLM failure = skipped
    expect(result.diagnostics.artificer.status).toBe('skipped');
    expect(result.diagnostics.artificer.reason).toBe('parse_failed');

    // No implementation should be persisted when LLM fails
    const implementations = listImplementationsForRule(stateDir, 'R-001');
    expect(implementations).toHaveLength(0);
  });

  it('Artificer candidate is trackable by lifecycle service', async () => {
    seedTrajectorySession(trajectory, 'session-artificer-lifecycle');
    const snapshot = getSeededSnapshot(workspaceDir, 'session-artificer-lifecycle');
    const result = await runAsyncPipeline(
      workspaceDir,
      stateDir,
      snapshot,
      createMockAdapter(
        JSON.stringify({
          ruleId: 'R-001',
          implementationType: 'code',
          candidateSource: VALID_CANDIDATE_SOURCE,
          helperUsage: ['getToolName', 'isRiskPath', 'getPlanStatus'],
          expectedDecision: 'block',
          rationale: 'Lifecycle test rationale',
          lineage: {
            artifactKind: 'rule-implementation-candidate',
            sourceSnapshotRef: 'snapshot-session-artificer-lifecycle',
            sourcePainIds: ['pain-2'],
            sourceGateBlockIds: ['gate-2'],
          },
        }),
      ),
    );

    expect(result.success).toBe(true);

    const lifecycleService = new PrincipleLifecycleService(workspaceDir, stateDir);
    const recomputed = lifecycleService.recomputeAll();

    expect(recomputed).toHaveLength(1);
    expect(recomputed[0].principleId).toBe('T-08');
    expect(recomputed[0].ruleMetrics['R-001']).toBeDefined();
    expect(recomputed[0].ruleMetrics['R-001'].coverageRate).toBeGreaterThan(0);
    expect(recomputed[0].ruleMetrics['R-001'].implementationStabilityScore).toBeGreaterThan(0);
    expect(recomputed[0].adherence.repeatedErrorSignal).toBeGreaterThan(0);

    const ledger = loadLedger(stateDir);
    expect(ledger.tree.rules['R-001'].coverageRate).toBeGreaterThan(0);
    expect(ledger.tree.rules['R-001'].implementationIds.length).toBeGreaterThan(0);
  });
});
