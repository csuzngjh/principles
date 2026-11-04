/**
 * Pain Phase 0 — retired llm_output pain sources (behavioral regression).
 *
 * SPEC PD-PAIN-SEMANTICS-AND-DETECTION-ARCHITECTURE-001 v0.3 §6/§9:
 * - Semantic Confusion (DetectionService funnel) no longer creates Pain.
 * - LLM Paralysis (stuckLoops) no longer creates Pain.
 * - The GFI health-side branch that used to feed the shared write points
 *   (eventLog.recordPainSignal + trajectory recordPainEvent) was deleted by
 *   GFI-COMPLETE-REMOVAL-001 (SPEC §3.5/§7.1), so its differential pin is
 *   removed along with the mechanism it froze.
 *
 * ERR checklist:
 * - ERR-009: fail-loud assertions on every retired write point.
 * - ERR-025: exercises the real handleLlmOutput path (module-level mocks only
 *   for I/O owners: workspace-context, session-tracker state, pain emitter).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks (I/O owners only; triage/trigger policy stays REAL) ────────

const mockRecordPainSignal = vi.fn();
const mockRecordPainEvent = vi.fn();
const mockRecordAssistantTurn = vi.fn();
const mockRecordTaskOutcome = vi.fn();

vi.mock('../../src/core/workspace-context.js', () => ({
  WorkspaceContext: {
    fromHookContext: vi.fn(() => ({
      workspaceDir: '/mock/workspace',
      stateDir: '/mock/workspace/.state',
      config: {
        get: (key: string) => {
          const values: Record<string, number> = {
            'thresholds.pain_trigger': 30,
            'severity_thresholds.high': 70,
          };
          return values[key];
        },
      },
      eventLog: {
        recordPainSignal: mockRecordPainSignal,
        getLastEmpathyEventId: vi.fn(() => null),
        rollbackEmpathyEvent: vi.fn(() => 0),
      },
      trajectory: {
        recordAssistantTurn: mockRecordAssistantTurn,
        recordTaskOutcome: mockRecordTaskOutcome,
        recordPainEvent: mockRecordPainEvent,
        getLatestCorrectionTurn: vi.fn(() => null),
      },
    })),
  },
}));

let mockSessionState = {
  stuckLoops: 0,
  totalInputTokens: 0,
};

vi.mock('../../src/core/session-tracker.js', () => ({
  trackLlmOutput: vi.fn(() => mockSessionState),
  resetFriction: vi.fn(),
  getInjectedPrincipleIds: vi.fn(() => []),
}));

vi.mock('../../src/core/principle-application-ledger.js', () => ({
  recordSelfReportFromText: vi.fn(),
}));

vi.mock('../../src/hooks/pain.js', () => ({
  emitPainDetectedEvent: vi.fn(),
}));

vi.mock('../../src/hooks/trigger-cooldown-tracker.js', () => ({
  isSharedCooldownActive: vi.fn(() => false),
  markSharedEpisodeAsDiagnosed: vi.fn(),
}));

import { handleLlmOutput } from '../../src/hooks/llm.js';
import { emitPainDetectedEvent } from '../../src/hooks/pain.js';

function makeEvent(text: string) {
  return {
    assistantTexts: [text],
    runId: 'run-1',
    provider: 'test',
    model: 'test-model',
    usage: { input: 100, output: 50 },
    lastAssistant: null,
  };
}

function makeCtx() {
  return {
    workspaceDir: '/mock/workspace',
    sessionId: 'sess-retire',
    sessionKey: 'sess-retire',
    agentId: 'main',
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSessionState = { stuckLoops: 0, totalInputTokens: 0 };
});

describe('Pain Phase 0: Semantic Confusion text no longer creates Pain', () => {
  it('old semantic-confusion phrasing produces zero pain writes', () => {
    handleLlmOutput(makeEvent("I'm sorry, but I'm still getting an error. I apologize for the confusion."), makeCtx());

    expect(mockRecordPainSignal).not.toHaveBeenCalled();
    expect(mockRecordPainEvent).not.toHaveBeenCalled();
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();
  });

  it('empathy structured-tag text produces zero pain writes (detection path gone)', () => {
    handleLlmOutput(makeEvent('[EMOTIONAL_DAMAGE_DETECTED:severe]'), makeCtx());

    expect(mockRecordPainSignal).not.toHaveBeenCalled();
    expect(mockRecordPainEvent).not.toHaveBeenCalled();
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();
  });

  it('assistant turn + task outcome keep recording (trajectory decoupled)', () => {
    handleLlmOutput(makeEvent('plain helpful answer'), makeCtx());

    expect(mockRecordAssistantTurn).toHaveBeenCalledTimes(1);
    expect(mockRecordTaskOutcome).toHaveBeenCalledTimes(1);
    expect(mockRecordAssistantTurn.mock.calls[0][0].empathySignalJson).toEqual(
      expect.objectContaining({ detected: false }),
    );
  });
});

describe('Pain Phase 0: LLM Paralysis state no longer creates Pain', () => {
  it('stuck loops + huge input tokens produce zero pain writes', () => {
    // Pre-Phase-0 this state assigned score 40 / source llm_paralysis.
    mockSessionState = { stuckLoops: 99, totalInputTokens: 9_999_999 };

    handleLlmOutput(makeEvent('tiny output'), makeCtx());

    expect(mockRecordPainSignal).not.toHaveBeenCalled();
    expect(mockRecordPainEvent).not.toHaveBeenCalled();
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();
    // Assistant turn evidence still captured for the degraded episode.
    expect(mockRecordAssistantTurn).toHaveBeenCalledTimes(1);
  });
});
