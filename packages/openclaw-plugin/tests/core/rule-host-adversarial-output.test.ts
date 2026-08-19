/**
 * PRI-437 Slice 5: Invalid tier/adversarial diagnostics cannot corrupt output
 *
 * PURPOSE: Verify that adversarial RuleCode cannot corrupt the RuleHost output
 * or merge logic through:
 *   1. Prototype pollution in diagnostics field
 *   2. Invalid tier in input (non-number epTier)
 *   3. Adversarial correctionProposal with prototype pollution
 *
 * ERR risk mitigation:
 *   - ERR-001: no `as` bypass on untrusted VM output
 *   - ERR-013: Object.hasOwn for untrusted keys
 *   - ERR-005: validate array element types
 *
 * Test approach:
 *   - Real SQLite activation with adversarial RuleCode
 *   - Real RuleHost.evaluate() (public interface)
 *   - Verify output is either rejected (undefined) or safely contained
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqliteConnection, SqliteActivationStateStore } from '@principles/core/runtime-v2';
import type { RuleHostInput } from '@principles/core/runtime-v2';
import { RuleHost } from '../../src/core/rule-host.js';

// ── Test helpers ───────────────────────────────────────────────────────────

let tempWorkspaceDir: string;
let tempStateDir: string;
let sqliteConn: SqliteConnection;

function setupTempDirs(): void {
  const baseTmp = os.tmpdir();
  tempWorkspaceDir = fs.mkdtempSync(path.join(baseTmp, 'pd-rulehost-adversarial-'));
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
    painReasonSummary: 'Test: adversarial',
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
    action: 'code_tool_hook_shadow_activate',
    targetRef: `impl://${ruleId}`,
    activatedAt: now,
    deactivatedAt: null,
  });
}

function makeInput(normalizedPath: string, epTier?: unknown): RuleHostInput {
  return {
    action: {
      toolName: 'write_file',
      normalizedPath,
      paramsSummary: { path: normalizedPath },
    },
    workspace: { isRiskPath: false },
    session: { sessionId: 'test-session-adversarial', currentGfi: 0 },
    evolution: { epTier: epTier as number },
    derived: { estimatedLineChanges: 1, bashRisk: 'safe' as const },
  };
}

// ── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  setupTempDirs();
  sqliteConn = new SqliteConnection(tempWorkspaceDir);
  sqliteConn.getDb();
});

afterEach(() => {
  try { sqliteConn?.close(); } catch { /* best-effort */ }
  try { fs.rmSync(tempWorkspaceDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

// ── Slice 5: Adversarial diagnostics cannot corrupt output ─────────────────

describe('PRI-437 Slice 5: Invalid tier/adversarial diagnostics cannot corrupt output', () => {
  it('prototype pollution in diagnostics field is rejected by validator', async () => {
    const RULE_ID = 'R_TEST_PROTO_005';
    const ARTIFACT_ID = 'art-proto-005';
    const ACTIVATION_ID = `act_code_${RULE_ID}`;

    // RuleCode that tries to inject __proto__ as an own property in diagnostics
    const ADVERSARIAL_CODE = `
function evaluate(input, helpers) {
  var diag = {};
  Object.defineProperty(diag, '__proto__', { value: { polluted: true }, enumerable: true, configurable: true });
  Object.defineProperty(diag, 'constructor', { value: { polluted: true }, enumerable: true, configurable: true });
  return { decision: 'block', matched: true, reason: 'adversarial', diagnostics: diag };
}
var meta = { name: 'proto-rule', version: '1', ruleId: '${RULE_ID}', coversCondition: 'all' };
`;

    insertRuleArtifact(ARTIFACT_ID, RULE_ID, 'task-proto-005', ADVERSARIAL_CODE);
    await insertActivation(ACTIVATION_ID, ARTIFACT_ID, RULE_ID);

    const warnCalls: string[] = [];
    const spyLogger = {
      warn: (message: string) => { warnCalls.push(message); },
      error: () => {},
      info: () => {},
    };

    const ruleHost = new RuleHost(tempStateDir, spyLogger, { workspaceDir: tempWorkspaceDir });
    const result = ruleHost.evaluate(makeInput('/etc/passwd'));

    // PRI-437 fail-closed contract: adversarial results must be rejected entirely,
    // resulting in conservative degradation (undefined). Not "accepted but sanitized".
    expect(result).toBeUndefined();

    // Must emit warn evidence about the invalid result
    expect(warnCalls.length).toBeGreaterThan(0);
  });

  it('invalid tier (string) in input does not corrupt output validation', async () => {
    const RULE_ID = 'R_TEST_TIER_005';
    const ARTIFACT_ID = 'art-tier-005';
    const ACTIVATION_ID = `act_code_${RULE_ID}`;

    // RuleCode that tries to use epTier as a string and produces invalid output
    const ADVERSARIAL_CODE = `
function evaluate(input, helpers) {
  var tier = input.evolution.epTier;
  // If tier is a string, try to use it to bypass validation
  if (typeof tier === 'string') {
    return { decision: 'BLOCK', matched: 'yes', reason: 123 };
  }
  return { decision: 'block', matched: true, reason: 'valid block' };
}
var meta = { name: 'tier-rule', version: '1', ruleId: '${RULE_ID}', coversCondition: 'all' };
`;

    insertRuleArtifact(ARTIFACT_ID, RULE_ID, 'task-tier-005', ADVERSARIAL_CODE);
    await insertActivation(ACTIVATION_ID, ARTIFACT_ID, RULE_ID);

    const warnCalls: string[] = [];
    const spyLogger = {
      warn: (message: string) => { warnCalls.push(message); },
      error: () => {},
      info: () => {},
    };

    const ruleHost = new RuleHost(tempStateDir, spyLogger, { workspaceDir: tempWorkspaceDir });

    // Pass invalid tier (string instead of number)
    const result = ruleHost.evaluate(makeInput('/etc/passwd', 'invalid_tier_string'));

    // The invalid output (decision='BLOCK' instead of 'block', matched='yes' instead of boolean)
    // must be rejected by the validator → undefined (conservative degradation)
    expect(result).toBeUndefined();

    // Must emit warn evidence about the invalid result
    expect(warnCalls.length).toBeGreaterThan(0);
    const invalidWarn = warnCalls.find(m =>
      m.toLowerCase().includes('invalid') ||
      m.toLowerCase().includes('evaluation failed')
    );
    expect(invalidWarn).toBeDefined();
  });

  it('adversarial correctionProposal with prototype pollution is rejected', async () => {
    const RULE_ID = 'R_TEST_CORR_005';
    const ARTIFACT_ID = 'art-corr-005';
    const ACTIVATION_ID = `act_code_${RULE_ID}`;

    // RuleCode that returns auto_correct with adversarial correctionProposal
    const ADVERSARIAL_CODE = `
function evaluate(input, helpers) {
  var proposal = {
    ruleId: '${RULE_ID}',
    correctedFields: [{ field: 'file_path', reason: 'x' }],
    proposedParams: { file_path: '/safe/path' },
    applicationMode: 'live',
    confidence: 0.9,
  };
  // Try to inject __proto__ into the proposal
  Object.defineProperty(proposal, '__proto__', { value: { polluted: true }, enumerable: true });
  return { decision: 'auto_correct', matched: true, reason: 'adversarial correction', correctionProposal: proposal };
}
var meta = { name: 'corr-rule', version: '1', ruleId: '${RULE_ID}', coversCondition: 'all' };
`;

    insertRuleArtifact(ARTIFACT_ID, RULE_ID, 'task-corr-005', ADVERSARIAL_CODE);
    await insertActivation(ACTIVATION_ID, ARTIFACT_ID, RULE_ID);

    const warnCalls: string[] = [];
    const spyLogger = {
      warn: (message: string) => { warnCalls.push(message); },
      error: () => {},
      info: () => {},
    };

    const ruleHost = new RuleHost(tempStateDir, spyLogger, { workspaceDir: tempWorkspaceDir });
    const result = ruleHost.evaluate(makeInput('/etc/passwd'));

    // PRI-437 fail-closed contract: adversarial correctionProposal must be rejected
    // entirely, resulting in conservative degradation (undefined).
    expect(result).toBeUndefined();

    // Must emit warn evidence
    expect(warnCalls.length).toBeGreaterThan(0);
  });
});
