/**
 * Gate Rule Host Only - Pipeline Integration Tests
 *
 * PURPOSE: Verify the production rule-host decision path (no hardcoded gates).
 *
 * Production entry is the shared host runtime:
 *   createProductionRuleHostGate → onBeforeToolResult → handleSharedRuleHostResult
 *
 * `handleBeforeToolCall` is no longer wired into production; only the F1
 * `evaluation_failed` degradation case (adjudicated to PR-A) still enters
 * through it, unchanged.
 *
 * Tests:
 * 1. shared deny → recorded (rulehost_blocked + deny accounting) and the
 *    handler returns undefined: the host already blocks on the gate's deny
 *    decision, so the adapter does not return a second block object
 * 2. allow (no match) → operation passes
 * 3. allow still records one rulehost_evaluated row (no_rules_armed)
 * 4. degraded gate result (warnings) → conservative allow
 * 5. requireApproval → records event, does not block
 * 6. tool-specific early returns collapsed into the shared gate
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleBeforeToolCall, handleSharedRuleHostResult } from '../../src/hooks/gate.js';
import * as sessionTracker from '../../src/core/session-tracker.js';
import { SqliteConnection, SqliteActivationStateStore, type RuleHostInput } from '@principles/core/runtime';
import { createProductionRuleHostGate } from '@principles/host-runtime';
import type { HostEvent, HostEventResult } from '@principles/core/host';

const workspaceDir = '/mock/workspace';
const sessionId = 'test-session-rh';

vi.mock('../../src/core/session-tracker.js', () => ({
  getSession: vi.fn(() => ({ currentGfi: 0 })),
  trackBlock: vi.fn(),
  trackReceiptAutoCorrect: vi.fn(),
  setInjectedPrincipleIds: vi.fn(),
}));

const mockEventLogInstance = {
  recordRuleHostEvaluated: vi.fn(),
  recordRuleEnforced: vi.fn(),
  recordRuleHostBlocked: vi.fn(),
  recordRuleHostRequireApproval: vi.fn(),
  recordGateBlock: vi.fn(),
};
vi.mock('../../src/core/event-log.js', () => ({
  EventLogService: { get: vi.fn(() => mockEventLogInstance) },
}));

const mockRecordPrincipleApplication = vi.fn(() => true);
const mockRecordGateEnforcementEvidence = vi.fn();
const mockObserveRuleCodeSafety = vi.fn(() => false);

vi.mock('../../src/core/principle-application-ledger.js', () => ({
  recordPrincipleApplication: (...args: unknown[]) => mockRecordPrincipleApplication(...args),
}));

vi.mock('../../src/core/intervention-evidence-recorder.js', () => ({
  recordGateEnforcementEvidence: (...args: unknown[]) => mockRecordGateEnforcementEvidence(...args),
}));

vi.mock('../../src/core/rulecode-safety-circuit.js', () => ({
  observeRuleCodeSafety: (...args: unknown[]) => mockObserveRuleCodeSafety(...args),
}));

// The receipt-ledger flag is ON so the shared deny accounting's ledger write is
// observable (the flag itself is covered by gate-receipt-integration).
vi.mock('../../src/core/pd-config-loader.js', () => ({
  loadPdConfigForPlugin: vi.fn(() => ({ ok: false, errors: [{ reason: 'test: no config' }] })),
  loadFeatureFlagFromConfig: vi.fn(() => ({ enabled: true })),
}));

let _mockEvaluate = vi.fn().mockReturnValue(undefined);
let _mockEvaluateDetailed: ReturnType<typeof vi.fn> | undefined;
vi.mock('../../src/core/rule-host.js', () => ({
  RuleHost: vi.fn(function(this: any, _stateDir: string, _logger: any) {
    this.evaluate = _mockEvaluate;
  }),
  // P1 (2026-08-20): gate.ts routes compatibility-guard blocks through this type
  // guard; the mocked rule-host must export it so mocked evaluate() results are
  // not misrouted.
  isCompatibilityGuardBlock: vi.fn(() => false),
}));

vi.mock('../../src/core/principle-tree-ledger.js', () => ({
  loadLedger: vi.fn(),
}));

// The ONLY remaining legacy entry is the F1 `evaluation_failed` case, which
// needs a RuleHost mock. The shared handler still uses WorkspaceContext for
// event-log/trajectory access, so the mock must serve both entries.
vi.mock('../../src/core/workspace-context.js', () => ({
  WorkspaceContext: {
    fromHookContext: vi.fn((ctx: { workspaceDir?: string }) => ({
      workspaceDir: ctx.workspaceDir,
      stateDir: (ctx.workspaceDir ?? '') + '/.state',
      getRuleHost: () => ({
        ...(_mockEvaluateDetailed ? { evaluateDetailed: _mockEvaluateDetailed } : {}),
        dispose: vi.fn(),
      }),
      eventLog: mockEventLogInstance,
      trajectory: { recordGateBlock: vi.fn(), getRuleHostContextRows: vi.fn(() => ({ rows: [], truncated: false })) },
      config: { get: vi.fn().mockReturnValue(undefined) },
      resolve: vi.fn(() => '/mock/PROFILE.json'),
    })),
  },
}));

// ── Shared-path fixtures ───────────────────────────────────────────────────

function makeCtx(extra: Record<string, unknown> = {}) {
  return {
    workspaceDir,
    sessionId,
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    ...extra,
  };
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    toolName: 'write',
    params: { file_path: 'src/danger.ts', content: 'bad' },
    ...overrides,
  };
}

/** Host-neutral deny result exactly as createProductionRuleHostGate emits it. */
function makeDenyResult(extra: Record<string, unknown> = {}): HostEventResult {
  return {
    decision: 'deny',
    source: 'before_tool_call',
    reason: 'High-risk path',
    metadata: {
      evaluatedLiveRules: 1,
      ruleId: 'R_002',
      principleId: 'P_002',
      evaluations: [
        {
          toolName: 'write',
          filePath: 'src/danger.ts',
          matched: true,
          decision: 'block',
          ruleId: 'R_002',
          activationId: 'act-R_002',
          activationMode: 'live',
          hostKind: 'openclaw',
        },
      ],
    },
    ...extra,
  };
}

