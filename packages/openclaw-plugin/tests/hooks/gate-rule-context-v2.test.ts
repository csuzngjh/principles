/**
 * PRI-483 Phase 4 — RuleContext v2 gate integration unit tests
 *
 * PURPOSE: Verify that the PRODUCTION shared gate (`createProductionRuleHostGate`,
 * wired by src/index.ts with `buildRuleContextIfEnabled` as the context provider)
 * assembles RuleContextV2 and hands it to the rule engine when the
 * `rulecode_context_v2` flag is ON, and does NOT pass context when the flag is
 * OFF (v1 zero-change).
 *
 * PR-1 (RuleHost retirement): this file previously drove `handleBeforeToolCall`
 * and asserted against `RuleHost.evaluate`. That path has no production wiring.
 * The assertions now inspect the `input` the gate passes to
 * `implementationRuntime.evaluateBatch` — the exact engine boundary — so the
 * coverage is on the production path, not a test-only orchestration layer.
 *
 * ERR prevention:
 *   - ERR-024: context assembly failure (throw) must not skip rule evaluation
 *   - v1 regression: flag OFF → engine input.context === undefined
 *
 * Spec: docs/superpowers/specs/2026-06-27-rulecode-context-vision-design.md §5.3
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createProductionRuleHostGate } from '@principles/host-runtime';
import type { RuleImplementationRuntime } from '@principles/host-runtime';
import type { HostEvent } from '@principles/core/host';
import { SqliteConnection, SqliteActivationStateStore } from '@principles/core/runtime';
import type { RuleContextV2, EffectivePdConfig, RuleHostInput } from '@principles/core/runtime';
import { buildRuleContextIfEnabled } from '../../src/hooks/gate.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import { loadPdConfigForPlugin } from '../../src/core/pd-config-loader.js';
import { buildProductionRuleContext } from '../../src/core/rule-context-assembler.js';
import { OPENCLAW_TOOL_SEMANTICS } from '../../src/constants/tool-semantics.js';

// ── Shared mock state ──────────────────────────────────────────────────────

const sessionId = 'test-session-ctx-v2';

const mockEventLogInstance = {
  recordRuleHostEvaluated: vi.fn(),
  recordRuleEnforced: vi.fn(),
  recordRuleHostBlocked: vi.fn(),
  recordRuleHostRequireApproval: vi.fn(),
  recordRuleHostAutoCorrectProposed: vi.fn(),
  recordRuleHostAutoCorrectApplied: vi.fn(),
};
vi.mock('../../src/core/event-log.js', () => ({
  EventLogService: { get: vi.fn(() => mockEventLogInstance) },
}));

vi.mock('../../src/core/principle-tree-ledger.js', () => ({
  loadLedger: vi.fn(),
}));

// Mock pd-config-loader to control feature flag state per test
vi.mock('../../src/core/pd-config-loader.js', () => ({
  loadPdConfigForPlugin: vi.fn(),
  getPdConfigPath: vi.fn(),
}));

// Mock rule-context-assembler to control buildProductionRuleContext per test
vi.mock('../../src/core/rule-context-assembler.js', () => ({
  buildProductionRuleContext: vi.fn(),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

let tempWorkspaceDir: string;
let sqliteConn: SqliteConnection;

function flagOffConfig(): ReturnType<typeof loadPdConfigForPlugin> {
  return {
    ok: true,
    // PRI-780: the flag defaults ON — "flag OFF" means the explicit config
    // kill switch (features.rulecode_context_v2.enabled: false).
    effective: {
      config: {
        features: {
          rulecode_context_v2: { category: 'quiet' as const, enabled: false },
        },
      },
    } as unknown as EffectivePdConfig,
    source: 'user_config',
    configPath: '/mock/.pd/config.yaml',
    warnings: [],
    errors: [],
  };
}

function flagOnConfig(): ReturnType<typeof loadPdConfigForPlugin> {
  return {
    ok: true,
    effective: {
      config: {
        features: {
          rulecode_context_v2: { category: 'quiet' as const, enabled: true },
        },
      },
    } as unknown as EffectivePdConfig,
    source: 'user_config',
    configPath: '/mock/.pd/config.yaml',
    warnings: [],
    errors: [],
  };
}

function malformedConfig(): ReturnType<typeof loadPdConfigForPlugin> {
  return {
    ok: false,
    effective: { config: { features: {} } } as unknown as EffectivePdConfig,
    source: 'malformed',
    configPath: '/mock/.pd/config.yaml',
    warnings: [],
    errors: [{ path: '', reason: 'YAML parse error: bad indentation', nextAction: 'Fix YAML syntax' }],
  };
}

function availableContext(overrides: Partial<RuleContextV2> = {}): RuleContextV2 {
  return {
    version: 2,
    history: { status: 'available', truncated: false, calls: [] },
    facts: {
      priorReadOfTarget: 'unknown',
      readCount: 0,
      writeCount: 0,
      uniqueWritePathCount: 0,
      sameActionBlockCount: null,
    },
    ...overrides,
  };
}

function unavailableContext(reason: string): RuleContextV2 {
  return {
    version: 2,
    history: { status: 'unavailable', unavailableReason: reason, truncated: false, calls: [] },
    facts: {
      priorReadOfTarget: 'unknown',
      readCount: null,
      writeCount: null,
      uniqueWritePathCount: null,
      sameActionBlockCount: null,
    },
  };
}

/**
 * The gate only reaches the engine when the workspace has a governance store
 * (`.pd/state.db`) with at least one live activation, so each test seeds one
 * benign live activation. The artifact deliberately does NOT declare
 * `requiresContextVersion`, which keeps the rule eligible both with and
 * without a v2 context — the flag-OFF tests must still reach the engine.
 */
