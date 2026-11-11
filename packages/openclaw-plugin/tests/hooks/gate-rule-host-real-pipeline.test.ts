/**
 * PRI-437 Slice 2: Valid decisions work through the production rule-host path
 *
 * PURPOSE: Verify that valid RuleHost decisions (block/allow) flow correctly
 * through the two production stages:
 *   createProductionRuleHostGate (real SQLite activations + real RuleCode
 *   runtime) → handleSharedRuleHostResult (deny accounting / allow pass-through)
 *
 * `handleBeforeToolCall` has no production wiring anymore; the shared path is
 * the only decision owner, so the assertions moved with it.
 *
 * No mocking of SQLite, the rule runtime, or gate internals.
 *
 * ERR risk mitigation:
 *   - ERR-024: validator is wired into the production path (verified end-to-end)
 *   - ERR-048: activation write (SQLite) connects to read (gate) connects to enforcement
 *   - ERR-002: valid decisions must NOT be silently degraded
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqliteConnection, SqliteActivationStateStore } from '@principles/core/runtime';
import { createProductionRuleHostGate } from '@principles/host-runtime';
import type { HostEvent } from '@principles/core/host';
import { handleSharedRuleHostResult } from '../../src/hooks/gate.js';
import type { PluginHookBeforeToolCallEvent, PluginHookToolContext } from '../../src/openclaw-sdk.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import { EventLogService } from '../../src/core/event-log.js';

// ── Test helpers ───────────────────────────────────────────────────────────

const RULE_ID = 'R_TEST_GATE_002';
const ARTIFACT_ID = 'art-gate-002';
const ACTIVATION_ID = `act_code_${RULE_ID}`;
const SESSION_ID = 'test-session-gate-002';

const BLOCK_CODE = `
function evaluate(input, helpers) {
  var p = input.action.normalizedPath || '';
  if (p.indexOf('/etc/') === 0 || p === '/etc') {
    return { decision: 'block', matched: true, reason: 'GATE_BLOCK_002: system directory' };
  }
  return { decision: 'allow', matched: false, reason: 'Not matched' };
}
var meta = { name: 'gate-test-rule', version: '1', ruleId: '${RULE_ID}', coversCondition: 'all' };
`;

let tempWorkspaceDir: string;
let sqliteConn: SqliteConnection;

function setupTempDirs(): void {
  const baseTmp = os.tmpdir();
  tempWorkspaceDir = fs.mkdtempSync(path.join(baseTmp, 'pd-gate-real-'));
}

function insertRuleArtifact(): void {
  const db = sqliteConn.getDb();
  const now = new Date().toISOString();
  const contentJson = JSON.stringify({
    principleId: 'P_TEST_GATE_002',
    ruleId: RULE_ID,
    implementationCode: BLOCK_CODE,
    goldenTrace: {
      traceId: 'trace-gate-002',
      cases: [],
      createdAt: now,
      version: 1,
    },
    ruleHostGateDecision: 'accepted_shadow',
    affectedTools: ['write'],
    painReasonSummary: 'Test: block /etc writes via gate',
  });

  db.prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ARTIFACT_ID,
    'rule',
    'task-gate-002',
    'P_TEST_GATE_002',
    RULE_ID,
    '[]',
    'validated',
    contentJson,
    now,
    now,
  );
}

async function insertActivation(action = 'code_tool_hook_live_activate'): Promise<void> {
  const store = new SqliteActivationStateStore(sqliteConn);
  const now = new Date().toISOString();
  await store.recordActivation({
    activationId: ACTIVATION_ID,
    idempotencyKey: `${ARTIFACT_ID}::code_tool_hook`,
    artifactId: ARTIFACT_ID,
    channel: 'code_tool_hook',
    action,
    targetRef: `impl://${RULE_ID}`,
    activatedAt: now,
    deactivatedAt: null,
  });
}

function makeHostEvent(filePath: string, extra: { sessionId?: string; toolCallId?: string } = {}): HostEvent {
  return {
    kind: 'before_tool_call',
    context: {
      workspaceDir: tempWorkspaceDir,
      sessionId: extra.sessionId ?? SESSION_ID,
      toolName: 'write',
      ...(extra.toolCallId !== undefined ? { toolCallId: extra.toolCallId } : {}),
    },
    rawPayload: { toolInput: { toolName: 'write', params: { file_path: filePath, content: 'payload' } } },
    source: 'openclaw:before_tool_call',
  };
}

function makePluginEvent(filePath: string, extra: Record<string, unknown> = {}): PluginHookBeforeToolCallEvent {
  return {
    toolName: 'write',
    params: { file_path: filePath, content: 'payload' },
    ...extra,
  } as PluginHookBeforeToolCallEvent;
}

function makeCtx(sessionId = SESSION_ID): PluginHookToolContext {
  return {
    workspaceDir: tempWorkspaceDir,
    sessionId,
    logger: { warn: () => {}, error: () => {}, info: () => {} },
  };
}

/** The EventLog instance the workspace context itself writes through. */
function workspaceEvents() {
  const stateDir = WorkspaceContext.fromHookContext({ workspaceDir: tempWorkspaceDir }).stateDir;
  return EventLogService.get(stateDir).getBufferedEvents();
}

// ── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  setupTempDirs();
  WorkspaceContext.clearCache();
  sqliteConn = new SqliteConnection(tempWorkspaceDir);
  sqliteConn.getDb();
});

afterEach(() => {
  WorkspaceContext.clearCache();
  try { sqliteConn?.close(); } catch { /* best-effort */ }
  try { fs.rmSync(tempWorkspaceDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

// ── Slice 2: Valid decisions through the production path ───────────────────

describe('PRI-437 Slice 2: Valid decisions work through the production rule-host path', () => {
  it('valid block decision from SQLite activation → shared gate denies and the deny is accounted', async () => {
    // Setup: real SQLite activation with valid blocking code
    insertRuleArtifact();
    await insertActivation();

    const gate = createProductionRuleHostGate();
    const gateResult = await gate(makeHostEvent('/etc/passwd', { toolCallId: 'toolu-real-1' }));

    // Verify: the shared gate produced the block decision from the real rule
    expect(gateResult.decision).toBe('deny');
    expect(gateResult.reason).toContain('GATE_BLOCK_002: system directory');

    const handled = handleSharedRuleHostResult(
      makePluginEvent('/etc/passwd', { toolUseId: 'toolu-real-1' }),
      makeCtx(),
      gateResult,
    );

    // The host blocks on the deny decision; the adapter returns the SAME
    // owner-facing block copy (PRI-1184 / F4) while accounting for the block.
    expect(handled?.block).toBe(true);
    expect(workspaceEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'gate_block',
        data: expect.objectContaining({
          toolName: 'write',
          // DIFF: the shared path tags the block source 'rule-host-shared'
          // (the legacy hook wrote 'rule-host').
          blockSource: 'rule-host-shared',
        }),
      }),
    ]));
  });

  it('shadow block is observed but does not block the tool call', async () => {
    insertRuleArtifact();
    await insertActivation('code_tool_hook_shadow_activate');

    const gate = createProductionRuleHostGate();
    const gateResult = await gate(makeHostEvent('/etc/passwd', { sessionId: 'test-session-shadow' }));

    expect(gateResult.decision).toBe('allow');

    const handled = handleSharedRuleHostResult(
      makePluginEvent('/etc/passwd'),
      makeCtx('test-session-shadow'),
      gateResult,
    );

    expect(handled).toBeUndefined();
    expect(workspaceEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'rulehost_evaluated',
        data: expect.objectContaining({
          activationId: ACTIVATION_ID,
          activationMode: 'shadow',
          decision: 'block',
          ruleId: RULE_ID,
        }),
      }),
    ]));
  });

  it('valid allow (no match) from SQLite activation → the tool call passes', async () => {
    insertRuleArtifact();
    await insertActivation();

    const gate = createProductionRuleHostGate();
    const gateResult = await gate(makeHostEvent('/safe/project/file.txt'));

    expect(gateResult.decision).toBe('allow');

    const handled = handleSharedRuleHostResult(
      makePluginEvent('/safe/project/file.txt'),
      makeCtx(),
      gateResult,
    );

    // Verify: no block (allow passes through)
    expect(handled).toBeUndefined();
  });

  it('no SQLite activation → the gate has no opinion and the tool call passes', async () => {
    // Artifact exists but no activation
    insertRuleArtifact();

    const gate = createProductionRuleHostGate();
    const gateResult = await gate(makeHostEvent('/etc/passwd'));

    expect(gateResult.decision).toBe('allow');

    const handled = handleSharedRuleHostResult(
      makePluginEvent('/etc/passwd'),
      makeCtx(),
      gateResult,
    );

    // No activation → the gate reports no_rules_armed → gate allows
    expect(handled).toBeUndefined();
  });
});