function makeAllowResult(metadata: Record<string, unknown>): HostEventResult {
  return { decision: 'allow', source: 'before_tool_call', metadata };
}

// ── Real-workspace fixture for the session-identity assertion ──────────────

const GATE_RULE_ID = 'R_SESSION_PROBE';

async function seedLiveRuleWorkspace(dir: string): Promise<SqliteConnection> {
  const conn = new SqliteConnection({ workspaceDir: dir });
  const db = conn.getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'art-session-probe',
    'rule',
    'task-session-probe',
    'P_SESSION_PROBE',
    GATE_RULE_ID,
    '[]',
    'validated',
    JSON.stringify({
      principleId: 'P_SESSION_PROBE',
      ruleId: GATE_RULE_ID,
      implementationCode: "function evaluate(input, helpers) { return { decision: 'allow', matched: false, reason: 'no opinion' }; }",
      goldenTrace: { traceId: 'trace-session-probe', cases: [], createdAt: now, version: 1 },
      ruleHostGateDecision: 'accepted_shadow',
      affectedTools: ['write'],
      painReasonSummary: 'session identity probe',
    }),
    now,
    now,
  );
  await new SqliteActivationStateStore(conn).recordActivation({
    activationId: 'act-session-probe',
    idempotencyKey: 'art-session-probe::code_tool_hook',
    artifactId: 'art-session-probe',
    channel: 'code_tool_hook',
    action: 'code_tool_hook_live_activate',
    targetRef: `impl://${GATE_RULE_ID}`,
    activatedAt: now,
    deactivatedAt: null,
  });
  return conn;
}

