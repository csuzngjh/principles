/**
 * PRI-486 Phase 7 — RuleContext v2 production VM E2E (spec §10.2 layer-3)
 *
 * PURPOSE: Verify the production hook runtime with REAL VM execution:
 *   validated fixture activation → recordToolCall → handleBeforeToolCall
 *   → buildProductionRuleContext → RuleHost.evaluate (real VM) → block/allow
 *
 * This is a runtime component test, not the generation/approval E2E. It uses
 * fixture artifacts deliberately and does not claim to validate that upstream chain.
 *   - Real TrajectoryDatabase (production schema)
 *   - Real loadPdConfigForPlugin (reads .pd/config.yaml)
 *   - Real buildProductionRuleContext
 *   - Real SqliteConnection + real RuleHost.evaluate (real VM subprocess)
 *   - Real v2 rule code (read-before-write)
 *
 * ERR-025: E2E covers recordToolCall → before_tool_call → block
 * ERR-024: flag OFF suspends the v2 activation before VM execution.
 *
 * Spec: docs/superpowers/specs/2026-06-27-rulecode-context-vision-design.md §6.3, §10.2 layer-3
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { SqliteConnection, SqliteActivationStateStore } from '@principles/core/runtime-v2';
import { handleBeforeToolCall } from '../../src/hooks/gate.js';
import type { PluginHookBeforeToolCallEvent, PluginHookToolContext } from '../../src/openclaw-sdk.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';

// ── Mocks (non-RuleHost only; RuleHost runs real VM) ───────────────────────

const mockEvolution = {
  getTier: vi.fn().mockReturnValue(3),
  getPoints: vi.fn().mockReturnValue(200),
};

vi.mock('../../src/core/session-tracker.js', () => ({
  getSession: vi.fn(() => ({ currentGfi: 0 })),
  trackBlock: vi.fn(),
  hasRecentThinking: vi.fn(() => false),
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
  recordRuleHostSkipped: vi.fn(),
};
vi.mock('../../src/core/event-log.js', () => ({
  EventLogService: { get: vi.fn(() => mockEventLogInstance) },
}));

vi.mock('../../src/core/principle-tree-ledger.js', () => ({
  loadLedger: vi.fn(),
}));

// ── Test constants ─────────────────────────────────────────────────────────

const RULE_ID = 'R_RBW_001';
const ARTIFACT_ID = 'art-rbw-001';
const ACTIVATION_ID = `act_code_${RULE_ID}`;
const SESSION_ID = 'vm-e2e-ctx-v2-session';

/**
 * v2 dogfood rule: read-before-write.
 *
 * Behavior:
 *   - risk path → block (v1 dominance, spec §10.1 scenario 10)
 *   - context undefined OR history.status === 'unavailable' → allow (fail-soft)
 *   - write_file + priorReadOfTarget === 'no' → block (spec §10.1 scenario 1)
 *   - otherwise → allow
 *
 * This rule reads input.context (v2 feature). When flag is OFF, gate.ts sets
 * context = undefined, and the rule falls through to allow (v1 zero-change).
 */
const V2_RULE_CODE = `
function evaluate(input, helpers) {
  if (input.workspace.isRiskPath) {
    return { decision: 'block', matched: true, reason: 'R_RBW_001: risk path blocked' };
  }
  if (!input.context || input.context.history.status === 'unavailable') {
    return { decision: 'allow', matched: false, reason: 'R_RBW_001: context unavailable, fail-soft' };
  }
  if (input.action.toolName === 'write_file' && input.context.facts.priorReadOfTarget === 'no') {
    return { decision: 'block', matched: true, reason: 'R_RBW_001: read before write required' };
  }
  return { decision: 'allow', matched: false, reason: 'R_RBW_001: ok' };
}
var meta = { name: 'read-before-write', version: '1', ruleId: '${RULE_ID}', coversCondition: 'write' };
`;

// ── Test setup ─────────────────────────────────────────────────────────────

let tempWorkspaceDir: string;
let sqliteConn: SqliteConnection;

