/**
 * Detection Funnel Policy Tests — PRI-446
 *
 * Tests the pure core DetectionFunnelCore directly with injected stubs for
 * matcher/hasher/gate (no crypto, no dictionary). The plugin's
 * detection-funnel-characterization.test.ts (10 tests) exercises the same logic
 * through the wired adapter; this file gives core its own direct coverage.
 *
 * ERR checklist:
 * - ERR-025: tests the real DetectionFunnelCore path.
 */

import { describe, it, expect } from 'vitest';
import {
  DetectionFunnelCore,
  SimpleLRU,
  type DetectionFunnelConfig,
} from '../detection-funnel-policy.js';

function makeConfig(overrides: Partial<DetectionFunnelConfig> = {}): DetectionFunnelConfig {
  return {
    match: () => undefined,
    hash: (t) => `hash:${t}`,
    shouldIgnoreProtocol: () => false,
    ...overrides,
  };
}

describe('DetectionFunnelCore: L1 exact', () => {
  it('returns l1_exact with ruleId+severity on match', () => {
    const funnel = new DetectionFunnelCore(makeConfig({
      match: (t) => (t === 'i am confused' ? { ruleId: 'P_CONFUSION_EN', severity: 35 } : undefined),
    }));
    const r = funnel.detect('i am confused');
    expect(r).toEqual({ detected: true, severity: 35, ruleId: 'P_CONFUSION_EN', source: 'l1_exact' });
  });

  it('protocol token gate short-circuits before L1', () => {
    const funnel = new DetectionFunnelCore(makeConfig({
      match: () => ({ ruleId: 'X', severity: 10 }),
      shouldIgnoreProtocol: (t) => t === 'HEARTBEAT_OK',
    }));
    const r = funnel.detect('HEARTBEAT_OK');
    expect(r).toEqual({ detected: false, source: 'l1_exact' });
  });
});

describe('DetectionFunnelCore: L3 async queue', () => {
  it('no match + no cache → l3_async_queued', () => {
    const funnel = new DetectionFunnelCore(makeConfig());
    expect(funnel.detect('unseen')).toEqual({ detected: false, source: 'l3_async_queued' });
  });

  it('flushQueue returns queued texts and clears', () => {
    const funnel = new DetectionFunnelCore(makeConfig());
    funnel.detect('a');
    funnel.detect('b');
    expect(funnel.flushQueue()).toEqual(['a', 'b']);
    expect(funnel.flushQueue()).toEqual([]);
  });
});

describe('DetectionFunnelCore: L2 cache', () => {
  it('updateCache then detect returns l2_cache with stored result', () => {
    const funnel = new DetectionFunnelCore(makeConfig());
    funnel.updateCache('text', { detected: true, severity: 72 });
    const r = funnel.detect('text');
    expect(r.source).toBe('l2_cache');
    expect(r).toMatchObject({ detected: true, severity: 72 });
  });

  it('L1 takes precedence over a poisoned L2 cache', () => {
    const funnel = new DetectionFunnelCore(makeConfig({
      match: (t) => (t === 'x' ? { ruleId: 'R', severity: 35 } : undefined),
    }));
    funnel.updateCache('x', { detected: false });
    const r = funnel.detect('x');
    expect(r.source).toBe('l1_exact');
    expect(r.detected).toBe(true);
  });
});

describe('DetectionFunnelCore: LRU eviction', () => {
  it('evicts oldest beyond capacity', () => {
    const funnel = new DetectionFunnelCore(makeConfig({ cacheSize: 2 }));
    funnel.updateCache('a', { detected: true });
    funnel.updateCache('b', { detected: true });
    funnel.updateCache('c', { detected: true }); // evicts 'a'
    expect(funnel.detect('a').source).toBe('l3_async_queued');
    expect(funnel.detect('c').source).toBe('l2_cache');
  });

  it('refreshes LRU position on get', () => {
    const funnel = new DetectionFunnelCore(makeConfig({ cacheSize: 2 }));
    funnel.updateCache('a', { detected: true });
    funnel.updateCache('b', { detected: true });
    funnel.detect('a'); // refresh 'a' -> now 'b' is oldest
    funnel.updateCache('c', { detected: true }); // evicts 'b'
    expect(funnel.detect('a').source).toBe('l2_cache');
    expect(funnel.detect('b').source).toBe('l3_async_queued');
  });
});

describe('DetectionFunnelCore: queue capacity', () => {
  it('bounds the queue at queueCapacity', () => {
    const funnel = new DetectionFunnelCore(makeConfig({ queueCapacity: 2 }));
    funnel.detect('a');
    funnel.detect('b');
    funnel.detect('c'); // exceeds capacity, dropped
    expect(funnel.flushQueue()).toEqual(['a', 'b']);
  });
});

describe('SimpleLRU', () => {
  it('get returns undefined for missing key', () => {
    const lru = new SimpleLRU<string, number>(10);
    expect(lru.get('missing')).toBeUndefined();
  });

  it('default capacity is 100', () => {
    const lru = new SimpleLRU<string, number>();
    for (let i = 0; i < 150; i++) lru.set(`k${i}`, i);
    expect(lru.get('k0')).toBeUndefined(); // evicted
    expect(lru.get('k149')).toBe(149);
  });
});
