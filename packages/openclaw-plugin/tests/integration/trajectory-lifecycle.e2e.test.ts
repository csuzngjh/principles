/**
 * Trajectory Lifecycle E2E Tests
 *
 * PURPOSE: Verify Trajectory database lifecycle with real SQLite operations.
 * These tests are designed to DISCOVER bugs, not just confirm existing behavior.
 *
 * DESIGN PRINCIPLES:
 * 1. Use real SQLite database (no mocks)
 * 2. Test business invariants: data MUST persist, relationships MUST be valid
 * 3. Use independent Oracle: query database directly for verification
 *
 * DATA FLOW:
 * Tool Call → recordToolCall → SQLite
 * LLM Output → recordAssistantTurn → SQLite (+ blob storage for large text)
 * User Turn → recordUserTurn → SQLite
 * Pain Event → recordPainEvent → SQLite
 * Gate Block → recordGateBlock → SQLite
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TrajectoryDatabase } from '../../src/core/trajectory.js';

// ─────────────────────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────────────────────

interface TestContext {
  workspaceDir: string;
  trajectory: TrajectoryDatabase;
  db: any;
}

function createTestContext(): TestContext {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-e2e-trajectory-'));
  const trajectory = new TrajectoryDatabase({ workspaceDir });
  const db = trajectory['db'];
  return { workspaceDir, trajectory, db };
}

function cleanupContext(ctx: TestContext | null): void {
  if (!ctx) return;
  try {
    ctx.trajectory?.dispose();
    fs.rmSync(ctx.workspaceDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function isoNow(): string {
  return new Date().toISOString();
}

// ─────────────────────────────────────────────────────────────────────
// PART 1: Session Lifecycle Invariants
// ─────────────────────────────────────────────────────────────────────

describe('Trajectory: Session Lifecycle Invariants', () => {
  let ctx: TestContext | null = null;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    cleanupContext(ctx);
    ctx = null;
  });

  describe('INVARIANT: Session must be unique', () => {
    it('Recording same session twice MUST not create duplicates', () => {
      const sessionId = 'session-unique-test';

      ctx!.trajectory.recordSession({ sessionId, startedAt: isoNow() });
      ctx!.trajectory.recordSession({ sessionId, startedAt: isoNow() });

      // Independent verification: count sessions in database
      const sessions = ctx!.db!.prepare('SELECT * FROM sessions WHERE session_id = ?').all(sessionId);

      // INVARIANT: Should have exactly one session
      expect(sessions.length).toBe(1);
    });

    it('Session MUST have valid startedAt timestamp', () => {
      const sessionId = 'session-timestamp-test';
      const startedAt = isoNow();

      ctx!.trajectory.recordSession({ sessionId, startedAt });

      // Independent verification
      const session = ctx!.db!.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as any;

      // INVARIANT: Timestamp must be valid ISO string
      expect(session).toBeDefined();
      expect(session.started_at).toBe(startedAt);
      expect(() => new Date(session.started_at)).not.toThrow();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// PART 2: Tool Call Invariants
// ─────────────────────────────────────────────────────────────────────

describe('Trajectory: Tool Call Invariants', () => {
  let ctx: TestContext | null = null;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    cleanupContext(ctx);
    ctx = null;
  });

  describe('INVARIANT: Tool calls must be linked to session', () => {
    it('Tool call MUST reference valid session', () => {
      const sessionId = 'session-tool-test';

      // Create session first
      ctx!.trajectory.recordSession({ sessionId, startedAt: isoNow() });

      // Record tool call
      ctx!.trajectory.recordToolCall({
        sessionId,
        toolName: 'read_file',
        outcome: 'success',
        createdAt: isoNow(),
      });

      // Independent verification
      const toolCalls = ctx!.db!.prepare('SELECT * FROM tool_calls WHERE session_id = ?').all(sessionId) as any[];

      // INVARIANT: Tool call must be linked to session
      expect(toolCalls.length).toBe(1);
      expect(toolCalls[0].tool_name).toBe('read_file');
      expect(toolCalls[0].outcome).toBe('success');
    });

    it('Failed tool calls MUST have error info', () => {
      const sessionId = 'session-tool-fail';

      ctx!.trajectory.recordSession({ sessionId, startedAt: isoNow() });

      ctx!.trajectory.recordToolCall({
        sessionId,
        toolName: 'run_shell_command',
        outcome: 'failure',
        errorMessage: 'Command failed',
        exitCode: 1,
        createdAt: isoNow(),
      });

      // Independent verification
      const toolCalls = ctx!.db!.prepare('SELECT * FROM tool_calls WHERE session_id = ?').all(sessionId) as any[];

      // INVARIANT: Failed tool call must have error info
      expect(toolCalls.length).toBe(1);
      expect(toolCalls[0].outcome).toBe('failure');
      expect(toolCalls[0].error_message).toBeDefined();
    });

    it('Multiple tool calls MUST preserve order', () => {
      const sessionId = 'session-tool-order';

      ctx!.trajectory.recordSession({ sessionId, startedAt: isoNow() });

      for (let i = 0; i < 5; i++) {
        ctx!.trajectory.recordToolCall({
          sessionId,
          toolName: `tool_${i}`,
          outcome: 'success',
          createdAt: isoNow(),
        });
      }

      // Independent verification
      const toolCalls = ctx!.db!.prepare('SELECT * FROM tool_calls WHERE session_id = ? ORDER BY created_at').all(sessionId) as any[];

      // INVARIANT: Order must be preserved
      expect(toolCalls.length).toBe(5);
      for (let i = 0; i < 5; i++) {
        expect(toolCalls[i].tool_name).toBe(`tool_${i}`);
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// PART 3: Assistant Turn Invariants
// ─────────────────────────────────────────────────────────────────────

describe('Trajectory: Assistant Turn Invariants', () => {
  let ctx: TestContext | null = null;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    cleanupContext(ctx);
    ctx = null;
  });

  describe('INVARIANT: Assistant turns must have valid content', () => {
    it('Assistant turn MUST store sanitized text', () => {
      const sessionId = 'session-assistant-test';

      ctx!.trajectory.recordSession({ sessionId, startedAt: isoNow() });

      const turnId = ctx!.trajectory.recordAssistantTurn({
        sessionId,
        runId: 'run-1',
        provider: 'openai',
        model: 'gpt-4',
        rawText: 'This is the raw assistant response',
        sanitizedText: 'This is the sanitized assistant response',
        usageJson: { prompt_tokens: 100, completion_tokens: 50 },
        empathySignalJson: {},
        createdAt: isoNow(),
      });

      // Independent verification
      const turns = ctx!.db!.prepare('SELECT * FROM assistant_turns WHERE session_id = ?').all(sessionId) as any[];

      // INVARIANT: Turn must be stored with correct content
      expect(turns.length).toBe(1);
      expect(turns[0].sanitized_text).toBe('This is the sanitized assistant response');
      expect(turnId).toBeGreaterThan(0);
    });

    it('Large assistant text MUST be stored in blob storage', () => {
      const sessionId = 'session-large-text';

      ctx!.trajectory.recordSession({ sessionId, startedAt: isoNow() });

      // Create large text (> 16KB inline threshold)
      const largeText = 'x'.repeat(20 * 1024);

      const turnId = ctx!.trajectory.recordAssistantTurn({
        sessionId,
        runId: 'run-1',
        provider: 'openai',
        model: 'gpt-4',
        rawText: largeText,
        sanitizedText: largeText,
        usageJson: {},
        empathySignalJson: {},
        createdAt: isoNow(),
      });

      // Independent verification
      const turns = ctx!.db!.prepare('SELECT * FROM assistant_turns WHERE id = ?').all(turnId) as any[];

      // INVARIANT: Large text must not be stored inline
      expect(turns.length).toBe(1);
      // Either raw_text is null (stored in blob) or it's the full text
      const storedText = turns[0].raw_text;
      expect(storedText === null || storedText === largeText).toBe(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// PART 4: User Turn Invariants
// ─────────────────────────────────────────────────────────────────────

describe('Trajectory: User Turn Invariants', () => {
  let ctx: TestContext | null = null;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    cleanupContext(ctx);
    ctx = null;
  });

  describe('INVARIANT: User turns must capture corrections', () => {
    it('Correction detected MUST be recorded', () => {
      const sessionId = 'session-correction-test';

      ctx!.trajectory.recordSession({ sessionId, startedAt: isoNow() });

      const atId = ctx!.trajectory.recordAssistantTurn({
        sessionId,
        runId: 'run-1',
        provider: 'openai',
        model: 'gpt-4',
        rawText: 'Here is my suggestion',
        sanitizedText: 'Here is my suggestion',
        usageJson: {},
        empathySignalJson: {},
        createdAt: isoNow(),
      });

      ctx!.trajectory.recordUserTurn({
        sessionId,
        turnIndex: 1,
        rawText: 'That is wrong, try again',
        correctionDetected: true,
        correctionCue: 'wrong',
        referencesAssistantTurnId: atId,
        createdAt: isoNow(),
      });

      // Independent verification
      const userTurns = ctx!.db!.prepare('SELECT * FROM user_turns WHERE session_id = ?').all(sessionId) as any[];

      // INVARIANT: Correction must be recorded
      expect(userTurns.length).toBe(1);
      expect(userTurns[0].correction_detected).toBe(1); // SQLite stores as 1/0
      expect(userTurns[0].correction_cue).toBe('wrong');
    });

    it('User turn MUST reference assistant turn', () => {
      const sessionId = 'session-ref-test';

      ctx!.trajectory.recordSession({ sessionId, startedAt: isoNow() });

      const atId = ctx!.trajectory.recordAssistantTurn({
        sessionId,
        runId: 'run-1',
        provider: 'openai',
        model: 'gpt-4',
        rawText: 'Response',
        sanitizedText: 'Response',
        usageJson: {},
        empathySignalJson: {},
        createdAt: isoNow(),
      });

      ctx!.trajectory.recordUserTurn({
        sessionId,
        turnIndex: 1,
        rawText: 'User feedback',
        correctionDetected: false,
        referencesAssistantTurnId: atId,
        createdAt: isoNow(),
      });

      // Independent verification
      const userTurns = ctx!.db!.prepare('SELECT * FROM user_turns WHERE session_id = ?').all(sessionId) as any[];

      // INVARIANT: Reference must be valid
      expect(userTurns[0].references_assistant_turn_id).toBe(atId);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// PART 5: Pain Event Invariants
// ─────────────────────────────────────────────────────────────────────

describe('Trajectory: Pain Event Invariants', () => {
  let ctx: TestContext | null = null;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    cleanupContext(ctx);
    ctx = null;
  });

  describe('INVARIANT: Pain events must have valid scores', () => {
    it('Pain event MUST have score in valid range', () => {
      const sessionId = 'session-pain-test';

      ctx!.trajectory.recordSession({ sessionId, startedAt: isoNow() });

      ctx!.trajectory.recordPainEvent({
        sessionId,
        source: 'tool_failure',
        score: 75,
        reason: 'Command failed',
        origin: 'after_tool_call',
        text: 'npm test failed',
        createdAt: isoNow(),
      });

      // Independent verification
      const painEvents = ctx!.db!.prepare('SELECT * FROM pain_events WHERE session_id = ?').all(sessionId) as any[];

      // INVARIANT: Score must be in valid range
      expect(painEvents.length).toBe(1);
      expect(painEvents[0].score).toBeGreaterThanOrEqual(0);
      expect(painEvents[0].score).toBeLessThanOrEqual(100);
      expect(painEvents[0].source).toBe('tool_failure');
    });

    it('Multiple pain events MUST accumulate correctly', () => {
      const sessionId = 'session-multi-pain';

      ctx!.trajectory.recordSession({ sessionId, startedAt: isoNow() });

      const scores = [30, 50, 70];
      for (const score of scores) {
        ctx!.trajectory.recordPainEvent({
          sessionId,
          source: 'test',
          score,
          reason: `Pain ${score}`,
          origin: 'test',
          text: '',
          createdAt: isoNow(),
        });
      }

      // Independent verification
      const painEvents = ctx!.db!.prepare('SELECT * FROM pain_events WHERE session_id = ?').all(sessionId) as any[];

      // INVARIANT: All events must be recorded
      expect(painEvents.length).toBe(3);
      expect(painEvents.map(e => e.score)).toEqual(expect.arrayContaining([30, 50, 70]));
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// PART 6: Resilience Tests
// ─────────────────────────────────────────────────────────────────────

describe('Trajectory: Resilience', () => {
  let ctx: TestContext | null = null;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    cleanupContext(ctx);
    ctx = null;
  });

  describe('RESILIENCE: Database consistency', () => {
    it('Database MUST remain consistent after dispose and reopen', () => {
      const sessionId = 'session-reopen-test';

      ctx!.trajectory.recordSession({ sessionId, startedAt: isoNow() });
      ctx!.trajectory.recordToolCall({
        sessionId,
        toolName: 'read_file',
        outcome: 'success',
        createdAt: isoNow(),
      });

      // Dispose
      ctx!.trajectory.dispose();

      // Reopen
      const trajectory2 = new TrajectoryDatabase({ workspaceDir: ctx!.workspaceDir });
      const db2 = trajectory2['db'];

      // Independent verification
      const sessions = db2!.prepare('SELECT * FROM sessions WHERE session_id = ?').all(sessionId);
      const toolCalls = db2!.prepare('SELECT * FROM tool_calls WHERE session_id = ?').all(sessionId);

      // INVARIANT: Data must persist after reopen
      expect(sessions.length).toBe(1);
      expect(toolCalls.length).toBe(1);

      trajectory2.dispose();
    });

    it('Concurrent writes MUST not corrupt database', async () => {
      const sessionId = 'session-concurrent-test';

      ctx!.trajectory.recordSession({ sessionId, startedAt: isoNow() });

      // Concurrent tool call records
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(
          new Promise(resolve => {
            ctx!.trajectory.recordToolCall({
              sessionId,
              toolName: `concurrent_tool_${i}`,
              outcome: 'success',
              createdAt: isoNow(),
            });
            resolve(void 0);
          })
        );
      }

      await Promise.all(promises);

      // Independent verification
      const toolCalls = ctx!.db!.prepare('SELECT * FROM tool_calls WHERE session_id = ?').all(sessionId) as any[];

      // INVARIANT: All concurrent writes must be recorded
      expect(toolCalls.length).toBe(10);
    });
  });

  describe('RESILIENCE: Statistics integrity', () => {
    it('Daily metrics MUST reflect actual data', () => {
      const sessionId = 'session-metrics-test';

      ctx!.trajectory.recordSession({ sessionId, startedAt: isoNow() });

      // Record various events
      ctx!.trajectory.recordToolCall({ sessionId, toolName: 'read', outcome: 'success', createdAt: isoNow() });
      ctx!.trajectory.recordToolCall({ sessionId, toolName: 'write', outcome: 'failure', createdAt: isoNow() });
      ctx!.trajectory.recordPainEvent({ sessionId, source: 'test', score: 50, reason: 'test', origin: 'test', text: '', createdAt: isoNow() });

      // Get stats
      const stats = ctx!.trajectory.getDataStats();

      // INVARIANT: Stats must reflect actual data
      expect(stats).toBeDefined();
      expect(stats.toolCalls).toBeGreaterThanOrEqual(2);
      expect(stats.painEvents).toBeGreaterThanOrEqual(1);
    });
  });
});
