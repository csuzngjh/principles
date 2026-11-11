/**
 * Legacy-fallback convergence (Task 1)
 *
 * The shared production gate is the authoritative evaluation path. It already
 * produces `auto_correct` / `requireApproval` verdicts, but `onBeforeToolResult`
 * used to hand those two verdicts back to the legacy `handleBeforeToolCall`,
 * which re-evaluated the same activations from SQLite and then recorded/applied
 * the decision.
 *
 * These tests pin behavioural equivalence for the three decision shapes the
 * fallback served:
 *   1. auto_correct  — corrected params returned, proposed/applied telemetry
 *   2. requireApproval — no params change, enforced + approval telemetry
 *   3. allow (normal)  — no params change, one allow evaluation row
 *
 * For each case the SAME decision is fed to the legacy handler and to the
 * converged shared handler; the observable outputs must match exactly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleBeforeToolCall, handleSharedRuleHostResult } from '../../src/hooks/gate.js';
import type { HostEventResult } from '@principles/core/host';

const workspaceDir = '/mock/workspace';
const sessionId = 'test-convergence';
const filePath = '/mock/workspace/src/foo.ts';
const activationId = 'act-convergence-1';

const mockEventLogInstance = {
  recordRuleHostEvaluated: vi.fn(),
  recordRuleEnforced: vi.fn(),
  recordRuleHostBlocked: vi.fn(),
  recordRuleHostRequireApproval: vi.fn(),
  recordRuleHostAutoCorrectProposed: vi.fn(),
  recordRuleHostAutoCorrectApplied: vi.fn(),
};

const mockTrackReceiptAutoCorrect = vi.fn();
const mockRecordPrincipleApplication = vi.fn(() => true);
const mockRecordGateEnforcementEvidence = vi.fn();
const mockObserveRuleCodeSafety = vi.fn(() => false);

vi.mock('../../src/core/session-tracker.js', () => ({
  getSession: vi.fn(() => ({ currentGfi: 0 })),
  trackBlock: vi.fn(),
  trackReceiptAutoCorrect: (...args: unknown[]) => mockTrackReceiptAutoCorrect(...args),
  setInjectedPrincipleIds: vi.fn(),
}));

vi.mock('../../src/core/event-log.js', () => ({
  EventLogService: { get: vi.fn(() => mockEventLogInstance) },
}));

vi.mock('../../src/core/principle-application-ledger.js', () => ({
  recordPrincipleApplication: (...args: unknown[]) => mockRecordPrincipleApplication(...args),
}));

vi.mock('../../src/core/intervention-evidence-recorder.js', () => ({
  recordGateEnforcementEvidence: (...args: unknown[]) => mockRecordGateEnforcementEvidence(...args),
}));

vi.mock('../../src/core/rulecode-safety-circuit.js', () => ({
  observeRuleCodeSafety: (...args: unknown[]) => mockObserveRuleCodeSafety(...args),
}));

vi.mock('../../src/core/pd-config-loader.js', () => ({
  loadPdConfigForPlugin: vi.fn(() => ({ ok: false, errors: [{ reason: 'test: no config' }] })),
  loadFeatureFlagFromConfig: vi.fn(() => ({ enabled: true })),
}));

let legacyReport: Record<string, unknown>;

vi.mock('../../src/core/workspace-context.js', () => ({
  WorkspaceContext: {
    fromHookContext: vi.fn((ctx: { workspaceDir?: string }) => ({
      workspaceDir: ctx.workspaceDir,
      stateDir: `${ctx.workspaceDir ?? ''}/.state`,
      getRuleHost: () => ({ evaluateDetailed: () => legacyReport, dispose: vi.fn() }),
      eventLog: mockEventLogInstance,
      trajectory: { recordGateBlock: vi.fn(), getRuleHostContextRows: vi.fn(() => ({ rows: [], truncated: false })) },
      config: { get: vi.fn().mockReturnValue(undefined) },
      resolve: vi.fn(() => '/mock/PROFILE.json'),
    })),
  },
}));

function makeEvent() {
  return {
    toolName: 'write',
    params: { file_path: filePath, content: 'broken' },
  };
}

function makeCtx() {
  return {
    workspaceDir,
    sessionId,
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  };
}

function makeProposal() {
  return {
    proposedParams: { content: 'fixed content' },
    correctedFields: [
      { field: 'content', original: 'broken', proposed: 'fixed content', reason: 'fix typo' },
    ],
    applicationMode: 'live' as const,
    confidence: 0.9,
    ruleId: 'R_convergence',
    principleId: 'P_convergence',
    notifyAgent: true,
  };
}

/** The host-neutral metadata the shared gate emits for a non-block verdict. */
function makeSharedMetadata(ruleDecision: string, extra: Record<string, unknown> = {}) {
  return {
    evaluatedLiveRules: 1,
    ruleDecision,
    evaluations: [
      {
        toolName: 'write',
        filePath,
        matched: ruleDecision !== 'allow',
        decision: ruleDecision,
        ...(ruleDecision === 'auto_correct' ? { ruleId: 'R_convergence', activationId } : {}),
        activationMode: 'live',
        hostKind: 'openclaw',
      },
    ],
    ...extra,
  };
}

function makeSharedResult(metadata: Record<string, unknown>): HostEventResult {
  return { decision: 'allow', source: 'before_tool_call', metadata };
}

