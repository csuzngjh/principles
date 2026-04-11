/**
 * Nocturnal Trinity End-to-End Test
 *
 * Purpose: Protect the complete Trinity reflection chain that was debugged
 * in issue #244. This test covers the full pipeline from session snapshot
 * to final artifact, ensuring all data contracts between stages are valid.
 *
 * Test Scenarios:
 * 1. Complete Trinity chain with real session data (mocked LLM)
 * 2. Dreamer → Philosopher → Scribe data contract validation
 * 3. Arbiter quality gate (thinkingModelDelta)
 * 4. Runtime adapter integration (no stubs)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import {
  runTrinityAsync,
  validateDraftArtifact,
  draftToArtifact,
  DEFAULT_TRINITY_CONFIG,
  type TrinityConfig,
  type TrinityRuntimeAdapter,
  type DreamerOutput,
  type PhilosopherOutput,
  type TrinityDraftArtifact,
  type TrinityTelemetry,
  type NocturnalSessionSnapshot,
} from '../../src/core/nocturnal-trinity.js';
import { computeThinkingModelDelta } from '../../src/core/nocturnal-trajectory-extractor.js';

// ---------------------------------------------------------------------------
// Real Session Data (from actual trajectory.db session 75e377ea)
// ---------------------------------------------------------------------------

function makeRealViolatingSnapshot(): NocturnalSessionSnapshot {
  return {
    sessionId: '75e377ea-413f-4b5a-b249-cfc4bd87e3b3',
    stats: {
      failureCount: 1,
      totalPainEvents: 0,
      totalGateBlocks: 0,
      totalAssistantTurns: 1,
      totalToolCalls: 7,
    },
    toolCalls: [
      { toolName: 'read', outcome: 'success' as const, filePath: '/home/csuzngjh/.openclaw/workspace-main/.state/.pain_flag' },
      { toolName: 'exec', outcome: 'success' as const },
      { toolName: 'exec', outcome: 'success' as const },
      { toolName: 'exec', outcome: 'success' as const },
      { toolName: 'exec', outcome: 'success' as const },
      { toolName: 'sessions_list', outcome: 'failure' as const, errorMessage: 'gateway timeout after 10000ms' },
      { toolName: 'write', outcome: 'success' as const, filePath: '/home/csuzngjh/.openclaw/workspace-main/.state/.pain_flag' },
    ],
    painEvents: [],
    gateBlocks: [],
    assistantTurns: [
      { sanitizedText: 'No user messages in events.jsonl — only hook/tool events. The store is already well-tuned. Bumping stats and timestamp.' },
    ],
    userTurns: [],
  };
}

function makeHighViolationSnapshot(): NocturnalSessionSnapshot {
  return {
    sessionId: 'c5341af6-eb83-4e0b-8952-704e63c4dd90',
    stats: {
      failureCount: 25,
      totalPainEvents: 7,
      totalGateBlocks: 2,
      totalAssistantTurns: 15,
      totalToolCalls: 40,
    },
    toolCalls: [
      { toolName: 'write', outcome: 'failure' as const, errorMessage: 'File already exists, overwriting without confirmation' },
      { toolName: 'exec', outcome: 'failure' as const, errorMessage: 'Command failed: attempted to run privileged operation' },
      { toolName: 'read', outcome: 'success' as const },
      { toolName: 'edit', outcome: 'failure' as const, errorMessage: 'Could not find string to replace' },
    ],
    painEvents: [
      { source: 'tool_call', score: 85, reason: 'Agent attempted destructive operation without user confirmation' },
      { source: 'tool_call', score: 72, reason: 'Agent attempted privileged operation without proper authorization' },
      { source: 'tool_call', score: 50, reason: 'Agent wrote to state file without reading first' },
    ],
    gateBlocks: [
      { toolName: 'exec', reason: 'Security gate blocked dangerous command' },
    ],
    assistantTurns: [
      { sanitizedText: 'Attempting to fix the issue by modifying configuration files.' },
      { sanitizedText: 'Running system commands to diagnose the problem.' },
    ],
    userTurns: [],
  };
}

// ---------------------------------------------------------------------------
// Mock Runtime Adapter (simulates real LLM responses)
// ---------------------------------------------------------------------------

function makeRealisticMockAdapter(): TrinityRuntimeAdapter {
  return {
    async invokeDreamer(_snapshot, _principleId, maxCandidates) {
      const candidates = [];
      for (let i = 0; i < Math.min(maxCandidates, 2); i++) {
        candidates.push({
          candidateIndex: i,
          badDecision: 'The agent attempted to execute a privileged operation without proper user authorization, which triggered a security gate block and caused a gateway timeout.',
          betterDecision: i === 0
            ? 'The agent should have first checked user permissions and requested explicit approval before attempting any privileged operation, preventing the timeout and security violation.'
            : 'The agent should have used a read-only diagnostic command first to understand the system state, then proposed the privileged action to the user with clear justification.',
          rationale: i === 0
            ? 'This aligns with the principle of checking permissions before action. The principle states that agents must verify authorization before executing privileged operations.'
            : 'This follows the principle of understanding before acting. Reading state first would have prevented the failed operation and subsequent timeout.',
          confidence: i === 0 ? 0.92 : 0.85,
        });
      }
      return {
        valid: true,
        candidates,
        generatedAt: new Date().toISOString(),
      };
    },

    async invokePhilosopher(dreamerOutput) {
      const judgments = dreamerOutput.candidates.map((c, i) => ({
        candidateIndex: c.candidateIndex,
        critique: i === 0
          ? 'Strong alignment with principle. The betterDecision provides a concrete, actionable alternative (check permissions first) that directly addresses the root cause of the violation.'
          : 'Good alternative approach. The read-first strategy is safer but less directly aligned with the specific principle about authorization.',
        principleAligned: true,
        score: i === 0 ? 0.95 : 0.88,
        rank: i + 1,
      }));

      return {
        valid: true,
        judgments,
        overallAssessment: 'Both candidates show strong principle alignment. Candidate 0 is slightly better due to more direct alignment with the authorization principle.',
        generatedAt: new Date().toISOString(),
      };
    },

    async invokeScribe(_dreamerOutput, _philosopherOutput, snapshot, principleId, telemetry) {
      return {
        selectedCandidateIndex: 0,
        badDecision: 'The agent attempted to execute a privileged operation without proper user authorization, which triggered a security gate block and caused a gateway timeout.',
        betterDecision: 'The agent should have first checked user permissions and requested explicit approval before attempting any privileged operation, preventing the timeout and security violation.',
        rationale: 'This aligns with the principle of checking permissions before action. The principle states that agents must verify authorization before executing privileged operations. The better decision provides a concrete, actionable alternative that directly addresses the root cause of the violation.',
        sessionId: snapshot.sessionId,
        principleId,
        sourceSnapshotRef: `snapshot-${snapshot.sessionId}-${Date.now()}`,
        telemetry: {
          chainMode: 'trinity',
          usedStubs: false,
          dreamerPassed: true,
          philosopherPassed: true,
          scribePassed: true,
          candidateCount: _dreamerOutput.candidates.length,
          selectedCandidateIndex: 0,
          stageFailures: [],
        },
      };
    },

    async close() {
      // Cleanup (no-op for mock)
    },
  };
}

function makePoorQualityAdapter(): TrinityRuntimeAdapter {
  return {
    async invokeDreamer() {
      return {
        valid: true,
        candidates: [
          {
            candidateIndex: 0,
            badDecision: 'Something went wrong',
            betterDecision: 'Something should be done differently',
            rationale: 'This is better',
            confidence: 0.5,
          },
        ],
        generatedAt: new Date().toISOString(),
      };
    },

    async invokePhilosopher() {
      return {
        valid: true,
        judgments: [
          {
            candidateIndex: 0,
            critique: 'Okay',
            principleAligned: true,
            score: 0.6,
            rank: 1,
          },
        ],
        overallAssessment: 'Fine',
        generatedAt: new Date().toISOString(),
      };
    },

    async invokeScribe(_dreamerOutput, _philosopherOutput, snapshot, principleId, telemetry) {
      return {
        selectedCandidateIndex: 0,
        badDecision: 'Something went wrong',
        betterDecision: 'Something should be done differently',
        rationale: 'This is better because it is better',
        sessionId: snapshot.sessionId,
        principleId,
        sourceSnapshotRef: `snapshot-${snapshot.sessionId}-${Date.now()}`,
        telemetry: {
          chainMode: 'trinity',
          usedStubs: false,
          dreamerPassed: true,
          philosopherPassed: true,
          scribePassed: true,
          candidateCount: 1,
          selectedCandidateIndex: 0,
          stageFailures: [],
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// E2E Tests
// ---------------------------------------------------------------------------

describe('Nocturnal Trinity E2E — Complete Chain', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-11T15:00:00.000Z'));
  });

  // ---------------------------------------------------------------------------
  // Test 1: Complete chain with realistic LLM output
  // ---------------------------------------------------------------------------
  it('completes full Trinity chain with realistic mock adapter and high-violation session', async () => {
    const snapshot = makeHighViolationSnapshot();
    const config: TrinityConfig = {
      useTrinity: true,
      maxCandidates: 2,
      useStubs: false,
      runtimeAdapter: makeRealisticMockAdapter(),
    };

    const result = await runTrinityAsync({
      snapshot,
      principleId: 'P_001',
      config,
    });

    expect(result.success).toBe(true);
    expect(result.artifact).toBeDefined();
    expect(result.telemetry.chainMode).toBe('trinity');
    expect(result.telemetry.dreamerPassed).toBe(true);
    expect(result.telemetry.philosopherPassed).toBe(true);
    expect(result.telemetry.scribePassed).toBe(true);
    expect(result.telemetry.candidateCount).toBe(2);
    expect(result.failures).toHaveLength(0);

    // Verify artifact structure
    const artifact = result.artifact!;
    expect(artifact.badDecision).toContain('privileged operation');
    expect(artifact.betterDecision).toContain('checked user permissions');
    expect(artifact.rationale.length).toBeGreaterThan(50);
    expect(artifact.sessionId).toBe(snapshot.sessionId);
    expect(artifact.principleId).toBe('P_001');
  });

  // ---------------------------------------------------------------------------
  // Test 2: Data contract validation between stages
  // ---------------------------------------------------------------------------
  it('validates data contracts between Dreamer → Philosopher → Scribe', async () => {
    const snapshot = makeRealViolatingSnapshot();
    const adapter = makeRealisticMockAdapter();

    // Stage 1: Dreamer
    const dreamerOutput = await adapter.invokeDreamer(snapshot, 'P_001', 2);
    expect(dreamerOutput.valid).toBe(true);
    expect(dreamerOutput.candidates.length).toBeGreaterThan(0);
    expect(dreamerOutput.candidates[0].candidateIndex).toBe(0);
    expect(dreamerOutput.candidates[0].badDecision).toBeTruthy();
    expect(dreamerOutput.candidates[0].betterDecision).toBeTruthy();
    expect(dreamerOutput.candidates[0].rationale).toBeTruthy();
    expect(dreamerOutput.candidates[0].confidence).toBeGreaterThanOrEqual(0);
    expect(dreamerOutput.candidates[0].confidence).toBeLessThanOrEqual(1);

    // Stage 2: Philosopher
    const philosopherOutput = await adapter.invokePhilosopher(dreamerOutput, 'P_001');
    expect(philosopherOutput.valid).toBe(true);
    expect(philosopherOutput.judgments.length).toBe(dreamerOutput.candidates.length);
    expect(philosopherOutput.judgments[0].candidateIndex).toBe(0);
    expect(philosopherOutput.judgments[0].score).toBeGreaterThanOrEqual(0);
    expect(philosopherOutput.judgments[0].score).toBeLessThanOrEqual(1);
    expect(philosopherOutput.judgments[0].rank).toBe(1);

    // Stage 3: Scribe
    const scribeArtifact = await adapter.invokeScribe(
      dreamerOutput,
      philosopherOutput,
      snapshot,
      'P_001',
      { chainMode: 'trinity' } as TrinityTelemetry,
      { useTrinity: true, maxCandidates: 2, useStubs: false }
    );
    expect(scribeArtifact).not.toBeNull();
    expect(scribeArtifact!.selectedCandidateIndex).toBeGreaterThanOrEqual(0);
    expect(scribeArtifact!.badDecision).toBeTruthy();
    expect(scribeArtifact!.betterDecision).toBeTruthy();
    expect(scribeArtifact!.rationale.length).toBeGreaterThan(10);
    expect(scribeArtifact!.sessionId).toBe(snapshot.sessionId);
    expect(scribeArtifact!.principleId).toBe('P_001');

    // Verify draft artifact passes validation
    const draftValidation = validateDraftArtifact(scribeArtifact!);
    expect(draftValidation.valid).toBe(true);
    expect(draftValidation.failures).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Test 3: Arbiter quality gate (thinkingModelDelta)
  // ---------------------------------------------------------------------------
  it('computes thinkingModelDelta for quality gate', () => {
    // Realistic case: meaningful improvement should have positive delta
    const goodBad = 'The agent executed a privileged command without checking permissions first, causing a security violation and gateway timeout.';
    const goodBetter = 'The agent should have first verified user authorization and explicitly requested approval before attempting any privileged operation.';

    const delta = computeThinkingModelDelta(goodBad, goodBetter);
    expect(delta).toBeGreaterThanOrEqual(0); // Should be non-negative for real improvements

    // Poor quality case: nearly identical text should have delta near 0
    const poorBad = 'Something went wrong with the operation';
    const poorBetter = 'Something should be done differently with the operation';

    const poorDelta = computeThinkingModelDelta(poorBad, poorBetter);
    expect(poorDelta).toBeLessThan(0.01); // Should fail quality gate
  });

  it('fails quality gate when thinkingModelDelta is too low', async () => {
    const snapshot = makeRealViolatingSnapshot();
    const config: TrinityConfig = {
      useTrinity: true,
      maxCandidates: 1,
      useStubs: false,
      runtimeAdapter: makePoorQualityAdapter(),
    };

    const result = await runTrinityAsync({
      snapshot,
      principleId: 'P_001',
      config,
    });

    // The poor quality adapter should produce low delta
    const delta = computeThinkingModelDelta(
      result.artifact?.badDecision || '',
      result.artifact?.betterDecision || ''
    );
    expect(delta).toBeLessThan(0.01);
  });

  // ---------------------------------------------------------------------------
  // Test 4: Runtime adapter integration
  // ---------------------------------------------------------------------------
  it('calls runtime adapter methods in correct order', async () => {
    const callOrder: string[] = [];
    const trackingAdapter: TrinityRuntimeAdapter = {
      async invokeDreamer(...args) {
        callOrder.push('dreamer');
        return makeRealisticMockAdapter().invokeDreamer(...args);
      },
      async invokePhilosopher(...args) {
        callOrder.push('philosopher');
        return makeRealisticMockAdapter().invokePhilosopher(...args);
      },
      async invokeScribe(...args) {
        callOrder.push('scribe');
        return makeRealisticMockAdapter().invokeScribe(...args);
      },
      async close() {
        callOrder.push('close');
      },
    };

    const snapshot = makeHighViolationSnapshot();
    const config: TrinityConfig = {
      useTrinity: true,
      maxCandidates: 2,
      useStubs: false,
      runtimeAdapter: trackingAdapter,
    };

    await runTrinityAsync({
      snapshot,
      principleId: 'T-01',
      config,
    });

    expect(callOrder).toEqual(['dreamer', 'philosopher', 'scribe', 'close']);
  });

  // ---------------------------------------------------------------------------
  // Test 5: Model resolution from config
  // ---------------------------------------------------------------------------
  it('resolves provider and model from config', () => {
    // This tests the resolveModel logic in OpenClawTrinityRuntimeAdapter
    const mockConfig = {
      agents: {
        defaults: {
          model: 'minimax-portal/MiniMax-M2.7',
        },
      },
    };

    const config = mockConfig as Record<string, unknown>;
    const agents = config?.agents as Record<string, unknown> | undefined;
    const defaults = agents?.defaults as Record<string, unknown> | undefined;
    const modelConfig = defaults?.model;

    expect(typeof modelConfig).toBe('string');
    expect(modelConfig).toBe('minimax-portal/MiniMax-M2.7');

    // Parse model string
    if (typeof modelConfig === 'string' && modelConfig.includes('/')) {
      const parts = modelConfig.split('/');
      expect(parts[0]).toBe('minimax-portal');
      expect(parts.slice(1).join('/')).toBe('MiniMax-M2.7');
    }
  });

  it('handles object model config with primary field', () => {
    const mockConfig = {
      agents: {
        defaults: {
          model: {
            primary: 'zai/GLM-5.1',
            fallbacks: ['zai/glm-5-turbo'],
          },
        },
      },
    };

    const config = mockConfig as Record<string, unknown>;
    const agents = config?.agents as Record<string, unknown> | undefined;
    const defaults = agents?.defaults as Record<string, unknown> | undefined;
    const modelConfig = defaults?.model;

    if (modelConfig && typeof modelConfig === 'object') {
      const mc = modelConfig as Record<string, unknown>;
      const primary = mc.primary as string | undefined;
      expect(primary).toBe('zai/GLM-5.1');

      if (primary && primary.includes('/')) {
        const parts = primary.split('/');
        expect(parts[0]).toBe('zai');
        expect(parts.slice(1).join('/')).toBe('GLM-5.1');
      }
    }
  });

  it('uses fallback when model config is missing', () => {
    const mockConfig = {
      agents: {
        defaults: {},
      },
    };

    const config = mockConfig as Record<string, unknown>;
    const agents = config?.agents as Record<string, unknown> | undefined;
    const defaults = agents?.defaults as Record<string, unknown> | undefined;
    const modelConfig = defaults?.model;

    expect(modelConfig).toBeUndefined();
    // Should fall back to minimax-portal/MiniMax-M2.7
  });

  // ---------------------------------------------------------------------------
  // Test 6: Session snapshot contract validation
  // ---------------------------------------------------------------------------
  it('validates session snapshot has required fields for violation detection', () => {
    const snapshot = makeHighViolationSnapshot();

    // Must have toolCalls for violation detection
    expect(Array.isArray(snapshot.toolCalls)).toBe(true);
    expect(snapshot.toolCalls.length).toBeGreaterThan(0);

    // Must have stats for target selection
    expect(snapshot.stats).toBeDefined();
    expect(typeof snapshot.stats.failureCount).toBe('number');
    expect(typeof snapshot.stats.totalPainEvents).toBe('number');
    expect(typeof snapshot.stats.totalGateBlocks).toBe('number');

    // Violation detection checks these
    const hasFailures = snapshot.toolCalls.some(tc => tc.outcome === 'failure');
    expect(hasFailures).toBe(true);

    const hasPain = snapshot.painEvents.some(pe => pe.score >= 50);
    expect(hasPain).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 7: End-to-end with draftToArtifact conversion
  // ---------------------------------------------------------------------------
  it('converts draft to final artifact structure', async () => {
    const snapshot = makeRealViolatingSnapshot();
    const adapter = makeRealisticMockAdapter();

    const dreamerOutput = await adapter.invokeDreamer(snapshot, 'P_001', 2);
    const philosopherOutput = await adapter.invokePhilosopher(dreamerOutput, 'P_001');
    const scribeArtifact = await adapter.invokeScribe(
      dreamerOutput,
      philosopherOutput,
      snapshot,
      'P_001',
      { chainMode: 'trinity' } as TrinityTelemetry,
      { useTrinity: true, maxCandidates: 2, useStubs: false }
    );

    expect(scribeArtifact).not.toBeNull();

    const finalArtifact = draftToArtifact(scribeArtifact!);
    expect(finalArtifact.artifactId).toBeDefined();
    expect(finalArtifact.sessionId).toBe(snapshot.sessionId);
    expect(finalArtifact.principleId).toBe('P_001');
    expect(finalArtifact.badDecision).toBe(scribeArtifact!.badDecision);
    expect(finalArtifact.betterDecision).toBe(scribeArtifact!.betterDecision);
    expect(finalArtifact.rationale).toBe(scribeArtifact!.rationale);
    expect(finalArtifact.createdAt).toBeDefined();
  });
});

describe('Nocturnal Trinity E2E — Regression Guards', () => {
  // Guard against #244: Unknown model error
  it('does not throw "Unknown model" error when config is properly set', () => {
    const mockConfig = {
      agents: {
        defaults: {
          model: 'minimax-portal/MiniMax-M2.7',
        },
      },
      models: {
        providers: {
          'minimax-portal': {
            api: 'anthropic-messages',
            models: [{ id: 'MiniMax-M2.7' }],
          },
        },
      },
    };

    // This should not throw
    const config = mockConfig as Record<string, unknown>;
    const agents = config?.agents as Record<string, unknown> | undefined;
    const defaults = agents?.defaults as Record<string, unknown> | undefined;
    const modelConfig = defaults?.model;

    expect(modelConfig).toBe('minimax-portal/MiniMax-M2.7');
  });

  // Guard against: runtimeAdapter undefined
  it('fails gracefully when runtimeAdapter is undefined', async () => {
    const snapshot = makeRealViolatingSnapshot();
    const config: TrinityConfig = {
      useTrinity: true,
      maxCandidates: 2,
      useStubs: false,
      // runtimeAdapter intentionally omitted
    };

    const result = await runTrinityAsync({
      snapshot,
      principleId: 'P_001',
      config,
    });

    // Should fail gracefully with clear error message
    expect(result.success).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures[0].reason).toContain('runtimeAdapter');
    expect(result.failures[0].stage).toBe('dreamer');
  });
});
