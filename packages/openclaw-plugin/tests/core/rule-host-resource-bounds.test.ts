/**
 * PRI-437 Slice 3: Infinite loop and memory allocation terminate without taking down host
 *
 * PURPOSE: Verify that RuleCode with infinite loops or excessive memory allocation
 * is terminated by the vm timeout boundary and degrades conservatively (undefined).
 *
 * ERR risk mitigation:
 *   - ERR-002: timeout/degradation must include a reason (not silent)
 *   - Resource boundary: RuleCode must have time AND memory limits
 *
 * Test approach:
 *   - Real SQLite activation with malicious RuleCode
 *   - Real RuleHost.evaluate() (public interface)
 *   - Verify termination within reasonable time (not hang forever)
 *   - Verify conservative degradation (undefined result + warn evidence)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqliteConnection, SqliteActivationStateStore } from '@principles/core/runtime-v2';
import type { RuleHostInput } from '@principles/core/runtime-v2';
import { RuleHost } from '../../src/core/rule-host.js';

// ── Test helpers ───────────────────────────────────────────────────────────

const RULE_ID_INFINITE = 'R_TEST_INFINITE_003';
const ARTIFACT_ID_INFINITE = 'art-infinite-003';
const ACTIVATION_ID_INFINITE = `act_code_${RULE_ID_INFINITE}`;

const INFINITE_LOOP_CODE = `
function evaluate(input, helpers) {
  // Infinite loop — must be terminated by vm timeout
  while (true) {
    // burn CPU forever
  }
  return { decision: 'block', matched: true, reason: 'never reached' };
}
var meta = { name: 'infinite-loop-rule', version: '1', ruleId: '${RULE_ID_INFINITE}', coversCondition: 'all' };
`;

const RULE_ID_MEMORY = 'R_TEST_MEMORY_003';
const ARTIFACT_ID_MEMORY = 'art-memory-003';
const ACTIVATION_ID_MEMORY = `act_code_${RULE_ID_MEMORY}`;

const MEMORY_BOMB_CODE = `
function evaluate(input, helpers) {
  // Excessive memory allocation — must be bounded or caught
  var arr = [];
  for (var i = 0; i < 100000000; i++) {
    arr.push(new Array(10000));
  }
  return { decision: 'block', matched: true, reason: 'memory bomb' };
}
var meta = { name: 'memory-bomb-rule', version: '1', ruleId: '${RULE_ID_MEMORY}', coversCondition: 'all' };
`;

let tempWorkspaceDir: string;
let tempStateDir: string;
let sqliteConn: SqliteConnection;

function setupTempDirs(): void {
  const baseTmp = os.tmpdir();
  tempWorkspaceDir = fs.mkdtempSync(path.join(baseTmp, 'pd-rulehost-bounds-'));
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
    painReasonSummary: 'Test: resource boundary',
  });

  db.prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    artifactId,
    'rule',
    sourceTaskId,
    `P_${ruleId}`,
    ruleId,
    '[]',
    'validated',
    contentJson,
    now,
    now,
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

function makeInput(): RuleHostInput {
  return {
    action: {
      toolName: 'write_file',
      normalizedPath: '/etc/passwd',
      paramsSummary: { path: '/etc/passwd' },
    },
    workspace: { isRiskPath: false },
    session: { sessionId: 'test-session-bounds', currentGfi: 0, recentThinking: false },
    evolution: { epTier: 1 },
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

// ── Slice 3: Resource boundaries ───────────────────────────────────────────

describe('PRI-437 Slice 3: Infinite loop and memory allocation terminate without taking down host', () => {
  it('infinite loop in evaluate() is terminated by vm timeout → undefined + warn evidence', async () => {
    insertRuleArtifact(ARTIFACT_ID_INFINITE, RULE_ID_INFINITE, 'task-infinite-003', INFINITE_LOOP_CODE);
    await insertActivation(ACTIVATION_ID_INFINITE, ARTIFACT_ID_INFINITE, RULE_ID_INFINITE);

    const warnCalls: string[] = [];
    const spyLogger = {
      warn: (message: string) => { warnCalls.push(message); },
      error: () => {},
      info: () => {},
    };

    const ruleHost = new RuleHost(tempStateDir, spyLogger, { workspaceDir: tempWorkspaceDir });

    // Must terminate within 10 seconds (vm timeout is 1000ms, plus overhead)
    const startTime = Date.now();
    const result = ruleHost.evaluate(makeInput());
    const elapsed = Date.now() - startTime;

    // Conservative degradation: undefined (no opinion)
    expect(result).toBeUndefined();

    // Must not hang — should complete well under 10 seconds
    expect(elapsed).toBeLessThan(10000);

    // Must emit structured warn evidence (ERR-002: degradation includes reason)
    expect(warnCalls.length).toBeGreaterThan(0);
    const timeoutWarn = warnCalls.find(m =>
      m.toLowerCase().includes('timeout') ||
      m.toLowerCase().includes('timed out') ||
      m.toLowerCase().includes('terminated')
    );
    expect(timeoutWarn).toBeDefined();
  }, 15000); // 15 second test timeout (fail safe)

  it('memory bomb in evaluate() is bounded or caught → undefined + warn evidence', async () => {
    insertRuleArtifact(ARTIFACT_ID_MEMORY, RULE_ID_MEMORY, 'task-memory-003', MEMORY_BOMB_CODE);
    await insertActivation(ACTIVATION_ID_MEMORY, ARTIFACT_ID_MEMORY, RULE_ID_MEMORY);

    const warnCalls: string[] = [];
    const spyLogger = {
      warn: (message: string) => { warnCalls.push(message); },
      error: () => {},
      info: () => {},
    };

    const ruleHost = new RuleHost(tempStateDir, spyLogger, { workspaceDir: tempWorkspaceDir });

    // Must terminate without crashing the host process
    const startTime = Date.now();
    let thrown: unknown;
    let result: unknown;
    try {
      result = ruleHost.evaluate(makeInput());
    } catch (err) {
      thrown = err;
    }
    const elapsed = Date.now() - startTime;

    // PRI-437 fail-closed: must NOT throw (vm timeout should catch it),
    // and must return undefined (conservative degradation)
    expect(thrown).toBeUndefined();
    expect(result).toBeUndefined();

    // Must not hang — should complete well under 30 seconds
    expect(elapsed).toBeLessThan(30000);

    // Must emit structured warn evidence with reason (ERR-002)
    expect(warnCalls.length).toBeGreaterThan(0);
    const reasonWarn = warnCalls.find(m =>
      m.toLowerCase().includes('timeout') ||
      m.toLowerCase().includes('timed out') ||
      m.toLowerCase().includes('terminated') ||
      m.toLowerCase().includes('memory') ||
      m.toLowerCase().includes('heap') ||
      m.toLowerCase().includes('range')
    );
    expect(reasonWarn).toBeDefined();
  }, 60000); // 60 second test timeout (fail safe for memory pressure)
});
