/**
 * PRI-437 Slice 4: Approved compile failure is visible in EventLog, CLI and Console
 *
 * PURPOSE: Verify that when an approved rule fails to compile/load, the failure
 * is recorded in EventLog as an unhealthy event with reason and nextAction.
 * NOT just a logger.warn that's silently skipped.
 *
 * ERR risk mitigation:
 *   - ERR-002: degradation must include a reason (not silent logger.warn)
 *   - Observability: unhealthy state must be persisted and queryable
 *
 * Test approach:
 *   - Real SQLite activation with broken code (syntax error)
 *   - Real RuleHost.evaluate() (public interface)
 *   - Read real EventLog JSONL file to verify unhealthy record
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqliteConnection, SqliteActivationStateStore } from '@principles/core/runtime-v2';
import type { RuleHostInput } from '@principles/core/runtime-v2';
import { RuleHost } from '../../src/core/rule-host.js';
import { EventLogService } from '../../src/core/event-log.js';

// ── Test helpers ───────────────────────────────────────────────────────────

const RULE_ID_BROKEN = 'R_TEST_BROKEN_004';
const ARTIFACT_ID_BROKEN = 'art-broken-004';
const ACTIVATION_ID_BROKEN = `act_code_${RULE_ID_BROKEN}`;

// Code with a syntax error that will cause compilation failure
const BROKEN_CODE = `
function evaluate(input, helpers) {
  // Syntax error: unclosed brace
  return { decision: 'block', matched: true, reason: 'broken'
// Missing closing brace for function and return object
var meta = { name: 'broken-rule', version: '1', ruleId: '${RULE_ID_BROKEN}', coversCondition: 'all' };
`;

let tempWorkspaceDir: string;
let tempStateDir: string;
let sqliteConn: SqliteConnection;

function setupTempDirs(): void {
  const baseTmp = os.tmpdir();
  tempWorkspaceDir = fs.mkdtempSync(path.join(baseTmp, 'pd-rulehost-unhealthy-'));
  tempStateDir = path.join(tempWorkspaceDir, '.principles');
  fs.mkdirSync(tempStateDir, { recursive: true });
}

function insertRuleArtifact(): void {
  const db = sqliteConn.getDb();
  const now = new Date().toISOString();
  const contentJson = JSON.stringify({
    principleId: 'P_TEST_BROKEN_004',
    ruleId: RULE_ID_BROKEN,
    implementationCode: BROKEN_CODE,
    goldenTrace: { traceId: 'trace-broken-004', cases: [], createdAt: now, version: 1 },
    ruleHostGateDecision: 'accepted_shadow',
    affectedTools: ['write_file'],
    painReasonSummary: 'Test: broken code compilation',
  });

  db.prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ARTIFACT_ID_BROKEN,
    'rule',
    'task-broken-004',
    'P_TEST_BROKEN_004',
    RULE_ID_BROKEN,
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
    activationId: ACTIVATION_ID_BROKEN,
    idempotencyKey: `${ARTIFACT_ID_BROKEN}::code_tool_hook`,
    artifactId: ARTIFACT_ID_BROKEN,
    channel: 'code_tool_hook',
    action: 'code_tool_hook_shadow_activate',
    targetRef: `impl://${RULE_ID_BROKEN}`,
    activatedAt: now,
    deactivatedAt: null,
  });
}

function makeInput(): RuleHostInput {
  return {
    action: {
      toolName: 'write_file',
      normalizedPath: '/etc/passwd',
      paramsSummary: { path: '/etc/passwd' },
    },
    workspace: { isRiskPath: false, planStatus: 'NONE' as const, hasPlanFile: false },
    session: { sessionId: 'test-session-unhealthy', currentGfi: 0, recentThinking: false },
    evolution: { epTier: 1 },
    derived: { estimatedLineChanges: 1, bashRisk: 'safe' as const },
  };
}

function readTodayEvents(stateDir: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const eventsFile = path.join(stateDir, 'logs', `events_${today}.jsonl`);
  if (!fs.existsSync(eventsFile)) {
    return '';
  }
  return fs.readFileSync(eventsFile, 'utf-8');
}

// ── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  setupTempDirs();
  EventLogService.disposeAll();
  sqliteConn = new SqliteConnection(tempWorkspaceDir);
  sqliteConn.getDb();
});

afterEach(() => {
  EventLogService.disposeAll();
  try { sqliteConn?.close(); } catch { /* best-effort */ }
  try { fs.rmSync(tempWorkspaceDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

// ── Slice 4: Compile failure visible in EventLog ───────────────────────────

describe('PRI-437 Slice 4: Approved compile failure is visible in EventLog', () => {
  it('broken code compilation → EventLog records rulehost_unhealthy with reason and nextAction', async () => {
    insertRuleArtifact();
    await insertActivation();

    const warnCalls: string[] = [];
    const spyLogger = {
      warn: (message: string) => { warnCalls.push(message); },
      error: () => {},
      info: () => {},
    };

    const ruleHost = new RuleHost(tempStateDir, spyLogger, { workspaceDir: tempWorkspaceDir });

    // Evaluate — should attempt to compile the broken code and fail
    const result = ruleHost.evaluate(makeInput());

    // Conservative degradation: undefined (no opinion)
    expect(result).toBeUndefined();

    // Flush EventLog to ensure events are written to disk
    const eventLog = EventLogService.get(tempStateDir);
    eventLog.flush();

    // Read the EventLog JSONL file and verify unhealthy record exists
    const eventsContent = readTodayEvents(tempStateDir);

    // Must contain a rulehost_unhealthy event (NOT just logger.warn)
    expect(eventsContent).toContain('rulehost_unhealthy');

    // Structured validation: parse JSONL lines and find the unhealthy event
    const lines = eventsContent.trim().split('\n').filter(l => l.trim());
    const unhealthyEvents = lines
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(evt => evt?.type === 'rulehost_unhealthy');

    expect(unhealthyEvents.length).toBeGreaterThanOrEqual(1);

    // Verify the unhealthy event has all required fields in the same record
    const unhealthy = unhealthyEvents[0];
    expect(unhealthy.data.activationId).toBe(ACTIVATION_ID_BROKEN);
    expect(unhealthy.data.ruleId).toBe(RULE_ID_BROKEN);
    expect(typeof unhealthy.data.reason).toBe('string');
    expect(unhealthy.data.reason.length).toBeGreaterThan(0);
    expect(typeof unhealthy.data.nextAction).toBe('string');
    expect(unhealthy.data.nextAction.length).toBeGreaterThan(0);
  });

  it('valid rule does NOT produce rulehost_unhealthy event', async () => {
    // Insert a VALID rule (not broken)
    const VALID_CODE = `
function evaluate(input, helpers) {
  var p = input.action.normalizedPath || '';
  if (p.indexOf('/etc/') === 0) {
    return { decision: 'block', matched: true, reason: 'valid block' };
  }
  return { decision: 'allow', matched: false, reason: 'not matched' };
}
var meta = { name: 'valid-rule', version: '1', ruleId: '${RULE_ID_BROKEN}', coversCondition: 'all' };
`;

    const db = sqliteConn.getDb();
    const now = new Date().toISOString();
    const contentJson = JSON.stringify({
      principleId: 'P_TEST_VALID_004',
      ruleId: RULE_ID_BROKEN,
      implementationCode: VALID_CODE,
      goldenTrace: { traceId: 'trace-valid-004', cases: [], createdAt: now, version: 1 },
      ruleHostGateDecision: 'accepted_shadow',
      affectedTools: ['write_file'],
      painReasonSummary: 'Test: valid code',
    });

    db.prepare(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ARTIFACT_ID_BROKEN, 'rule', 'task-valid-004', 'P_TEST_VALID_004', RULE_ID_BROKEN,
      '[]', 'validated', contentJson, now, now,
    );

    await insertActivation();

    const ruleHost = new RuleHost(tempStateDir, { warn: () => {}, error: () => {}, info: () => {} }, { workspaceDir: tempWorkspaceDir });
    const result = ruleHost.evaluate(makeInput());

    // Valid rule should block (not undefined)
    expect(result).toBeDefined();
    expect(result?.decision).toBe('block');

    // Flush and verify NO unhealthy event
    const eventLog = EventLogService.get(tempStateDir);
    eventLog.flush();

    const eventsContent = readTodayEvents(tempStateDir);
    expect(eventsContent).not.toContain('rulehost_unhealthy');
  });
});
