/**
 * DetectionFunnel characterization — PRI-446 Phase 0
 *
 * Locks the observable behavior of DetectionFunnel.detect() BEFORE any logic
 * is migrated to principles-core. After Phase 4 moves the pure funnel logic
 * into core (plugin file becomes a thin adapter delegating to core), this same
 * test must pass unchanged — that is the byte-for-byte equivalence proof.
 *
 * Coverage gap this fills: detection-service.test.ts mocks DetectionFunnel
 * entirely, so the L1/L2/L3 decision logic (LRU cache, async queue, source
 * discrimination, severity passthrough) has no behavioral test today.
 *
 * ERR checklist:
 * - ERR-025 (EP-02): tests the real class behavior, not strings/helpers.
 * - ERR-037 (EP-09): fixtures exercise the actual three-layer contract.
 */

import { describe, it, expect } from 'vitest';
import { DetectionFunnel, type DetectionResult } from '../../src/core/detection-funnel.js';
import type { PainDictionary } from '../../src/core/dictionary.js';

// Minimal in-memory PainDictionary that returns a fixed match for given text.
// We avoid the real PainDictionary (which needs fs) — the funnel only calls
// dictionary.match(text), so a stub is sufficient and keeps this a pure-logic test.
function makeDictionary(matches: Record<string, { ruleId: string; severity: number }>): PainDictionary {
  return { match: (text: string) => matches[text] } as unknown as PainDictionary;
}

describe('DetectionFunnel characterization (PRI-446 Phase 0)', () => {
  it('L1: exact dictionary match returns detected=true, source l1_exact, with ruleId+severity', () => {
    const dict = makeDictionary({ 'i am confused': { ruleId: 'P_CONFUSION_EN', severity: 35 } });
    const funnel = new DetectionFunnel(dict);

    const result = funnel.detect('i am confused');

    expect(result).toEqual({
      detected: true,
      severity: 35,
      ruleId: 'P_CONFUSION_EN',
      source: 'l1_exact',
    });
  });

  it('L1 protocol tokens are ignored before any layer (returns detected=false, l1_exact)', () => {
    const dict = makeDictionary({ HEARTBEAT_OK: { ruleId: 'X', severity: 10 } });
    const funnel = new DetectionFunnel(dict);

    // Even though the dictionary "would" match HEARTBEAT_OK, the protocol-token
    // gate (shouldIgnorePainProtocolText) runs first and short-circuits.
    const result = funnel.detect('HEARTBEAT_OK');

    expect(result.detected).toBe(false);
    expect(result.source).toBe('l1_exact');
    expect(result.severity).toBeUndefined();
    expect(result.ruleId).toBeUndefined();
  });

  it('L3: no match and no cache hit → returns detected=false, source l3_async_queued', () => {
    const dict = makeDictionary({}); // matches nothing
    const funnel = new DetectionFunnel(dict);

    const result = funnel.detect('some unseen text with no match');

    expect(result).toEqual({
      detected: false,
      source: 'l3_async_queued',
    });
  });

  it('L2: after updateCache populates the cache, the same text returns source l2_cache', () => {
    const dict = makeDictionary({});
    const funnel = new DetectionFunnel(dict);

    const text = 'queued semantic pain text';
    // First call: no L1 match, no cache → L3 async queue
    expect(funnel.detect(text).source).toBe('l3_async_queued');

    // Worker resolves semantic search and writes cache
    funnel.updateCache(text, { detected: true, severity: 72 });

    // Second call: L1 miss, L2 cache hit
    const result = funnel.detect(text);
    expect(result.source).toBe('l2_cache');
    expect(result.detected).toBe(true);
    expect(result.severity).toBe(72);
    // ruleId is not carried by the cache shape (only detected+severity)
    expect(result.ruleId).toBeUndefined();
  });

  it('L2 cache: a negative updateCache result is honored (detected=false cached)', () => {
    const dict = makeDictionary({});
    const funnel = new DetectionFunnel(dict);

    const text = 'definitely not pain';
    funnel.updateCache(text, { detected: false });

    const result = funnel.detect(text);
    expect(result.source).toBe('l2_cache');
    expect(result.detected).toBe(false);
  });

  it('flushQueue: returns all queued texts since last flush and clears the queue', () => {
    const dict = makeDictionary({});
    const funnel = new DetectionFunnel(dict);

    funnel.detect('text one');
    funnel.detect('text two');
    funnel.detect('text three');

    const queue = funnel.flushQueue();
    expect(queue).toEqual(['text one', 'text two', 'text three']);

    // Second flush is empty (queue was cleared)
    expect(funnel.flushQueue()).toEqual([]);
  });

  it('async queue is bounded: the same text re-queued on each miss (dedup not applied)', () => {
    const dict = makeDictionary({});
    const funnel = new DetectionFunnel(dict);

    funnel.detect('repeat text');
    funnel.detect('repeat text');
    funnel.detect('repeat text');

    // Current behavior: no dedup, text is pushed each L3 miss
    expect(funnel.flushQueue()).toEqual(['repeat text', 'repeat text', 'repeat text']);
  });

  it('L1 takes precedence over L2 cache: a dictionary match wins even if cache disagrees', () => {
    const dict = makeDictionary({ 'i am confused': { ruleId: 'P_CONFUSION_EN', severity: 35 } });
    const funnel = new DetectionFunnel(dict);

    // Poison the cache with a conflicting result
    funnel.updateCache('i am confused', { detected: false });

    // L1 should still win
    const result = funnel.detect('i am confused');
    expect(result.source).toBe('l1_exact');
    expect(result.detected).toBe(true);
    expect(result.severity).toBe(35);
    expect(result.ruleId).toBe('P_CONFUSION_EN');
  });

  it('LRU eviction: cache holds at most 100 entries (oldest evicted)', () => {
    const dict = makeDictionary({});
    const funnel = new DetectionFunnel(dict);

    // Fill 101 distinct texts into the cache
    for (let i = 0; i < 101; i++) {
      funnel.updateCache(`text-${i}`, { detected: true, severity: i });
    }

    // The first entry (text-0) should have been evicted → re-detecting hits L3, not L2
    const evicted = funnel.detect('text-0');
    expect(evicted.source).toBe('l3_async_queued');

    // The last entry (text-100) is still cached
    const kept = funnel.detect('text-100');
    expect(kept.source).toBe('l2_cache');
    expect(kept.detected).toBe(true);
    expect(kept.severity).toBe(100);
  });

  it('detect(): empty/whitespace-only text that is not a protocol token falls through to L3', () => {
    const dict = makeDictionary({});
    const funnel = new DetectionFunnel(dict);

    const result: DetectionResult = funnel.detect('   ');
    // Empty string is NOT ignored by shouldIgnorePainProtocolText (it returns false for empty/whitespace),
    // no L1 match, no cache → L3 queue
    expect(result.detected).toBe(false);
    expect(result.source).toBe('l3_async_queued');
  });
});