async function seedLiveActivation(): Promise<void> {
  sqliteConn = new SqliteConnection(tempWorkspaceDir);
  const db = sqliteConn.getDb();
  const now = new Date().toISOString();
  const artifactId = 'artifact-ctx-v2-probe';
  db.prepare(`
    INSERT INTO pi_artifacts (
      artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id,
      lineage_artifact_ids, validation_status, content_json, created_at, updated_at
    ) VALUES (?, 'rule', 'task-ctx-v2', 'P_CTX_V2', 'R_CTX_V2', '[]', 'validated', ?, ?, ?)
  `).run(artifactId, JSON.stringify({
    principleId: 'P_CTX_V2',
    ruleId: 'R_CTX_V2',
    implementationCode: [
      'function evaluate(input) {',
      "  return { decision: 'allow', matched: false, reason: 'context probe allow' };",
      '}',
      "var meta = { name: 'ctx-v2-probe', version: '1', ruleId: 'R_CTX_V2', coversCondition: 'all' };",
    ].join('\n'),
    goldenTrace: { traceId: 'trace-ctx-v2', cases: [], createdAt: now, version: 1 },
    ruleHostGateDecision: 'accepted_shadow',
    affectedTools: ['write'],
    painReasonSummary: 'rule context v2 probe',
  }), now, now);
  await new SqliteActivationStateStore(sqliteConn).recordActivation({
    activationId: 'act_code_R_CTX_V2',
    idempotencyKey: `${artifactId}::code_tool_hook`,
    artifactId,
    channel: 'code_tool_hook',
    action: 'code_tool_hook_live_activate',
    targetRef: 'impl://R_CTX_V2',
    activatedAt: now,
    deactivatedAt: null,
  });
}

function makeHostEvent(targetPath: string): HostEvent {
  return {
    kind: 'before_tool_call',
    context: { workspaceDir: tempWorkspaceDir, sessionId, toolName: 'write' },
    rawPayload: {
      toolInput: {
        toolName: 'write',
        params: { file_path: targetPath, content: 'const x = 1;' },
      },
    },
    source: 'openclaw:before_tool_call',
  } as HostEvent;
}

interface GateRun {
  result: Awaited<ReturnType<ReturnType<typeof createProductionRuleHostGate>>>;
  inputs: RuleHostInput[];
}

/**
 * Runs the production gate with a capturing fake engine. `ruleContextProvider`
 * mirrors src/index.ts exactly (`buildRuleContextIfEnabled` over the hook
 * context) so the test proves the production wiring feeds the engine.
 */
