/**
 * E2E Test: Pain ID Chain — pain event → createPrincipleFromDiagnosis → compile → RuleHost
 *
 * Tests the complete chain:
 *   1. recordPainEvent() returns AUTOINCREMENT row ID as number
 *   2. createPrincipleFromDiagnosis(painId: String(painEventId))
 *   3. derivedFromPainIds stores the stringified numeric ID
 *   4. PrincipleCompiler.compileOne() succeeds (registers candidate implementation)
 *   5. Promote to active
 *   6. RuleHost.evaluate(matching input) → block
 *   6. RuleHost.evaluate(non-matching input) → undefined (passthrough)
 *
 * Pain ID chain fixed in commits 4b0dce59 and 0146bbb7:
 *   - recordPainEvent() now returns real AUTOINCREMENT ID (was -1)
 *   - derivedFromPainIds now stores String(painId) correctly
 *   - LedgerPrinciple.derivedFromPainIds used by compiler reflection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TrajectoryDatabase } from '../../src/core/trajectory.js';
import { PrincipleCompiler } from '../../src/core/principle-compiler/compiler.js';
import { RuleHost } from '../../src/core/rule-host.js';
import { EvolutionReducerImpl } from '../../src/core/evolution-reducer.js';
import {
  loadLedger,
  transitionImplementationState,
} from '../../src/core/principle-tree-ledger.js';
import { safeRmDir } from '../test-utils.js';
import type { RuleHostInput } from '../../src/core/rule-host-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestWorkspace {
  workspaceDir: string;
  stateDir: string;
  trajectory: TrajectoryDatabase;
  reducer: EvolutionReducerImpl;
}

function createTestWorkspace(): TestWorkspace {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-chain-e2e-'));
  const stateDir = path.join(workspaceDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });

  const trajectory = new TrajectoryDatabase({ workspaceDir });
  const reducer = new EvolutionReducerImpl({ workspaceDir, stateDir });

  return { workspaceDir, stateDir, trajectory, reducer };
}

function disposeTestWorkspace(ws: TestWorkspace): void {
  ws.trajectory.dispose();
  safeRmDir(ws.workspaceDir);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Pain ID Chain E2E: pain event → principle → compile → RuleHost', () => {
  let ws: TestWorkspace;

  beforeEach(() => {
    ws = createTestWorkspace();
  });

  afterEach(() => {
    disposeTestWorkspace(ws);
  });

  it('full chain: pain event ID → createPrincipleFromDiagnosis → derivedFromPainIds → compile → block', () => {
    const sessionId = 'session-pain-chain-001';

    // ── Step 1: Record tool call + pain event, capture the returned AUTOINCREMENT ID ──
    ws.trajectory.recordToolCall({
      sessionId,
      toolName: 'bash',
      outcome: 'failure',
      errorType: 'command_not_found',
      errorMessage: 'heartbeat: command not found',
      paramsJson: { command: 'heartbeat --status' },
    });

    // recordPainEvent() returns the real AUTOINCREMENT row ID as a number (fix from 4b0dce59)
    const painEventId = ws.trajectory.recordPainEvent({
      sessionId,
      source: 'gate_block',
      score: 80,
      reason: 'Blocked bash heartbeat command due to unsafe operation',
      severity: 'moderate',
      origin: 'system_infer',
    });

    // Verify painEventId is a positive integer (real AUTOINCREMENT, not -1)
    expect(typeof painEventId).toBe('number');
    expect(painEventId).toBeGreaterThan(0);

    // ── Step 2: Create principle via createPrincipleFromDiagnosis with stringified pain ID ──
    const triggerPattern = 'heartbeat.*bash';
    const action = 'Block heartbeat commands in bash';
    const painIdStr = String(painEventId);

    const principleId = ws.reducer.createPrincipleFromDiagnosis({
      painId: painIdStr,
      painType: 'tool_failure',
      triggerPattern,
      action,
      source: 'pain-id-chain-e2e',
      evaluability: 'deterministic',
    });

    expect(principleId).not.toBeNull();
    expect(typeof principleId).toBe('string');

    // ── Step 3: Verify derivedFromPainIds in the ledger contains the stringified pain ID ──
    const ledger = loadLedger(ws.stateDir);
    const ledgerPrinciple = ledger.tree.principles[principleId!];
    expect(ledgerPrinciple).toBeDefined();
    expect(ledgerPrinciple!.derivedFromPainIds).toContain(painIdStr);

    // ── Step 4: Compile the principle (registers active implementation) ──
    const compiler = new PrincipleCompiler(ws.stateDir, ws.trajectory);
    const compileResult = compiler.compileOne(principleId!);

    expect(compileResult.success).toBe(true);
    expect(compileResult.principleId).toBe(principleId);
    expect(compileResult.code).toBeDefined();
    expect(compileResult.code).toContain('heartbeat');
    expect(compileResult.ruleId).toBeDefined();
    expect(compileResult.implementationId).toBeDefined();

    // Verify implementation is candidate (not active — must be promoted before enforcing)
    const updatedLedger = loadLedger(ws.stateDir);
    const impl = updatedLedger.tree.implementations[compileResult.implementationId!];
    expect(impl.lifecycleState).toBe('candidate');

    // ── Step 5: Promote to active so RuleHost will enforce ──
    transitionImplementationState(ws.stateDir, compileResult.implementationId!, 'active');

    // ── Step 6: RuleHost.evaluate(matching input) → block ──
    const host = new RuleHost(ws.stateDir, { warn: () => {} });

    const matchingInput: RuleHostInput = {
      action: {
        toolName: 'bash',
        normalizedPath: null,
        paramsSummary: { command: 'heartbeat --status' },
      },
      workspace: {
        isRiskPath: false,
        planStatus: 'NONE',
        hasPlanFile: false,
      },
      session: {
        sessionId: 'session-eval-001',
        currentGfi: 50,
        recentThinking: false,
      },
      evolution: {
        epTier: 0,
      },
      derived: {
        estimatedLineChanges: 0,
        bashRisk: 'unknown',
      },
    };

    const blockResult = host.evaluate(matchingInput);

    expect(blockResult).toBeDefined();
    expect(blockResult!.decision).toBe('block');
    expect(blockResult!.matched).toBe(true);
    expect(blockResult!.reason).toContain(principleId);

    // ── Step 6: RuleHost.evaluate(non-matching input) → undefined (passthrough) ──
    const nonMatchingInput: RuleHostInput = {
      action: {
        toolName: 'Read',
        normalizedPath: '/some/file.txt',
        paramsSummary: {},
      },
      workspace: {
        isRiskPath: false,
        planStatus: 'NONE',
        hasPlanFile: false,
      },
      session: {
        sessionId: 'session-eval-002',
        currentGfi: 50,
        recentThinking: false,
      },
      evolution: {
        epTier: 0,
      },
      derived: {
        estimatedLineChanges: 0,
        bashRisk: 'unknown',
      },
    };

    const passResult = host.evaluate(nonMatchingInput);
    expect(passResult).toBeUndefined();
  });

  it('compileOne returns failure for non-existent principle ID', () => {
    const compiler = new PrincipleCompiler(ws.stateDir, ws.trajectory);
    const badResult = compiler.compileOne('non-existent-principle-id');
    expect(badResult.success).toBe(false);
  });

  it('recordPainEvent returns sequential IDs for multiple events', () => {
    const sessionId = 'session-seq-001';

    ws.trajectory.recordToolCall({
      sessionId,
      toolName: 'bash',
      outcome: 'failure',
      errorType: 'command_not_found',
      errorMessage: 'test error 1',
      paramsJson: { command: 'test1' },
    });

    const id1 = ws.trajectory.recordPainEvent({
      sessionId,
      source: 'gate_block',
      score: 50,
      reason: 'First pain event',
      severity: 'low',
      origin: 'system_infer',
    });

    ws.trajectory.recordToolCall({
      sessionId,
      toolName: 'bash',
      outcome: 'failure',
      errorType: 'command_not_found',
      errorMessage: 'test error 2',
      paramsJson: { command: 'test2' },
    });

    const id2 = ws.trajectory.recordPainEvent({
      sessionId,
      source: 'gate_block',
      score: 60,
      reason: 'Second pain event',
      severity: 'moderate',
      origin: 'system_infer',
    });

    expect(id2).toBeGreaterThan(id1);
    expect(typeof id1).toBe('number');
    expect(typeof id2).toBe('number');
  });
});
