/**
 * PRI-437 Slice 2: Valid decisions work through public before-tool-call hook
 *
 * PURPOSE: Verify that valid RuleHost decisions (block/allow) flow correctly
 * through the real handleBeforeToolCall public hook with real SQLite activations.
 *
 * This test exercises the FULL public path:
 *   real SQLite activation → real RuleHost.evaluate() → validateRuleHostResult()
 *   → real handleBeforeToolCall() → block/allow result
 *
 * No mocking of RuleHost, SQLite, or gate internals.
 *
 * ERR risk mitigation:
 *   - ERR-024: validator is wired into the production path (verified end-to-end)
 *   - ERR-048: activation write (SQLite) connects to read (RuleHost) connects to enforcement (gate)
 *   - ERR-002: valid decisions must NOT be silently degraded
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqliteConnection, SqliteActivationStateStore } from '@principles/core/runtime-v2';
import { handleBeforeToolCall } from '../../src/hooks/gate.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';

// ── Test helpers ───────────────────────────────────────────────────────────

const RULE_ID = 'R_TEST_GATE_002';
const ARTIFACT_ID = 'art-gate-002';
const ACTIVATION_ID = `act_code_${RULE_ID}`;

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
let tempStateDir: string;
let sqliteConn: SqliteConnection;

function setupTempDirs(): void {
  const baseTmp = os.tmpdir();
  tempWorkspaceDir = fs.mkdtempSync(path.join(baseTmp, 'pd-gate-real-'));
  tempStateDir = path.join(tempWorkspaceDir, '.principles');
  fs.mkdirSync(tempStateDir, { recursive: true });
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
    affectedTools: ['write_file'],
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

// ── Slice 2: Valid decisions through public hook ───────────────────────────

describe('PRI-437 Slice 2: Valid decisions work through public before-tool-call hook', () => {
  it('valid block decision from SQLite activation → handleBeforeToolCall returns block result', async () => {
    // Setup: real SQLite activation with valid blocking code
    insertRuleArtifact();
    await insertActivation();

    // Exercise the PUBLIC hook with a real event targeting /etc/passwd
    const event = {
      toolName: 'write_file',
      params: { file_path: '/etc/passwd', content: 'malicious' },
    };

    const result = handleBeforeToolCall(
      event as any,
      {
        workspaceDir: tempWorkspaceDir,
        sessionId: 'test-session-gate-002',
        logger: { warn: () => {}, error: () => {}, info: () => {} },
      } as any,
    );

    // Verify: block decision is enforced through the public hook
    expect(result).toBeDefined();
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain('GATE_BLOCK_002: system directory');
  });

  it('valid allow (no match) from SQLite activation → handleBeforeToolCall returns undefined', async () => {
    insertRuleArtifact();
    await insertActivation();

    // Exercise the PUBLIC hook with a safe path that does NOT match the block rule
    const event = {
      toolName: 'write_file',
      params: { file_path: '/safe/project/file.txt', content: 'safe content' },
    };

    const result = handleBeforeToolCall(
      event as any,
      {
        workspaceDir: tempWorkspaceDir,
        sessionId: 'test-session-gate-002',
        logger: { warn: () => {}, error: () => {}, info: () => {} },
      } as any,
    );

    // Verify: no block (allow passes through)
    expect(result).toBeUndefined();
  });

  it('no SQLite activation → handleBeforeToolCall returns undefined (no opinion)', async () => {
    // Artifact exists but no activation
    insertRuleArtifact();

    const event = {
      toolName: 'write_file',
      params: { file_path: '/etc/passwd', content: 'malicious' },
    };

    const result = handleBeforeToolCall(
      event as any,
      {
        workspaceDir: tempWorkspaceDir,
        sessionId: 'test-session-gate-002',
        logger: { warn: () => {}, error: () => {}, info: () => {} },
      } as any,
    );

    // No activation → RuleHost returns undefined → gate allows
    expect(result).toBeUndefined();
  });
});
