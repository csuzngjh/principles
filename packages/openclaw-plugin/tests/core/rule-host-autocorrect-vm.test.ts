/**
 * PRI-437 Adversarial Self-Review: Valid auto_correct from VM must be accepted
 *
 * PURPOSE: Verify that a valid auto_correct proposal created INSIDE the vm
 * context is accepted by the validator (not rejected due to prototype realm
 * mismatch).
 *
 * CONTEXT: validateCorrectionProposal uses isPlainObject which checks
 * Object.getPrototypeOf() === Object.prototype. VM-created objects have
 * prototypes from the VM realm, not the host realm, so isPlainObject
 * returns false and rejects all VM-created proposals.
 *
 * ERR risk mitigation:
 *   - ERR-001: no `as` bypass on untrusted VM output
 *   - ERR-002: fail-closed with reason (not silent rejection)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqliteConnection, SqliteActivationStateStore } from '@principles/core/runtime-v2';
import type { RuleHostInput } from '@principles/core/runtime-v2';
import { RuleHost } from '../../src/core/rule-host.js';

let tempWorkspaceDir: string;
let tempStateDir: string;
let sqliteConn: SqliteConnection;

function setupTempDirs(): void {
  const baseTmp = os.tmpdir();
  tempWorkspaceDir = fs.mkdtempSync(path.join(baseTmp, 'pd-rulehost-autocorrect-'));
  tempStateDir = path.join(tempWorkspaceDir, '.principles');
  fs.mkdirSync(tempStateDir, { recursive: true });
}

function insertRuleArtifact(
  artifactId: string,
  ruleId: string,
  sourceTaskId: string,
  code: string,
): void {
  const db = sqliteConn.getDb();
  const now = new Date().toISOString();
  const contentJson = JSON.stringify({
    principleId: `P_${ruleId}`,
    ruleId,
    implementationCode: code,
    goldenTrace: { traceId: `trace-${ruleId}`, cases: [], createdAt: now, version: 1 },
    ruleHostGateDecision: 'accepted_shadow',
    affectedTools: ['write_file'],
    painReasonSummary: 'Test: auto_correct',
  });

  db.prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    artifactId, 'rule', sourceTaskId, `P_${ruleId}`, ruleId,
    '[]', 'validated', contentJson, now, now,
  );
}

async function insertActivation(
  activationId: string,
  artifactId: string,
  ruleId: string,
): Promise<void> {
  const store = new SqliteActivationStateStore(sqliteConn);
  const now = new Date().toISOString();
  await store.recordActivation({
    activationId,
    idempotencyKey: `${artifactId}::code_tool_hook`,
    artifactId,
    channel: 'code_tool_hook',
    action: 'code_tool_hook_live_activate',
    targetRef: `impl://${ruleId}`,
    activatedAt: now,
    deactivatedAt: null,
  });
}

function makeInput(normalizedPath: string): RuleHostInput {
  return {
    action: {
      toolName: 'write_file',
      normalizedPath,
      paramsSummary: { path: normalizedPath },
    },
    workspace: { isRiskPath: false },
    session: { sessionId: 'test-session-autocorrect', currentGfi: 0, recentThinking: false },
    evolution: { epTier: 0 },
    derived: { estimatedLineChanges: 1, bashRisk: 'safe' as const },
  };
}

beforeEach(() => {
  setupTempDirs();
  sqliteConn = new SqliteConnection(tempWorkspaceDir);
  sqliteConn.getDb();
});

afterEach(() => {
  try { sqliteConn?.close(); } catch { /* best-effort */ }
  try { fs.rmSync(tempWorkspaceDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

describe('PRI-437 Adversarial Self-Review: Valid auto_correct from VM must be accepted', () => {
  it('valid auto_correct proposal created inside VM is accepted (not rejected by isPlainObject)', async () => {
    const RULE_ID = 'R_TEST_AUTOCORRECT_VALID';
    const ARTIFACT_ID = 'art-autocorrect-valid';
    const ACTIVATION_ID = `act_code_${RULE_ID}`;

    // RuleCode that returns a valid auto_correct proposal.
    // The proposal object is created INSIDE the vm context, so its prototype
    // is the VM realm's Object.prototype, not the host's.
    const VALID_AUTOCORRECT_CODE = `
function evaluate(input, helpers) {
  return {
    decision: 'auto_correct',
    matched: true,
    reason: 'path should be within workspace',
    correctionProposal: {
      ruleId: '${RULE_ID}',
      correctedFields: [{ field: 'file_path', original: input.action.normalizedPath, proposed: '/safe/path', reason: 'redirect to safe path' }],
      proposedParams: { file_path: '/safe/path' },
      applicationMode: 'shadow',
      confidence: 0.9,
      notifyAgent: true
    }
  };
}
var meta = { name: 'autocorrect-rule', version: '1', ruleId: '${RULE_ID}', coversCondition: 'all' };
`;

    insertRuleArtifact(ARTIFACT_ID, RULE_ID, 'task-autocorrect-valid', VALID_AUTOCORRECT_CODE);
    await insertActivation(ACTIVATION_ID, ARTIFACT_ID, RULE_ID);

    const warnCalls: string[] = [];
    const spyLogger = {
      warn: (message: string) => { warnCalls.push(message); },
      error: () => {},
      info: () => {},
    };

    const ruleHost = new RuleHost(tempStateDir, spyLogger, { workspaceDir: tempWorkspaceDir });
    const result = ruleHost.evaluate(makeInput('/etc/passwd'));

    // The valid auto_correct proposal MUST be accepted — not rejected due to
    // VM prototype realm mismatch.
    expect(result).toBeDefined();
    expect(result?.decision).toBe('auto_correct');
    expect(result?.matched).toBe(true);
    expect(result?.correctionProposal).toBeDefined();
    expect(result?.correctionProposal?.ruleId).toBe(RULE_ID);

    // No warnings should be emitted about invalid results
    const invalidWarn = warnCalls.find(m =>
      m.toLowerCase().includes('invalid') ||
      m.toLowerCase().includes('must be a plain object')
    );
    expect(invalidWarn).toBeUndefined();
  });
});
