/**
 * PRI-46: pd candidate route — Internalization route inspection tests
 *
 * Tests that handleCandidateRoute correctly loads a candidate,
 * reconstructs the recommendation, calls decideInternalizationRoute,
 * and outputs the decision as JSON or text.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleCandidateRoute } from '../../src/commands/candidate.js';

// ── Mock setup ──────────────────────────────────────────────────────────────

const { mockStateManager, MockRuntimeStateManager } = vi.hoisted(() => {
  const mockStateManager = {
    initialize: vi.fn().mockResolvedValue(undefined),
    getCandidate: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    connection: {
      getDb: vi.fn(),
    },
  };

  function MockRuntimeStateManager(this: any) {
    return mockStateManager;
  }
  MockRuntimeStateManager.prototype = {};

  return { mockStateManager, MockRuntimeStateManager };
});

vi.mock('@principles/core/runtime-v2', () => ({
  RuntimeStateManager: MockRuntimeStateManager,
  decideInternalizationRoute: vi.fn(),
  resolveOutputLanguage: vi.fn().mockReturnValue({ outputLanguage: 'zh-CN' }),
}));

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/tmp/test-workspace'),
}));

import { decideInternalizationRoute } from '@principles/core/runtime-v2';

// ── Test fixtures ───────────────────────────────────────────────────────────

const mockCandidate = (overrides: Partial<{
  candidateId: string;
  sourceRecommendationJson: string;
  description: string;
}> = {}) => ({
  candidateId: overrides.candidateId ?? 'cand-001',
  artifactId: 'art-001',
  taskId: 'task-001',
  sourceRunId: 'run-001',
  title: 'Test candidate',
  description: overrides.description ?? 'Test recommendation',
  confidence: 0.85,
  sourceRecommendationJson: overrides.sourceRecommendationJson ?? JSON.stringify({
    kind: 'rule',
    description: 'Block force push',
    triggerPattern: 'git\\s+push\\s+--force',
    action: 'block and require approval',
  }),
  status: 'pending' as const,
  createdAt: '2026-05-04T00:00:00.000Z',
});

let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
});

afterEach(() => {
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  exitSpy.mockRestore();
  vi.clearAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('handleCandidateRoute', () => {
  // ── 1. Ready rule candidate ─────────────────────────────────────────────

  it('ready rule candidate outputs JSON with ready=true and route=rule-candidate', async () => {
    mockStateManager.getCandidate.mockResolvedValue(mockCandidate());
    (decideInternalizationRoute as ReturnType<typeof vi.fn>).mockReturnValue({
      ready: true,
      route: 'rule-candidate',
      missingFields: [],
      reason: 'Rule recommendation ready for candidate pipeline.',
      nextAction: 'Proceed with rule-candidate compilation.',
    });

    await handleCandidateRoute({ candidateId: 'cand-001', workspace: '/tmp/ws', json: true });

    expect(exitSpy).not.toHaveBeenCalledWith(1);

    const jsonOutput = consoleLogSpy.mock.calls.find(call => {
      try { JSON.parse(call[0] as string); return true; } catch { return false; }
    });
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse((jsonOutput as [string])[0]);
    expect(parsed.candidateId).toBe('cand-001');
    expect(parsed.recommendationKind).toBe('rule');
    expect(parsed.route).toBe('rule-candidate');
    expect(parsed.ready).toBe(true);
    expect(parsed.missingFields).toEqual([]);
  });

  // ── 2. Incomplete rule candidate ────────────────────────────────────────

  it('incomplete rule candidate (missing triggerPattern) outputs ready=false with missingFields', async () => {
    mockStateManager.getCandidate.mockResolvedValue(mockCandidate({
      sourceRecommendationJson: JSON.stringify({
        kind: 'rule',
        description: 'Incomplete rule',
        action: 'block',
      }),
    }));
    (decideInternalizationRoute as ReturnType<typeof vi.fn>).mockReturnValue({
      ready: false,
      route: 'rule-candidate',
      missingFields: ['triggerPattern'],
      reason: 'Rule recommendation incomplete: missing triggerPattern.',
      nextAction: 'Re-run diagnostician with PHASE 4 taxonomy to generate missing rule fields.',
    });

    await handleCandidateRoute({ candidateId: 'cand-002', workspace: '/tmp/ws', json: true });

    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(parsed.ready).toBe(false);
    expect(parsed.missingFields).toContain('triggerPattern');
    expect(parsed.route).toBe('rule-candidate');
  });

  // ── 3. Principle candidate ──────────────────────────────────────────────

  it('principle candidate with abstractedPrinciple routes to principle-ledger', async () => {
    mockStateManager.getCandidate.mockResolvedValue(mockCandidate({
      sourceRecommendationJson: JSON.stringify({
        kind: 'principle',
        description: 'Avoid mixing concerns',
        abstractedPrinciple: 'Separate concerns into distinct modules',
      }),
    }));
    (decideInternalizationRoute as ReturnType<typeof vi.fn>).mockReturnValue({
      ready: true,
      route: 'principle-ledger',
      missingFields: [],
      reason: 'Principle recommendation ready for ledger write path.',
      nextAction: 'Proceed with principle-ledger intake.',
    });

    await handleCandidateRoute({ candidateId: 'cand-003', workspace: '/tmp/ws', json: true });

    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(parsed.route).toBe('principle-ledger');
    expect(parsed.ready).toBe(true);
    expect(parsed.recommendationKind).toBe('principle');
  });

  // ── 4. Implementation candidate ──────────────────────────────────────────

  it('implementation candidate routes to implementation-candidate', async () => {
    mockStateManager.getCandidate.mockResolvedValue(mockCandidate({
      sourceRecommendationJson: JSON.stringify({
        kind: 'implementation',
        description: 'Auto-add error boundary to React components',
      }),
    }));
    (decideInternalizationRoute as ReturnType<typeof vi.fn>).mockReturnValue({
      ready: true,
      route: 'implementation-candidate',
      missingFields: [],
      reason: 'Implementation recommendation ready for candidate pipeline.',
      nextAction: 'Proceed with implementation-candidate intake and compilation.',
    });

    await handleCandidateRoute({ candidateId: 'cand-003b', workspace: '/tmp/ws', json: true });

    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(parsed.route).toBe('implementation-candidate');
    expect(parsed.ready).toBe(true);
    expect(parsed.recommendationKind).toBe('implementation');
  });

  // ── 5. Prompt candidate ─────────────────────────────────────────────────

  it('prompt candidate routes to prompt-injection-candidate', async () => {
    mockStateManager.getCandidate.mockResolvedValue(mockCandidate({
      sourceRecommendationJson: JSON.stringify({
        kind: 'prompt',
        description: 'Add safety reminder to system prompt',
      }),
    }));
    (decideInternalizationRoute as ReturnType<typeof vi.fn>).mockReturnValue({
      ready: true,
      route: 'prompt-injection-candidate',
      missingFields: [],
      reason: 'Prompt recommendation ready for injection candidate pipeline.',
      nextAction: 'Proceed with prompt-injection-candidate intake.',
    });

    await handleCandidateRoute({ candidateId: 'cand-004', workspace: '/tmp/ws', json: true });

    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(parsed.route).toBe('prompt-injection-candidate');
    expect(parsed.ready).toBe(true);
  });

  // ── 6. Defer candidate ──────────────────────────────────────────────────

  it('defer candidate routes to deferred with ready=false', async () => {
    mockStateManager.getCandidate.mockResolvedValue(mockCandidate({
      sourceRecommendationJson: JSON.stringify({
        kind: 'defer',
        description: 'Not actionable yet',
      }),
    }));
    (decideInternalizationRoute as ReturnType<typeof vi.fn>).mockReturnValue({
      ready: false,
      route: 'deferred',
      missingFields: [],
      reason: 'Recommendation explicitly deferred — no internalization action required.',
      nextAction: 'No action needed. Re-evaluate if context changes.',
    });

    await handleCandidateRoute({ candidateId: 'cand-005', workspace: '/tmp/ws', json: true });

    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(parsed.route).toBe('deferred');
    expect(parsed.ready).toBe(false);
    expect(parsed.reason).toContain('deferred');
  });

  // ── 7. Unknown kind routes to deferred ──────────────────────────────────

  it('unknown recommendation kind routes to deferred', async () => {
    mockStateManager.getCandidate.mockResolvedValue(mockCandidate({
      sourceRecommendationJson: JSON.stringify({
        kind: 'unknown_nonsense',
        description: 'Bad kind',
      }),
    }));
    (decideInternalizationRoute as ReturnType<typeof vi.fn>).mockReturnValue({
      ready: false,
      route: 'deferred',
      missingFields: [],
      reason: 'Unrecognized recommendation kind "unknown_nonsense" — deferred to safe default.',
      nextAction: 'Review diagnostician output for unsupported recommendation kind.',
    });

    await handleCandidateRoute({ candidateId: 'cand-005b', workspace: '/tmp/ws', json: true });

    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(parsed.route).toBe('deferred');
    expect(parsed.ready).toBe(false);
    expect(parsed.recommendationKind).toBe('unknown_nonsense');
  });

  // ── 8. Candidate not found ──────────────────────────────────────────────

  it('candidate not found exits 1 with error message', async () => {
    mockStateManager.getCandidate.mockResolvedValue(null);

    await handleCandidateRoute({ candidateId: 'nonexistent', workspace: '/tmp/ws', json: true });

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('nonexistent'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // ── 8. Malformed source_recommendation_json uses column fallback ────────

  it('malformed source_recommendation_json falls back to DB columns', async () => {
    mockStateManager.getCandidate.mockResolvedValue(mockCandidate({
      sourceRecommendationJson: 'not-valid-json{{{',
    }));
    mockStateManager.connection.getDb.mockReturnValue({
      prepare: () => ({
        get: () => ({
          recommendation_kind: 'implementation',
          trigger_pattern: null,
          action: null,
          abstracted_principle: null,
        }),
      }),
    });
    (decideInternalizationRoute as ReturnType<typeof vi.fn>).mockReturnValue({
      ready: true,
      route: 'implementation-candidate',
      missingFields: [],
      reason: 'Implementation recommendation ready for candidate pipeline.',
      nextAction: 'Proceed with implementation-candidate intake and compilation.',
    });

    await handleCandidateRoute({ candidateId: 'cand-006', workspace: '/tmp/ws', json: true });

    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(parsed.route).toBe('implementation-candidate');
    expect(parsed.ready).toBe(true);
    expect(parsed._meta?.source).toBe('column_fallback');
  });

  // ── 9. Text output includes route/ready/missingFields ───────────────────

  it('text output includes route, ready, and missingFields', async () => {
    mockStateManager.getCandidate.mockResolvedValue(mockCandidate());
    (decideInternalizationRoute as ReturnType<typeof vi.fn>).mockReturnValue({
      ready: true,
      route: 'rule-candidate',
      missingFields: [],
      reason: 'Rule recommendation ready for candidate pipeline.',
      nextAction: 'Proceed with rule-candidate compilation.',
    });

    await handleCandidateRoute({ candidateId: 'cand-001', workspace: '/tmp/ws', json: false });

    const allOutput = consoleLogSpy.mock.calls.map(call => call[0]).join('\n');
    expect(allOutput).toContain('cand-001');
    expect(allOutput).toContain('rule-candidate');
    expect(allOutput).toContain('Ready:          true');
    expect(allOutput).toContain('(none)');
  });
});