function snapshotObservables() {
  // `rulehost_evaluated` rows carry a path-format difference that predates the
  // convergence (the legacy hook writes the workspace-relative normalized path,
  // the shared handler writes the gate's own evaluation path, and either may
  // omit undefined fields). The decision-relevant facts are compared here.
  const evaluationFacts = mockEventLogInstance.recordRuleHostEvaluated.mock.calls.map(([row]) => {
    const record = row as Record<string, unknown>;
    return {
      decision: record['decision'],
      matched: record['matched'],
      ruleId: record['ruleId'],
      activationId: record['activationId'],
      activationMode: record['activationMode'],
      hostKind: record['hostKind'],
    };
  });
  return {
    eventLog: {
      recordRuleHostEvaluated: evaluationFacts,
      recordRuleEnforced: (mockEventLogInstance.recordRuleEnforced as { mock: { calls: unknown[][] } }).mock.calls,
      recordRuleHostBlocked: (mockEventLogInstance.recordRuleHostBlocked as { mock: { calls: unknown[][] } }).mock.calls,
      recordRuleHostRequireApproval: (mockEventLogInstance.recordRuleHostRequireApproval as { mock: { calls: unknown[][] } }).mock.calls,
      recordRuleHostAutoCorrectProposed: (mockEventLogInstance.recordRuleHostAutoCorrectProposed as { mock: { calls: unknown[][] } }).mock.calls,
      recordRuleHostAutoCorrectApplied: (mockEventLogInstance.recordRuleHostAutoCorrectApplied as { mock: { calls: unknown[][] } }).mock.calls,
    },
    trackReceiptAutoCorrect: mockTrackReceiptAutoCorrect.mock.calls,
    recordPrincipleApplication: mockRecordPrincipleApplication.mock.calls,
    recordGateEnforcementEvidence: mockRecordGateEnforcementEvidence.mock.calls.map(([input]) => {
      const { logger: _logger, ...facts } = input as Record<string, unknown>;
      return facts;
    }),
    // A safety observation without an activation id is a real no-op
    // (observeRuleCodeSafety early-returns), so it is not an observable effect.
    // The logger identity differs per call and is not part of the outcome.
    observeRuleCodeSafety: mockObserveRuleCodeSafety.mock.calls
      .filter(([input]) => (input as { activationId?: string }).activationId !== undefined)
      .map(([input]) => {
        const record = input as Record<string, unknown>;
        return {
          activationId: record['activationId'],
          workspaceDir: record['workspaceDir'],
          toolName: record['toolName'],
          params: record['params'],
          decision: record['decision'],
          matched: record['matched'],
        };
      }),
  };
}

function resetObservables() {
  vi.clearAllMocks();
  mockRecordPrincipleApplication.mockReturnValue(true);
  mockObserveRuleCodeSafety.mockReturnValue(false);
}

describe('shared gate / legacy handler convergence', () => {
  beforeEach(() => {
    resetObservables();
    legacyReport = {
      liveDecision: undefined,
      shadowDecisions: [],
      skippedActivations: [],
      liveRulesLoaded: 1,
      evaluationStatus: 'ok',
      liveDecisionActivationId: activationId,
    };
  });

  it('auto_correct: converged shared handler matches the legacy outcome', () => {
    const proposal = makeProposal();
    const decision = {
      decision: 'auto_correct',
      matched: true,
      reason: 'fix typo',
      ruleId: 'R_convergence',
      principleId: 'P_convergence',
      correctionProposal: proposal,
    };
    legacyReport.liveDecision = decision;

    const legacyEvent = makeEvent();
    const legacyReturn = handleBeforeToolCall(legacyEvent, makeCtx() as never);
    const legacyObservables = snapshotObservables();
    resetObservables();

    const sharedEvent = makeEvent();
    const sharedReturn = handleSharedRuleHostResult(
      sharedEvent,
      makeCtx() as never,
      makeSharedResult(makeSharedMetadata('auto_correct', {
        ruleId: 'R_convergence',
        principleId: 'P_convergence',
        matched: true,
        ruleReason: 'fix typo',
        correctionProposal: proposal,
      })),
    );

    expect(legacyReturn).toEqual({ params: { file_path: filePath, content: 'fixed content' } });
    expect(sharedReturn).toEqual(legacyReturn);
    expect(sharedEvent.params).toEqual(legacyEvent.params);
    expect(snapshotObservables()).toEqual(legacyObservables);
  });

  it('requireApproval: converged shared handler matches the legacy outcome', () => {
    const decision = {
      decision: 'requireApproval',
      matched: true,
      reason: 'needs owner approval',
    };
    legacyReport.liveDecision = decision;
    legacyReport.liveDecisionActivationId = undefined;

    const legacyEvent = makeEvent();
    const legacyReturn = handleBeforeToolCall(legacyEvent, makeCtx() as never);
    const legacyObservables = snapshotObservables();
    resetObservables();

    const sharedEvent = makeEvent();
    const sharedReturn = handleSharedRuleHostResult(
      sharedEvent,
      makeCtx() as never,
      makeSharedResult(makeSharedMetadata('requireApproval', {
        matched: true,
        ruleReason: 'needs owner approval',
      })),
    );

    expect(legacyReturn).toBeUndefined();
    expect(sharedReturn).toBeUndefined();
    expect(snapshotObservables()).toEqual(legacyObservables);
  });

  it('allow (normal path): converged shared handler matches the legacy outcome', () => {
    legacyReport.liveDecision = { decision: 'allow', matched: false, reason: 'no opinion' };
    legacyReport.liveDecisionActivationId = undefined;

    const legacyEvent = makeEvent();
    const legacyReturn = handleBeforeToolCall(legacyEvent, makeCtx() as never);
    const legacyObservables = snapshotObservables();
    resetObservables();

    const sharedEvent = makeEvent();
    const sharedReturn = handleSharedRuleHostResult(
      sharedEvent,
      makeCtx() as never,
      makeSharedResult(makeSharedMetadata('allow', { matched: false })),
    );

    expect(legacyReturn).toBeUndefined();
    expect(sharedReturn).toBeUndefined();
    expect(snapshotObservables()).toEqual(legacyObservables);
  });
});