function setupTempWorkspace(enableV2Flag: boolean): void {
  tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-ctx-v2-vm-'));
  const configDir = path.join(tempWorkspaceDir, '.pd');
  fs.mkdirSync(configDir, { recursive: true });

  const config = {
    version: 1,
    features: {
      prompt: { category: 'core', enabled: true },
      code_tool_hook: { category: 'core', enabled: true },
      defer_archive: { category: 'core', enabled: true },
      ...(enableV2Flag
        ? { rulecode_context_v2: { category: 'quiet', enabled: true } }
        : {}),
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

function insertV2RuleArtifact(ruleCode: string = V2_RULE_CODE): void {
  const db = sqliteConn.getDb();
  const now = new Date().toISOString();
  const contentJson = JSON.stringify({
    principleId: 'P_RBW_001',
    ruleId: RULE_ID,
    implementationCode: ruleCode,
    goldenTrace: {
      traceId: 'trace-rbw-001',
      cases: [],
      createdAt: now,
      version: 1,
    },
    ruleHostGateDecision: 'accepted_shadow',
    affectedTools: ['write_file'],
    painReasonSummary: 'Dogfood: read before write',
    requiresContextVersion: 2,
  });

  db.prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ARTIFACT_ID,
    'rule',
    'task-rbw-001',
    'P_RBW_001',
    RULE_ID,
    '[]',
    'validated',
    contentJson,
    now,
    now,
  );
}

async function insertActivation(): Promise<void> {
  const store = new SqliteActivationStateStore(sqliteConn);
  const now = new Date().toISOString();
  await store.recordActivation({
    activationId: ACTIVATION_ID,
    idempotencyKey: `${ARTIFACT_ID}::code_tool_hook`,
    artifactId: ARTIFACT_ID,
    channel: 'code_tool_hook',
    action: 'code_tool_hook_shadow_activate',
    targetRef: `impl://${RULE_ID}`,
    activatedAt: now,
    deactivatedAt: null,
  });
}

async function promoteActivation(): Promise<void> {
  const store = new SqliteActivationStateStore(sqliteConn);
  const promoted = await store.promoteActivation(ACTIVATION_ID, new Date().toISOString());
  expect(promoted).toBe(true);
}

function teardownTempWorkspace(): void {
  WorkspaceContext.clearCache();
  try { sqliteConn?.close(); } catch { /* best-effort */ }
  try {
    fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
  } catch {
    // Windows: best-effort
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  teardownTempWorkspace();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PRI-486 Phase 7 — RuleContext v2 production VM E2E (spec §10.2 layer-3)', () => {
  it('Test K1: flag ON + unread write → real VM block (read-before-write)', async () => {
    // 1. Setup: temp workspace with rulecode_context_v2 flag ON
    setupTempWorkspace(true);
    sqliteConn = new SqliteConnection(tempWorkspaceDir);
    sqliteConn.getDb();

    // 2. Insert v2 rule artifact + activation (real SQLite)
    insertV2RuleArtifact();
    await insertActivation();

    // 3. Get real WorkspaceContext (initializes TrajectoryDatabase)
    const wctx = WorkspaceContext.fromHookContext({
      workspaceDir: tempWorkspaceDir,
      logger: { warn: () => {}, info: () => {}, error: () => {} },
    } as unknown as Parameters<typeof WorkspaceContext.fromHookContext>[0]);

    // 4. Record some NON-read tool call (so history is non-empty but target not read)
    wctx.trajectory.recordToolCall({
      sessionId: SESSION_ID,
      toolName: 'write_file',
      outcome: 'success',
      paramsJson: { file_path: 'src/other.ts', content: 'other' },
    });

    // 5. Call handleBeforeToolCall with write_file to a DIFFERENT unread path
    const event: PluginHookBeforeToolCallEvent = {
      toolName: 'write_file',
      params: { file_path: 'src/auth.ts', content: 'modified' },
    };
    const warn = vi.fn();
    const ctx: PluginHookToolContext = {
      workspaceDir: tempWorkspaceDir,
      sessionId: SESSION_ID,
      logger: { warn, info: () => {}, error: () => {} },
    };

    // 6. Shadow executes and is observable but cannot block.
    expect(handleBeforeToolCall(event, ctx)).toBeUndefined();
    expect(mockEventLogInstance.recordRuleHostEvaluated).toHaveBeenCalledWith(
      expect.objectContaining({ activationId: ACTIVATION_ID, activationMode: 'shadow', decision: 'block' }),
    );

    // 7. Atomic promotion makes the same activation live; only now may it block.
    await promoteActivation();
    const result = handleBeforeToolCall(event, ctx);

    expect(result).toBeDefined();
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain('R_RBW_001: read before write required');
  });

  it('Test K2: flag ON + read recorded → real VM allow (read-before-write)', async () => {
    setupTempWorkspace(true);
    sqliteConn = new SqliteConnection(tempWorkspaceDir);
    sqliteConn.getDb();

    insertV2RuleArtifact();
    await insertActivation();
    await promoteActivation();

    const wctx = WorkspaceContext.fromHookContext({
      workspaceDir: tempWorkspaceDir,
      logger: { warn: () => {}, info: () => {}, error: () => {} },
    } as unknown as Parameters<typeof WorkspaceContext.fromHookContext>[0]);

    // 1. Record a read for the TARGET path
    wctx.trajectory.recordToolCall({
      sessionId: SESSION_ID,
      toolName: 'read_file',
      outcome: 'success',
      paramsJson: { file_path: 'src/auth.ts' },
    });

    // 2. Call handleBeforeToolCall with write_file to the SAME path
    const event: PluginHookBeforeToolCallEvent = {
      toolName: 'write_file',
      params: { file_path: 'src/auth.ts', content: 'modified' },
    };
    const warn = vi.fn();
    const ctx: PluginHookToolContext = {
      workspaceDir: tempWorkspaceDir,
      sessionId: SESSION_ID,
      logger: { warn, info: () => {}, error: () => {} },
    };

    // 3. Assert: real VM execution returns allow (priorReadOfTarget === 'yes')
    const result = handleBeforeToolCall(event, ctx);

    // allow = result is undefined (gate passes through)
    expect(result).toBeUndefined();
  });

  it('Test K3: flag OFF suspends v2 activation without executing it', async () => {
    // 1. Setup: temp workspace with rulecode_context_v2 flag OFF
    setupTempWorkspace(false);
    sqliteConn = new SqliteConnection(tempWorkspaceDir);
    sqliteConn.getDb();

    // 2. Persist a v2 activation to simulate a previously-enabled workspace.
    insertV2RuleArtifact();
    await insertActivation();

    // 3. Get real WorkspaceContext
    const wctx = WorkspaceContext.fromHookContext({
      workspaceDir: tempWorkspaceDir,
      logger: { warn: () => {}, info: () => {}, error: () => {} },
    } as unknown as Parameters<typeof WorkspaceContext.fromHookContext>[0]);

    // 4. Record a non-read tool call
    wctx.trajectory.recordToolCall({
      sessionId: SESSION_ID,
      toolName: 'write_file',
      outcome: 'success',
      paramsJson: { file_path: 'src/other.ts', content: 'other' },
    });

    // 5. Call handleBeforeToolCall with write_file to unread path
    const event: PluginHookBeforeToolCallEvent = {
      toolName: 'write_file',
      params: { file_path: 'src/auth.ts', content: 'modified' },
    };
    const warn = vi.fn();
    const ctx: PluginHookToolContext = {
      workspaceDir: tempWorkspaceDir,
      sessionId: SESSION_ID,
      logger: { warn, info: () => {}, error: () => {} },
    };

    const result = handleBeforeToolCall(event, ctx);
    expect(result).toBeUndefined();
    expect(warn.mock.calls.flat().join(' ')).toContain('suspended_by_flag: rulecode_context_v2 is disabled or unavailable');
    expect(mockEventLogInstance.recordRuleHostRequireApproval).not.toHaveBeenCalled();
  });
});
