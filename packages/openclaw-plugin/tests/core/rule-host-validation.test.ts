/**
 * PRI-437: Harden RuleHost execution validation, isolation and activation health
 *
 * TDD vertical slices:
 *   1. Malformed VM results never enforce and create unhealthy evidence
 *   2. Valid decisions work through public before-tool-call hook
 *   3. Infinite loop and memory allocation terminate without taking down host
 *   4. Approved compile failure is visible in health, CLI JSON and Console API
 *   5. Invalid tier/adversarial diagnostics cannot corrupt output
 *
 * Tests verify through public interfaces:
 *   - Real SQLite store (SqliteConnection + SqliteActivationStateStore)
 *   - Real RuleHost.evaluate()
 *   - No mocking of private internals
 *
 * ERR risk mitigation:
 *   - ERR-001: no `as` bypass at trust boundary — VM output validated as unknown
 *   - ERR-002: no catch-and-degrade — malformed results emit structured unhealthy evidence
 *   - ERR-013: Object.hasOwn for untrusted object key checks
 *   - ERR-024: validator wired into production path, not just demo/test
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqliteConnection, SqliteActivationStateStore } from '@principles/core/runtime-v2';
import type { RuleHostInput } from '@principles/core/runtime-v2';
import { RuleHost } from '../../src/core/rule-host.js';

// ── Test helpers (shared with rule-host-sqlite-source.test.ts pattern) ──────

const RULE_ID = 'R_TEST_PRI437_001';
const ARTIFACT_ID = 'art-pri437-001';
const ACTIVATION_ID = `act_code_${RULE_ID}`;

let tempWorkspaceDir: string;
let tempStateDir: string;
let sqliteConn: SqliteConnection;

function setupTempDirs(): void {
  const baseTmp = os.tmpdir();
  tempWorkspaceDir = fs.mkdtempSync(path.join(baseTmp, 'pd-rulehost-pri437-'));
  tempStateDir = path.join(tempWorkspaceDir, '.principles');
  fs.mkdirSync(tempStateDir, { recursive: true });
}

function insertRuleArtifact(overrides?: {
  artifactId?: string;
  ruleId?: string;
  contentJson?: string;
  validationStatus?: string;
  sourceTaskId?: string;
}): void {
  const artifactId = overrides?.artifactId ?? ARTIFACT_ID;
  const ruleId = overrides?.ruleId ?? RULE_ID;
  const validationStatus = overrides?.validationStatus ?? 'validated';
  const sourceTaskId = overrides?.sourceTaskId ?? 'task-pri437-001';
  const db = sqliteConn.getDb();
  const now = new Date().toISOString();

  const contentJson = overrides?.contentJson ?? JSON.stringify({
    principleId: 'P_TEST_PRI437',
    ruleId,
    implementationCode: '',
    goldenTrace: {
      traceId: 'trace-pri437',
      cases: [],
      createdAt: now,
      version: 1,
    },
    ruleHostGateDecision: 'accepted_shadow',
    affectedTools: ['write_file'],
    painReasonSummary: 'Test: PRI-437',
  });

  db.prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    artifactId,
    'rule',
    sourceTaskId,
    'P_TEST_PRI437',
    ruleId,
    '[]',
    validationStatus,
    contentJson,
    now,
    now,
  );
}

async function insertCodeToolHookActivation(overrides?: {
  activationId?: string;
  artifactId?: string;
  ruleId?: string;
  deactivatedAt?: string | null;
}): Promise<void> {
  const activationId = overrides?.activationId ?? ACTIVATION_ID;
  const artifactId = overrides?.artifactId ?? ARTIFACT_ID;
  const ruleId = overrides?.ruleId ?? RULE_ID;
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
    deactivatedAt: overrides?.deactivatedAt ?? null,
  });
}

function makeInput(normalizedPath: string): RuleHostInput {
  return {
    action: {
      toolName: 'write_file',
      normalizedPath,
      paramsSummary: { path: normalizedPath },
    },
    workspace: {
      isRiskPath: false,
    },
    session: {
      sessionId: 'test-session',
      currentGfi: 0,
    },
    evolution: {
      epTier: 1,
    },
    derived: {
      estimatedLineChanges: 1,
      bashRisk: 'safe' as const,
    },
  };
}

function makeContentJson(ruleId: string, code: string): string {
  return JSON.stringify({
    principleId: 'P_TEST_PRI437',
    ruleId,
    implementationCode: code,
    goldenTrace: {
      traceId: 'trace-pri437',
      cases: [],
      createdAt: new Date().toISOString(),
      version: 1,
    },
    ruleHostGateDecision: 'accepted_shadow',
    affectedTools: ['write_file'],
    painReasonSummary: 'Test: PRI-437',
  });
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

// ── Slice 1: Malformed VM results never enforce and create unhealthy evidence ─

describe('PRI-437 Slice 1: Malformed VM results never enforce and create unhealthy evidence', () => {
  it('malformed result with non-string reason does not enforce and emits unhealthy evidence', async () => {
    // RuleCode returns { matched: true, decision: 'block', reason: 42 } — reason is a number, not a string
    const MALFORMED_CODE = `
function evaluate(input, helpers) {
  return { matched: true, decision: 'block', reason: 42 };
}
var meta = { name: 'malformed-rule', version: '1', ruleId: '${RULE_ID}', coversCondition: 'all' };
`;
    insertRuleArtifact({ contentJson: makeContentJson(RULE_ID, MALFORMED_CODE) });
    await insertCodeToolHookActivation();

    const warnCalls: string[] = [];
    const spyLogger: { warn: (_message: string) => void } = {
      warn: (message: string) => { warnCalls.push(message); },
    };

    const ruleHost = new RuleHost(tempStateDir, spyLogger, { workspaceDir: tempWorkspaceDir });
    const result = ruleHost.evaluate(makeInput('/etc/passwd'));

    // Malformed result must NOT enforce — no block returned
    expect(result).toBeUndefined();

    // Unhealthy evidence must be emitted via logger.warn
    expect(warnCalls.length).toBeGreaterThan(0);
    const unhealthyWarn = warnCalls.find(m =>
      m.toLowerCase().includes('invalid') ||
      m.toLowerCase().includes('malformed') ||
      m.toLowerCase().includes('unhealthy') ||
      m.toLowerCase().includes('validation')
    );
    expect(unhealthyWarn).toBeDefined();
  });

  it('malformed result with non-boolean matched does not enforce and emits unhealthy evidence', async () => {
    // RuleCode returns { matched: "yes", decision: 'block', reason: 'valid' } — matched is a string
    const MALFORMED_CODE = `
function evaluate(input, helpers) {
  return { matched: "yes", decision: 'block', reason: 'Blocked: system directory' };
}
var meta = { name: 'malformed-matched', version: '1', ruleId: '${RULE_ID}', coversCondition: 'all' };
`;
    insertRuleArtifact({ contentJson: makeContentJson(RULE_ID, MALFORMED_CODE) });
    await insertCodeToolHookActivation();

    const warnCalls: string[] = [];
    const spyLogger: { warn: (_message: string) => void } = {
      warn: (message: string) => { warnCalls.push(message); },
    };

    const ruleHost = new RuleHost(tempStateDir, spyLogger, { workspaceDir: tempWorkspaceDir });
    const result = ruleHost.evaluate(makeInput('/etc/passwd'));

    expect(result).toBeUndefined();
    expect(warnCalls.length).toBeGreaterThan(0);
    const unhealthyWarn = warnCalls.find(m =>
      m.toLowerCase().includes('invalid') ||
      m.toLowerCase().includes('malformed') ||
      m.toLowerCase().includes('unhealthy') ||
      m.toLowerCase().includes('validation')
    );
    expect(unhealthyWarn).toBeDefined();
  });

  it('malformed result with invalid decision does not enforce and emits unhealthy evidence', async () => {
    // RuleCode returns { matched: true, decision: 'execute', reason: 'valid' } — decision is not one of the four
    const MALFORMED_CODE = `
function evaluate(input, helpers) {
  return { matched: true, decision: 'execute', reason: 'do it' };
}
var meta = { name: 'malformed-decision', version: '1', ruleId: '${RULE_ID}', coversCondition: 'all' };
`;
    insertRuleArtifact({ contentJson: makeContentJson(RULE_ID, MALFORMED_CODE) });
    await insertCodeToolHookActivation();

    const warnCalls: string[] = [];
    const spyLogger: { warn: (_message: string) => void } = {
      warn: (message: string) => { warnCalls.push(message); },
    };

    const ruleHost = new RuleHost(tempStateDir, spyLogger, { workspaceDir: tempWorkspaceDir });
    const result = ruleHost.evaluate(makeInput('/etc/passwd'));

    expect(result).toBeUndefined();
    expect(warnCalls.length).toBeGreaterThan(0);
    const unhealthyWarn = warnCalls.find(m =>
      m.toLowerCase().includes('invalid') ||
      m.toLowerCase().includes('malformed') ||
      m.toLowerCase().includes('unhealthy') ||
      m.toLowerCase().includes('validation')
    );
    expect(unhealthyWarn).toBeDefined();
  });

  it('null return from evaluate does not enforce and emits unhealthy evidence', async () => {
    const MALFORMED_CODE = `
function evaluate(input, helpers) {
  return null;
}
var meta = { name: 'null-return', version: '1', ruleId: '${RULE_ID}', coversCondition: 'all' };
`;
    insertRuleArtifact({ contentJson: makeContentJson(RULE_ID, MALFORMED_CODE) });
    await insertCodeToolHookActivation();

    const warnCalls: string[] = [];
    const spyLogger: { warn: (_message: string) => void } = {
      warn: (message: string) => { warnCalls.push(message); },
    };

    const ruleHost = new RuleHost(tempStateDir, spyLogger, { workspaceDir: tempWorkspaceDir });
    const result = ruleHost.evaluate(makeInput('/etc/passwd'));

    expect(result).toBeUndefined();
    expect(warnCalls.length).toBeGreaterThan(0);
  });

  it('valid block result still enforces correctly (no false positive rejection)', async () => {
    const VALID_CODE = `
function evaluate(input, helpers) {
  var p = input.action.normalizedPath || '';
  if (p.startsWith('/etc')) {
    return { decision: 'block', matched: true, reason: 'Blocked: system directory' };
  }
  return { decision: 'allow', matched: false, reason: 'Not matched' };
}
var meta = { name: 'valid-rule', version: '1', ruleId: '${RULE_ID}', coversCondition: 'all' };
`;
    insertRuleArtifact({ contentJson: makeContentJson(RULE_ID, VALID_CODE) });
    await insertCodeToolHookActivation();

    const ruleHost = new RuleHost(tempStateDir, console, { workspaceDir: tempWorkspaceDir });
    const result = ruleHost.evaluate(makeInput('/etc/passwd'));

    expect(result).toBeDefined();
    expect(result?.decision).toBe('block');
    expect(result?.matched).toBe(true);
    expect(result?.reason).toBe('Blocked: system directory');
    expect(result?.ruleId).toBe(RULE_ID);
  });
});
