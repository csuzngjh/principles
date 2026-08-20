/**
 * PRI-483 Phase 4 — RuleContext v2 gate integration unit tests
 *
 * PURPOSE: Verify that handleBeforeToolCall assembles RuleContextV2 and passes
 * it to RuleHost.evaluate when the `rulecode_context_v2` feature flag is ON,
 * and does NOT pass context when the flag is OFF (v1 zero-change).
 *
 * ERR prevention:
 *   - ERR-024: context assembly failure (throw) must not skip RuleHost.evaluate
 *   - v1 regression: flag OFF → hostInput.context === undefined
 *
 * Spec: docs/superpowers/specs/2026-06-27-rulecode-context-vision-design.md §5.3
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleBeforeToolCall } from '../../src/hooks/gate.js';
import { loadPdConfigForPlugin } from '../../src/core/pd-config-loader.js';
import { buildProductionRuleContext } from '../../src/core/rule-context-assembler.js';
import type { RuleContextV2, EffectivePdConfig } from '@principles/core/runtime-v2';

// Type aliases for test fixture construction (avoids `any` per project convention).
// `as unknown as T` is acceptable here: these are test fixtures with known shape,
// not untrusted data bypassing runtime validation (rc-2 applies to runtime validation).
type GateEvent = Parameters<typeof handleBeforeToolCall>[0];
type GateCtx = Parameters<typeof handleBeforeToolCall>[1];

// ── Shared mock state ──────────────────────────────────────────────────────

const workspaceDir = '/mock/workspace';
const sessionId = 'test-session-ctx-v2';

const mockEvolution = {
  getTier: vi.fn().mockReturnValue(3),
  getPoints: vi.fn().mockReturnValue(200),
};

vi.mock('../../src/core/session-tracker.js', () => ({
  getSession: vi.fn(() => ({ currentGfi: 0 })),
  trackBlock: vi.fn(),
}));

vi.mock('../../src/core/evolution-engine.js', () => ({
  getEvolutionEngine: vi.fn(() => mockEvolution),
}));

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

let _mockEvaluate = vi.fn().mockReturnValue(undefined);
vi.mock('../../src/core/rule-host.js', () => ({
  RuleHost: vi.fn(function (this: { evaluate: typeof _mockEvaluate }, _stateDir: string, _logger: unknown) {
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

// Mock WorkspaceContext.fromHookContext to provide a controllable wctx with
// a mock trajectory property (avoids real SQLite init on /mock/workspace).
vi.mock('../../src/core/workspace-context.js', () => ({
  WorkspaceContext: {
    fromHookContext: vi.fn(() => ({
      workspaceDir,
      stateDir: '/mock/state',
      trajectory: { getRuleHostContextRows: vi.fn(() => ({ rows: [], truncated: false })) },
      // PR1: gate.ts uses wctx.getRuleHost(logger) instead of `new RuleHost()`.
      // Return a fresh object each call so _mockEvaluate reassignments take effect.
      getRuleHost: () => ({ evaluate: _mockEvaluate }),
    })),
  },
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

function flagOffConfig(): ReturnType<typeof loadPdConfigForPlugin> {
  return {
    ok: true,
    effective: { config: { features: {} } } as unknown as EffectivePdConfig,
    source: 'defaults',
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

function makeWriteEvent(targetPath: string): { toolName: string; params: Record<string, unknown> } {
  return {
    toolName: 'write',
    params: { file_path: targetPath, content: 'const x = 1;' },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Gate RuleContext v2 — flag-gated context assembly (PRI-483 Phase 4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _mockEvaluate = vi.fn().mockReturnValue(undefined);
    vi.mocked(loadPdConfigForPlugin).mockReturnValue(flagOffConfig());
    vi.mocked(buildProductionRuleContext).mockReturnValue(availableContext());
  });

  describe('flag OFF (v1 zero-change)', () => {
    it('Test A: hostInput.context === undefined when flag is OFF', () => {
      vi.mocked(loadPdConfigForPlugin).mockReturnValue(flagOffConfig());

      const event = makeWriteEvent('src/safe.ts');
      handleBeforeToolCall(event as unknown as GateEvent, { workspaceDir, sessionId } as unknown as GateCtx);

      expect(_mockEvaluate).toHaveBeenCalledTimes(1);
      const hostInput = _mockEvaluate.mock.calls[0][0];
      expect(hostInput.context).toBeUndefined();
    });

    it('does not call buildProductionRuleContext when flag is OFF', () => {
      vi.mocked(loadPdConfigForPlugin).mockReturnValue(flagOffConfig());

      const event = makeWriteEvent('src/safe.ts');
      handleBeforeToolCall(event as unknown as GateEvent, { workspaceDir, sessionId } as unknown as GateCtx);

      expect(buildProductionRuleContext).not.toHaveBeenCalled();
    });
  });

  describe('flag ON — context assembly', () => {
    it('Test B: hostInput.context.version === 2 when flag is ON and trajectory is empty', () => {
      vi.mocked(loadPdConfigForPlugin).mockReturnValue(flagOnConfig());
      vi.mocked(buildProductionRuleContext).mockReturnValue(availableContext());

      const event = makeWriteEvent('src/safe.ts');
      handleBeforeToolCall(event as unknown as GateEvent, { workspaceDir, sessionId } as unknown as GateCtx);

      expect(_mockEvaluate).toHaveBeenCalledTimes(1);
      const hostInput = _mockEvaluate.mock.calls[0][0];
      expect(hostInput.context).toBeDefined();
      expect(hostInput.context.version).toBe(2);
      expect(hostInput.context.history.status).toBe('available');
      expect(hostInput.context.history.calls).toHaveLength(0);
    });

    it('passes sessionId, targetPath, trajectory source, and workspaceDir to buildProductionRuleContext', () => {
      vi.mocked(loadPdConfigForPlugin).mockReturnValue(flagOnConfig());
      vi.mocked(buildProductionRuleContext).mockReturnValue(availableContext());

      const event = makeWriteEvent('src/target.ts');
      handleBeforeToolCall(event as unknown as GateEvent, { workspaceDir, sessionId } as unknown as GateCtx);

      expect(buildProductionRuleContext).toHaveBeenCalledTimes(1);
      const [callSessionId, callTargetPath, callSource, callProjectDir] =
        vi.mocked(buildProductionRuleContext).mock.calls[0];
      expect(callSessionId).toBe(sessionId);
      expect(callTargetPath).toBe('src/target.ts');
      expect(callSource).toBeDefined();
      expect(typeof callSource.getRuleHostContextRows).toBe('function');
      expect(callProjectDir).toBe(workspaceDir);
    });

    it('Test E: passes context with priorReadOfTarget=yes when buildProductionRuleContext returns it', () => {
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

      const event = makeWriteEvent('src/auth.ts');
      handleBeforeToolCall(event as unknown as GateEvent, { workspaceDir, sessionId } as unknown as GateCtx);

      const hostInput = _mockEvaluate.mock.calls[0][0];
      expect(hostInput.context.facts.priorReadOfTarget).toBe('yes');
      expect(hostInput.context.facts.readCount).toBe(1);
    });

    it('Test F: passes context with priorReadOfTarget=no when target not in history', () => {
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

      const event = makeWriteEvent('src/other.ts');
      handleBeforeToolCall(event as unknown as GateEvent, { workspaceDir, sessionId } as unknown as GateCtx);

      const hostInput = _mockEvaluate.mock.calls[0][0];
      expect(hostInput.context.facts.priorReadOfTarget).toBe('no');
    });
  });

  describe('flag ON — fail-soft (ERR-024)', () => {
    it('Test C: buildProductionRuleContext throws → RuleHost.evaluate still called, context is unavailable', () => {
      vi.mocked(loadPdConfigForPlugin).mockReturnValue(flagOnConfig());
      vi.mocked(buildProductionRuleContext).mockImplementation(() => {
        throw new Error('unexpected DB failure');
      });

      const event = makeWriteEvent('src/safe.ts');
      handleBeforeToolCall(event as unknown as GateEvent, { workspaceDir, sessionId } as unknown as GateCtx);

      // ERR-024: evaluate MUST still be called
      expect(_mockEvaluate).toHaveBeenCalledTimes(1);
      const hostInput = _mockEvaluate.mock.calls[0][0];
      // Fail-soft: context is structured unavailable (not undefined) so v2 rules
      // see "context unavailable" and allow per spec §4
      expect(hostInput.context).toBeDefined();
      expect(hostInput.context.version).toBe(2);
      expect(hostInput.context.history.status).toBe('unavailable');
      expect(hostInput.context.facts.priorReadOfTarget).toBe('unknown');
      expect(hostInput.context.facts.readCount).toBeNull();
    });

    it('Test D: loadPdConfigForPlugin throws → RuleHost.evaluate still called, context undefined', () => {
      vi.mocked(loadPdConfigForPlugin).mockImplementation(() => {
        throw new Error('config read failure');
      });

      const event = makeWriteEvent('src/safe.ts');
      handleBeforeToolCall(event as unknown as GateEvent, { workspaceDir, sessionId } as unknown as GateCtx);

      // ERR-024: evaluate MUST still be called
      expect(_mockEvaluate).toHaveBeenCalledTimes(1);
      const hostInput = _mockEvaluate.mock.calls[0][0];
      // Can't even check the flag → conservative fail-soft: no context (v1-style)
      expect(hostInput.context).toBeUndefined();
    });

    it('Test D2: loadPdConfigForPlugin returns ok:false → RuleHost.evaluate still called, context undefined (rc-9)', () => {
      vi.mocked(loadPdConfigForPlugin).mockReturnValue(malformedConfig());

      const event = makeWriteEvent('src/safe.ts');
      handleBeforeToolCall(event as unknown as GateEvent, { workspaceDir, sessionId } as unknown as GateCtx);

      // ERR-024: evaluate MUST still be called
      expect(_mockEvaluate).toHaveBeenCalledTimes(1);
      const hostInput = _mockEvaluate.mock.calls[0][0];
      // rc-9: malformed config → explicit fail-soft to v1 (undefined), not silent
      // fall-through into flag computation on defaults
      expect(hostInput.context).toBeUndefined();
      // buildProductionRuleContext must NOT be called when config is malformed
      expect(buildProductionRuleContext).not.toHaveBeenCalled();
    });

    it('buildProductionRuleContext returns unavailable → context propagated as-is', () => {
      vi.mocked(loadPdConfigForPlugin).mockReturnValue(flagOnConfig());
      vi.mocked(buildProductionRuleContext).mockReturnValue(
        unavailableContext('query or assembly failed'),
      );

      const event = makeWriteEvent('src/safe.ts');
      handleBeforeToolCall(event as unknown as GateEvent, { workspaceDir, sessionId } as unknown as GateCtx);

      const hostInput = _mockEvaluate.mock.calls[0][0];
      expect(hostInput.context.history.status).toBe('unavailable');
      expect(hostInput.context.history.unavailableReason).toBe('query or assembly failed');
      expect(hostInput.context.facts.priorReadOfTarget).toBe('unknown');
    });
  });
});
