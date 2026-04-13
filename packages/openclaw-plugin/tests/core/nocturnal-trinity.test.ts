import { describe, it, expect, vi } from 'vitest';
import {
  runTrinity,
  runTrinityAsync,
  validateDraftArtifact,
  draftToArtifact,
  DEFAULT_TRINITY_CONFIG,
  OpenClawTrinityRuntimeAdapter,
  TrinityRuntimeContractError,
  NOCTURNAL_DREAMER_PROMPT,
  formatReasoningContext,
  invokeStubDreamer,
  type TrinityConfig,
  type DreamerOutput,
  type DreamerCandidate,
  type PhilosopherOutput,
  type TrinityDraftArtifact,
  type TrinityRuntimeAdapter,
  type TrinityTelemetry,
} from '../../src/core/nocturnal-trinity.js';
import {
  validateDreamerOutput,
  validatePhilosopherOutput,
  validateTrinityDraft,
} from '../../src/core/nocturnal-arbiter.js';

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<{
  failureCount: number;
  totalPainEvents: number;
  totalGateBlocks: number;
}> = {}) {
  return {
    sessionId: 'session-test-123',
    startedAt: '2026-04-12T00:00:00.000Z',
    updatedAt: '2026-04-12T00:05:00.000Z',
    assistantTurns: [],
    userTurns: [],
    toolCalls: [],
    painEvents: [],
    gateBlocks: [],
    stats: {
      failureCount: overrides.failureCount ?? 0,
      totalPainEvents: overrides.totalPainEvents ?? 0,
      totalGateBlocks: overrides.totalGateBlocks ?? 0,
      totalAssistantTurns: 5,
      totalToolCalls: 10,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests: validateDreamerOutput
// ---------------------------------------------------------------------------

describe('validateDreamerOutput', () => {
  it('passes a valid Dreamer output with candidates', () => {
    const output = {
      valid: true,
      candidates: [
        {
          candidateIndex: 0,
          badDecision: 'Did something wrong',
          betterDecision: 'Do it right',
          rationale: 'Because the principle says so',
          confidence: 0.9,
        },
      ],
      generatedAt: '2026-03-27T12:00:00.000Z',
    };
    const result = validateDreamerOutput(output);
    expect(result.valid).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it('passes a valid Dreamer output with multiple candidates', () => {
    const output = {
      valid: true,
      candidates: [
        {
          candidateIndex: 0,
          badDecision: 'Did something wrong',
          betterDecision: 'Do it right',
          rationale: 'Because the principle says so',
          confidence: 0.9,
        },
        {
          candidateIndex: 1,
          badDecision: 'Did another wrong thing',
          betterDecision: 'Do it differently',
          rationale: 'Alternative approach is better',
          confidence: 0.8,
        },
      ],
      generatedAt: '2026-03-27T12:00:00.000Z',
    };
    const result = validateDreamerOutput(output);
    expect(result.valid).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it('rejects Dreamer output marked invalid', () => {
    const output = {
      valid: false,
      candidates: [],
      reason: 'No signal found',
      generatedAt: '2026-03-27T12:00:00.000Z',
    };
    const result = validateDreamerOutput(output);
    expect(result.valid).toBe(false);
    expect(result.failures.some(f => f.includes('marked invalid'))).toBe(true);
  });

  it('rejects Dreamer output marked invalid without reason', () => {
    const output = {
      valid: false,
      candidates: [],
      generatedAt: '2026-03-27T12:00:00.000Z',
    };
    const result = validateDreamerOutput(output);
    expect(result.valid).toBe(false);
  });

  it('rejects Dreamer output without candidates array', () => {
    const output = {
      valid: true,
      generatedAt: '2026-03-27T12:00:00.000Z',
    };
    const result = validateDreamerOutput(output);
    expect(result.valid).toBe(false);
    expect(result.failures.some(f => f.includes('candidates array'))).toBe(true);
  });

  it('rejects Dreamer candidate missing required fields', () => {
    const output = {
      valid: true,
      candidates: [
        {
          candidateIndex: 0,
          badDecision: 'Has badDecision but missing betterDecision',
          // missing: betterDecision, rationale, confidence
        },
      ],
      generatedAt: '2026-03-27T12:00:00.000Z',
    };
    const result = validateDreamerOutput(output);
    expect(result.valid).toBe(false);
    expect(result.failures.some(f => f.includes('betterDecision'))).toBe(true);
    expect(result.failures.some(f => f.includes('rationale'))).toBe(true);
    expect(result.failures.some(f => f.includes('confidence'))).toBe(true);
  });

  it('rejects Dreamer candidate with invalid confidence (out of range)', () => {
    const output = {
      valid: true,
      candidates: [
        {
          candidateIndex: 0,
          badDecision: 'Wrong',
          betterDecision: 'Right',
          rationale: 'Because',
          confidence: 1.5, // out of range
        },
      ],
      generatedAt: '2026-03-27T12:00:00.000Z',
    };
    const result = validateDreamerOutput(output);
    expect(result.valid).toBe(false);
    expect(result.failures.some(f => f.includes('confidence'))).toBe(true);
  });

  it('rejects Dreamer candidate with duplicate candidateIndex', () => {
    const output = {
      valid: true,
      candidates: [
        {
          candidateIndex: 0,
          badDecision: 'Wrong 1',
          betterDecision: 'Right 1',
          rationale: 'Because 1',
          confidence: 0.9,
        },
        {
          candidateIndex: 0, // duplicate
          badDecision: 'Wrong 2',
          betterDecision: 'Right 2',
          rationale: 'Because 2',
          confidence: 0.8,
        },
      ],
      generatedAt: '2026-03-27T12:00:00.000Z',
    };
    const result = validateDreamerOutput(output);
    expect(result.valid).toBe(false);
    expect(result.failures.some(f => f.includes('duplicate'))).toBe(true);
  });

  it('rejects Dreamer candidate with identical badDecision and betterDecision', () => {
    const output = {
      valid: true,
      candidates: [
        {
          candidateIndex: 0,
          badDecision: 'Do the same thing',
          betterDecision: 'Do the same thing', // identical
          rationale: 'Because it is correct',
          confidence: 0.9,
        },
      ],
      generatedAt: '2026-03-27T12:00:00.000Z',
    };
    const result = validateDreamerOutput(output);
    expect(result.valid).toBe(false);
    expect(result.failures.some(f => f.includes('identical'))).toBe(true);
  });

  it('rejects Dreamer output missing generatedAt', () => {
    const output = {
      valid: true,
      candidates: [
        {
          candidateIndex: 0,
          badDecision: 'Wrong',
          betterDecision: 'Right',
          rationale: 'Because',
          confidence: 0.9,
        },
      ],
      // missing generatedAt
    };
    const result = validateDreamerOutput(output);
    expect(result.valid).toBe(false);
    expect(result.failures.some(f => f.includes('generatedAt'))).toBe(true);
  });

  it('rejects non-object input', () => {
    const result = validateDreamerOutput(null);
    expect(result.valid).toBe(false);
  });

  it('rejects string input', () => {
    const result = validateDreamerOutput('not an object');
    expect(result.valid).toBe(false);
  });
});

describe('OpenClawTrinityRuntimeAdapter contract hardening', () => {
  function makeRuntimeApi(overrides: Partial<any> = {}) {
    return {
      runtime: {
        agent: {
          runEmbeddedPiAgent: vi.fn().mockResolvedValue({
            payloads: [
              { text: '{"valid":true,"candidates":[],"generatedAt":"2026-04-12T00:00:00.000Z"}' },
            ],
          }),
        },
        config: {
          loadConfig: vi.fn().mockReturnValue({
            agents: {
              defaults: {
                model: 'openai/gpt-5.4',
              },
            },
          }),
        },
        ...overrides.runtime,
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    };
  }

  it('rejects missing runtime.agent.runEmbeddedPiAgent contract explicitly', () => {
    expect(() => new OpenClawTrinityRuntimeAdapter({ runtime: {} } as any)).toThrow(TrinityRuntimeContractError);
    expect(() => new OpenClawTrinityRuntimeAdapter({ runtime: {} } as any)).toThrow(/runtime_unavailable/);
  });

  it('passes explicit provider/model overrides into runtime.agent.runEmbeddedPiAgent', async () => {
    const api = makeRuntimeApi();
    const adapter = new OpenClawTrinityRuntimeAdapter(api as any);

    await adapter.invokeDreamer(makeSnapshot({ failureCount: 1 }) as any, 'T-08', 2);

    expect(api.runtime.agent.runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai',
        model: 'gpt-5.4',
      }),
    );
  });

  it('returns stable failure classes when runtime invocation fails', async () => {
    const api = makeRuntimeApi({
      runtime: {
        agent: {
          runEmbeddedPiAgent: vi.fn().mockRejectedValue(new Error('gateway unavailable')),
        },
      },
    });
    const adapter = new OpenClawTrinityRuntimeAdapter(api as any);

    const result = await adapter.invokeDreamer(makeSnapshot({ failureCount: 1 }) as any, 'T-08', 2);

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('runtime_run_failed');
    expect(adapter.getLastFailureReason()).toContain('runtime_run_failed');
  });
});

// ---------------------------------------------------------------------------
// Tests: validatePhilosopherOutput
// ---------------------------------------------------------------------------

describe('validatePhilosopherOutput', () => {
  it('passes a valid Philosopher output', () => {
    const output = {
      valid: true,
      judgments: [
        {
          candidateIndex: 0,
          critique: 'Strong alignment',
          principleAligned: true,
          score: 0.92,
          rank: 1,
        },
      ],
      overallAssessment: 'Good candidate set',
      generatedAt: '2026-03-27T12:00:00.000Z',
    };
    const result = validatePhilosopherOutput(output);
    expect(result.valid).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it('rejects Philosopher output marked invalid', () => {
    const output = {
      valid: false,
      judgments: [],
      reason: 'No candidates to judge',
      generatedAt: '2026-03-27T12:00:00.000Z',
    };
    const result = validatePhilosopherOutput(output);
    expect(result.valid).toBe(false);
  });

  it('rejects Philosopher output without judgments array', () => {
    const output = {
      valid: true,
      overallAssessment: 'Good',
      generatedAt: '2026-03-27T12:00:00.000Z',
    };
    const result = validatePhilosopherOutput(output);
    expect(result.valid).toBe(false);
    expect(result.failures.some(f => f.includes('judgments array'))).toBe(true);
  });

  it('rejects Philosopher judgment missing required fields', () => {
    const output = {
      valid: true,
      judgments: [
        {
          candidateIndex: 0,
          // missing: critique, principleAligned, score, rank
        },
      ],
      overallAssessment: 'Good',
      generatedAt: '2026-03-27T12:00:00.000Z',
    };
    const result = validatePhilosopherOutput(output);
    expect(result.valid).toBe(false);
  });

  it('rejects Philosopher judgment with invalid score (out of range)', () => {
    const output = {
      valid: true,
      judgments: [
        {
          candidateIndex: 0,
          critique: 'Good',
          principleAligned: true,
          score: 1.5, // out of range
          rank: 1,
        },
      ],
      overallAssessment: 'Good',
      generatedAt: '2026-03-27T12:00:00.000Z',
    };
    const result = validatePhilosopherOutput(output);
    expect(result.valid).toBe(false);
    expect(result.failures.some(f => f.includes('score'))).toBe(true);
  });

  it('rejects Philosopher judgment with invalid rank (must be >= 1)', () => {
    const output = {
      valid: true,
      judgments: [
        {
          candidateIndex: 0,
          critique: 'Good',
          principleAligned: true,
          score: 0.9,
          rank: 0, // invalid
        },
      ],
      overallAssessment: 'Good',
      generatedAt: '2026-03-27T12:00:00.000Z',
    };
    const result = validatePhilosopherOutput(output);
    expect(result.valid).toBe(false);
    expect(result.failures.some(f => f.includes('rank'))).toBe(true);
  });

  it('rejects Philosopher output with non-sequential ranks', () => {
    const output = {
      valid: true,
      judgments: [
        {
          candidateIndex: 0,
          critique: 'Good',
          principleAligned: true,
          score: 0.9,
          rank: 1,
        },
        {
          candidateIndex: 1,
          critique: 'Also good',
          principleAligned: true,
          score: 0.8,
          rank: 3, // should be 2
        },
      ],
      overallAssessment: 'Good',
      generatedAt: '2026-03-27T12:00:00.000Z',
    };
    const result = validatePhilosopherOutput(output);
    expect(result.valid).toBe(false);
    expect(result.failures.some(f => f.includes('sequential ranks'))).toBe(true);
  });

  it('rejects Philosopher output missing overallAssessment', () => {
    const output = {
      valid: true,
      judgments: [
        {
          candidateIndex: 0,
          critique: 'Good',
          principleAligned: true,
          score: 0.9,
          rank: 1,
        },
      ],
      // missing overallAssessment
      generatedAt: '2026-03-27T12:00:00.000Z',
    };
    const result = validatePhilosopherOutput(output);
    expect(result.valid).toBe(false);
    expect(result.failures.some(f => f.includes('overallAssessment'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: validateTrinityDraft
// ---------------------------------------------------------------------------

describe('validateTrinityDraft', () => {
  function makeValidDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      selectedCandidateIndex: 0,
      badDecision: 'Did something wrong',
      betterDecision: 'Do it right',
      rationale: 'Because the principle says so and this is the right approach',
      sessionId: 'session-test-123',
      principleId: 'T-01',
      sourceSnapshotRef: 'snapshot-test-001',
      telemetry: {
        chainMode: 'trinity',
        dreamerPassed: true,
        philosopherPassed: true,
        scribePassed: true,
        candidateCount: 3,
        selectedCandidateIndex: 0,
        stageFailures: [],
      },
      ...overrides,
    };
  }

  it('passes a valid Trinity draft artifact', () => {
    const draft = makeValidDraft();
    const result = validateTrinityDraft(draft);
    expect(result.valid).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it('rejects draft with missing badDecision', () => {
    const draft = makeValidDraft();
    delete draft.badDecision;
    const result = validateTrinityDraft(draft);
    expect(result.valid).toBe(false);
    expect(result.failures.some(f => f.includes('badDecision'))).toBe(true);
  });

  it('rejects draft with empty badDecision', () => {
    const draft = makeValidDraft({ badDecision: '   ' });
    const result = validateTrinityDraft(draft);
    expect(result.valid).toBe(false);
    expect(result.failures.some(f => f.includes('badDecision'))).toBe(true);
  });

  it('rejects draft with short rationale (< 20 chars)', () => {
    const draft = makeValidDraft({ rationale: 'Too short' });
    const result = validateTrinityDraft(draft);
    expect(result.valid).toBe(false);
    expect(result.failures.some(f => f.includes('rationale'))).toBe(true);
  });

  it('rejects draft with identical badDecision and betterDecision', () => {
    const draft = makeValidDraft({
      badDecision: 'Same thing',
      betterDecision: 'Same thing',
    });
    const result = validateTrinityDraft(draft);
    expect(result.valid).toBe(false);
    expect(result.failures.some(f => f.includes('identical'))).toBe(true);
  });

  it('rejects draft with invalid telemetry', () => {
    const draft = makeValidDraft({ telemetry: null });
    const result = validateTrinityDraft(draft);
    expect(result.valid).toBe(false);
    expect(result.failures.some(f => f.includes('telemetry'))).toBe(true);
  });

  it('rejects draft with invalid chainMode in telemetry', () => {
    const draft = makeValidDraft({
      telemetry: {
        chainMode: 'invalid-mode', // must be 'trinity' or 'single-reflector'
        dreamerPassed: true,
        philosopherPassed: true,
        scribePassed: true,
        candidateCount: 3,
        selectedCandidateIndex: 0,
        stageFailures: [],
      },
    });
    const result = validateTrinityDraft(draft);
    expect(result.valid).toBe(false);
    expect(result.failures.some(f => f.includes('chainMode'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: runTrinity — successful path
// ---------------------------------------------------------------------------

describe('runTrinity', () => {
  it('produces a successful Trinity result with valid snapshot (failure signal)', () => {
    const snapshot = makeSnapshot({ failureCount: 2 });
    const config: TrinityConfig = {
      useTrinity: true,
      maxCandidates: 3,
      useStubs: true, // Use stub implementations
    };

    const result = runTrinity({ snapshot, principleId: 'T-08', config });

    expect(result.success).toBe(true);
    expect(result.artifact).toBeDefined();
    expect(result.telemetry.chainMode).toBe('trinity');
    expect(result.telemetry.dreamerPassed).toBe(true);
    expect(result.telemetry.philosopherPassed).toBe(true);
    expect(result.telemetry.scribePassed).toBe(true);
    expect(result.telemetry.candidateCount).toBeGreaterThan(0);
    expect(result.telemetry.selectedCandidateIndex).toBeGreaterThanOrEqual(0);
    expect(result.failures).toHaveLength(0);
    expect(result.fallbackOccurred).toBe(false);
  });

  it('produces a successful Trinity result with pain signal', () => {
    const snapshot = makeSnapshot({ totalPainEvents: 3 });
    const config: TrinityConfig = {
      useTrinity: true,
      maxCandidates: 3,
      useStubs: true,
    };

    const result = runTrinity({ snapshot, principleId: 'T-08', config });

    expect(result.success).toBe(true);
    expect(result.artifact).toBeDefined();
  });

  it('produces a successful Trinity result with gate block signal', () => {
    const snapshot = makeSnapshot({ totalGateBlocks: 1 });
    const config: TrinityConfig = {
      useTrinity: true,
      maxCandidates: 3,
      useStubs: true,
    };

    const result = runTrinity({ snapshot, principleId: 'T-03', config });

    expect(result.success).toBe(true);
    expect(result.artifact).toBeDefined();
  });

  it('respects maxCandidates config', () => {
    const snapshot = makeSnapshot({ failureCount: 5 });
    const config: TrinityConfig = {
      useTrinity: true,
      maxCandidates: 2,
      useStubs: true,
    };

    const result = runTrinity({ snapshot, principleId: 'T-08', config });

    expect(result.success).toBe(true);
    expect(result.telemetry.candidateCount).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: runTrinity — failure paths
// ---------------------------------------------------------------------------

describe('runTrinity — failure paths', () => {
  it('fails when snapshot has no signal and generates no candidates', () => {
    // Snapshot with all zero stats - stub will fail to generate candidates
    const snapshot = makeSnapshot({
      failureCount: 0,
      totalPainEvents: 0,
      totalGateBlocks: 0,
    });
    const config: TrinityConfig = {
      useTrinity: true,
      maxCandidates: 3,
      useStubs: true,
    };

    const result = runTrinity({ snapshot, principleId: 'T-08', config });

    expect(result.success).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures[0].stage).toBe('dreamer');
    expect(result.telemetry.dreamerPassed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: validateDraftArtifact
// ---------------------------------------------------------------------------

describe('validateDraftArtifact', () => {
  function makeValidArtifact(): TrinityDraftArtifact {
    return {
      selectedCandidateIndex: 0,
      badDecision: 'Did something wrong',
      betterDecision: 'Do it right',
      rationale: 'Because the principle says so and this is the correct approach',
      sessionId: 'session-test-123',
      principleId: 'T-01',
      sourceSnapshotRef: 'snapshot-test-001',
      telemetry: {
        chainMode: 'trinity',
        dreamerPassed: true,
        philosopherPassed: true,
        scribePassed: true,
        candidateCount: 3,
        selectedCandidateIndex: 0,
        stageFailures: [],
      },
    };
  }

  it('passes a valid TrinityDraftArtifact', () => {
    const artifact = makeValidArtifact();
    const result = validateDraftArtifact(artifact);
    expect(result.valid).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it('rejects artifact with missing badDecision', () => {
    const artifact = makeValidArtifact();
    delete (artifact as Record<string, unknown>).badDecision;
    const result = validateDraftArtifact(artifact);
    expect(result.valid).toBe(false);
  });

  it('rejects artifact with empty betterDecision', () => {
    const artifact = makeValidArtifact();
    artifact.betterDecision = '   ';
    const result = validateDraftArtifact(artifact);
    expect(result.valid).toBe(false);
  });

  it('rejects artifact with short rationale', () => {
    const artifact = makeValidArtifact();
    artifact.rationale = 'Too short';
    const result = validateDraftArtifact(artifact);
    expect(result.valid).toBe(false);
  });

  it('rejects artifact with identical badDecision and betterDecision', () => {
    const artifact = makeValidArtifact();
    artifact.badDecision = 'Same';
    artifact.betterDecision = 'Same';
    const result = validateDraftArtifact(artifact);
    expect(result.valid).toBe(false);
    expect(result.failures.some(f => f.includes('identical'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: draftToArtifact
// ---------------------------------------------------------------------------

describe('draftToArtifact', () => {
  it('converts TrinityDraftArtifact to NocturnalArtifact-compatible structure', () => {
    const draft: TrinityDraftArtifact = {
      selectedCandidateIndex: 1,
      badDecision: 'Did something wrong',
      betterDecision: 'Do it right',
      rationale: 'Because the principle says so',
      sessionId: 'session-test-123',
      principleId: 'T-01',
      sourceSnapshotRef: 'snapshot-test-001',
      telemetry: {
        chainMode: 'trinity',
        dreamerPassed: true,
        philosopherPassed: true,
        scribePassed: true,
        candidateCount: 3,
        selectedCandidateIndex: 1,
        stageFailures: [],
      },
    };

    const artifact = draftToArtifact(draft);

    expect(artifact.artifactId).toBeDefined(); // Generated UUID
    expect(artifact.sessionId).toBe('session-test-123');
    expect(artifact.principleId).toBe('T-01');
    expect(artifact.badDecision).toBe('Did something wrong');
    expect(artifact.betterDecision).toBe('Do it right');
    expect(artifact.rationale).toBe('Because the principle says so');
    expect(artifact.sourceSnapshotRef).toBe('snapshot-test-001');
    expect(artifact.createdAt).toBeDefined(); // Current timestamp
  });
});

// ---------------------------------------------------------------------------
// Tests: DEFAULT_TRINITY_CONFIG
// ---------------------------------------------------------------------------

describe('DEFAULT_TRINITY_CONFIG', () => {
  it('has sensible defaults', () => {
    expect(DEFAULT_TRINITY_CONFIG.useTrinity).toBe(true);
    expect(DEFAULT_TRINITY_CONFIG.maxCandidates).toBe(3);
    expect(DEFAULT_TRINITY_CONFIG.useStubs).toBe(false);  // real subagent execution is now the default
  });
});

// ---------------------------------------------------------------------------
// Tests: runTrinity — useStubs=false without adapter (sync failure)
// ---------------------------------------------------------------------------

describe('runTrinity — useStubs=false without adapter', () => {
  it('fails with clear error when useStubs=false but no runtimeAdapter provided', () => {
    const snapshot = makeSnapshot({ failureCount: 2 });
    const config: TrinityConfig = {
      useTrinity: true,
      maxCandidates: 3,
      useStubs: false,  // No adapter provided!
    };

    const result = runTrinity({ snapshot, principleId: 'T-08', config });

    expect(result.success).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures[0].stage).toBe('dreamer');
    expect(result.failures[0].reason).toContain('runtimeAdapter');
    expect(result.telemetry.usedStubs).toBe(false);
    expect(result.telemetry.dreamerPassed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: runTrinityAsync — with mock runtime adapter
// ---------------------------------------------------------------------------

describe('runTrinityAsync — with mock runtime adapter', () => {
  function makeMockAdapter(overrides: Partial<{
    dreamerOutput: DreamerOutput;
    philosopherOutput: PhilosopherOutput;
    scribeArtifact: TrinityDraftArtifact | null;
    closeCalled: boolean;
  }> = {}): TrinityRuntimeAdapter & { closeCalled: boolean } {
    const defaultDreamerOutput: DreamerOutput = {
      valid: true,
      candidates: [
        {
          candidateIndex: 0,
          badDecision: 'Did something wrong',
          betterDecision: 'Do it right',
          rationale: 'Because the principle says so',
          confidence: 0.9,
        },
      ],
      generatedAt: new Date().toISOString(),
    };

    const defaultPhilosopherOutput: PhilosopherOutput = {
      valid: true,
      judgments: [
        {
          candidateIndex: 0,
          critique: 'Good alignment',
          principleAligned: true,
          score: 0.92,
          rank: 1,
        },
      ],
      overallAssessment: 'Good candidate',
      generatedAt: new Date().toISOString(),
    };

    const defaultScribeArtifact: TrinityDraftArtifact = {
      selectedCandidateIndex: 0,
      badDecision: 'Did something wrong',
      betterDecision: 'Do it right',
      rationale: 'Because the principle says so and this is the right approach',
      sessionId: 'session-test-123',
      principleId: 'T-01',
      sourceSnapshotRef: 'snapshot-test-001',
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

    return {
      closeCalled: overrides.closeCalled ?? false,
      invokeDreamer: vi.fn().mockResolvedValue(overrides.dreamerOutput ?? defaultDreamerOutput),
      invokePhilosopher: vi.fn().mockResolvedValue(overrides.philosopherOutput ?? defaultPhilosopherOutput),
      invokeScribe: vi.fn().mockResolvedValue(
        overrides.scribeArtifact === null ? null : (overrides.scribeArtifact ?? defaultScribeArtifact)
      ),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as TrinityRuntimeAdapter & { closeCalled: boolean; invokeDreamer: ReturnType<typeof vi.fn>; invokePhilosopher: ReturnType<typeof vi.fn>; invokeScribe: ReturnType<typeof vi.fn> };
  }

  it('uses runtime adapter when useStubs=false with adapter provided', async () => {
    const snapshot = makeSnapshot({ failureCount: 2 });
    const adapter = makeMockAdapter();
    const config: TrinityConfig = {
      useTrinity: true,
      maxCandidates: 3,
      useStubs: false,
      runtimeAdapter: adapter,
    };

    const result = await runTrinityAsync({ snapshot, principleId: 'T-08', config });

    expect(result.success).toBe(true);
    expect(adapter.invokeDreamer).toHaveBeenCalledWith(snapshot, 'T-08', 3);
    expect(adapter.invokePhilosopher).toHaveBeenCalled();
    expect(adapter.invokeScribe).toHaveBeenCalled();
    expect(result.telemetry.usedStubs).toBe(false);
    expect(result.telemetry.dreamerPassed).toBe(true);
    expect(result.telemetry.philosopherPassed).toBe(true);
    expect(result.telemetry.scribePassed).toBe(true);
  });

  it('fails closed when Dreamer stage returns invalid output', async () => {
    const snapshot = makeSnapshot({ failureCount: 2 });
    const adapter = makeMockAdapter({
      dreamerOutput: { valid: false, candidates: [], reason: 'No signal found', generatedAt: new Date().toISOString() },
    });
    const config: TrinityConfig = {
      useTrinity: true,
      maxCandidates: 3,
      useStubs: false,
      runtimeAdapter: adapter,
    };

    const result = await runTrinityAsync({ snapshot, principleId: 'T-08', config });

    expect(result.success).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures[0].stage).toBe('dreamer');
    expect(result.telemetry.dreamerPassed).toBe(false);
    expect(result.telemetry.philosopherPassed).toBe(false);
    expect(result.telemetry.scribePassed).toBe(false);
  });

  it('fails closed when Philosopher stage returns invalid output', async () => {
    const snapshot = makeSnapshot({ failureCount: 2 });
    const adapter = makeMockAdapter({
      philosopherOutput: { valid: false, judgments: [], overallAssessment: '', reason: 'No candidates', generatedAt: new Date().toISOString() },
    });
    const config: TrinityConfig = {
      useTrinity: true,
      maxCandidates: 3,
      useStubs: false,
      runtimeAdapter: adapter,
    };

    const result = await runTrinityAsync({ snapshot, principleId: 'T-08', config });

    expect(result.success).toBe(false);
    expect(result.failures.some(f => f.stage === 'dreamer')).toBe(false);  // Dreamer passed
    expect(result.failures.some(f => f.stage === 'philosopher')).toBe(true);
    expect(result.telemetry.dreamerPassed).toBe(true);
    expect(result.telemetry.philosopherPassed).toBe(false);
  });

  it('fails closed when Scribe stage returns null', async () => {
    const snapshot = makeSnapshot({ failureCount: 2 });
    const adapter = makeMockAdapter({ scribeArtifact: null });
    const config: TrinityConfig = {
      useTrinity: true,
      maxCandidates: 3,
      useStubs: false,
      runtimeAdapter: adapter,
    };

    const result = await runTrinityAsync({ snapshot, principleId: 'T-08', config });

    expect(result.success).toBe(false);
    expect(result.failures.some(f => f.stage === 'scribe')).toBe(true);
    expect(result.telemetry.dreamerPassed).toBe(true);
    expect(result.telemetry.philosopherPassed).toBe(true);
    expect(result.telemetry.scribePassed).toBe(false);
  });

  it('calls adapter.close() after successful execution', async () => {
    const snapshot = makeSnapshot({ failureCount: 2 });
    const adapter = makeMockAdapter();
    const config: TrinityConfig = {
      useTrinity: true,
      maxCandidates: 3,
      useStubs: false,
      runtimeAdapter: adapter,
    };

    await runTrinityAsync({ snapshot, principleId: 'T-08', config });

    expect(adapter.close).toHaveBeenCalled();
  });

  it('calls adapter.close() even when execution fails', async () => {
    const snapshot = makeSnapshot({ failureCount: 2 });
    const adapter = makeMockAdapter({
      dreamerOutput: { valid: false, candidates: [], reason: 'No signal', generatedAt: new Date().toISOString() },
    });
    const config: TrinityConfig = {
      useTrinity: true,
      maxCandidates: 3,
      useStubs: false,
      runtimeAdapter: adapter,
    };

    await runTrinityAsync({ snapshot, principleId: 'T-08', config });

    expect(adapter.close).toHaveBeenCalled();
  });

  it('produces artifact compatible with draftToArtifact', async () => {
    const snapshot = makeSnapshot({ failureCount: 2 });
    const adapter = makeMockAdapter();
    const config: TrinityConfig = {
      useTrinity: true,
      maxCandidates: 3,
      useStubs: false,
      runtimeAdapter: adapter,
    };

    const result = await runTrinityAsync({ snapshot, principleId: 'T-08', config });

    expect(result.success).toBe(true);
    expect(result.artifact).toBeDefined();
    const artifact = draftToArtifact(result.artifact!);
    expect(artifact.artifactId).toBeDefined();
    expect(artifact.sessionId).toBe('session-test-123');
    expect(artifact.principleId).toBe('T-01');
    expect(artifact.badDecision).toBeDefined();
    expect(artifact.betterDecision).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: runTrinityAsync — useStubs=true still uses stubs
// ---------------------------------------------------------------------------

describe('runTrinityAsync — useStubs=true uses synchronous stubs', () => {
  it('still uses stub implementations when useStubs=true even with adapter', async () => {
    const snapshot = makeSnapshot({ failureCount: 2 });
    const adapter = {
      invokeDreamer: vi.fn().mockResolvedValue({ valid: true, candidates: [], generatedAt: new Date().toISOString() }),
      invokePhilosopher: vi.fn().mockResolvedValue({ valid: true, judgments: [], overallAssessment: '', generatedAt: new Date().toISOString() }),
      invokeScribe: vi.fn().mockResolvedValue(null),
    };
    const config: TrinityConfig = {
      useTrinity: true,
      maxCandidates: 3,
      useStubs: true,  // Explicitly use stubs
      runtimeAdapter: adapter as unknown as TrinityRuntimeAdapter,
    };

    // With stubs, adapter is ignored - stub produces success with failureCount signal
    const result = await runTrinityAsync({ snapshot, principleId: 'T-08', config });

    expect(result.success).toBe(true);  // Stub succeeds because snapshot has failureCount
    expect(adapter.invokeDreamer).not.toHaveBeenCalled();  // Adapter NOT called
    expect(adapter.invokePhilosopher).not.toHaveBeenCalled();
    expect(adapter.invokeScribe).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: NOCTURNAL_DREAMER_PROMPT — strategic perspective requirements (Task 1)
// ---------------------------------------------------------------------------

describe('NOCTURNAL_DREAMER_PROMPT — strategic perspective requirements', () => {
  it('contains "## Strategic Perspective Requirements" section', () => {
    expect(NOCTURNAL_DREAMER_PROMPT).toContain('## Strategic Perspective Requirements');
  });

  it('mentions all three strategic perspectives', () => {
    expect(NOCTURNAL_DREAMER_PROMPT).toContain('conservative_fix');
    expect(NOCTURNAL_DREAMER_PROMPT).toContain('structural_improvement');
    expect(NOCTURNAL_DREAMER_PROMPT).toContain('paradigm_shift');
  });

  it('contains ANTI-PATTERN warning', () => {
    expect(NOCTURNAL_DREAMER_PROMPT).toContain('ANTI-PATTERN');
  });

  it('references riskLevel as required candidate field', () => {
    expect(NOCTURNAL_DREAMER_PROMPT).toContain('riskLevel');
  });

  it('references strategicPerspective as required candidate field', () => {
    expect(NOCTURNAL_DREAMER_PROMPT).toContain('strategicPerspective');
  });
});

// ---------------------------------------------------------------------------
// Tests: DreamerCandidate interface — optional fields (Task 1)
// ---------------------------------------------------------------------------

describe('DreamerCandidate interface — optional fields', () => {
  it('accepts a candidate with riskLevel and strategicPerspective', () => {
    const candidate: DreamerCandidate = {
      candidateIndex: 0,
      badDecision: 'Did something wrong',
      betterDecision: 'Do it right',
      rationale: 'Because the principle says so',
      confidence: 0.9,
      riskLevel: 'medium',
      strategicPerspective: 'structural_improvement',
    };
    expect(candidate.riskLevel).toBe('medium');
    expect(candidate.strategicPerspective).toBe('structural_improvement');
  });

  it('accepts a candidate without riskLevel or strategicPerspective (backward compat)', () => {
    const candidate: DreamerCandidate = {
      candidateIndex: 0,
      badDecision: 'Did something wrong',
      betterDecision: 'Do it right',
      rationale: 'Because the principle says so',
      confidence: 0.9,
    };
    expect(candidate.riskLevel).toBeUndefined();
    expect(candidate.strategicPerspective).toBeUndefined();
  });

  it('accepts all valid riskLevel values', () => {
    const levels: Array<'low' | 'medium' | 'high'> = ['low', 'medium', 'high'];
    for (const level of levels) {
      const candidate: DreamerCandidate = {
        candidateIndex: 0,
        badDecision: 'Wrong',
        betterDecision: 'Right',
        rationale: 'Because',
        confidence: 0.8,
        riskLevel: level,
      };
      expect(candidate.riskLevel).toBe(level);
    }
  });

  it('accepts all valid strategicPerspective values', () => {
    const perspectives: Array<'conservative_fix' | 'structural_improvement' | 'paradigm_shift'> = [
      'conservative_fix',
      'structural_improvement',
      'paradigm_shift',
    ];
    for (const perspective of perspectives) {
      const candidate: DreamerCandidate = {
        candidateIndex: 0,
        badDecision: 'Wrong',
        betterDecision: 'Right',
        rationale: 'Because',
        confidence: 0.8,
        strategicPerspective: perspective,
      };
      expect(candidate.strategicPerspective).toBe(perspective);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: buildDreamerPrompt — reasoning context injection (Task 2)
// ---------------------------------------------------------------------------

describe('buildDreamerPrompt — reasoning context injection', () => {
  // Helper to create a minimal snapshot for reasoning context tests
  function makeReasoningSnapshot(overrides: {
    assistantTurns?: any[];
    toolCalls?: any[];
    userTurns?: any[];
  } = {}) {
    return {
      sessionId: 'session-reasoning-test',
      startedAt: '2026-04-13T00:00:00.000Z',
      updatedAt: '2026-04-13T00:05:00.000Z',
      assistantTurns: overrides.assistantTurns ?? [],
      userTurns: overrides.userTurns ?? [],
      toolCalls: overrides.toolCalls ?? [],
      painEvents: [],
      gateBlocks: [],
      stats: {
        failureCount: 0,
        totalPainEvents: 0,
        totalGateBlocks: 0,
        totalAssistantTurns: overrides.assistantTurns?.length ?? 0,
        totalToolCalls: overrides.toolCalls?.length ?? 0,
      },
    };
  }

  it('injects ## Reasoning Context section when assistant turns have thinking content', () => {
    const snapshot = makeReasoningSnapshot({
      assistantTurns: [
        {
          turnIndex: 0,
          sanitizedText: '<thinking>I need to consider the implications carefully</thinking>',
          createdAt: '2026-04-13T00:01:00.000Z',
        },
      ],
    });

    const result = formatReasoningContext(snapshot as any);
    expect(result).toContain('## Reasoning Context');
  });

  it('includes uncertainty markers in reasoning context', () => {
    const snapshot = makeReasoningSnapshot({
      assistantTurns: [
        {
          turnIndex: 0,
          sanitizedText: 'let me verify this first before proceeding with the change',
          createdAt: '2026-04-13T00:01:00.000Z',
        },
      ],
    });

    const result = formatReasoningContext(snapshot as any);
    expect(result).toContain('Uncertainty detected');
  });

  it('includes confidence signal when not high', () => {
    const snapshot = makeReasoningSnapshot({
      assistantTurns: [
        {
          turnIndex: 0,
          sanitizedText: 'I should probably check this more thoroughly before continuing',
          createdAt: '2026-04-13T00:01:00.000Z',
        },
      ],
    });

    const result = formatReasoningContext(snapshot as any);
    // Low or medium confidence should be shown
    expect(result).toMatch(/Confidence:\s*(low|medium)/);
  });

  it('includes contextual factors when present', () => {
    const snapshot = makeReasoningSnapshot({
      assistantTurns: [],
      toolCalls: [
        { toolName: 'Read', outcome: 'success', createdAt: '2026-04-13T00:01:00.000Z' },
        { toolName: 'Edit', outcome: 'success', createdAt: '2026-04-13T00:02:00.000Z' },
      ],
    });

    const result = formatReasoningContext(snapshot as any);
    expect(result).toContain('File structure explored');
  });

  it('omits ## Reasoning Context when no reasoning signals exist', () => {
    const snapshot = makeReasoningSnapshot({
      assistantTurns: [],
      toolCalls: [
        { toolName: 'Edit', outcome: 'success', createdAt: '2026-04-13T00:01:00.000Z' },
      ],
    });

    const result = formatReasoningContext(snapshot as any);
    expect(result).toBeNull();
  });

  it('does not inject decisionPoints', () => {
    const snapshot = makeReasoningSnapshot({
      assistantTurns: [
        {
          turnIndex: 0,
          sanitizedText: '<thinking>some thought</thinking>',
          createdAt: '2026-04-13T00:01:00.000Z',
        },
      ],
    });

    const result = formatReasoningContext(snapshot as any);
    expect(result).not.toContain('decisionPoint');
    expect(result).not.toContain('DecisionPoint');
  });
});

// ---------------------------------------------------------------------------
// Tests: invokeStubDreamer — risk level and perspective mapping (D-07)
// ---------------------------------------------------------------------------

describe('invokeStubDreamer — risk level and perspective mapping (D-07)', () => {
  it('gateBlocks candidates get conservative_fix/low', () => {
    const snapshot = makeSnapshot({ totalGateBlocks: 2 });
    const output = invokeStubDreamer(snapshot as any, 'T-03', 3);
    expect(output.valid).toBe(true);
    expect(output.candidates.length).toBeGreaterThan(0);
    for (const candidate of output.candidates) {
      expect(candidate.riskLevel).toBe('low');
      expect(candidate.strategicPerspective).toBe('conservative_fix');
    }
  });

  it('pain candidates get structural_improvement/medium', () => {
    const snapshot = makeSnapshot({ totalPainEvents: 3 });
    const output = invokeStubDreamer(snapshot as any, 'T-08', 3);
    expect(output.valid).toBe(true);
    expect(output.candidates.length).toBeGreaterThan(0);
    for (const candidate of output.candidates) {
      expect(candidate.riskLevel).toBe('medium');
      expect(candidate.strategicPerspective).toBe('structural_improvement');
    }
  });

  it('failure candidates get paradigm_shift/high', () => {
    const snapshot = makeSnapshot({ failureCount: 2 });
    const output = invokeStubDreamer(snapshot as any, 'T-08', 3);
    expect(output.valid).toBe(true);
    expect(output.candidates.length).toBeGreaterThan(0);
    for (const candidate of output.candidates) {
      expect(candidate.riskLevel).toBe('high');
      expect(candidate.strategicPerspective).toBe('paradigm_shift');
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: runTrinity — diversity telemetry (DIVER-04)
// ---------------------------------------------------------------------------

describe('runTrinity — diversity telemetry (DIVER-04)', () => {
  it('emits diversityCheckPassed=false when stub candidates all have same risk level', () => {
    // Failure signal produces all paradigm_shift/high candidates → not diverse
    const snapshot = makeSnapshot({ failureCount: 2 });
    const config: TrinityConfig = {
      useTrinity: true,
      maxCandidates: 3,
      useStubs: true,
    };

    const result = runTrinity({ snapshot: snapshot as any, principleId: 'T-08', config });

    expect(result.success).toBe(true);
    expect(result.telemetry.diversityCheckPassed).toBe(false);
  });

  it('emits candidateRiskLevels array matching stub mapping', () => {
    const snapshot = makeSnapshot({ failureCount: 2 });
    const config: TrinityConfig = {
      useTrinity: true,
      maxCandidates: 3,
      useStubs: true,
    };

    const result = runTrinity({ snapshot: snapshot as any, principleId: 'T-08', config });

    expect(result.success).toBe(true);
    expect(result.telemetry.candidateRiskLevels).toBeDefined();
    expect(result.telemetry.candidateRiskLevels!.length).toBeGreaterThan(0);
    // All failure stub candidates should be 'high'
    for (const level of result.telemetry.candidateRiskLevels!) {
      expect(level).toBe('high');
    }
  });

  it('pipeline completes even when diversity check fails (soft enforcement)', () => {
    // Failure signal: all candidates have same risk → diversity fails
    const snapshot = makeSnapshot({ failureCount: 2 });
    const config: TrinityConfig = {
      useTrinity: true,
      maxCandidates: 3,
      useStubs: true,
    };

    const result = runTrinity({ snapshot: snapshot as any, principleId: 'T-08', config });

    expect(result.telemetry.diversityCheckPassed).toBe(false);
    expect(result.success).toBe(true);
    expect(result.artifact).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: TrinityTelemetry — diversity fields
// ---------------------------------------------------------------------------

describe('TrinityTelemetry — diversity fields', () => {
  it('accepts optional diversityCheckPassed field', () => {
    const telemetry: TrinityTelemetry = {
      chainMode: 'trinity',
      usedStubs: true,
      dreamerPassed: true,
      philosopherPassed: true,
      scribePassed: true,
      candidateCount: 2,
      selectedCandidateIndex: 0,
      stageFailures: [],
      diversityCheckPassed: true,
    };
    expect(telemetry.diversityCheckPassed).toBe(true);
  });

  it('accepts optional candidateRiskLevels field', () => {
    const telemetry: TrinityTelemetry = {
      chainMode: 'trinity',
      usedStubs: true,
      dreamerPassed: true,
      philosopherPassed: true,
      scribePassed: true,
      candidateCount: 2,
      selectedCandidateIndex: 0,
      stageFailures: [],
      candidateRiskLevels: ['low', 'high'],
    };
    expect(telemetry.candidateRiskLevels).toEqual(['low', 'high']);
  });
});
