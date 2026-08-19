/**
 * E2E Test: Principle Compiler → RuleHost Enforcement
 *
 * Tests the full chain:
 *   1. Set up principle in ledger with derivedFromPainIds
 *   2. Record tool call (bash, failure) and pain event in trajectory DB
 *   3. Compile principle via PrincipleCompiler (registers as 'candidate' — NOT 'active')
 *   4. RuleHost.evaluate(matching input) → NO block yet (candidate not loaded)
 *   5. Promote implementation to 'active'
 *   6. RuleHost.evaluate(matching input) → block
 *   7. RuleHost.evaluate(non-matching input) → undefined (passthrough)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TrajectoryDatabase } from '../../src/core/trajectory.js';
import { PrincipleCompiler } from '../../src/core/principle-compiler/compiler.js';
import { RuleHost } from '../../src/core/rule-host.js';
import {
  loadLedger,
  saveLedger,
} from '../../src/core/principle-tree-ledger.js';
import { SqliteConnection, SqliteActivationStateStore } from '@principles/core/runtime-v2';
import type { RuleHostInput } from '@principles/core/runtime-v2';
import { safeRmDir } from '../test-utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestWorkspace {
  workspaceDir: string;
  stateDir: string;
  trajectory: TrajectoryDatabase;
}

function createTestWorkspace(): TestWorkspace {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-compiler-e2e-'));
  const stateDir = path.join(workspaceDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });

  const trajectory = new TrajectoryDatabase({ workspaceDir });

  return { workspaceDir, stateDir, trajectory };
}

function disposeTestWorkspace(ws: TestWorkspace): void {
  ws.trajectory.dispose();
  // RuleHost created inside test bodies opens a SQLite connection to ws.stateDir
  // which locks files on Windows. safeRmDir ignores EPERM/ENOTEMPTY so cleanup
  // does not crash teardown (OS reclaims temp dir eventually).
  safeRmDir(ws.workspaceDir);
}

/**
 * PRI-436: Insert compiled rule code as a pi_artifacts row + activations row
 * so RuleHost can load it from SQLite (the sole production source).
 */
