import { describe, expect, it } from 'vitest';
import {
  buildArtificerPrompt,
  runArtificerAsync,
  type ArtificerInput,
} from '../../src/core/nocturnal-artificer.js';
import type {
  ArtificerRuleContext,
  TrinityConfig,
  TrinityRuntimeAdapter,
  TrinityTelemetry,
} from '../../src/core/nocturnal-trinity.js';

const mockArtificerInput: ArtificerInput = {
  principleId: 'principle-test-001',
  ruleId: 'rule-test-001',
  snapshot: {
    sessionId: 'session-001',
    startedAt: '2026-04-30T00:00:00.000Z',
    updatedAt: '2026-04-30T00:05:00.000Z',
    assistantTurns: [{ sanitizedText: 'test turn', turnIndex: 1 }],
    userTurns: [],
    toolCalls: [
      {
        toolName: 'write',
        filePath: 'src/risk.ts',
        outcome: 'failure',
        errorMessage: 'test error',
        timestamp: '2026-04-30T00:00:00Z',
      },
    ],
    painEvents: [
      {
        score: 80,
        reason: 'test pain',
        source: 'after_tool_call',
        timestamp: '2026-04-30T00:00:00Z',
      },
    ],
    gateBlocks: [
      {
        toolName: 'write',
        reason: 'no plan',
        createdAt: '2026-04-30T00:00:00Z',
      },
    ],
    userCorrections: [],
    stats: {
      totalAssistantTurns: 1,
      totalToolCalls: 1,
      totalPainEvents: 1,
      totalGateBlocks: 1,
      failureCount: 1,
    },
  } as unknown as ArtificerInput['snapshot'],
  scribeArtifact: {
    sessionId: 'session-001',
    badDecision: 'Wrote to risk path without plan',
    betterDecision: 'Should check plan status before writing to risk paths',
    rationale: 'The agent bypassed the plan gate by not checking planStatus',
    sourceSnapshotRef: 'snapshot-001',
  },
  lineage: {
    artifactKind: 'rule-implementation-candidate',
    sourceSnapshotRef: 'snapshot-001',
    sourcePainIds: ['pain-001'],
    sourceGateBlockIds: ['gate-001'],
  },
};

const mockRuleContext: ArtificerRuleContext = {
  ruleName: 'Plan Gate Rule',
  ruleDescription: 'Requires plan before writing to risk paths',
  triggerCondition: 'toolName === write && isRiskPath',
  action: 'requireApproval',
};

const validArtificerOutputJson = JSON.stringify({
  ruleId: 'rule-test-001',
  implementationType: 'code',
  candidateSource:
    "export const meta = { name: 'test-rule', version: '1.0.0', ruleId: 'rule-test-001', coversCondition: 'test' };\nexport function evaluate(input, helpers) { return { decision: 'allow', matched: false, reason: 'not-applicable' }; }",
  helperUsage: ['isRiskPath', 'getToolName', 'getPlanStatus'],
  expectedDecision: 'requireApproval',
  rationale: 'Prevents unreviewed writes to risk paths',
  lineage: {
    artifactKind: 'rule-implementation-candidate',
    sourceSnapshotRef: 'snapshot-001',
    sourcePainIds: ['pain-001'],
    sourceGateBlockIds: ['gate-001'],
  },
});

const mockTelemetry: TrinityTelemetry = {
  chainMode: 'trinity',
  usedStubs: false,
  dreamerPassed: false,
  philosopherPassed: false,
  scribePassed: false,
  candidateCount: 0,
  selectedCandidateIndex: -1,
  stageFailures: [],
};

const mockConfig: TrinityConfig = {
  useTrinity: true,
  maxCandidates: 3,
  useStubs: false,
};

function createMockAdapter(
  invokeArtificerFn: TrinityRuntimeAdapter['invokeArtificer']
): TrinityRuntimeAdapter {
  return {
    isRuntimeAvailable: () => true,
    getLastFailureReason: () => null,
    invokeDreamer: () => Promise.resolve({} as never),
    invokePhilosopher: () => Promise.resolve({} as never),
    invokeScribe: () => Promise.resolve(null),
    invokeArtificer: invokeArtificerFn,
    close: () => Promise.resolve(),
  } as TrinityRuntimeAdapter;
}

describe('m10 artificer core', () => {
  it('buildArtificerPrompt contains required sections', () => {
    const prompt = buildArtificerPrompt(mockArtificerInput, mockRuleContext);

    expect(prompt).toContain('Target Rule');
    expect(prompt).toContain('Scribe Reflection');
    expect(prompt).toContain('Pain Events');
    expect(prompt).toContain('Gate Blocks');
    expect(prompt).toContain('Lineage');
    expect(prompt).toContain(mockArtificerInput.ruleId);
    expect(prompt).toContain(mockArtificerInput.scribeArtifact.badDecision);
    expect(prompt).toContain(mockArtificerInput.scribeArtifact.betterDecision);
    expect(prompt).toContain(mockArtificerInput.scribeArtifact.rationale);
  });

  it('runArtificerAsync happy path', async () => {
    const adapter = createMockAdapter(() => Promise.resolve(validArtificerOutputJson));

    const result = await runArtificerAsync(
      mockArtificerInput,
      mockRuleContext,
      adapter,
      mockTelemetry,
      mockConfig
    );

    expect(result).not.toBeNull();
    expect(result?.ruleId).toBe(mockArtificerInput.ruleId);
    expect(typeof result?.candidateSource).toBe('string');
    expect(Array.isArray(result?.helperUsage)).toBe(true);
  });

  it('runArtificerAsync adapter returns null', async () => {
    const adapter = createMockAdapter(() => Promise.resolve(null));

    const result = await runArtificerAsync(
      mockArtificerInput,
      mockRuleContext,
      adapter,
      mockTelemetry,
      mockConfig
    );

    expect(result).toBeNull();
  });

  it('runArtificerAsync adapter returns invalid JSON', async () => {
    const adapter = createMockAdapter(() => Promise.resolve('{ invalid json'));

    const result = await runArtificerAsync(
      mockArtificerInput,
      mockRuleContext,
      adapter,
      mockTelemetry,
      mockConfig
    );

    expect(result).toBeNull();
  });

  it('runArtificerAsync parseArtificerOutput rejection', async () => {
    const adapter = createMockAdapter(() => Promise.resolve('{"ruleId":"rule-test-001"}'));

    const result = await runArtificerAsync(
      mockArtificerInput,
      mockRuleContext,
      adapter,
      mockTelemetry,
      mockConfig
    );

    expect(result).toBeNull();
  });

  it('runArtificerAsync ruleId mismatch', async () => {
    const adapter = createMockAdapter(() =>
      Promise.resolve(
        JSON.stringify({
          ...JSON.parse(validArtificerOutputJson),
          ruleId: 'rule-other-999',
        })
      )
    );

    const result = await runArtificerAsync(
      mockArtificerInput,
      mockRuleContext,
      adapter,
      mockTelemetry,
      mockConfig
    );

    expect(result).toBeNull();
  });

  it('runArtificerAsync adapter throws error', async () => {
    const adapter = createMockAdapter(() => Promise.reject(new Error('adapter failed')));

    const result = await runArtificerAsync(
      mockArtificerInput,
      mockRuleContext,
      adapter,
      mockTelemetry,
      mockConfig
    );

    expect(result).toBeNull();
  });
});
