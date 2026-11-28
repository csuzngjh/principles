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
import { handleSharedRuleHostResult } from '../../src/hooks/gate.js';
import * as sessionTracker from '../../src/core/session-tracker.js';
import { SqliteConnection, SqliteActivationStateStore, type RuleHostInput } from '@principles/core/runtime';
import { createProductionRuleHostGate } from '@principles/host-runtime';
import { createOpenClawHostRuntime } from '../../src/host-runtime/openclaw-host-runtime.js';
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

vi.mock('../../src/core/principle-tree-ledger.js', () => ({
  loadLedger: vi.fn(),
}));

vi.mock('../../src/core/workspace-context.js', () => ({
  WorkspaceContext: {
    fromHookContext: vi.fn((ctx: { workspaceDir?: string }) => ({
      workspaceDir: ctx.workspaceDir,
      stateDir: (ctx.workspaceDir ?? '') + '/.state',
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

async function seedLiveRuleWorkspace(
  dir: string,
  implementationCode = "function evaluate(input, helpers) { return { decision: 'allow', matched: false, reason: 'no opinion' }; }",
): Promise<SqliteConnection> {
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
      implementationCode,
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

function bootstrapEmptyGovernanceStore(dir: string): void {
  const conn = new SqliteConnection({ workspaceDir: dir });
  conn.getDb();
  conn.close();
}

/**
 * The same adapter composition used by production: native OpenClaw dispatch →
 * shared production host runtime/gate → handleSharedRuleHostResult. The
 * before-prompt port is required by the TypeScript interface but is never
 * dispatched by these before_tool_call tests.
 */
function createRealOpenClawBeforeToolRuntime(): ReturnType<typeof createOpenClawHostRuntime> {
  return createOpenClawHostRuntime({
    beforePromptBuild: async () => undefined,
    onBeforeToolResult(event, context, result) {
      if (!context.workspaceDir) throw new Error('test requires workspaceDir');
      return handleSharedRuleHostResult(event, { ...context, workspaceDir: context.workspaceDir }, result);
    },
  });
}

describe('Gate Rule Host Only Pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordPrincipleApplication.mockReturnValue(true);
    mockObserveRuleCodeSafety.mockReturnValue(false);
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

    it('contract-only/unverified host effect: a real production requireApproval is recorded but returns no OpenClaw pause or block object', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-require-approval-'));
      const implementationCode = `
function evaluate(input) {
  return { decision: 'requireApproval', matched: true, reason: 'High-risk operation needs approval' };
}
var meta = { name: 'require-approval-probe', version: '1', ruleId: '${GATE_RULE_ID}', coversCondition: 'all' };
`;
      const conn = await seedLiveRuleWorkspace(dir, implementationCode);
      try {
        // No implementationRuntime injection: the production OpenClaw runtime
        // composition uses the OpenClaw semantic registry and the default Node
        // RuleCode runtime. The shared result is captured at the production
        // adapter seam before the native continuation decision is returned.
        let sharedResult: HostEventResult | undefined;
        const host = createOpenClawHostRuntime({
          beforePromptBuild: async () => undefined,
          onBeforeToolResult(event, context, result) {
            if (!context.workspaceDir) throw new Error('test requires workspaceDir');
            sharedResult = result;
            return handleSharedRuleHostResult(event, { ...context, workspaceDir: context.workspaceDir }, result);
          },
        });
        const adapterResult = await host.dispatchBeforeToolCall(
          { toolName: 'exec', params: { command: 'rm -rf node_modules' } },
          { workspaceDir: dir, sessionId, logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } },
        );

        // Layer separation: the ruleDecision is requireApproval, but the
        // shared HostEventResult.decision remains allow and therefore cannot
        // be treated as evidence of a host pause.
        expect(sharedResult?.decision).toBe('allow');
        expect(sharedResult?.metadata?.['ruleDecision']).toBe('requireApproval');
        expect(sharedResult?.metadata?.['evaluatedLiveRules']).toBe(1);

        // Contract-only characterization: undefined is the adapter-native
        // continuation value. Whether the OpenClaw host itself pauses is not
        // probe-verified here; the proven fact is that PD returns no block,
        // no modified input and no pause object.
        expect(adapterResult).toBeUndefined();
        expect(mockEventLogInstance.recordRuleHostEvaluated).toHaveBeenCalledWith(
          expect.objectContaining({
            toolName: 'exec',
            filePath: 'node_modules',
            decision: 'requireApproval',
            activationMode: 'live',
          }),
        );
        expect(mockEventLogInstance.recordRuleEnforced).toHaveBeenCalledWith(
          expect.objectContaining({
            enforcement: 'requireApproval',
            toolName: 'exec',
            filePath: 'node_modules',
            // Current production characterization: a requireApproval aggregate
            // carries no winning rule attribution, so the enforced row degrades
            // to unknown rather than inventing the seeded rule id.
            ruleId: 'unknown',
            principleId: 'unknown',
          }),
        );
        expect(mockEventLogInstance.recordRuleHostRequireApproval).toHaveBeenCalledWith(
          expect.objectContaining({
            toolName: 'exec',
            filePath: 'node_modules',
            reason: 'High-risk operation needs approval',
            // Same unattributable aggregate fact, preserved as undefined here.
            ruleId: undefined,
          }),
        );
        // Negative controls: recording approval telemetry must not become a
        // host-blocking side effect or a block receipt.
        expect(mockEventLogInstance.recordRuleHostBlocked).not.toHaveBeenCalled();
        expect(mockEventLogInstance.recordGateBlock).not.toHaveBeenCalled();
        expect(sessionTracker.trackBlock).not.toHaveBeenCalled();
      } finally {
        conn.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('Tool-specific entry filtering (canonicalKind gate contract)', () => {
    it('should allow read tool without calling Rule Host', async () => {
      // PR-A F3': restored to the legacy strength. The shared gate derives the
      // canonical kind from the same ToolSemanticRegistry the host declares;
      // read is not write/execute/agent, so the RuleCode engine is never
      // called — even with a live rule armed in this workspace.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-entry-'));
      const conn = await seedLiveRuleWorkspace(dir);
      try {
        const evaluateBatch = vi.fn(() => ({
          ok: true as const,
          results: [{ ok: true, result: { decision: 'block', matched: true, reason: 'must not run' } }],
        }));
        const gate = createProductionRuleHostGate({ implementationRuntime: { evaluateBatch } });

        const gateResult = await gate({
          kind: 'before_tool_call',
          context: { workspaceDir: dir, sessionId, toolName: 'read' },
          rawPayload: { toolInput: { toolName: 'read', params: { file_path: 'src/readonly.ts' } } },
          source: 'openclaw:before_tool_call',
        });

        expect(gateResult.decision).toBe('allow');
        expect(evaluateBatch).not.toHaveBeenCalled();
        expect(gateResult.metadata?.['evaluations'] ?? []).toHaveLength(0);
      } finally {
        conn.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should allow an agent tool that carries no resolvable target path', async () => {
      // PR-A F3': agent remains an evaluable family, but this call carries no
      // path-like param, so the action snapshot has no target and the engine is
      // not called (the old `=== null` guard could not see the empty string).
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-entry-'));
      const conn = await seedLiveRuleWorkspace(dir);
      try {
        const evaluateBatch = vi.fn(() => ({ ok: true as const, results: [] }));
        const gate = createProductionRuleHostGate({ implementationRuntime: { evaluateBatch } });

        const gateResult = await gate({
          kind: 'before_tool_call',
          context: { workspaceDir: dir, sessionId, toolName: 'sessions_spawn' },
          rawPayload: { toolInput: { toolName: 'sessions_spawn', params: { task: 'do something' } } },
          source: 'openclaw:before_tool_call',
        });

        expect(gateResult.decision).toBe('allow');
        expect(evaluateBatch).not.toHaveBeenCalled();
      } finally {
        conn.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('PRI-1309 early-skip telemetry contamination (real OpenClaw host-runtime path)', () => {
    const SKIP_CASES = [
      {
        label: 'non-evaluable read with a structured path',
        toolName: 'read',
        params: { file_path: 'src/readonly.ts' },
        expectedFilePath: 'src/readonly.ts',
      },
      {
        label: 'evaluable agent without a target',
        toolName: 'sessions_spawn',
        params: { task: 'investigate the workspace' },
        expectedFilePath: '',
      },
      {
        label: 'evaluable exec without a command',
        toolName: 'exec',
        params: {},
        expectedFilePath: '',
      },
    ] as const;

    for (const testCase of SKIP_CASES) {
      it(`contract-only fallback contamination: ${testCase.label} still invokes rulehost_evaluated allow persistence`, async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-openclaw-early-skip-'));
        try {
          // A real initialized store removes activation_db_not_found as an
          // explanation: these rows come from the adapter's no-evaluations-array
          // fallback after the shared gate's early skip.
          bootstrapEmptyGovernanceStore(dir);
          const host = createRealOpenClawBeforeToolRuntime();
          const nativeResult = await host.dispatchBeforeToolCall(
            { toolName: testCase.toolName, params: testCase.params },
            { workspaceDir: dir, sessionId, logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } },
          );

          expect(nativeResult).toBeUndefined();
          expect(mockEventLogInstance.recordRuleHostEvaluated).toHaveBeenCalledTimes(1);
          expect(mockEventLogInstance.recordRuleHostEvaluated).toHaveBeenCalledWith(
            expect.objectContaining({
              toolName: testCase.toolName,
              filePath: testCase.expectedFilePath,
              matched: false,
              decision: 'allow',
              activationMode: 'live',
              hostKind: 'openclaw',
            }),
          );
          // Negative control: this fallback is evaluation telemetry only, not
          // a block or a host pause.
          expect(mockEventLogInstance.recordRuleHostBlocked).not.toHaveBeenCalled();
          expect(mockEventLogInstance.recordGateBlock).not.toHaveBeenCalled();
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });
    }

    it('positive control: an evaluable write reaching the initialized empty store invokes no_rules_armed persistence, not fallback allow', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-openclaw-no-rules-'));
      try {
        bootstrapEmptyGovernanceStore(dir);
        const host = createRealOpenClawBeforeToolRuntime();
        const nativeResult = await host.dispatchBeforeToolCall(
          { toolName: 'write', params: { file_path: 'src/safe.ts', content: 'x' } },
          { workspaceDir: dir, sessionId, logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } },
        );

        expect(nativeResult).toBeUndefined();
        expect(mockEventLogInstance.recordRuleHostEvaluated).toHaveBeenCalledTimes(1);
        expect(mockEventLogInstance.recordRuleHostEvaluated).toHaveBeenCalledWith(
          expect.objectContaining({
            toolName: 'write',
            filePath: 'src/safe.ts',
            matched: false,
            decision: 'no_rules_armed',
            activationMode: 'live',
            hostKind: 'openclaw',
          }),
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
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