function activateCompiledRule(
  workspaceDir: string,
  ruleId: string,
  implementationCode: string,
  principleId: string,
): void {
  const sqliteConn = new SqliteConnection(workspaceDir);
  try {
    const db = sqliteConn.getDb();
    const now = new Date().toISOString();
    const artifactId = `art-${ruleId}`;

    const contentJson = JSON.stringify({
      principleId,
      ruleId,
      implementationCode,
    });

    db.prepare(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      artifactId,
      'rule',
      `task-${ruleId}`,
      principleId,
      ruleId,
      '[]',
      'validated',
      contentJson,
      now,
      now,
    );

    const store = new SqliteActivationStateStore(sqliteConn);
    store.recordActivation({
      activationId: `act_code_${ruleId}`,
      idempotencyKey: `${artifactId}::code_tool_hook`,
      artifactId,
      channel: 'code_tool_hook',
      action: 'code_tool_hook_live_activate',
      targetRef: `impl://${ruleId}`,
      activatedAt: now,
      deactivatedAt: null,
    });
  } finally {
    try { sqliteConn.close(); } catch { /* best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Principle Compiler E2E: compile → promote → RuleHost blocks', () => {
  let ws: TestWorkspace;

  beforeEach(() => {
    ws = createTestWorkspace();
  });

  afterEach(() => {
    disposeTestWorkspace(ws);
  });

  it('should compile a principle, promote it, and have RuleHost block matching input', () => {
    const sessionId = 'session-e2e-001';
    const principleId = 'P_066';

    // ── Step 1: Record a tool call and pain event in trajectory DB ──
    ws.trajectory.recordToolCall({
      sessionId,
      toolName: 'bash',
      outcome: 'failure',
      errorType: 'command_not_found',
      errorMessage: 'heartbeat: command not found',
      paramsJson: { command: 'heartbeat --status' },
    });

    // Pain event whose reason contains "bash" (known tool) so
    // extractPatterns() can infer the toolName.
    ws.trajectory.recordPainEvent({
      sessionId,
      source: 'gate_block',
      score: 75,
      reason: 'Blocked bash heartbeat command due to unsafe operation',
      severity: 'moderate',
      origin: 'system_infer',
    });

    // ── Step 2: Set up principle P_066 in the ledger with derivedFromPainIds ──
    const store = loadLedger(ws.stateDir);

    const now = new Date().toISOString();

    // Principle must have derivedFromPainIds for the ReflectionContextCollector
    // to return a non-null context. The painIds are arbitrary strings that
    // we make match the pain event's auto-increment row ID via the
    // best-effort resolution logic (it checks if painId appears in
    // pe.reason, pe.origin, or String(pe.id)).
    store.tree.principles[principleId] = {
      id: principleId,
      version: 1,
      text: 'Do not run heartbeat commands via bash',
      triggerPattern: 'heartbeat.*bash',
      action: 'Block heartbeat commands in bash',
      status: 'active',
      priority: 'P1',
      scope: 'general',
      evaluability: 'deterministic',
      valueScore: 0,
      adherenceRate: 0,
      painPreventedCount: 0,
      derivedFromPainIds: ['1'], // references pain event row id (stringified)
      ruleIds: [],
      conflictsWithPrincipleIds: [],
      createdAt: now,
      updatedAt: now,
    };

    saveLedger(ws.stateDir, store);

    // ── Step 3: Create PrincipleCompiler and compile P_066 ──
    const compiler = new PrincipleCompiler(ws.stateDir, ws.trajectory);
    const result = compiler.compileOne(principleId);

    // Verify compilation succeeded
    expect(result.success).toBe(true);
    expect(result.principleId).toBe(principleId);
    expect(result.code).toBeDefined();
    expect(result.ruleId).toBeDefined();
    expect(result.implementationId).toBeDefined();

    const implId = result.implementationId!;

    // Verify the implementation was registered as 'candidate' (not 'active')
    // FIX: Auto-generated implementations start as 'candidate' until explicitly promoted
    // after replay evaluation and human approval. This prevents false-positive blocks.
    const ledger = loadLedger(ws.stateDir);
    const impl = ledger.tree.implementations[implId];
    expect(impl.lifecycleState).toBe('candidate');

    // Define matching input for RuleHost evaluation (used in both Step 4 and Step 6)
    const matchingInput: RuleHostInput = {
      action: {
        toolName: 'bash',
        normalizedPath: null,
        paramsSummary: { command: 'heartbeat --status' },
      },
      workspace: {
        isRiskPath: false,
      },
      session: {
        sessionId: 'session-eval-001',
        currentGfi: 50,
      },
      evolution: {
        epTier: 0,
      },
      derived: {
        estimatedLineChanges: 0,
        bashRisk: 'unknown',
      },
    };

    // ── Step 4: RuleHost should NOT block yet (no SQLite activation yet) ──
    const hostBeforePromote = new RuleHost(ws.stateDir, { warn: () => {} }, { workspaceDir: ws.workspaceDir });
    const noBlockResult = hostBeforePromote.evaluate(matchingInput);
    expect(noBlockResult).toBeUndefined(); // no activation → no block

    // ── Step 5: Activate via SQLite (PRI-436: sole production source) ──
    activateCompiledRule(ws.workspaceDir, result.ruleId!, result.code!, principleId);

    // ── Step 6: Create RuleHost and evaluate with matching input ──
    const host = new RuleHost(ws.stateDir, { warn: () => {} }, { workspaceDir: ws.workspaceDir });

    // Matching input: bash tool with a heartbeat command (defined in Step 4)
    const blockResult = host.evaluate(matchingInput);

    // Verify RuleHost blocks the matching input
    expect(blockResult).toBeDefined();
    expect(blockResult!.decision).toBe('block');
    expect(blockResult!.matched).toBe(true);
    expect(blockResult!.reason).toContain(principleId);

    // ── Step 5: Verify non-matching input returns undefined (passthrough) ──
    const nonMatchingInput: RuleHostInput = {
      action: {
        toolName: 'write', // different tool, not bash
        normalizedPath: '/home/user/project/src/index.ts',
        paramsSummary: { content: 'console.log("hello")' },
      },
      workspace: {
        isRiskPath: false,
      },
      session: {
        sessionId: 'session-eval-002',
        currentGfi: 50,
      },
      evolution: {
        epTier: 0,
      },
      derived: {
        estimatedLineChanges: 5,
        bashRisk: 'safe',
      },
    };

    const passthroughResult = host.evaluate(nonMatchingInput);
    expect(passthroughResult).toBeUndefined();
  });

  it('should return undefined when no active implementations exist', () => {
    const host = new RuleHost(ws.stateDir, { warn: () => {} }, { workspaceDir: ws.workspaceDir });

    const input: RuleHostInput = {
      action: {
        toolName: 'bash',
        normalizedPath: null,
        paramsSummary: { command: 'rm -rf /' },
      },
      workspace: {
        isRiskPath: true,
      },
      session: {
        sessionId: 'session-empty-001',
        currentGfi: 0,
      },
      evolution: {
        epTier: 0,
      },
      derived: {
        estimatedLineChanges: 0,
        bashRisk: 'dangerous',
      },
    };

    const result = host.evaluate(input);
    expect(result).toBeUndefined();
  });

  it('should return compilation failure when principle has no derivedFromPainIds', () => {
    const sessionId = 'session-no-pain-001';
    const principleId = 'P_099';

    // Set up a principle WITHOUT derivedFromPainIds
    const store = loadLedger(ws.stateDir);
    const now = new Date().toISOString();

    store.tree.principles[principleId] = {
      id: principleId,
      version: 1,
      text: 'A principle with no pain grounding',
      triggerPattern: 'noop',
      action: 'do nothing',
      status: 'active',
      priority: 'P2',
      scope: 'general',
      evaluability: 'manual_only',
      valueScore: 0,
      adherenceRate: 0,
      painPreventedCount: 0,
      derivedFromPainIds: [], // EMPTY — no pain grounding
      ruleIds: [],
      conflictsWithPrincipleIds: [],
      createdAt: now,
      updatedAt: now,
    };

    saveLedger(ws.stateDir, store);

    const compiler = new PrincipleCompiler(ws.stateDir, ws.trajectory);
    const result = compiler.compileOne(principleId);

    // Should fail because no context (no derivedFromPainIds)
    expect(result.success).toBe(false);
    expect(result.reason).toBe('no context');
  });

  it('should compile using session snapshot tool calls as pattern source', () => {
    const sessionId = 'session-snapshot-001';
    const principleId = 'P_077';

    // Record a tool call that the session snapshot will pick up.
    // Avoid file paths in the reason/params to prevent path-based regex
    // generation which has a known escaping limitation in the template generator.
    ws.trajectory.recordToolCall({
      sessionId,
      toolName: 'grep',
      outcome: 'failure',
      errorType: 'timeout',
      errorMessage: 'grep command timed out',
      paramsJson: { pattern: 'TODO' },
    });

    // Pain event referencing this session
    ws.trajectory.recordPainEvent({
      sessionId,
      source: 'gate_block',
      score: 60,
      reason: 'grep tool failed with timeout error',
      severity: 'moderate',
      origin: 'system_infer',
    });

    // Set up principle
    const store = loadLedger(ws.stateDir);
    const now = new Date().toISOString();

    store.tree.principles[principleId] = {
      id: principleId,
      version: 1,
      text: 'Block grep tool on timeout patterns',
      triggerPattern: 'grep.*timeout',
      action: 'Block grep commands that time out',
      status: 'active',
      priority: 'P1',
      scope: 'general',
      evaluability: 'deterministic',
      valueScore: 0,
      adherenceRate: 0,
      painPreventedCount: 0,
      derivedFromPainIds: ['1'], // reference to pain event (auto-increment ID)
      ruleIds: [],
      conflictsWithPrincipleIds: [],
      createdAt: now,
      updatedAt: now,
    };

    saveLedger(ws.stateDir, store);

    const compiler = new PrincipleCompiler(ws.stateDir, ws.trajectory);
    const result = compiler.compileOne(principleId);

    expect(result.success).toBe(true);
    expect(result.code).toContain('grep'); // generated code should check for grep tool
  });
});
