import { describe, it, expect } from 'vitest';
import {
  validateExecutability,
  validateForApproval,
  type BoundedAction,
} from '../../src/core/nocturnal-executability.js';

describe('Nocturnal Executability', () => {

  // -------------------------------------------------------------------------
  // Tests: validateExecutability — valid bounded actions
  // -------------------------------------------------------------------------

  describe('validateExecutability — valid bounded actions', () => {
    it('accepts "Read the file before editing"', () => {
      const result = validateExecutability({
        badDecision: 'Edited a file without reading it first',
        betterDecision: 'Read the file before editing to understand its current structure',
      });
      expect(result.executable).toBe(true);
      expect(result.boundedAction).toBeDefined();
      expect(result.boundedAction?.verb.toLowerCase()).toBe('read');
    });

    it('accepts "Check the error message and verify preconditions"', () => {
      const result = validateExecutability({
        badDecision: 'Retried without checking error',
        betterDecision: 'Check the error message and verify preconditions before retrying',
      });
      expect(result.executable).toBe(true);
      expect(result.boundedAction?.verb.toLowerCase()).toBe('check');
    });

    it('accepts "Verify the current state of the repository"', () => {
      const result = validateExecutability({
        badDecision: 'Committed without checking status',
        betterDecision: 'Verify the current state of the repository before committing',
      });
      expect(result.executable).toBe(true);
      expect(result.boundedAction?.verb.toLowerCase()).toBe('verify');
    });

    it('accepts "Edit the config file to add the missing setting"', () => {
      const result = validateExecutability({
        badDecision: 'Changed settings without knowing current values',
        betterDecision: 'Edit the config file to add the missing setting',
      });
      expect(result.executable).toBe(true);
      expect(result.boundedAction?.verb.toLowerCase()).toBe('edit');
    });

    it('accepts "Search the codebase for similar patterns"', () => {
      const result = validateExecutability({
        badDecision: 'Wrote duplicate code',
        betterDecision: 'Search the codebase for similar patterns before implementing new code',
      });
      expect(result.executable).toBe(true);
      expect(result.boundedAction?.verb.toLowerCase()).toBe('search');
    });

    it('accepts "Look at the file to understand its structure"', () => {
      const result = validateExecutability({
        badDecision: 'Made changes without understanding the code',
        betterDecision: 'Look at the file to understand its structure before modifying it',
      });
      expect(result.executable).toBe(true);
      expect(result.boundedAction?.verb.toLowerCase()).toBe('look');
    });
  });

  // -------------------------------------------------------------------------
  // Tests: validateExecutability — vague verbs
  // -------------------------------------------------------------------------

  describe('validateExecutability — vague verbs', () => {
    const vagueVerbTests = [
      { text: 'Understand the error before proceeding', expectedFail: true },
      { text: 'Learn from the failure and adjust', expectedFail: true },
      { text: 'Improve the error handling approach', expectedFail: true },
      { text: 'Fix the issue by checking preconditions', expectedFail: true }, // "fix" is vague
      { text: 'Handle errors more gracefully', expectedFail: true },
      { text: 'Be more careful with edge cases', expectedFail: true },
      { text: 'Ensure the code is correct', expectedFail: true },
      { text: 'Consider reading the documentation', expectedFail: true },
      { text: 'Think about the root cause', expectedFail: true },
      { text: 'Reflect on the failure', expectedFail: true },
      { text: 'Review the error carefully', expectedFail: true }, // borderline but rejected by our list
    ];

    vagueVerbTests.forEach(({ text, expectedFail }) => {
      it(`"${text}" → ${expectedFail ? 'rejected' : 'accepted'}`, () => {
        const result = validateExecutability({
          badDecision: 'Made a mistake',
          betterDecision: text,
        });
        if (expectedFail) {
          expect(result.executable).toBe(false);
          expect(result.failures.some(f => f.reason.includes('vague verb'))).toBe(true);
        } else {
          expect(result.executable).toBe(true);
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // Tests: validateExecutability — hollow patterns
  // -------------------------------------------------------------------------

  describe('validateExecutability — hollow patterns', () => {
    const hollowTests = [
      { text: 'Always be careful when editing files', expectedFail: true },
      { text: 'Be mindful of potential conflicts', expectedFail: true },
      { text: "Don't rush into making changes", expectedFail: true },
      { text: 'Take your time with complex tasks', expectedFail: true },
      { text: 'Be patient and verify your work', expectedFail: true },
      { text: 'Be more careful next time', expectedFail: true },
      { text: 'Work smarter, not harder', expectedFail: true },
      { text: 'Follow best practices for error handling', expectedFail: true },
      { text: 'Read the documentation before proceeding', expectedFail: false }, // not hollow
    ];

    hollowTests.forEach(({ text, expectedFail }) => {
      it(`"${text}" → ${expectedFail ? 'rejected (hollow)' : 'accepted'}`, () => {
        const result = validateExecutability({
          badDecision: 'Made an error',
          betterDecision: text,
        });
        if (expectedFail) {
          expect(result.executable).toBe(false);
          expect(result.failures.some(f => f.reason.includes('hollow'))).toBe(true);
        } else {
          expect(result.executable).toBe(true);
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // Tests: validateExecutability — too generic
  // -------------------------------------------------------------------------

  describe('validateExecutability — too generic', () => {
    it('rejects text that is too short', () => {
      const result = validateExecutability({
        badDecision: 'Made a mistake',
        betterDecision: 'Be better',
      });
      expect(result.executable).toBe(false);
      expect(result.failures.some(f => f.reason.includes('too generic'))).toBe(true);
    });

    it('rejects purely negative constraints', () => {
      const result = validateExecutability({
        badDecision: 'Did not check the error',
        betterDecision: 'Do not make the same mistake again',
      });
      expect(result.executable).toBe(false);
      expect(result.failures.some(f => f.reason.includes('too generic'))).toBe(true);
    });

    it('accepts a concrete action with target', () => {
      const result = validateExecutability({
        badDecision: 'Edited without reading',
        betterDecision: 'Read src/main.ts to understand the current structure before editing',
      });
      expect(result.executable).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Tests: validateExecutability — non-existent operations
  // -------------------------------------------------------------------------

  describe('validateExecutability — non-existent operations', () => {
    it('rejects "rewrite the entire codebase"', () => {
      const result = validateExecutability({
        badDecision: 'Made changes poorly',
        betterDecision: 'Rewrite the entire codebase to fix the architecture',
      });
      expect(result.executable).toBe(false);
      expect(result.failures.some(f => f.reason.includes('too broad'))).toBe(true);
    });

    it('rejects "redesign the whole system"', () => {
      const result = validateExecutability({
        badDecision: 'System design was flawed',
        betterDecision: 'Redesign the whole system from scratch',
      });
      expect(result.executable).toBe(false);
      expect(result.failures.some(f => f.reason.includes('too broad'))).toBe(true);
    });

    it('rejects "restart from scratch"', () => {
      const result = validateExecutability({
        badDecision: 'Initial approach was wrong',
        betterDecision: 'Restart from scratch with a new plan',
      });
      expect(result.executable).toBe(false);
      expect(result.failures.some(f => f.reason.includes('too broad'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Tests: validateExecutability — badDecision hollow check
  // -------------------------------------------------------------------------

  describe('validateExecutability — badDecision checks', () => {
    it('rejects hollow badDecision pattern', () => {
      const result = validateExecutability({
        badDecision: 'Always be careful and mindful of your actions',
        betterDecision: 'Read the file before editing',
      });
      // The hollow check applies to badDecision too
      expect(result.executable).toBe(false);
      expect(result.failures.some(f => f.field === 'badDecision')).toBe(true);
    });

    it('accepts specific badDecision', () => {
      const result = validateExecutability({
        badDecision: 'Edited a file without reading it first, causing a merge conflict',
        betterDecision: 'Read the file before editing to check for conflicts',
      });
      expect(result.executable).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Tests: validateForApproval — combined arbiter + executability
  // -------------------------------------------------------------------------

  describe('validateForApproval — combined check', () => {
    function makeValidArtifact(overrides: Record<string, unknown> = {}): string {
      return JSON.stringify({
        artifactId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        sessionId: 'session-abc123',
        principleId: 'T-08',
        sourceSnapshotRef: 'snapshot-001',
        badDecision: 'After bash command failed, immediately retried without diagnosing the root cause',
        betterDecision: 'Check the error message and verify preconditions before retrying a failed bash command',
        rationale: 'Treating each failure as a signal to diagnose rather than blindly retry prevents repeated failures and respects the cost of each action',
        createdAt: '2026-03-27T12:00:00.000Z',
        ...overrides,
      });
    }

    it('approves a valid artifact that passes both arbiter and executability', () => {
      const json = makeValidArtifact();
      const result = validateForApproval(json);
      expect(result.approved).toBe(true);
      expect(result.artifact).toBeDefined();
      expect(result.failures).toHaveLength(0);
    });

    it('rejects artifact with invalid JSON', () => {
      const result = validateForApproval('not json');
      expect(result.approved).toBe(false);
      expect(result.failures.some(f => f.includes('parse'))).toBe(true);
    });

    it('rejects artifact with missing principleId', () => {
      const json = makeValidArtifact({ principleId: undefined });
      const result = validateForApproval(json);
      expect(result.approved).toBe(false);
    });

    it('rejects artifact with cross-validation mismatch', () => {
      const json = makeValidArtifact({ principleId: 'T-08' });
      const result = validateForApproval(json, { expectedPrincipleId: 'T-01' });
      expect(result.approved).toBe(false);
      expect(result.failures.some(f => f.includes('mismatch'))).toBe(true);
    });

    it('rejects artifact with vague verb in betterDecision', () => {
      const json = makeValidArtifact({ betterDecision: 'Understand the error first' });
      const result = validateForApproval(json);
      expect(result.approved).toBe(false);
      expect(result.failures.some(f => f.includes('vague verb'))).toBe(true);
    });

    it('rejects artifact with hollow pattern in betterDecision', () => {
      const json = makeValidArtifact({ betterDecision: 'Always be careful when proceeding' });
      const result = validateForApproval(json);
      expect(result.approved).toBe(false);
      expect(result.failures.some(f => f.includes('hollow'))).toBe(true);
    });

    it('rejects artifact with invalid: true', () => {
      const json = makeValidArtifact({ invalid: true, reason: 'no violation found' });
      const result = validateForApproval(json);
      expect(result.approved).toBe(false);
    });

    it('returns boundedAction in approved artifact', () => {
      const json = makeValidArtifact();
      const result = validateForApproval(json);
      expect(result.approved).toBe(true);
      expect(result.artifact?.boundedAction).toBeDefined();
      expect(result.artifact?.boundedAction?.verb.toLowerCase()).toBe('check');
    });

    it('passes when cross-validation matches', () => {
      const json = makeValidArtifact({ principleId: 'T-08', sessionId: 'session-xyz' });
      const result = validateForApproval(json, {
        expectedPrincipleId: 'T-08',
        expectedSessionId: 'session-xyz',
      });
      expect(result.approved).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Tests: bounded action parsing
  // -------------------------------------------------------------------------

  describe('bounded action parsing', () => {
    it('extracts verb and target from "Read the file"', () => {
      const result = validateExecutability({
        badDecision: 'Did not read',
        betterDecision: 'Read the file before proceeding',
      });
      expect(result.executable).toBe(true);
      expect(result.boundedAction?.verb.toLowerCase()).toBe('read');
      // The boundedPattern captures (?:word\s+){0,4} after first word, so target = "file before proceeding"
      expect(result.boundedAction?.target).toBe('file before proceeding');
    });

    it('extracts verb and target from "Check X first"', () => {
      const result = validateExecutability({
        badDecision: 'Did not check',
        betterDecision: 'Check the error message first',
      });
      expect(result.executable).toBe(true);
      expect(result.boundedAction?.verb.toLowerCase()).toBe('check');
      // "Check the error message first" → verb="check", target="error message first"
      expect(result.boundedAction?.target).toBe('error message first');
    });

    it('includes fullText in bounded action', () => {
      const result = validateExecutability({
        badDecision: 'Made a mistake',
        betterDecision: 'Verify the preconditions before running the command',
      });
      expect(result.executable).toBe(true);
      expect(result.boundedAction?.fullText.toLowerCase()).toContain('verify');
    });

    it('returns executable: false without boundedAction when all checks fail', () => {
      const result = validateExecutability({
        badDecision: 'Made a mistake',
        betterDecision: 'Be better next time',
      });
      expect(result.executable).toBe(false);
      expect(result.boundedAction).toBeUndefined();
    });
  });
});
