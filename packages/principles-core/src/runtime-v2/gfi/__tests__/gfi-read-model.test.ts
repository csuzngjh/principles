import { describe, it, expect } from 'vitest';
import type { GfiReadModelInput } from '../gfi-read-model.js';
import { buildGfiWorkspaceSnapshot } from '../gfi-read-model.js';

describe('buildGfiWorkspaceSnapshot', () => {
  const nowMs = 1000 * 60 * 60 * 10; // 10 hours ago in ms

  function makeSession(overrides: Partial<GfiReadModelInput['sessions'][0]> = {}): GfiReadModelInput['sessions'][0] {
    return {
      sessionId: 's_test',
      currentGfi: 0,
      gfiBySource: {},
      consecutiveErrors: 0,
      lastActivityAt: nowMs,
      ...overrides,
    };
  }

  describe('active session selection', () => {
    it('recent session -> non-null snapshot', () => {
      const input: GfiReadModelInput = {
        sessions: [makeSession({ sessionId: 's_1', currentGfi: 50, lastActivityAt: nowMs })],
        nowMs: nowMs + 1000,
      };

      const result = buildGfiWorkspaceSnapshot(input);

      expect(result.active).not.toBeNull();
      expect(result.active?.currentGfi).toBe(50);
      expect(result.activeSessionCount).toBe(1);
      expect(result.staleSessionCount).toBe(0);
      expect(result.totalSessionCount).toBe(1);
    });

    it('only stale sessions -> null active with non-zero stale count', () => {
      const twoHoursAgo = nowMs - 2 * 60 * 60 * 1000;
      const input: GfiReadModelInput = {
        sessions: [
          makeSession({ sessionId: 's_1', currentGfi: 30, lastActivityAt: twoHoursAgo }),
          makeSession({ sessionId: 's_2', currentGfi: 50, lastActivityAt: twoHoursAgo - 1000 }),
        ],
        nowMs: nowMs + 1000,
      };

      const result = buildGfiWorkspaceSnapshot(input);

      expect(result.active).toBeNull();
      expect(result.staleSessionCount).toBe(2);
      expect(result.staleGfiRange).toEqual({ min: 30, max: 50 });
      expect(result.activeSessionCount).toBe(0);
      expect(result.totalSessionCount).toBe(2);
    });

    it('mixed active/stale -> active selected, stale counted', () => {
      const twoHoursAgo = nowMs - 2 * 60 * 60 * 1000;
      const input: GfiReadModelInput = {
        sessions: [
          makeSession({ sessionId: 's_1', currentGfi: 30, lastActivityAt: twoHoursAgo }),
          makeSession({ sessionId: 's_2', currentGfi: 70, lastActivityAt: nowMs }), // active
        ],
        nowMs: nowMs + 1000,
      };

      const result = buildGfiWorkspaceSnapshot(input);

      expect(result.active).not.toBeNull();
      expect(result.active?.currentGfi).toBe(70);
      expect(result.activeSessionCount).toBe(1);
      expect(result.staleSessionCount).toBe(1);
      expect(result.totalSessionCount).toBe(2);
    });

    it('multiple active -> highest GFI wins (tie-break: most recent)', () => {
      const input: GfiReadModelInput = {
        sessions: [
          makeSession({ sessionId: 's_1', currentGfi: 40, lastActivityAt: nowMs + 5000 }),
          makeSession({ sessionId: 's_2', currentGfi: 75, lastActivityAt: nowMs + 3000 }),
          makeSession({ sessionId: 's_3', currentGfi: 75, lastActivityAt: nowMs + 4000 }), // tie with s_2 but more recent
        ],
        nowMs: nowMs + 10000,
      };

      const result = buildGfiWorkspaceSnapshot(input);

      expect(result.active).not.toBeNull();
      // s_3 has same GFI as s_2 but more recent
      expect(result.active?.currentGfi).toBe(75);
      // Most recent among ties
      expect(result.activeSessionCount).toBe(3);
      expect(result.staleSessionCount).toBe(0);
    });
  });

  describe('stale vs active boundary', () => {
    it('session exactly at cutoff is active', () => {
      const cutoffMs = 2 * 60 * 60 * 1000; // 2 hours
      const atCutoff = nowMs - cutoffMs + 1; // 1ms before cutoff

      const input: GfiReadModelInput = {
        sessions: [makeSession({ sessionId: 's_1', currentGfi: 50, lastActivityAt: atCutoff })],
        nowMs: nowMs,
        staleCutoffMs: cutoffMs,
      };

      const result = buildGfiWorkspaceSnapshot(input);

      expect(result.active).not.toBeNull();
      expect(result.activeSessionCount).toBe(1);
      expect(result.staleSessionCount).toBe(0);
    });

    it('custom staleCutoffMs override', () => {
      // Using baseNow as the reference "current time"
      const baseNow = nowMs + 1000; // 10 hours + 1 second ago
      const fiveMinAgo = baseNow - 5 * 60 * 1000; // 5 minutes before baseNow
      const input: GfiReadModelInput = {
        sessions: [makeSession({ sessionId: 's_1', currentGfi: 50, lastActivityAt: fiveMinAgo })],
        nowMs: baseNow,
        staleCutoffMs: 10 * 60 * 1000, // 10 minutes
      };

      const result = buildGfiWorkspaceSnapshot(input);

      // Session is 5 minutes old, cutoff is 10 minutes -> ACTIVE
      expect(result.active).not.toBeNull();
      expect(result.active?.currentGfi).toBe(50);

      // Now test with session older than cutoff
      const fifteenMinAgo = baseNow - 15 * 60 * 1000;
      const input2: GfiReadModelInput = {
        sessions: [makeSession({ sessionId: 's_1', currentGfi: 50, lastActivityAt: fifteenMinAgo })],
        nowMs: baseNow,
        staleCutoffMs: 10 * 60 * 1000, // 10 minutes
      };

      const result2 = buildGfiWorkspaceSnapshot(input2);

      // Session is 15 minutes old, cutoff is 10 minutes -> STALE
      expect(result2.active).toBeNull();
      expect(result2.staleSessionCount).toBe(1);
    });
  });

  describe('GfiSnapshot content', () => {
    it('snapshot includes correct stage, dominant source, policy thresholds', () => {
      const input: GfiReadModelInput = {
        sessions: [
          makeSession({
            sessionId: 's_1',
            currentGfi: 75,
            gfiBySource: { tool_failure: 50, dispatch_error: 25 },
            consecutiveErrors: 3,
            lastErrorSource: 'tool_failure',
            dailyGfiPeak: 80,
            lastActivityAt: nowMs,
          }),
        ],
        nowMs: nowMs + 1000,
      };

      const result = buildGfiWorkspaceSnapshot(input);

      expect(result.active).not.toBeNull();
      expect(result.active?.stage).toBe('critical'); // 75 >= 70 (critical threshold)
      expect(result.active?.dominantSource).toBe('tool_failure'); // 50 > 25
      expect(result.active?.consecutiveErrors).toBe(3);
      expect(result.active?.dailyGfiPeak).toBe(80);
      expect(result.active?.policy.elevatedThreshold).toBe(40);
      expect(result.active?.policy.criticalThreshold).toBe(70);
      expect(result.active?.policy.saturatedThreshold).toBe(100);
      expect(result.active?.consumers.attitudeMode).toBe('humble_recovery');
      expect(result.active?.consumers.painDiagnosticReason).toBe('high_gfi');
    });

    it('saturated stage when currentGfi >= 100', () => {
      const input: GfiReadModelInput = {
        sessions: [makeSession({ sessionId: 's_1', currentGfi: 100, lastActivityAt: nowMs })],
        nowMs: nowMs + 1000,
      };

      const result = buildGfiWorkspaceSnapshot(input);

      expect(result.active?.stage).toBe('saturated');
    });

    it('stable stage when currentGfi < 40', () => {
      const input: GfiReadModelInput = {
        sessions: [makeSession({ sessionId: 's_1', currentGfi: 20, lastActivityAt: nowMs })],
        nowMs: nowMs + 1000,
      };

      const result = buildGfiWorkspaceSnapshot(input);

      expect(result.active?.stage).toBe('stable');
      expect(result.active?.consumers.attitudeMode).toBe('efficient');
      expect(result.active?.consumers.painDiagnosticReason).toBe('none');
    });
  });

  describe('stale GFI range', () => {
    it('empty stale range when no stale sessions', () => {
      const input: GfiReadModelInput = {
        sessions: [makeSession({ sessionId: 's_1', currentGfi: 50, lastActivityAt: nowMs })],
        nowMs: nowMs + 1000,
      };

      const result = buildGfiWorkspaceSnapshot(input);

      expect(result.staleGfiRange).toBeNull();
    });

    it('stale range with single session', () => {
      const twoHoursAgo = nowMs - 2 * 60 * 60 * 1000;
      const input: GfiReadModelInput = {
        sessions: [makeSession({ sessionId: 's_1', currentGfi: 45, lastActivityAt: twoHoursAgo })],
        nowMs: nowMs + 1000,
      };

      const result = buildGfiWorkspaceSnapshot(input);

      expect(result.staleGfiRange).toEqual({ min: 45, max: 45 });
    });
  });

  describe('generatedAt', () => {
    it('includes ISO timestamp', () => {
      const input: GfiReadModelInput = {
        sessions: [],
        nowMs: nowMs + 1000,
      };

      const result = buildGfiWorkspaceSnapshot(input);

      expect(result.generatedAt).toBeDefined();
      expect(new Date(result.generatedAt).toISOString()).toBe(result.generatedAt);
    });
  });
});
