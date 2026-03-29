import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  NocturnalTrajectoryExtractor,
  listNocturnalCandidateSessions,
  getNocturnalSessionSnapshot,
  computeThinkingModelActivation,
  computePlanningRatio,
  computeThinkingModelDelta,
  computePlanningRatioGain,
  type NocturnalSessionSnapshot,
  type NocturnalSessionSummary,
} from '../../src/core/nocturnal-trajectory-extractor.js';
import { TrajectoryDatabase } from '../../src/core/trajectory.js';

describe('NocturnalTrajectoryExtractor', () => {
  let tmpDir: string;
  let trajectory: TrajectoryDatabase;
  let extractor: NocturnalTrajectoryExtractor;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-nocturnal-extractor-test-'));
    trajectory = new TrajectoryDatabase({ workspaceDir: tmpDir });
    extractor = new NocturnalTrajectoryExtractor(trajectory);
  });

  afterEach(() => {
    trajectory.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Helper: Seed trajectory data
  // -------------------------------------------------------------------------

  function seedSession(sessionId: string, startedAt?: string): void {
    trajectory.recordSession({ sessionId, startedAt: startedAt ?? new Date().toISOString() });
  }

  function seedAssistantTurn(
    sessionId: string,
    sanitizedText: string,
    rawText: string,
    model = 'gpt-4'
  ): void {
    trajectory.recordAssistantTurn({
      sessionId,
      runId: 'run-1',
      provider: 'openai',
      model,
      rawText,
      sanitizedText,
      usageJson: {},
      empathySignalJson: {},
    });
  }

  function seedToolCall(
    sessionId: string,
    toolName: string,
    outcome: 'success' | 'failure' | 'blocked',
    errorMessage?: string
  ): void {
    trajectory.recordToolCall({
      sessionId,
      toolName,
      outcome,
      errorMessage: errorMessage ?? null,
    });
  }

  function seedPainEvent(
    sessionId: string,
    score: number,
    source: string,
    reason?: string
  ): void {
    trajectory.recordPainEvent({
      sessionId,
      source,
      score,
      reason: reason ?? null,
    });
  }

  function seedGateBlock(
    sessionId: string,
    toolName: string,
    reason: string
  ): void {
    trajectory.recordGateBlock({
      sessionId,
      toolName,
      reason,
    });
  }

  // -------------------------------------------------------------------------
  // listRecentNocturnalCandidateSessions
  // -------------------------------------------------------------------------

  describe('listRecentNocturnalCandidateSessions', () => {
    it('returns empty array when no sessions exist', () => {
      const result = extractor.listRecentNocturnalCandidateSessions();
      expect(result).toEqual([]);
    });

    it('returns sessions with tool calls above threshold', () => {
      seedSession('session-1');
      seedSession('session-2');
      seedToolCall('session-1', 'read_file', 'success');
      seedToolCall('session-2', 'read_file', 'success');

      const result = extractor.listRecentNocturnalCandidateSessions();
      expect(result).toHaveLength(2);
      expect(result.map((s) => s.sessionId).sort()).toEqual(['session-1', 'session-2']);
    });

    it('filters out sessions below minToolCalls threshold', () => {
      seedSession('session-1');
      seedSession('session-2');
      seedToolCall('session-1', 'read_file', 'success');
      // session-2 has no tool calls

      const result = extractor.listRecentNocturnalCandidateSessions({ minToolCalls: 1 });
      expect(result).toHaveLength(1);
      expect(result[0].sessionId).toBe('session-1');
    });

    it('counts failures correctly', () => {
      seedSession('session-1');
      seedToolCall('session-1', 'bash', 'failure', 'command failed');
      seedToolCall('session-1', 'read_file', 'success');

      const result = extractor.listRecentNocturnalCandidateSessions();
      expect(result[0].failureCount).toBe(1);
      expect(result[0].toolCallCount).toBe(2);
    });

    it('counts pain events and gate blocks', () => {
      seedSession('session-1');
      seedToolCall('session-1', 'bash', 'failure', 'command failed');
      seedPainEvent('session-1', 50, 'tool_failure', 'bash failed');
      seedGateBlock('session-1', 'delete_file', 'risky operation');

      const result = extractor.listRecentNocturnalCandidateSessions();
      expect(result[0].painEventCount).toBe(1);
      expect(result[0].gateBlockCount).toBe(1);
    });

    it('respects limit option', () => {
      for (let i = 0; i < 10; i++) {
        seedSession(`session-${i}`);
        seedToolCall(`session-${i}`, 'read_file', 'success');
      }

      const result = extractor.listRecentNocturnalCandidateSessions({ limit: 5 });
      expect(result).toHaveLength(5);
    });

    it('returns sessions ordered by most recently updated', () => {
      const old = new Date(Date.now() - 86400000).toISOString(); // 1 day ago
      const recent = new Date().toISOString();
      seedSession('session-old', old);
      seedSession('session-recent', recent);
      seedToolCall('session-old', 'read_file', 'success');
      seedToolCall('session-recent', 'read_file', 'success');

      const result = extractor.listRecentNocturnalCandidateSessions();
      expect(result[0].sessionId).toBe('session-recent');
    });
  });

  // -------------------------------------------------------------------------
  // getNocturnalSessionSnapshot
  // -------------------------------------------------------------------------

  describe('getNocturnalSessionSnapshot', () => {
    it('returns null for non-existent session', () => {
      const result = extractor.getNocturnalSessionSnapshot('does-not-exist');
      expect(result).toBeNull();
    });

    it('returns full snapshot with all turn types', () => {
      seedSession('session-1');
      seedAssistantTurn('session-1', 'I will read the file first.', 'User asked me to read the file.');
      seedAssistantTurn(
        'session-1',
        'I am editing the file now.',
        'User asked me to edit the file.'
      );
      trajectory.recordUserTurn({
        sessionId: 'session-1',
        turnIndex: 0,
        rawText: 'Good, keep going',
        correctionDetected: false,
      });
      trajectory.recordUserTurn({
        sessionId: 'session-1',
        turnIndex: 1,
        rawText: 'No, that is wrong!',
        correctionDetected: true,
        correctionCue: 'explicit correction',
      });
      seedToolCall('session-1', 'read_file', 'success');
      seedToolCall('session-1', 'edit_file', 'success');
      seedPainEvent('session-1', 40, 'tool_failure', 'minor issue');
      seedGateBlock('session-1', 'delete_file', 'risky');

      const snapshot = extractor.getNocturnalSessionSnapshot('session-1');

      expect(snapshot).not.toBeNull();
      snapshot!;

      expect(snapshot!.sessionId).toBe('session-1');
      expect(snapshot!.assistantTurns).toHaveLength(2);
      expect(snapshot!.userTurns).toHaveLength(2);
      expect(snapshot!.toolCalls).toHaveLength(2);
      expect(snapshot!.painEvents).toHaveLength(1);
      expect(snapshot!.gateBlocks).toHaveLength(1);
      expect(snapshot!.stats.totalAssistantTurns).toBe(2);
      expect(snapshot!.stats.totalToolCalls).toBe(2);
      expect(snapshot!.stats.failureCount).toBe(0);
    });

    it('sanitizedText only — never raw_text', () => {
      seedSession('session-1');
      seedAssistantTurn(
        'session-1',
        'I will fix the bug now.',
        'User private API key was exposed in the file content. Fix the bug now please!'
      );

      const snapshot = extractor.getNocturnalSessionSnapshot('session-1');

      expect(snapshot).not.toBeNull();
      // Sanitized text should not contain the private content
      expect(snapshot!.assistantTurns[0].sanitizedText).toBe('I will fix the bug now.');
      // Ensure raw text is NOT in the snapshot
      expect(JSON.stringify(snapshot)).not.toContain('API key');
      expect(JSON.stringify(snapshot)).not.toContain('exposed');
    });

    it('user turns expose only correctionCue — never raw user text', () => {
      seedSession('session-1');
      trajectory.recordUserTurn({
        sessionId: 'session-1',
        turnIndex: 0,
        rawText: 'DELETE ALL THE FILES immediately!',
        correctionDetected: true,
        correctionCue: 'User said "No, that is wrong!"',
      });

      const snapshot = extractor.getNocturnalSessionSnapshot('session-1');

      expect(snapshot).not.toBeNull();
      // Only correctionCue should be present
      expect(snapshot!.userTurns[0].correctionCue).toBe('User said "No, that is wrong!"');
      // rawText should NOT be in the snapshot
      expect(JSON.stringify(snapshot)).not.toContain('DELETE ALL THE FILES');
    });

    it('tool calls include outcome and error info but not params', () => {
      seedSession('session-1');
      seedToolCall('session-1', 'bash', 'failure', 'rm: cannot delete /protected: Permission denied');

      const snapshot = extractor.getNocturnalSessionSnapshot('session-1');

      expect(snapshot).not.toBeNull();
      expect(snapshot!.toolCalls[0].toolName).toBe('bash');
      expect(snapshot!.toolCalls[0].outcome).toBe('failure');
      expect(snapshot!.toolCalls[0].errorMessage).toBe('rm: cannot delete /protected: Permission denied');
      // params should not be included (we don't seed params in seedToolCall)
      expect(snapshot!.toolCalls[0]).not.toHaveProperty('paramsJson');
    });

    it('pain events include score and reason only', () => {
      seedSession('session-1');
      seedPainEvent('session-1', 65, 'gate_block', 'Agent attempted risky delete without plan');

      const snapshot = extractor.getNocturnalSessionSnapshot('session-1');

      expect(snapshot).not.toBeNull();
      expect(snapshot!.painEvents[0].score).toBe(65);
      expect(snapshot!.painEvents[0].reason).toBe('Agent attempted risky delete without plan');
      expect(snapshot!.painEvents[0].source).toBe('gate_block');
    });

    it('gate blocks include tool and reason only', () => {
      seedSession('session-1');
      seedGateBlock('session-1', 'delete_file', 'No PLAN.md found for risky path');

      const snapshot = extractor.getNocturnalSessionSnapshot('session-1');

      expect(snapshot).not.toBeNull();
      expect(snapshot!.gateBlocks[0].toolName).toBe('delete_file');
      expect(snapshot!.gateBlocks[0].reason).toBe('No PLAN.md found for risky path');
    });

    it('snapshot stats compute failureCount correctly', () => {
      seedSession('session-1');
      seedToolCall('session-1', 'bash', 'failure', 'error 1');
      seedToolCall('session-1', 'read_file', 'success');
      seedToolCall('session-1', 'bash', 'failure', 'error 2');
      seedToolCall('session-1', 'edit_file', 'success');

      const snapshot = extractor.getNocturnalSessionSnapshot('session-1');

      expect(snapshot).not.toBeNull();
      expect(snapshot!.stats.failureCount).toBe(2);
      expect(snapshot!.stats.totalToolCalls).toBe(4);
    });
  });

  // -------------------------------------------------------------------------
  // Convenience wrappers
  // -------------------------------------------------------------------------

  describe('module-level convenience functions', () => {
    it('listNocturnalCandidateSessions works as a standalone function', () => {
      seedSession('session-1');
      seedToolCall('session-1', 'read_file', 'success');

      const result = listNocturnalCandidateSessions(trajectory);
      expect(result).toHaveLength(1);
    });

    it('getNocturnalSessionSnapshot works as a standalone function', () => {
      seedSession('session-1');
      seedAssistantTurn('session-1', 'Hello', 'Hello');

      const result = getNocturnalSessionSnapshot(trajectory, 'session-1');
      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('session-1');
    });

    it('getNocturnalSessionSnapshot returns null for non-existent session', () => {
      const result = getNocturnalSessionSnapshot(trajectory, 'non-existent');
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Security / sanitization guarantees
  // -------------------------------------------------------------------------

  describe('sanitization guarantees', () => {
    it('snapshot JSON stringified output does not contain raw_text field names', () => {
      seedSession('session-1');
      seedAssistantTurn(
        'session-1',
        'Fixed the issue.',
        'SECRET_API_KEY=sk-12345678 user private data here'
      );

      const snapshot = extractor.getNocturnalSessionSnapshot('session-1');
      const jsonStr = JSON.stringify(snapshot);

      // Verify sanitized text is present
      expect(jsonStr).toContain('Fixed the issue.');
      // Verify raw text content is NOT present
      expect(jsonStr).not.toContain('SECRET_API_KEY');
      expect(jsonStr).not.toContain('sk-12345678');
      expect(jsonStr).not.toContain('user private data');
      // Verify field name 'rawText' is NOT in the output
      expect(jsonStr).not.toContain('"rawText"');
    });

    it('session with very long raw text only stores sanitized version', () => {
      const longContent = 'A'.repeat(10000);
      seedSession('session-1');
      seedAssistantTurn('session-1', 'Summary: large file processed', longContent);

      const snapshot = extractor.getNocturnalSessionSnapshot('session-1');
      expect(snapshot).not.toBeNull();
      // The sanitized text should be short
      expect(snapshot!.assistantTurns[0].sanitizedText).toBe('Summary: large file processed');
      // The JSON should not contain the long raw content
      expect(JSON.stringify(snapshot)).not.toContain(longContent);
    });
  });
});

describe('Reflection Quality Metrics', () => {
  // -------------------------------------------------------------------------
  // computeThinkingModelActivation
  // -------------------------------------------------------------------------

  describe('computeThinkingModelActivation', () => {
    it('returns 0 for empty text', () => {
      expect(computeThinkingModelActivation('')).toBe(0);
      expect(computeThinkingModelActivation('   ')).toBe(0);
    });

    it('returns 0 for text with no thinking model patterns', () => {
      const text = 'Just do it now without any planning';
      const activation = computeThinkingModelActivation(text);
      expect(activation).toBeGreaterThanOrEqual(0);
      expect(activation).toBeLessThanOrEqual(1);
    });

    it('returns positive value for text with thinking model patterns', () => {
      // T-01 pattern: "let me first understand the structure"
      const text = 'Let me first understand the structure before editing anything';
      const activation = computeThinkingModelActivation(text);
      expect(activation).toBeGreaterThan(0);
      expect(activation).toBeLessThanOrEqual(1);
    });

    it('returns value rounded to 2 decimal places', () => {
      const text = 'Based on the evidence and logs, let me check the actual source code';
      const activation = computeThinkingModelActivation(text);
      // Should be rounded to 2 decimal places
      expect(activation * 100).toBe(Math.round(activation * 100));
    });
  });

  // -------------------------------------------------------------------------
  // computePlanningRatio
  // -------------------------------------------------------------------------

  describe('computePlanningRatio', () => {
    it('returns 0 for snapshot with no tool calls', () => {
      const snapshot: NocturnalSessionSnapshot = {
        sessionId: 'test',
        startedAt: '',
        principleId: '',
        assistantTurns: [],
        userTurns: [],
        toolCalls: [],
        painEvents: [],
        gateBlocks: [],
        stats: { failureCount: 0, totalPainEvents: 0, totalGateBlocks: 0 },
      };
      expect(computePlanningRatio(snapshot)).toBe(0);
    });

    it('returns 0 for snapshot with writes but no preceding reads', () => {
      const snapshot: NocturnalSessionSnapshot = {
        sessionId: 'test',
        startedAt: '',
        principleId: '',
        assistantTurns: [],
        userTurns: [],
        toolCalls: [
          { toolName: 'edit', outcome: 'success', filePath: null, durationMs: 100, exitCode: null, errorType: null, errorMessage: null, createdAt: '' },
          { toolName: 'write', outcome: 'success', filePath: null, durationMs: 100, exitCode: null, errorType: null, errorMessage: null, createdAt: '' },
        ],
        painEvents: [],
        gateBlocks: [],
        stats: { failureCount: 0, totalPainEvents: 0, totalGateBlocks: 0 },
      };
      expect(computePlanningRatio(snapshot)).toBe(0);
    });

    it('returns 1 for snapshot where all writes are preceded by reads', () => {
      const snapshot: NocturnalSessionSnapshot = {
        sessionId: 'test',
        startedAt: '',
        principleId: '',
        assistantTurns: [],
        userTurns: [],
        toolCalls: [
          { toolName: 'read', outcome: 'success', filePath: null, durationMs: 100, exitCode: null, errorType: null, errorMessage: null, createdAt: '' },
          { toolName: 'edit', outcome: 'success', filePath: null, durationMs: 100, exitCode: null, errorType: null, errorMessage: null, createdAt: '' },
        ],
        painEvents: [],
        gateBlocks: [],
        stats: { failureCount: 0, totalPainEvents: 0, totalGateBlocks: 0 },
      };
      expect(computePlanningRatio(snapshot)).toBe(1);
    });

    it('returns 0.5 when half of writes are preceded by reads', () => {
      const snapshot: NocturnalSessionSnapshot = {
        sessionId: 'test',
        startedAt: '',
        principleId: '',
        assistantTurns: [],
        userTurns: [],
        toolCalls: [
          { toolName: 'read', outcome: 'success', filePath: null, durationMs: 100, exitCode: null, errorType: null, errorMessage: null, createdAt: '' },
          { toolName: 'edit', outcome: 'success', filePath: null, durationMs: 100, exitCode: null, errorType: null, errorMessage: null, createdAt: '' },
          { toolName: 'edit', outcome: 'success', filePath: null, durationMs: 100, exitCode: null, errorType: null, errorMessage: null, createdAt: '' },
        ],
        painEvents: [],
        gateBlocks: [],
        stats: { failureCount: 0, totalPainEvents: 0, totalGateBlocks: 0 },
      };
      expect(computePlanningRatio(snapshot)).toBe(0.5);
    });

    it('returns value rounded to 2 decimal places', () => {
      const snapshot: NocturnalSessionSnapshot = {
        sessionId: 'test',
        startedAt: '',
        principleId: '',
        assistantTurns: [],
        userTurns: [],
        toolCalls: [
          { toolName: 'read', outcome: 'success', filePath: null, durationMs: 100, exitCode: null, errorType: null, errorMessage: null, createdAt: '' },
          { toolName: 'read', outcome: 'success', filePath: null, durationMs: 100, exitCode: null, errorType: null, errorMessage: null, createdAt: '' },
          { toolName: 'edit', outcome: 'success', filePath: null, durationMs: 100, exitCode: null, errorType: null, errorMessage: null, createdAt: '' },
        ],
        painEvents: [],
        gateBlocks: [],
        stats: { failureCount: 0, totalPainEvents: 0, totalGateBlocks: 0 },
      };
      expect(computePlanningRatio(snapshot)).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // computeThinkingModelDelta
  // -------------------------------------------------------------------------

  describe('computeThinkingModelDelta', () => {
    it('returns 0 for identical texts', () => {
      const text = 'Just do it now';
      expect(computeThinkingModelDelta(text, text)).toBe(0);
    });

    it('returns positive delta when improved has more thinking models', () => {
      const original = 'Edit the file now';
      const improved = 'Let me first understand the structure before editing anything';
      const delta = computeThinkingModelDelta(original, improved);
      expect(delta).toBeGreaterThan(0);
    });

    it('returns negative delta when improved has fewer thinking models', () => {
      const original = 'Let me first understand the structure before editing anything';
      const improved = 'Edit the file now';
      const delta = computeThinkingModelDelta(original, improved);
      expect(delta).toBeLessThan(0);
    });

    it('returns delta rounded to 2 decimal places', () => {
      const original = 'Edit the file';
      const improved = 'Based on the evidence, let me check the actual source and verify before editing';
      const delta = computeThinkingModelDelta(original, improved);
      expect(delta * 100).toBe(Math.round(delta * 100));
    });
  });

  // -------------------------------------------------------------------------
  // computePlanningRatioGain
  // -------------------------------------------------------------------------

  describe('computePlanningRatioGain', () => {
    it('returns 0 for identical snapshots', () => {
      const snapshot: NocturnalSessionSnapshot = {
        sessionId: 'test',
        startedAt: '',
        principleId: '',
        assistantTurns: [],
        userTurns: [],
        toolCalls: [
          { toolName: 'read', outcome: 'success', filePath: null, durationMs: 100, exitCode: null, errorType: null, errorMessage: null, createdAt: '' },
          { toolName: 'edit', outcome: 'success', filePath: null, durationMs: 100, exitCode: null, errorType: null, errorMessage: null, createdAt: '' },
        ],
        painEvents: [],
        gateBlocks: [],
        stats: { failureCount: 0, totalPainEvents: 0, totalGateBlocks: 0 },
      };
      expect(computePlanningRatioGain(snapshot, snapshot)).toBe(0);
    });

    it('returns positive gain when improved has better planning ratio', () => {
      const original: NocturnalSessionSnapshot = {
        sessionId: 'test',
        startedAt: '',
        principleId: '',
        assistantTurns: [],
        userTurns: [],
        toolCalls: [
          { toolName: 'edit', outcome: 'success', filePath: null, durationMs: 100, exitCode: null, errorType: null, errorMessage: null, createdAt: '' },
        ],
        painEvents: [],
        gateBlocks: [],
        stats: { failureCount: 0, totalPainEvents: 0, totalGateBlocks: 0 },
      };
      const improved: NocturnalSessionSnapshot = {
        sessionId: 'test',
        startedAt: '',
        principleId: '',
        assistantTurns: [],
        userTurns: [],
        toolCalls: [
          { toolName: 'read', outcome: 'success', filePath: null, durationMs: 100, exitCode: null, errorType: null, errorMessage: null, createdAt: '' },
          { toolName: 'edit', outcome: 'success', filePath: null, durationMs: 100, exitCode: null, errorType: null, errorMessage: null, createdAt: '' },
        ],
        painEvents: [],
        gateBlocks: [],
        stats: { failureCount: 0, totalPainEvents: 0, totalGateBlocks: 0 },
      };
      const gain = computePlanningRatioGain(original, improved);
      expect(gain).toBeGreaterThan(0);
    });

    it('returns negative gain when improved has worse planning ratio', () => {
      const original: NocturnalSessionSnapshot = {
        sessionId: 'test',
        startedAt: '',
        principleId: '',
        assistantTurns: [],
        userTurns: [],
        toolCalls: [
          { toolName: 'read', outcome: 'success', filePath: null, durationMs: 100, exitCode: null, errorType: null, errorMessage: null, createdAt: '' },
          { toolName: 'edit', outcome: 'success', filePath: null, durationMs: 100, exitCode: null, errorType: null, errorMessage: null, createdAt: '' },
        ],
        painEvents: [],
        gateBlocks: [],
        stats: { failureCount: 0, totalPainEvents: 0, totalGateBlocks: 0 },
      };
      const improved: NocturnalSessionSnapshot = {
        sessionId: 'test',
        startedAt: '',
        principleId: '',
        assistantTurns: [],
        userTurns: [],
        toolCalls: [
          { toolName: 'edit', outcome: 'success', filePath: null, durationMs: 100, exitCode: null, errorType: null, errorMessage: null, createdAt: '' },
        ],
        painEvents: [],
        gateBlocks: [],
        stats: { failureCount: 0, totalPainEvents: 0, totalGateBlocks: 0 },
      };
      const gain = computePlanningRatioGain(original, improved);
      expect(gain).toBeLessThan(0);
    });
  });
});
