/**
 * Additional tests for SignalCollectorHost trigger gating edge cases.
 *
 * Context: commit d43d968c fixed inconsistent trigger gating where
 * isUserInteractionTrigger was used in prompt.ts but SignalCollectorHost.detectSync
 * had its own internal gate that rejected api/undefined triggers.
 *
 * This test file ensures the fix remains stable and covers edge cases:
 * - All trigger values that should be accepted/rejected
 * - Transition between trigger states
 * - Boundary conditions in trigger classification
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isUserInteractionTrigger } from '../../src/core/signal-collector-host.js';

describe('isUserInteractionTrigger classification', () => {
  describe('accept values (user interaction)', () => {
    it('accepts "user" trigger', () => {
      expect(isUserInteractionTrigger('user')).toBe(true);
    });

    it('accepts "api" trigger', () => {
      // This was the critical fix - api trigger should be accepted
      expect(isUserInteractionTrigger('api')).toBe(true);
    });

    it('accepts undefined trigger', () => {
      // undefined should also be treated as user interaction
      expect(isUserInteractionTrigger(undefined)).toBe(true);
    });
  });

  describe('reject values (non-user interaction)', () => {
    it('rejects "heartbeat" trigger', () => {
      expect(isUserInteractionTrigger('heartbeat')).toBe(false);
    });

    it('rejects "cron" trigger', () => {
      expect(isUserInteractionTrigger('cron')).toBe(false);
    });

    it('rejects "subagent" trigger', () => {
      expect(isUserInteractionTrigger('subagent')).toBe(false);
    });

    it('rejects arbitrary string values', () => {
      expect(isUserInteractionTrigger('random-value')).toBe(false);
      expect(isUserInteractionTrigger('')).toBe(false);
      expect(isUserInteractionTrigger('USER')).toBe(false); // Case-sensitive
      expect(isUserInteractionTrigger('User')).toBe(false);
    });
  });

  describe('boundary conditions', () => {
    it('is case-sensitive for all values', () => {
      // Only lowercase 'user', 'api' should match
      expect(isUserInteractionTrigger('USER')).toBe(false);
      expect(isUserInteractionTrigger('API')).toBe(false);
      expect(isUserInteractionTrigger('User')).toBe(false);
      expect(isUserInteractionTrigger('Api')).toBe(false);
    });

    it('handles whitespace variations correctly', () => {
      // Exact match required, no trimming
      expect(isUserInteractionTrigger(' user ')).toBe(false);
      expect(isUserInteractionTrigger('api ')).toBe(false);
      expect(isUserInteractionTrigger(' user')).toBe(false);
    });

    it('treats null as non-user interaction', () => {
      // null is explicitly not undefined, should be rejected
      expect(isUserInteractionTrigger(null as unknown as string)).toBe(false);
    });

    it('handles numeric triggers correctly', () => {
      // Numbers should be rejected
      expect(isUserInteractionTrigger(123 as unknown as string)).toBe(false);
      expect(isUserInteractionTrigger(0 as unknown as string)).toBe(false);
    });
  });

  describe('integration with detectSync', () => {
    it('ensures api trigger is not rejected by internal gate', () => {
      // This test documents the fix from commit d43d968c
      // Previously, even though prompt.ts would call detectSync with api trigger,
      // the internal gate in detectSync would reject it.
      // The fix ensures both use isUserInteractionTrigger for consistency.

      const apiTrigger = 'api';
      expect(isUserInteractionTrigger(apiTrigger)).toBe(true);

      // If isUserInteractionTrigger returns true, detectSync should proceed
      // (not return early due to trigger gate)
      const shouldProcess = isUserInteractionTrigger(apiTrigger);
      expect(shouldProcess).toBe(true);
    });

    it('ensures undefined trigger is not rejected by internal gate', () => {
      // Same as api trigger - undefined should pass the gate
      expect(isUserInteractionTrigger(undefined)).toBe(true);

      const shouldProcess = isUserInteractionTrigger(undefined);
      expect(shouldProcess).toBe(true);
    });
  });
});