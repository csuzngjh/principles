/**
 * PRI-483 Phase 4 — RuleContext v2 gate E2E test (ERR-025)
 *
 * PURPOSE: Verify the full production chain:
 *   recordToolCall → production shared gate (createProductionRuleHostGate)
 *   → TrajectoryDatabase query → buildProductionRuleContext
 *   → RuleHostInput.context → implementationRuntime.evaluateBatch
 *
 * PR-1 (RuleHost retirement): the entry point was `handleBeforeToolCall`, which
 * has no production wiring. The test now drives the SAME gate object that
 * src/index.ts assembles (`createProductionRuleHostGate` + the production
 * `buildRuleContextIfEnabled` provider) and captures the input handed to the
 * rule engine instead of RuleHost.evaluate.
 *
 * Uses REAL TrajectoryDatabase (production schema), REAL loadPdConfigForPlugin
 * (reads .pd/config.yaml from temp workspace), REAL buildProductionRuleContext.
 * Only the engine (`evaluateBatch`) is faked, to capture the engine input.
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
import { createProductionRuleHostGate } from '@principles/host-runtime';
import type { RuleImplementationRuntime } from '@principles/host-runtime';
import type { HostEvent } from '@principles/core/host';
import { SqliteConnection, SqliteActivationStateStore } from '@principles/core/runtime';
import type { RuleHostInput } from '@principles/core/runtime';
import { buildRuleContextIfEnabled } from '../../src/hooks/gate.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import { OPENCLAW_TOOL_SEMANTICS } from '../../src/constants/tool-semantics.js';

// ── Mocks (only non-DB services) ───────────────────────────────────────────

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
  recordRuleHostAutoCorrectProposed: vi.fn(),
  recordRuleHostAutoCorrectApplied: vi.fn(),
};
vi.mock('../../src/core/event-log.js', () => ({
  EventLogService: { get: vi.fn(() => mockEventLogInstance) },
}));

vi.mock('../../src/core/principle-tree-ledger.js', () => ({
  loadLedger: vi.fn(),
}));

// ── Test setup ─────────────────────────────────────────────────────────────

let tempWorkspaceDir: string;
let sqliteConn: SqliteConnection;
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

/**
 * The shared gate only reaches the engine when `.pd/state.db` exists AND at
 * least one live activation is seeded, so each test arms one benign live rule.
 */
async function seedLiveActivation(): Promise<void> {
  sqliteConn = new SqliteConnection(tempWorkspaceDir);
  const db = sqliteConn.getDb();
  const now = new Date().toISOString();
  const artifactId = 'artifact-e2e-ctx-v2';
  db.prepare(`
    INSERT INTO pi_artifacts (
      artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id,
      lineage_artifact_ids, validation_status, content_json, created_at, updated_at
    ) VALUES (?, 'rule', 'task-e2e-ctx-v2', 'P_E2E_CTX', 'R_E2E_CTX', '[]', 'validated', ?, ?, ?)
  `).run(artifactId, JSON.stringify({
    principleId: 'P_E2E_CTX',
    ruleId: 'R_E2E_CTX',
    implementationCode: [
      'function evaluate(input) {',
      "  return { decision: 'allow', matched: false, reason: 'e2e context probe allow' };",
      '}',
      "var meta = { name: 'e2e-ctx-probe', version: '1', ruleId: 'R_E2E_CTX', coversCondition: 'all' };",
    ].join('\n'),
    goldenTrace: { traceId: 'trace-e2e-ctx', cases: [], createdAt: now, version: 1 },
    ruleHostGateDecision: 'accepted_shadow',
    affectedTools: ['write'],
    painReasonSummary: 'rule context v2 e2e probe',
  }), now, now);
  await new SqliteActivationStateStore(sqliteConn).recordActivation({
    activationId: 'act_code_R_E2E_CTX',
    idempotencyKey: `${artifactId}::code_tool_hook`,
    artifactId,
    channel: 'code_tool_hook',
    action: 'code_tool_hook_live_activate',
    targetRef: 'impl://R_E2E_CTX',
    activatedAt: now,
    deactivatedAt: null,
  });
}

function teardownTempWorkspace(): void {
  sqliteConn?.close();
  WorkspaceContext.clearCache();
  try {
    fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
  } catch {
    // Windows: best-effort
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  setupTempWorkspace();
  await seedLiveActivation();
});

afterEach(() => {
  teardownTempWorkspace();
});

function makeHostEvent(targetPath: string): HostEvent {
  return {
    kind: 'before_tool_call',
    context: { workspaceDir: tempWorkspaceDir, sessionId, toolName: 'write' },
    rawPayload: {
      toolInput: {
        toolName: 'write',
        params: { file_path: targetPath, content: 'modified' },
      },
    },
    source: 'openclaw:before_tool_call',
  } as HostEvent;
}