async function runGate(targetPath: string): Promise<GateRun> {
  const inputs: RuleHostInput[] = [];
  const implementationRuntime: RuleImplementationRuntime = {
    evaluateBatch(rules, input) {
      inputs.push(input as RuleHostInput);
      return {
        ok: true,
        results: rules.map(() => ({ ok: true as const, result: { decision: 'allow', matched: false, reason: 'context probe allow' } })),
      };
    },
  };
  const gate = createProductionRuleHostGate({
    hostKind: 'openclaw',
    toolSemantics: OPENCLAW_TOOL_SEMANTICS,
    implementationRuntime,
    // SAME provider function as src/index.ts (the OpenClaw adapter only rebinds
    // its first two arguments to the native hook payload).
    ruleContextProvider: (request) => buildRuleContextIfEnabled(
      WorkspaceContext.fromHookContext({ workspaceDir: request.workspaceDir, sessionId: request.sessionId }),
      request.targetPath,
      request.sessionId,
      undefined,
    ),
  });
  const result = await gate(makeHostEvent(targetPath));
  return { result, inputs };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Gate RuleContext v2 — flag-gated context assembly (PRI-483 Phase 4)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-ctx-v2-'));
    fs.mkdirSync(path.join(tempWorkspaceDir, '.pd'), { recursive: true });
    await seedLiveActivation();
    vi.mocked(loadPdConfigForPlugin).mockReturnValue(flagOffConfig());
    vi.mocked(buildProductionRuleContext).mockReturnValue(availableContext());
  });

  afterEach(() => {
    sqliteConn.close();
    WorkspaceContext.clearCache();
    fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
  });

  describe('flag OFF (v1 zero-change)', () => {
    it('Test A: engine input.context === undefined when flag is OFF', async () => {
      vi.mocked(loadPdConfigForPlugin).mockReturnValue(flagOffConfig());

      const { inputs } = await runGate('src/safe.ts');

      expect(inputs).toHaveLength(1);
      expect(inputs[0].context).toBeUndefined();
    });

    it('does not call buildProductionRuleContext when flag is OFF', async () => {
      vi.mocked(loadPdConfigForPlugin).mockReturnValue(flagOffConfig());

      const { inputs } = await runGate('src/safe.ts');

      expect(inputs).toHaveLength(1);
      expect(buildProductionRuleContext).not.toHaveBeenCalled();
    });
  });

  describe('flag ON — context assembly', () => {
    it('PRI-780 AC1: a config with NO feature overrides defaults ON and assembles context', async () => {
      // The registry default is enabled:true (graduated 2026-09-13) — an
      // untouched workspace gets context assembly with zero configuration.
      vi.mocked(loadPdConfigForPlugin).mockReturnValue({
        ok: true,
        effective: { config: { features: {} } } as unknown as EffectivePdConfig,
        source: 'defaults',
        configPath: '/mock/.pd/config.yaml',
        warnings: [],
        errors: [],
      });
      vi.mocked(buildProductionRuleContext).mockReturnValue(availableContext());

      const { inputs } = await runGate('src/default-on.ts');

      expect(inputs).toHaveLength(1);
      expect(inputs[0].context).toBeDefined();
      expect(inputs[0].context?.version).toBe(2);
    });

    it('Test B: engine input.context.version === 2 when flag is ON and trajectory is empty', async () => {
      vi.mocked(loadPdConfigForPlugin).mockReturnValue(flagOnConfig());
      vi.mocked(buildProductionRuleContext).mockReturnValue(availableContext());

      const { inputs } = await runGate('src/safe.ts');

      expect(inputs).toHaveLength(1);
      const hostInput = inputs[0];
      expect(hostInput.context).toBeDefined();
      expect(hostInput.context?.version).toBe(2);
      expect(hostInput.context?.history.status).toBe('available');
      expect(hostInput.context?.history.calls).toHaveLength(0);
      // Session identity and derived action survive the production boundary.
      expect(hostInput.session.sessionId).toBe(sessionId);
      expect(hostInput.action.toolName).toBe('write');
      expect(hostInput.action.normalizedPath).toBe('src/safe.ts');
    });

    it('passes sessionId, targetPath, trajectory source, and workspaceDir to buildProductionRuleContext', async () => {
      vi.mocked(loadPdConfigForPlugin).mockReturnValue(flagOnConfig());
      vi.mocked(buildProductionRuleContext).mockReturnValue(availableContext());

      await runGate('src/target.ts');

      expect(buildProductionRuleContext).toHaveBeenCalledTimes(1);
      const [callSessionId, callTargetPath, callSource, callProjectDir] =
        vi.mocked(buildProductionRuleContext).mock.calls[0];
      expect(callSessionId).toBe(sessionId);
      expect(callTargetPath).toBe('src/target.ts');
      expect(callSource).toBeDefined();
      expect(typeof callSource.getRuleHostContextRows).toBe('function');
      expect(callProjectDir).toBe(WorkspaceContext.fromHookContext({ workspaceDir: tempWorkspaceDir, sessionId }).workspaceDir);
    });

    it('Test E: passes context with priorReadOfTarget=yes when buildProductionRuleContext returns it', async () => {
      vi.mocked(loadPdConfigForPlugin).mockReturnValue(flagOnConfig());
      vi.mocked(buildProductionRuleContext).mockReturnValue(
        availableContext({
          history: {
            status: 'available',
            truncated: false,
            calls: [
              {
                sequenceId: 1,
                toolName: 'read',
                canonicalKind: 'read',
                normalizedPath: 'src/auth.ts',
                paramsSummary: { file_path: 'src/auth.ts' },
                outcome: 'success',
              },
            ],
          },
          facts: {
            priorReadOfTarget: 'yes',
            readCount: 1,
            writeCount: 0,
            uniqueWritePathCount: 0,
            sameActionBlockCount: null,
          },
        }),
      );

      const { inputs } = await runGate('src/auth.ts');

      expect(inputs).toHaveLength(1);
      expect(inputs[0].context?.facts.priorReadOfTarget).toBe('yes');
      expect(inputs[0].context?.facts.readCount).toBe(1);
    });

    it('Test F: passes context with priorReadOfTarget=no when target not in history', async () => {
      vi.mocked(loadPdConfigForPlugin).mockReturnValue(flagOnConfig());
      vi.mocked(buildProductionRuleContext).mockReturnValue(
        availableContext({
          facts: {
            priorReadOfTarget: 'no',
            readCount: 1,
            writeCount: 0,
            uniqueWritePathCount: 0,
            sameActionBlockCount: null,
          },
        }),
      );

      const { inputs } = await runGate('src/other.ts');

      expect(inputs).toHaveLength(1);
      expect(inputs[0].context?.facts.priorReadOfTarget).toBe('no');
    });
  });

  describe('flag ON — fail-soft (ERR-024)', () => {
    it('Test C: buildProductionRuleContext throws → engine still called, context is unavailable', async () => {
      vi.mocked(loadPdConfigForPlugin).mockReturnValue(flagOnConfig());
      vi.mocked(buildProductionRuleContext).mockImplementation(() => {
        throw new Error('unexpected DB failure');
      });

      const { inputs } = await runGate('src/safe.ts');

      // ERR-024: the engine MUST still be called
      expect(inputs).toHaveLength(1);
      // Fail-soft: context is structured unavailable (not undefined) so v2 rules
      // see "context unavailable" and allow per spec §4
      expect(inputs[0].context).toBeDefined();
      expect(inputs[0].context?.version).toBe(2);
      expect(inputs[0].context?.history.status).toBe('unavailable');
      expect(inputs[0].context?.facts.priorReadOfTarget).toBe('unknown');
      expect(inputs[0].context?.facts.readCount).toBeNull();
    });

    it('Test D: loadPdConfigForPlugin throws → engine still called, context undefined', async () => {
      vi.mocked(loadPdConfigForPlugin).mockImplementation(() => {
        throw new Error('config read failure');
      });

      const { inputs } = await runGate('src/safe.ts');

      // ERR-024: the engine MUST still be called
      expect(inputs).toHaveLength(1);
      // Can't even check the flag → conservative fail-soft: no context (v1-style)
      expect(inputs[0].context).toBeUndefined();
    });

    it('Test D2: loadPdConfigForPlugin returns ok:false → engine still called, context undefined (rc-9)', async () => {
      vi.mocked(loadPdConfigForPlugin).mockReturnValue(malformedConfig());

      const { inputs } = await runGate('src/safe.ts');

      // ERR-024: the engine MUST still be called
      expect(inputs).toHaveLength(1);
      // rc-9: malformed config → explicit fail-soft to v1 (undefined), not silent
      // fall-through into flag computation on defaults
      expect(inputs[0].context).toBeUndefined();
      // buildProductionRuleContext must NOT be called when config is malformed
      expect(buildProductionRuleContext).not.toHaveBeenCalled();
    });

    it('buildProductionRuleContext returns unavailable → context propagated as-is', async () => {
      vi.mocked(loadPdConfigForPlugin).mockReturnValue(flagOnConfig());
      vi.mocked(buildProductionRuleContext).mockReturnValue(
        unavailableContext('query or assembly failed'),
      );

      const { inputs } = await runGate('src/safe.ts');

      expect(inputs).toHaveLength(1);
      expect(inputs[0].context?.history.status).toBe('unavailable');
      expect(inputs[0].context?.history.unavailableReason).toBe('query or assembly failed');
      expect(inputs[0].context?.facts.priorReadOfTarget).toBe('unknown');
    });
  });
});
