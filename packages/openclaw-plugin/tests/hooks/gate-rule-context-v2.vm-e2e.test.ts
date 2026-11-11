/**
 * PRI-486 Phase 7 — RuleContext v2 production VM E2E (spec §10.2 layer-3)
 *
 * PURPOSE: Verify the production hook runtime with REAL VM execution:
 *   validated fixture activation → recordToolCall
 *   → OpenClaw production runtime (createOpenClawHostRuntime, the object
 *     src/index.ts assembles) → buildProductionRuleContext → real VM → block/allow
 *
 * PR-1 (RuleHost retirement): the entry point was `handleBeforeToolCall`, which
 * has no production wiring. The test now drives `dispatchBeforeToolCall` on the
 * SAME runtime object index.ts registers, so the block/allow contract asserted
 * here is the one the host actually receives.
 *
 * This is a runtime component test, not the generation/approval E2E. It uses
 * fixture artifacts deliberately and does not claim to validate that upstream chain.
 *   - Real TrajectoryDatabase (production schema)
 *   - Real loadPdConfigForPlugin (reads .pd/config.yaml)
 *   - Real buildProductionRuleContext
 *   - Real SqliteConnection + real evaluateBatch (real VM subprocess)
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
import { SqliteConnection, SqliteActivationStateStore } from '@principles/core/runtime';
import { buildRuleContextIfEnabled, handleSharedRuleHostResult } from '../../src/hooks/gate.js';
import type { PluginHookBeforeToolCallEvent, PluginHookToolContext } from '../../src/openclaw-sdk.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import { createOpenClawHostRuntime } from '../../src/host-runtime/openclaw-host-runtime.js';

// ── Mocks (non-RuleHost only; the rule engine runs real VM) ────────────────

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
 * When the flag is OFF the shared gate suspends this v2 rule BEFORE the VM
 * runs (it requires an available v2 context), so the write is allowed.
 */
const V2_RULE_CODE = `
function evaluate(input, helpers) {
  if (input.workspace.isRiskPath) {
    return { decision: 'block', matched: true, reason: 'R_RBW_001: risk path blocked' };
  }
  if (!input.context || input.context.history.status === 'unavailable') {
    return { decision: 'allow', matched: false, reason: 'R_RBW_001: context unavailable, fail-soft' };
  }
  if (input.action.toolName === 'write' && input.context.facts.priorReadOfTarget === 'no') {
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
      // PRI-780: the flag defaults ON — the OFF branch must set the explicit
      // config kill switch (not merely omit the feature key).
      ...(enableV2Flag
        ? { rulecode_context_v2: { category: 'quiet', enabled: true } }
        : { rulecode_context_v2: { category: 'quiet', enabled: false } }),
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
    affectedTools: ['write'],
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

/**
 * The SAME runtime object src/index.ts assembles: production context provider,
 * production shared-result handler, real node VM evaluator.
 */
function makeRuntime() {
  return createOpenClawHostRuntime({
    ruleContextProvider: (event, context, request) => buildRuleContextIfEnabled(
      WorkspaceContext.fromHookContext({ ...context, workspaceDir: context.workspaceDir }),
      request.targetPath,
      context.sessionId,
      context.logger,
    ),
    onBeforeToolResult: (event, context, result) => handleSharedRuleHostResult(
      event,
      { ...context, workspaceDir: context.workspaceDir, logger: context.logger },
      result,
    ),
  });
}

function makeEvent(): PluginHookBeforeToolCallEvent {
  return {
    toolName: 'write',
    params: { file_path: 'src/auth.ts', content: 'modified' },
  } as PluginHookBeforeToolCallEvent;
}

function makeCtx(warn: (message: string) => void): PluginHookToolContext {
  return {
    workspaceDir: tempWorkspaceDir,
    sessionId: SESSION_ID,
    logger: { warn, info: () => {}, error: () => {} },
  } as unknown as PluginHookToolContext;
}

function recordNonReadToolCall(): void {
  const wctx = WorkspaceContext.fromHookContext({
    workspaceDir: tempWorkspaceDir,
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  } as unknown as Parameters<typeof WorkspaceContext.fromHookContext>[0]);
  // History is non-empty, but the target path was never read.
  wctx.trajectory.recordToolCall({
    sessionId: SESSION_ID,
    toolName: 'write',
    outcome: 'success',
    paramsJson: { file_path: 'src/other.ts', content: 'other' },
  });
}

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

    // 3. Record a NON-read tool call (history non-empty, target not read)
    recordNonReadToolCall();

    // 4. Production runtime entry point + host context
    const runtime = makeRuntime();
    const warn = vi.fn();
    const event = makeEvent();
    const ctx = makeCtx(warn);

    // 5. Shadow executes and is observable but cannot block.
    expect(await runtime.dispatchBeforeToolCall(event, ctx)).toBeUndefined();
    expect(mockEventLogInstance.recordRuleHostEvaluated).toHaveBeenCalledWith(
      expect.objectContaining({ activationId: ACTIVATION_ID, activationMode: 'shadow', decision: 'block' }),
    );

    // 6. Atomic promotion makes the same activation live; only now may it block.
    await promoteActivation();
    const result = await runtime.dispatchBeforeToolCall(event, ctx);

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

    // 2. Dispatch the production before_tool_call with a write to the SAME path
    const runtime = makeRuntime();
    const warn = vi.fn();
    const ctx = makeCtx(warn);

    // 3. Real VM execution returns allow (priorReadOfTarget === 'yes')
    expect(await runtime.dispatchBeforeToolCall(makeEvent(), ctx)).toBeUndefined();
    // The live aggregate row proves the rule actually ran (and allowed); an
    // allow has no winning activation id, so only the decision is attributable.
    expect(mockEventLogInstance.recordRuleHostEvaluated).toHaveBeenCalledWith(
      expect.objectContaining({ activationMode: 'live', decision: 'allow' }),
    );
  });

  it('Test K3: flag OFF suspends v2 activation without executing it', async () => {
    // 1. Setup: temp workspace with rulecode_context_v2 flag OFF
    setupTempWorkspace(false);
    sqliteConn = new SqliteConnection(tempWorkspaceDir);
    sqliteConn.getDb();

    // 2. Persist a v2 activation to simulate a previously-enabled workspace.
    insertV2RuleArtifact();
    await insertActivation();

    // 3. Record a non-read tool call
    recordNonReadToolCall();

    // 4. Dispatch a write to the unread path. If the rule executed, the VM
    // would block; the allow below therefore proves suspension-before-VM.
    const runtime = makeRuntime();
    const warn = vi.fn();
    const result = await runtime.dispatchBeforeToolCall(makeEvent(), makeCtx(warn));

    expect(result).toBeUndefined();
    // rc-9: the suspension reason is surfaced by the shared gate's warnings,
    // which the production handler logs.
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('rule_context_v2_unavailable: provider_returned_undefined');
    expect(logged).toContain(`(activation=${ACTIVATION_ID})`);
    // No live rule evaluated → the aggregate evaluation row says so.
    expect(mockEventLogInstance.recordRuleHostEvaluated).toHaveBeenCalledWith(
      expect.objectContaining({ activationMode: 'live', decision: 'no_rules_armed' }),
    );
    expect(mockEventLogInstance.recordRuleHostRequireApproval).not.toHaveBeenCalled();
  });
});
