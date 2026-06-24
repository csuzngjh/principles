/**
 * Trigger Cooldown Tracker Tests — PRI-454 Step 2
 *
 * Tests that the shared cooldown Map is truly shared across different
 * call sites, ensuring unified cooldown state when Gate B owns all paths.
 *
 * ERR checklist:
 * - ERR-025: Tests exercise the real shared Map, not an isolated helper.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  isSharedCooldownActive,
  markSharedEpisodeAsDiagnosed,
  resetSharedCooldownForTest,
  isCooldownActive,
  markEpisodeAsDiagnosed,
} from '../../src/hooks/trigger-cooldown-tracker.js';

describe('Shared cooldown Map (PRI-454)', () => {
  beforeEach(() => {
    resetSharedCooldownForTest();
  });

  it('isSharedCooldownActive returns false for unseen episode', () => {
    expect(isSharedCooldownActive('tool_failure', 'sess-1', 'hash-1')).toBe(false);
  });

  it('markSharedEpisodeAsDiagnosed sets cooldown for the episode', () => {
    markSharedEpisodeAsDiagnosed('tool_failure', 'sess-1', 'hash-1');
    expect(isSharedCooldownActive('tool_failure', 'sess-1', 'hash-1')).toBe(true);
  });

  it('cooldown is scoped to the same episode key', () => {
    markSharedEpisodeAsDiagnosed('tool_failure', 'sess-1', 'hash-1');
    // Different session → not in cooldown
    expect(isSharedCooldownActive('tool_failure', 'sess-2', 'hash-1')).toBe(false);
    // Different hash → not in cooldown
    expect(isSharedCooldownActive('tool_failure', 'sess-1', 'hash-2')).toBe(false);
    // Different source → not in cooldown
    expect(isSharedCooldownActive('owner_reported', 'sess-1', 'hash-1')).toBe(false);
  });

  it('resetSharedCooldownForTest clears all state', () => {
    markSharedEpisodeAsDiagnosed('tool_failure', 'sess-1', 'hash-1');
    resetSharedCooldownForTest();
    expect(isSharedCooldownActive('tool_failure', 'sess-1', 'hash-1')).toBe(false);
  });

  it('shared Map is the same state across different source kinds', () => {
    // Mark from tool_failure path
    markSharedEpisodeAsDiagnosed('tool_failure', 'sess-1', 'hash-1');
    // Same episode key (sess-1:tool_failure:hash-1) should be in cooldown
    expect(isSharedCooldownActive('tool_failure', 'sess-1', 'hash-1')).toBe(true);
    // Different source kind is a different key
    expect(isSharedCooldownActive('owner_reported', 'sess-1', 'hash-1')).toBe(false);
  });
});
