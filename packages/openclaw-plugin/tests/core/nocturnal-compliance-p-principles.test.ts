/**
 * Tests for #216: P_* principle violation and opportunity detection
 *
 * Before this fix, detectOpportunity and detectViolation only handled T-01~T-09,
 * causing all P_* principles to return false for both applicable and violated.
 */

import { describe, expect, it } from 'vitest';
import { detectOpportunity, detectViolation } from '../../src/core/nocturnal-compliance.js';
import type { SessionEvents } from '../../src/core/nocturnal-compliance.js';

function makeSession(overrides: Partial<SessionEvents> = {}): SessionEvents {
  return {
    sessionId: 'test-session',
    toolCalls: overrides.toolCalls ?? [],
    painSignals: overrides.painSignals ?? [],
    gateBlocks: overrides.gateBlocks ?? [],
    userCorrections: overrides.userCorrections ?? [],
    planApprovals: overrides.planApprovals ?? [],
  };
}

describe('#216: P_* principle detection', () => {
  describe('detectOpportunity for P_* principles', () => {
    it('returns applicable=true when session has pain signals', () => {
      const session = makeSession({
        painSignals: [{ source: 'tool_failure', score: 80, reason: 'write failed' }],
      });
      const result = detectOpportunity('P_001', session);
      expect(result.applicable).toBe(true);
      expect(result.reason).toContain('pain signal');
    });

    it('returns applicable=true when session has tool failures', () => {
      const session = makeSession({
        toolCalls: [{ toolName: 'write', filePath: 'test.txt', outcome: 'failure', errorMessage: 'disk full' }],
      });
      const result = detectOpportunity('P_042', session);
      expect(result.applicable).toBe(true);
      expect(result.reason).toContain('tool failure');
    });

    it('returns applicable=true when session has gate blocks', () => {
      const session = makeSession({
        gateBlocks: [{ toolName: 'bash', reason: 'high risk operation' }],
      });
      const result = detectOpportunity('P_065', session);
      expect(result.applicable).toBe(true);
      expect(result.reason).toContain('gate block');
    });

    it('returns applicable=false when session has no negative signals', () => {
      const session = makeSession({
        toolCalls: [{ toolName: 'read', filePath: 'test.txt', outcome: 'success' }],
      });
      const result = detectOpportunity('P_001', session);
      expect(result.applicable).toBe(false);
      expect(result.reason).toContain('no pain/tool-failure/gate-block');
    });
  });

  describe('detectViolation for P_* principles', () => {
    it('returns violated=true when session has high pain signals (score >= 50)', () => {
      const session = makeSession({
        painSignals: [{ source: 'tool_failure', score: 80, reason: 'write failed' }],
      });
      const result = detectViolation('P_001', session);
      expect(result.violated).toBe(true);
      expect(result.reason).toContain('pain signal');
    });

    it('returns violated=false when pain signals are low (score < 50)', () => {
      const session = makeSession({
        painSignals: [{ source: 'minor_issue', score: 30, reason: 'cosmetic' }],
        toolCalls: [{ toolName: 'read', filePath: 'test.txt', outcome: 'success' }],
      });
      const result = detectViolation('P_001', session);
      expect(result.violated).toBe(false);
      expect(result.reason).toContain('no violation signals');
    });

    it('returns violated=true when session has tool failures', () => {
      const session = makeSession({
        toolCalls: [
          { toolName: 'write', filePath: 'test.txt', outcome: 'failure', errorMessage: 'disk full' },
        ],
      });
      const result = detectViolation('P_042', session);
      expect(result.violated).toBe(true);
      expect(result.reason).toContain('tool failure');
    });

    it('returns violated=true when session has gate blocks', () => {
      const session = makeSession({
        gateBlocks: [{ toolName: 'bash', reason: 'high risk operation' }],
      });
      const result = detectViolation('P_065', session);
      expect(result.violated).toBe(true);
      expect(result.reason).toContain('gate block');
    });

    it('returns violated=false for clean session with no negative signals', () => {
      const session = makeSession({
        toolCalls: [{ toolName: 'read', filePath: 'test.txt', outcome: 'success' }],
      });
      const result = detectViolation('P_001', session);
      expect(result.violated).toBe(false);
      expect(result.reason).toContain('no violation signals');
    });
  });

  describe('T-* principles still work (regression check)', () => {
    it('T-01 opportunity detected for edit operations', () => {
      const session = makeSession({
        toolCalls: [{ toolName: 'edit_file', filePath: 'test.ts', outcome: 'success' }],
      });
      const result = detectOpportunity('T-01', session);
      expect(result.applicable).toBe(true);
    });

    it('T-01 violation detected when editing without reading first', () => {
      const session = makeSession({
        toolCalls: [
          { toolName: 'edit_file', filePath: 'test.ts', outcome: 'failure', errorMessage: 'merge conflict' },
        ],
        painSignals: [{ source: 'test.ts edit failed', score: 70, reason: 'Did not survey structure before editing' }],
      });
      const result = detectViolation('T-01', session);
      // T-01 violation: edit without prior read, with pain signal matching file or pattern
      expect(result.violated).toBe(true);
    });
  });
});