describe('Gate Rule Host Only Pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordPrincipleApplication.mockReturnValue(true);
    mockObserveRuleCodeSafety.mockReturnValue(false);
    _mockEvaluate = vi.fn().mockReturnValue(undefined);
    _mockEvaluateDetailed = undefined;
  });

  describe('Rule Host blocks', () => {
    it('should return the shared deny decision with its owner-facing block copy', () => {
      const event = makeEvent({ toolUseId: 'toolu-rh-1' });
      const ctx = makeCtx();

      // The host already blocks on this result; the adapter returns the same
      // block result so the owner-facing copy is not dropped (PRI-1184 / F4).
      const result = handleSharedRuleHostResult(event as never, ctx as never, makeDenyResult());

      expect(result?.block).toBe(true);
      expect(mockEventLogInstance.recordRuleHostBlocked).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'write',
          ruleId: 'R_002',
        }),
      );
      expect(mockEventLogInstance.recordRuleHostEvaluated).toHaveBeenCalledWith(
        expect.objectContaining({
          activationId: 'act-R_002',
          activationMode: 'live',
          decision: 'block',
        }),
      );
      expect(mockRecordGateEnforcementEvidence).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: 'block',
          toolName: 'write',
          ruleId: 'R_002',
          principleId: 'P_002',
          activationId: 'act-R_002',
          sessionId,
          toolCallId: 'toolu-rh-1',
        }),
      );
      expect(mockRecordPrincipleApplication).toHaveBeenCalledWith(
        workspaceDir,
        expect.objectContaining({
          principleId: 'P_002',
          activationId: 'act-R_002',
          kind: 'rule_blocked',
          sessionId,
        }),
      );
      // persistGateBlock: session tally + EventLog row with the SHARED source tag.
      expect(sessionTracker.trackBlock).toHaveBeenCalledWith(sessionId);
      expect(mockEventLogInstance.recordGateBlock).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({
          toolName: 'write',
          reason: 'High-risk path',
          blockSource: 'rule-host-shared',
        }),
      );
    });
  });

  describe('Rule Host allows', () => {
    it('should allow when Rule Host returns undefined (no match)', () => {
      const event = {
        toolName: 'write',
        params: { file_path: 'src/safe.ts', content: 'const x = 1' },
      };

      const result = handleSharedRuleHostResult(
        event as never,
        makeCtx() as never,
        makeAllowResult({ evaluatedLiveRules: 0, ruleDecision: 'allow' }),
      );

      expect(result).toBeUndefined();
    });

    it('should record rulehost_evaluated even when no match', () => {
      const event = {
        toolName: 'edit',
        params: { file_path: 'src/config.ts', oldText: 'x', newText: 'y' },
      };

      handleSharedRuleHostResult(
        event as never,
        makeCtx() as never,
        makeAllowResult({
          evaluatedLiveRules: 0,
          ruleDecision: 'allow',
          matched: false,
          evaluations: [
            {
              toolName: 'edit',
              filePath: 'src/config.ts',
              matched: false,
              // PRI-567: no live rules armed is not the same fact as a live 'allow'.
              decision: 'no_rules_armed',
              activationMode: 'live',
              hostKind: 'openclaw',
            },
          ],
        }),
      );

      expect(mockEventLogInstance.recordRuleHostEvaluated).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'edit',
          matched: false,
          decision: 'no_rules_armed',
        }),
      );
    });
  });

  describe('Rule Host degradation', () => {
    // F1-DEFERRED: adjudicated to PR-A. This case still enters through the
    // legacy hook and is intentionally left unchanged.
    it('records evaluation_failed instead of no_rules_armed when detailed evaluation degrades', () => {
      _mockEvaluateDetailed = vi.fn().mockReturnValue({
        liveDecision: undefined,
        shadowDecisions: [],
        skippedActivations: [],
        liveRulesLoaded: 0,
        evaluationStatus: 'failed',
      });

      handleBeforeToolCall(
        { toolName: 'exec', params: { command: 'ls -la' } } as any,
        { workspaceDir, sessionId } as any,
      );

      expect(mockEventLogInstance.recordRuleHostEvaluated).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'evaluation_failed' }),
      );
    });

    it('should allow operation when the shared gate degrades with warnings', () => {
      const ctx = makeCtx();

      // A thrown/degraded evaluation surfaces as allow + warnings from the gate
      // (rule_batch_failed / rule_batch_timeout / activation_read_failed ...).
      const result = handleSharedRuleHostResult(
        { toolName: 'exec', params: { command: 'ls -la' } } as never,
        ctx as never,
        {
          decision: 'allow',
          source: 'before_tool_call',
          warnings: ['rule_batch_failed: Host internal error; nextAction=inspect active RuleCode'],
          metadata: { evaluatedLiveRules: 0 },
        },
      );

      expect(result).toBeUndefined();
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('rule_batch_failed'),
      );
    });
  });

  describe('Rule Host requireApproval', () => {
    it('should not block when Rule Host returns requireApproval', () => {
      const event = {
        toolName: 'exec',
        params: { command: 'rm -rf node_modules' },
      };

      const result = handleSharedRuleHostResult(
        event as never,
        makeCtx() as never,
        makeAllowResult({
          evaluatedLiveRules: 1,
          ruleDecision: 'requireApproval',
          matched: true,
          ruleId: 'R_003',
          ruleReason: 'High-risk operation needs approval',
          evaluations: [
            {
              toolName: 'exec',
              filePath: event.params.command,
              matched: true,
              decision: 'requireApproval',
              ruleId: 'R_003',
              activationMode: 'live',
              hostKind: 'openclaw',
            },
          ],
        }),
      );

      expect(result).toBeUndefined();
      expect(mockEventLogInstance.recordRuleEnforced).toHaveBeenCalledWith(
        expect.objectContaining({ enforcement: 'requireApproval' })
      );
    });
  });

  describe('Tool-specific entry filtering (collapsed into the shared gate)', () => {
    it('should allow a read tool through the shared path without blocking', () => {
      // DIFF-WEAKENED (PR-A checklist F3'): the shared gate evaluates every tool
      // with a resolvable target path, so the legacy read-tool early return no
      // longer exists and "the engine was never called" is not observable here.
      // Strength asserted today: a read call is never blocked by an allow verdict.
      // PR-A restores the original strength by expressing the entry filter
      // through the existing tool-semantics authority (ToolSemanticRegistry /
      // canonicalKind) and asserting that read/agent tools never reach the
      // production gate at all.
      const event = {
        toolName: 'read',
        params: { file_path: 'src/readonly.ts' },
      };

      const result = handleSharedRuleHostResult(
        event as never,
        makeCtx() as never,
        makeAllowResult({
          evaluatedLiveRules: 1,
          ruleDecision: 'allow',
          evaluations: [
            {
              toolName: 'read',
              filePath: 'src/readonly.ts',
              matched: false,
              decision: 'allow',
              activationMode: 'live',
              hostKind: 'openclaw',
            },
          ],
        }),
      );

      expect(result).toBeUndefined();
      expect(mockEventLogInstance.recordRuleHostBlocked).not.toHaveBeenCalled();
    });

    it('should allow an agent tool that carries no resolvable target path', () => {
      // DIFF-WEAKENED (PR-A checklist F3'): the missing-workspace guard now
      // lives in the OpenClaw adapter wiring (index.ts skips the result
      // mapping). The shared gate still evaluates this call with an empty
      // target path, so the strength asserted here is only "no block".
      // PR-A restores the original strength: assert on the adapter/gate entry
      // filter that agent tools are skipped entirely (no engine call), using the
      // same ToolSemanticRegistry authority as the read-tool case.
      const event = {
        toolName: 'agent',
        params: { task: 'do something' },
      };

      const result = handleSharedRuleHostResult(
        event as never,
        { sessionId } as never,
        makeAllowResult({ evaluatedLiveRules: 0, ruleDecision: 'allow' }),
      );

      expect(result).toBeUndefined();
      expect(mockEventLogInstance.recordRuleHostBlocked).not.toHaveBeenCalled();
    });
  });

  // GFI-COMPLETE-REMOVAL-001: 2bae37491 (SPEC §3.8) removed
  // RuleHostInput.session.currentGfi, so GFI propagation can no longer be the
  // protected object here. The surviving contract is that the production rule
  // VM still receives the host session identity. Enrichment parity
  // (evolution.epTier / derived.bashRisk) is covered by
  // tests/integration/rulehost-seed-mvp-e2e.test.ts and the host-runtime
  // production-host-runtime.test.ts enrichment test.
  describe('Session context', () => {
    it('should pass the session identity into the shared production gate', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-session-'));
      const conn = await seedLiveRuleWorkspace(dir);
      try {
        const captured: RuleHostInput[] = [];
        const gate = createProductionRuleHostGate({
          implementationRuntime: {
            evaluateBatch: (rules, input) => {
              captured.push(input as RuleHostInput);
              return {
                ok: true,
                results: rules.map(() => ({
                  ok: true,
                  result: { decision: 'allow', matched: false, reason: 'no opinion' },
                })),
              };
            },
          },
        });

        const hostEvent: HostEvent = {
          kind: 'before_tool_call',
          context: { workspaceDir: dir, sessionId, toolName: 'write' },
          rawPayload: { toolInput: { toolName: 'write', params: { file_path: 'src/test.ts', content: 'x' } } },
          source: 'openclaw:before_tool_call',
        };

        const gateResult = await gate(hostEvent);

        expect(gateResult.decision).toBe('allow');
        expect(captured).toHaveLength(1);
        expect(captured[0]?.session).toEqual({ sessionId });
      } finally {
        conn.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
