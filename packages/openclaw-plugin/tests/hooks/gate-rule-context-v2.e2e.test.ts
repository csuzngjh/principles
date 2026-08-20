/**
 * PRI-483 Phase 4 — RuleContext v2 gate E2E test (ERR-025)
 *
 * PURPOSE: Verify the full production chain:
 *   recordToolCall → handleBeforeToolCall → TrajectoryDatabase query
 *   → buildProductionRuleContext → RuleHostInput.context → RuleHost.evaluate
 *
 * Uses REAL TrajectoryDatabase (production schema), REAL loadPdConfigForPlugin
 * (reads .pd/config.yaml from temp workspace), REAL buildProductionRuleContext.
 * Only RuleHost is mocked (to capture hostInput.context).
 *
 * ERR-025: at least one test must cover recordToolCall → before_tool_call
 * with a production-schema-initialized workspace.
 *
 * Spec: docs/superpowers/specs/2026-06-27-rulecode-context-vision-design.md §6.3, §10.2 layer-4
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { handleBeforeToolCall } from '../../src/hooks/gate.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';

// Type aliases for test fixture construction (avoids `any` per project convention).
type GateEvent = Parameters<typeof handleBeforeToolCall>[0];
type GateCtx = Parameters<typeof handleBeforeToolCall>[1];
type HookContextParam = Parameters<typeof WorkspaceContext.fromHookContext>[0];

// ── Mocks (only RuleHost and non-DB services) ──────────────────────────────

const mockEvolution = {
  getTier: vi.fn().mockReturnValue(3),
  getPoints: vi.fn().mockReturnValue(200),
};

vi.mock('../../src/core/session-tracker.js', () => ({
  getSession: vi.fn(() => ({ currentGfi: 0 })),
  trackBlock: vi.fn(),
  trackReceiptAutoCorrect: vi.fn(),
  setInjectedPrincipleIds: vi.fn(),
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
  RuleHost: vi.fn(function (this: { evaluate: typeof _mockEvaluate; dispose: () => void }, _stateDir: string, _logger: unknown) {
    this.evaluate = _mockEvaluate;
    // PR1: WorkspaceContext.invalidate() calls this._ruleHost?.dispose() during
    // clearCache(). Without this, afterEach teardown crashes with
    // "this._ruleHost?.dispose is not a function".
    this.dispose = () => {};
  }),
  // P1 (2026-08-20): gate.ts routes compatibility-guard blocks through this type
  // guard; the mocked rule-host must export it so mocked evaluate() results are
  // not misrouted.
  isCompatibilityGuardBlock: vi.fn(() => false),
}));

vi.mock('../../src/core/principle-tree-ledger.js', () => ({
  loadLedger: vi.fn(),
}));

// ── Test setup ─────────────────────────────────────────────────────────────

let tempWorkspaceDir: string;
const sessionId = 'e2e-ctx-v2-session';

function setupTempWorkspace(): void {
  tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-ctx-v2-'));
  const configDir = path.join(tempWorkspaceDir, '.pd');
  fs.mkdirSync(configDir, { recursive: true });

  const config = {
    version: 1,
    features: {
      prompt: { category: 'core', enabled: true },
      code_tool_hook: { category: 'core', enabled: true },
      defer_archive: { category: 'core', enabled: true },
      rulecode_context_v2: { category: 'quiet', enabled: true },
    },
    runtimeProfiles: { 'openclaw.default': { type: 'openclaw', source: 'default' } },
    internalAgents: { defaultRuntime: 'openclaw.default', agents: { diagnostician: { enabled: true } } },
    ui: { diagnostics: { mode: 'simple' } },
  };
  fs.writeFileSync(
    path.join(configDir, 'config.yaml'),
    yaml.dump(config),
    'utf8',
  );
}

function teardownTempWorkspace(): void {
  WorkspaceContext.clearCache();
  try {
    fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
  } catch {
    // Windows: best-effort
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  _mockEvaluate = vi.fn().mockReturnValue(undefined);
  setupTempWorkspace();
});

afterEach(() => {
  teardownTempWorkspace();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Gate RuleContext v2 E2E — recordToolCall → before_tool_call (ERR-025)', () => {
  it('Test G: read recorded → write to same path → context.facts.priorReadOfTarget === "yes"', () => {
    // 1. Get real WorkspaceContext for the temp workspace
    const wctx = WorkspaceContext.fromHookContext({
      workspaceDir: tempWorkspaceDir,
      logger: { warn: () => {}, info: () => {}, error: () => {} },
    } as unknown as HookContextParam);

    // 2. Record a read tool call on the real trajectory DB
    wctx.trajectory.recordToolCall({
      sessionId,
      toolName: 'read_file',
      outcome: 'success',
      paramsJson: { file_path: 'src/auth.ts' },
    });

    // 3. Call handleBeforeToolCall with a write to the SAME path
    const event = {
      toolName: 'write',
      params: { file_path: 'src/auth.ts', content: 'modified' },
    };
    const ctx = {
      workspaceDir: tempWorkspaceDir,
      sessionId,
      logger: { warn: () => {}, info: () => {}, error: () => {} },
    };

    handleBeforeToolCall(event as unknown as GateEvent, ctx as unknown as GateCtx);

    // 4. Assert RuleHost.evaluate received context with the read in history
    expect(_mockEvaluate).toHaveBeenCalledTimes(1);
    const hostInput = _mockEvaluate.mock.calls[0][0];

    expect(hostInput.context).toBeDefined();
    expect(hostInput.context.version).toBe(2);
    expect(hostInput.context.history.status).toBe('available');
    expect(hostInput.context.history.calls).toHaveLength(1);

    const call = hostInput.context.history.calls[0];
    expect(call.toolName).toBe('read_file');
    expect(call.canonicalKind).toBe('read');
    expect(call.outcome).toBe('success');

    // The read path must match the write target → priorReadOfTarget = 'yes'
    expect(hostInput.context.facts.priorReadOfTarget).toBe('yes');
    expect(hostInput.context.facts.readCount).toBe(1);
    expect(hostInput.context.facts.writeCount).toBe(0);
  });

  it('Test H: read recorded → write to DIFFERENT path → context.facts.priorReadOfTarget === "no"', () => {
    const wctx = WorkspaceContext.fromHookContext({
      workspaceDir: tempWorkspaceDir,
      logger: { warn: () => {}, info: () => {}, error: () => {} },
    } as unknown as HookContextParam);

    // Record a read for src/auth.ts
    wctx.trajectory.recordToolCall({
      sessionId,
      toolName: 'read_file',
      outcome: 'success',
      paramsJson: { file_path: 'src/auth.ts' },
    });

    // Write to a DIFFERENT path
    const event = {
      toolName: 'write',
      params: { file_path: 'src/other.ts', content: 'new file' },
    };
    const ctx = {
      workspaceDir: tempWorkspaceDir,
      sessionId,
      logger: { warn: () => {}, info: () => {}, error: () => {} },
    };

    handleBeforeToolCall(event as unknown as GateEvent, ctx as unknown as GateCtx);

    expect(_mockEvaluate).toHaveBeenCalledTimes(1);
    const hostInput = _mockEvaluate.mock.calls[0][0];

    expect(hostInput.context).toBeDefined();
    expect(hostInput.context.history.status).toBe('available');
    expect(hostInput.context.history.calls).toHaveLength(1);
    expect(hostInput.context.history.calls[0].canonicalKind).toBe('read');

    // Different path → priorReadOfTarget = 'no'
    expect(hostInput.context.facts.priorReadOfTarget).toBe('no');
    expect(hostInput.context.facts.readCount).toBe(1);
  });

  it('Test I: no prior tool calls → context.history.calls is empty, priorReadOfTarget === "no"', () => {
    // Don't record any tool calls — just call handleBeforeToolCall directly.
    // NOTE: priorReadOfTarget is 'no' (not 'unknown') because targetPath is non-null
    // and history is available — we checked the (empty) history and the target was
    // not read. 'unknown' only applies when targetPath is null or history is unavailable.
    const event = {
      toolName: 'write',
      params: { file_path: 'src/new.ts', content: 'new' },
    };
    const ctx = {
      workspaceDir: tempWorkspaceDir,
      sessionId,
      logger: { warn: () => {}, info: () => {}, error: () => {} },
    };

    handleBeforeToolCall(event as unknown as GateEvent, ctx as unknown as GateCtx);

    expect(_mockEvaluate).toHaveBeenCalledTimes(1);
    const hostInput = _mockEvaluate.mock.calls[0][0];

    expect(hostInput.context).toBeDefined();
    expect(hostInput.context.history.status).toBe('available');
    expect(hostInput.context.history.calls).toHaveLength(0);
    expect(hostInput.context.facts.priorReadOfTarget).toBe('no');
    expect(hostInput.context.facts.readCount).toBe(0);
  });

  it('Test J: sessionId isolation — read in different session does not affect current', () => {
    const wctx = WorkspaceContext.fromHookContext({
      workspaceDir: tempWorkspaceDir,
      logger: { warn: () => {}, info: () => {}, error: () => {} },
    } as unknown as HookContextParam);

    // Record a read in a DIFFERENT session
    wctx.trajectory.recordToolCall({
      sessionId: 'other-session',
      toolName: 'read_file',
      outcome: 'success',
      paramsJson: { file_path: 'src/auth.ts' },
    });

    // Write in the current session
    const event = {
      toolName: 'write',
      params: { file_path: 'src/auth.ts', content: 'modified' },
    };
    const ctx = {
      workspaceDir: tempWorkspaceDir,
      sessionId,
      logger: { warn: () => {}, info: () => {}, error: () => {} },
    };

    handleBeforeToolCall(event as unknown as GateEvent, ctx as unknown as GateCtx);

    const hostInput = _mockEvaluate.mock.calls[0][0];
    // Session isolation: the other-session read is NOT in current session's history.
    // priorReadOfTarget is 'no' (not 'unknown') because targetPath is non-null and
    // history is available — we checked the (empty for this session) history.
    expect(hostInput.context.history.calls).toHaveLength(0);
    expect(hostInput.context.facts.priorReadOfTarget).toBe('no');
  });
});