/** Runs the production gate and returns the exact input the engine received. */
async function runProductionGate(targetPath: string): Promise<RuleHostInput[]> {
  const inputs: RuleHostInput[] = [];
  const implementationRuntime: RuleImplementationRuntime = {
    evaluateBatch(rules, input) {
      inputs.push(input as RuleHostInput);
      return {
        ok: true,
        results: rules.map(() => ({ ok: true as const, result: { decision: 'allow', matched: false, reason: 'e2e context probe allow' } })),
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
  await gate(makeHostEvent(targetPath));
  return inputs;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Gate RuleContext v2 E2E — recordToolCall → before_tool_call (ERR-025)', () => {
  it('Test G: read recorded → write to same path → context.facts.priorReadOfTarget === "yes"', async () => {
    // 1. Get real WorkspaceContext for the temp workspace
    const wctx = WorkspaceContext.fromHookContext({
      workspaceDir: tempWorkspaceDir,
      logger: { warn: () => {}, info: () => {}, error: () => {} },
    });

    // 2. Record a read tool call on the real trajectory DB
    wctx.trajectory.recordToolCall({
      sessionId,
      toolName: 'read_file',
      outcome: 'success',
      paramsJson: { file_path: 'src/auth.ts' },
    });

    // 3. Run the production gate for a write to the SAME path
    const inputs = await runProductionGate('src/auth.ts');

    // 4. Assert the engine received context with the read in history
    expect(inputs).toHaveLength(1);
    const hostInput = inputs[0];

    expect(hostInput.context).toBeDefined();
    expect(hostInput.context?.version).toBe(2);
    expect(hostInput.context?.history.status).toBe('available');
    expect(hostInput.context?.history.calls).toHaveLength(1);

    const call = hostInput.context?.history.calls[0];
    expect(call?.toolName).toBe('read_file');
    expect(call?.canonicalKind).toBe('read');
    expect(call?.outcome).toBe('success');

    // The read path must match the write target → priorReadOfTarget = 'yes'
    expect(hostInput.context?.facts.priorReadOfTarget).toBe('yes');
    expect(hostInput.context?.facts.readCount).toBe(1);
    expect(hostInput.context?.facts.writeCount).toBe(0);
  });

  it('Test H: read recorded → write to DIFFERENT path → context.facts.priorReadOfTarget === "no"', async () => {
    const wctx = WorkspaceContext.fromHookContext({
      workspaceDir: tempWorkspaceDir,
      logger: { warn: () => {}, info: () => {}, error: () => {} },
    });

    // Record a read for src/auth.ts
    wctx.trajectory.recordToolCall({
      sessionId,
      toolName: 'read_file',
      outcome: 'success',
      paramsJson: { file_path: 'src/auth.ts' },
    });

    // Write to a DIFFERENT path
    const inputs = await runProductionGate('src/other.ts');

    expect(inputs).toHaveLength(1);
    const hostInput = inputs[0];

    expect(hostInput.context).toBeDefined();
    expect(hostInput.context?.history.status).toBe('available');
    expect(hostInput.context?.history.calls).toHaveLength(1);
    expect(hostInput.context?.history.calls[0].canonicalKind).toBe('read');

    // Different path → priorReadOfTarget = 'no'
    expect(hostInput.context?.facts.priorReadOfTarget).toBe('no');
    expect(hostInput.context?.facts.readCount).toBe(1);
  });

  it('Test I: no prior tool calls → context.history.calls is empty, priorReadOfTarget === "no"', async () => {
    // Don't record any tool calls — just run the gate directly.
    // NOTE: priorReadOfTarget is 'no' (not 'unknown') because targetPath is non-null
    // and history is available — we checked the (empty) history and the target was
    // not read. 'unknown' only applies when targetPath is null or history is unavailable.
    const inputs = await runProductionGate('src/new.ts');

    expect(inputs).toHaveLength(1);
    const hostInput = inputs[0];

    expect(hostInput.context).toBeDefined();
    expect(hostInput.context?.history.status).toBe('available');
    expect(hostInput.context?.history.calls).toHaveLength(0);
    expect(hostInput.context?.facts.priorReadOfTarget).toBe('no');
    expect(hostInput.context?.facts.readCount).toBe(0);
  });

  it('Test J: sessionId isolation — read in different session does not affect current', async () => {
    const wctx = WorkspaceContext.fromHookContext({
      workspaceDir: tempWorkspaceDir,
      logger: { warn: () => {}, info: () => {}, error: () => {} },
    });

    // Record a read in a DIFFERENT session
    wctx.trajectory.recordToolCall({
      sessionId: 'other-session',
      toolName: 'read_file',
      outcome: 'success',
      paramsJson: { file_path: 'src/auth.ts' },
    });

    // Write in the current session
    const inputs = await runProductionGate('src/auth.ts');

    expect(inputs).toHaveLength(1);
    const hostInput = inputs[0];
    // Session identity crosses the production boundary unchanged.
    expect(hostInput.session.sessionId).toBe(sessionId);
    // Session isolation: the other-session read is NOT in current session's history.
    // priorReadOfTarget is 'no' (not 'unknown') because targetPath is non-null and
    // history is available — we checked the (empty for this session) history.
    expect(hostInput.context?.history.calls).toHaveLength(0);
    expect(hostInput.context?.facts.priorReadOfTarget).toBe('no');
  });
});
