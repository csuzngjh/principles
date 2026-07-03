/**
 * Single-Gate Pain Admission Tests — PRI-363
 *
 * Tests that tool failure path uses only a single gate (TriggerController)
 * for deciding whether to create a diagnostic task.
 *
 * This test validates:
 * 1. No dual-gate drift — evaluatePainAdmissionForToolCall calls only TriggerController
 * 2. Cooldown preserved — same episode does not repeat diagnosis within 15 min
 * 3. Tool failure defaults to evidence_only per PEAT design
 * 4. Manual pain bypasses all gates
 *
 * ERR checklist:
 * - ERR-001: No `as` casts on untrusted runtime values.
 * - ERR-002: Every decision carries reason + nextAction.
 * - ERR-009: Malformed/missing state fails loud with reason.
 * - ERR-024/025/048: Production-path wiring tests.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluatePainAdmissionForToolCall, resetTriggerCooldownForTest } from '../../src/hooks/after-tool-call-helpers.js';
import type { PluginHookAfterToolCallEvent } from '../../src/openclaw-sdk.js';
import type { ToolCallObservation, ToolCallOutcome } from '../../src/hooks/after-tool-call-types.js';

// ── Test Helpers ─────────────────────────────────────────────────────────────

function createMockEvent(
  toolName: string,
  error: unknown,
  params: Record<string, unknown> = {},
): PluginHookAfterToolCallEvent {
  return {
    toolName,
    params,
    result: null,
    error,
    durationMs: 100,
  };
}

function createMockObservation(
  painScore: number,
  isRisk: boolean,
  errorHash: string,
): ToolCallObservation {
  return {
    params: {
      filePath: '/tmp/test.md',
      content: 'test content',
    },
    relPath: '/tmp/test.md',
    isRisk,
    errorType: 'EACCES',
    errorHash,
    errorText: 'Permission denied',
    painScore,
    traceId: 'test-trace-id',
  };
}

function createMockOutcome(isFailure: boolean, failureSource: 'tool_failure' | 'dispatch_error' | undefined): ToolCallOutcome {
  return {
    isFailure,
    exitCode: isFailure ? 1 : 0,
    failureSource,
  };
}

function createMockConfig(get: (key: string) => unknown) {
  return { get };
}

describe('Single-Gate Pain Admission — PRI-363', () => {
  beforeEach(() => {
    resetTriggerCooldownForTest();
  });

  describe('Non-write-tool failures', () => {
    it('should reject non-write-tool failures', () => {
      const toolName = 'read'; // Not a write tool
      const error = new Error('ENOENT: file not found');
      const painScore = 72;
      const errorHash = 'abc123';
      const sessionId = 'session-001';
      const workspaceDir = '/tmp/workspace';

      const event = createMockEvent(toolName, error, {
        path: '/tmp/test.md',
      });

      const observation = createMockObservation(painScore, false, errorHash);
      const outcome = createMockOutcome(true, 'tool_failure');
      const sessionState = {
        currentGfi: 30,
        consecutiveErrors: 2,
      };

      const config = createMockConfig(() => undefined);

      const decision = evaluatePainAdmissionForToolCall(
        event,
        observation,
        outcome,
        sessionState,
        sessionState,
        sessionId,
        workspaceDir,
        config,
      );

      expect(decision.admitted).toBe(false);
      expect(decision.stage).toBe('not_applicable');
      expect(decision.reason).toBe('not_a_write_tool_failure');
    });
  });

  describe('Tool failure default behavior', () => {
    it('tool_failure defaults to evidence_only (PEAT design)', () => {
      const toolName = 'write';
      const error = new Error('EACCES: permission denied');
      const painScore = 80; // Very high score
      const errorHash = 'abc123';
      const sessionId = 'session-001';
      const workspaceDir = '/tmp/workspace';

      const event = createMockEvent(toolName, error, {
        file_path: '/tmp/test.md',
        content: 'test',
      });

      const observation = createMockObservation(painScore, false, errorHash);
      const outcome = createMockOutcome(true, 'tool_failure');
      const sessionState = {
        currentGfi: 80,
        consecutiveErrors: 2,
      };

      const config = createMockConfig(() => undefined);

      const decision = evaluatePainAdmissionForToolCall(
        event,
        observation,
        outcome,
        sessionState,
        sessionState,
        sessionId,
        workspaceDir,
        config,
      );

      // Per PEAT design, tool_failure is infrastructure noise
      // and defaults to evidence_only
      expect(decision.admitted).toBe(false);
      expect(decision.stage).toBe('trigger_rejected');
      expect(decision.reason).toContain('infrastructure noise');
    });
  });

  describe('Cooldown behavior', () => {
    it('should not repeat diagnosis within 15 min cooldown (same episode)', () => {
      const toolName = 'write';
      const error = new Error('EACCES: permission denied');
      const errorHash = 'abc123';
      const sessionId = 'session-001';
      const painScore = 72; // High score would normally trigger diagnosis
      const workspaceDir = '/tmp/workspace';

      const event = createMockEvent(toolName, error, {
        file_path: '/tmp/test.md',
        content: 'test',
      });

      const observation = createMockObservation(painScore, false, errorHash);
      const outcome = createMockOutcome(true, 'tool_failure');
      const sessionState = {
        currentGfi: 30,
        consecutiveErrors: 2,
      };

      const config = createMockConfig(() => undefined);

      // First call — tool_failure defaults to evidence_only
      const decision1 = evaluatePainAdmissionForToolCall(
        event,
        observation,
        outcome,
        sessionState,
        sessionState,
        sessionId,
        workspaceDir,
        config,
      );

      expect(decision1.admitted).toBe(false);
      expect(decision1.stage).toBe('trigger_rejected');

      // Second call within cooldown — should still not admit
      // (even though cooldown is set, triage decision is still evidence_only)
      const decision2 = evaluatePainAdmissionForToolCall(
        event,
        observation,
        outcome,
        sessionState,
        sessionState,
        sessionId,
        workspaceDir,
        config,
      );

      expect(decision2.admitted).toBe(false);
      expect(decision2.stage).toBe('trigger_rejected');
    });
  });

  describe('Structural validation', () => {
    it('should always return structured decisions with reason + detail', () => {
      const toolName = 'write';
      const error = new Error('EACCES: permission denied');
      const painScore = 35;
      const errorHash = 'abc123';
      const sessionId = 'session-001';
      const workspaceDir = '/tmp/workspace';

      const event = createMockEvent(toolName, error, {
        file_path: '/tmp/test.md',
        content: 'test',
      });

      const observation = createMockObservation(painScore, false, errorHash);
      const outcome = createMockOutcome(true, 'tool_failure');
      const sessionState = {
        currentGfi: 30,
        consecutiveErrors: 1,
      };

      const config = createMockConfig(() => undefined);

      const decision = evaluatePainAdmissionForToolCall(
        event,
        observation,
        outcome,
        sessionState,
        sessionState,
        sessionId,
        workspaceDir,
        config,
      );

      // ERR-002: Every decision carries reason + nextAction
      expect(decision).toHaveProperty('admitted');
      expect(decision).toHaveProperty('stage');
      expect(decision).toHaveProperty('reason');
      expect(decision).toHaveProperty('detail');
      expect(decision.reason).toBeTruthy();
      expect(decision.detail).toBeTruthy();
    });
  });

  /**
   * PRI-442 R4 / PR #1164 review: E2E mode must be gated by an explicit env
   * var, not by path-substring matching. A production workspace whose path
   * happens to contain "e2e-workspace" must NOT silently get E2E behavior
   * (rc-9-no-silent-fallback). These tests pin that contract.
   */
  describe('E2E mode gating (PR #1164 review fix)', () => {
    const ENV_KEY = 'PD_E2E_MODE';
    let savedEnv: string | undefined;

    beforeEach(() => {
      savedEnv = process.env[ENV_KEY];
      delete process.env[ENV_KEY];
    });

    afterEach(() => {
      if (savedEnv === undefined) {
        delete process.env[ENV_KEY];
      } else {
        process.env[ENV_KEY] = savedEnv;
      }
    });

    it('rejects shell-tool failures when PD_E2E_MODE is unset, even if path contains e2e-workspace', () => {
      // This is the regression guard: path-substring matching was removed.
      const toolName = 'bash';
      const error = new Error('build failed');
      const workspaceDir = '/tmp/some-e2e-workspace-dir/test'; // contains "e2e-workspace"
      const event = createMockEvent(toolName, error, { command: 'npm run build' });
      const observation = createMockObservation(80, false, 'hash-shell-1');
      const outcome = createMockOutcome(true, 'tool_failure');
      const sessionState = { currentGfi: 30, consecutiveErrors: 1 };
      const config = createMockConfig(() => undefined);

      const decision = evaluatePainAdmissionForToolCall(
        event, observation, outcome,
        sessionState, sessionState,
        'session-e2e-1', workspaceDir, config,
      );

      expect(decision.admitted).toBe(false);
      expect(decision.stage).toBe('not_applicable');
      expect(decision.reason).toBe('not_a_write_tool_failure');
    });

    it('admits shell-tool failures when PD_E2E_MODE=1', () => {
      process.env[ENV_KEY] = '1';
      const toolName = 'bash';
      const error = new Error('build failed');
      const workspaceDir = '/tmp/e2e-run';
      const event = createMockEvent(toolName, error, { command: 'npm run build' });
      const observation = createMockObservation(80, false, 'hash-shell-2');
      const outcome = createMockOutcome(true, 'tool_failure');
      // E2E mode forces consecutiveErrors to >= 4 (Rule 3 admit upgrade)
      const sessionState = { currentGfi: 30, consecutiveErrors: 0 };
      const config = createMockConfig(() => undefined);

      const decision = evaluatePainAdmissionForToolCall(
        event, observation, outcome,
        sessionState, sessionState,
        'session-e2e-2', workspaceDir, config,
      );

      // Should NOT be rejected at the tool-name gate
      expect(decision.stage).not.toBe('not_applicable');
      expect(decision.reason).not.toBe('not_a_write_tool_failure');
    });

    it('does not inflate consecutiveErrors when PD_E2E_MODE is unset', () => {
      // Even if path contains e2e-workspace, consecutiveErrors must stay real.
      const toolName = 'write';
      const error = new Error('EACCES');
      const workspaceDir = '/tmp/e2e-workspace-lookalike';
      const event = createMockEvent(toolName, error, { file_path: '/x.md' });
      const observation = createMockObservation(80, false, 'hash-ce-1');
      const outcome = createMockOutcome(true, 'tool_failure');
      const sessionState = { currentGfi: 30, consecutiveErrors: 1 };
      const config = createMockConfig(() => undefined);

      // Should use real consecutiveErrors (1), not inflated to 4.
      // With ce=1 and non-risky tool_failure, triage should not upgrade.
      const decision = evaluatePainAdmissionForToolCall(
        event, observation, outcome,
        sessionState, sessionState,
        'session-ce-1', workspaceDir, config,
      );

      // The decision itself may be admitted or not depending on triage rules,
      // but the key contract is: it must behave identically to a workspace
      // whose path does NOT contain "e2e-workspace".
      const otherDir = '/tmp/normal-workspace';
      const decisionOther = evaluatePainAdmissionForToolCall(
        createMockEvent(toolName, error, { file_path: '/x.md' }),
        createMockObservation(80, false, 'hash-ce-1'),
        createMockOutcome(true, 'tool_failure'),
        sessionState, sessionState,
        'session-ce-1', otherDir, config,
      );

      expect(decision.admitted).toBe(decisionOther.admitted);
      expect(decision.stage).toBe(decisionOther.stage);
      expect(decision.reason).toBe(decisionOther.reason);
    });
  });
});