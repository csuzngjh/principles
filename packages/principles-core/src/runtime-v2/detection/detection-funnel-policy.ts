/**
 * Detection Funnel Policy — PRI-446 (migrated from the plugin adapter)
 *
 * Pure three-layer detection funnel logic:
 *   L1 — exact dictionary match (sync, delegated via injected matchFn)
 *   L2 — LRU cache of prior L3 resolutions (sync)
 *   L3 — async semantic queue (caller drains via flushQueue + updateCache)
 *
 * This module is fully pure: no I/O, no crypto, no plugin imports. The two
 * environment-coupled dependencies — the dictionary matcher and the text hasher —
 * are injected, so core owns the funnel *logic* while the plugin owns the
 * concrete crypto.createHash and the PainDictionary.
 *
 * The plugin-side detection-funnel.ts is now a thin shell that wires
 * DetectionFunnelCore with crypto + dictionary and re-exports the DetectionFunnel
 * name, so DetectionService and evolution-worker keep working unchanged.
 *
 * ERR checklist:
 * - ERR-001: no `as` casts; cache reads validated.
 * - ERR-002: results carry structured source + severity.
 * - EP-01: queue is bounded.
 */

// ── Result + dependency contracts ───────────────────────────────────────────

export interface DetectionResult {
  detected: boolean;
  severity?: number;
  ruleId?: string;
  source: 'l1_exact' | 'l2_cache' | 'l3_async_queued' | 'l3_semantic_hit';
}

/** A matched pain rule (subset of PainDictionary's match return). */
export interface PainMatchResult {
  ruleId: string;
  severity: number;
}

/**
 * Matcher contract injected by the plugin (backed by PainDictionary).
 * Returns the matched rule + severity for L1 exact matching, or undefined.
 */
export type PainMatcher = (text: string) => PainMatchResult | undefined;

/**
 * Hash function injected by the plugin (backed by crypto.createHash).
 * Used for L2 cache keys.
 */
export type TextHasher = (text: string) => string;

/**
 * Predicate injected by the plugin (backed by shouldIgnorePainProtocolText).
 * Returns true for protocol tokens that short-circuit before any layer.
 */
export type ProtocolTokenGate = (text: string) => boolean;

// ── LRU cache ───────────────────────────────────────────────────────────────

/**
 * A simple LRU Cache implementation using Map.
 * Migrated verbatim from the prior plugin detection-funnel.ts.
 */
export class SimpleLRU<K, V> {
  private readonly cache: Map<K, V>;
  private readonly maxSize: number;
  constructor(maxSize = 100) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const item = this.cache.get(key);
    if (item !== undefined) {
      // Refresh: delete and re-insert
      this.cache.delete(key);
      this.cache.set(key, item);
    }
    return item;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Remove the oldest (first) item
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }
}

// ── Funnel configuration ────────────────────────────────────────────────────

export interface DetectionFunnelConfig {
  /** L1 exact-match delegate. */
  match: PainMatcher;
  /** Text hasher for L2 cache keys. */
  hash: TextHasher;
  /** Protocol-token gate that runs before any layer. */
  shouldIgnoreProtocol: ProtocolTokenGate;
  /** L2 cache capacity. Default 100. */
  cacheSize?: number;
  /** L3 async queue capacity. Default 1000. */
  queueCapacity?: number;
}

// ── Funnel ──────────────────────────────────────────────────────────────────

/**
 * Orchestrates the three-layer detection funnel for pain signals.
 *
 * Pure logic: holds only in-memory cache and queue state. All environment
 * coupling (dictionary, crypto) is injected via config.
 */
export class DetectionFunnelCore {
  private readonly cache: SimpleLRU<string, { detected: boolean; severity?: number }>;
  private asyncQueue: string[] = [];
  private readonly match: PainMatcher;
  private readonly hash: TextHasher;
  private readonly shouldIgnoreProtocol: ProtocolTokenGate;
  private readonly queueCapacity: number;

  constructor(config: DetectionFunnelConfig) {
    this.match = config.match;
    this.hash = config.hash;
    this.shouldIgnoreProtocol = config.shouldIgnoreProtocol;
    this.cache = new SimpleLRU<string, { detected: boolean; severity?: number }>(config.cacheSize ?? 100);
    this.queueCapacity = config.queueCapacity ?? 1000;
  }

  /**
   * Detects pain in the given text using L1 (Exact), L2 (Cache), and L3 (Async).
   */
  detect(text: string): DetectionResult {
    if (this.shouldIgnoreProtocol(text)) {
      return { detected: false, source: 'l1_exact' };
    }

    // --- Layer 1: Exact Match (Sync) ---
    const exactMatch = this.match(text);
    if (exactMatch) {
      return {
        detected: true,
        severity: exactMatch.severity,
        ruleId: exactMatch.ruleId,
        source: 'l1_exact',
      };
    }

    // --- Layer 2: LRU Cache (Sync) ---
    const hash = this.hash(text);
    const cached = this.cache.get(hash);
    if (cached) {
      return {
        detected: cached.detected,
        severity: cached.severity,
        source: 'l2_cache',
      };
    }

    // --- Layer 3: Async Semantic Queue ---
    this.enqueueAsync(text);

    return {
      detected: false,
      source: 'l3_async_queued',
    };
  }

  private enqueueAsync(text: string): void {
    if (this.asyncQueue.length < this.queueCapacity) {
      this.asyncQueue.push(text);
    }
    // Worker will pick this up and perform semantic search, then updateCache.
  }

  /**
   * Internal method for the worker to update the cache after a semantic hit.
   */
  updateCache(text: string, result: { detected: boolean; severity?: number }): void {
    const hash = this.hash(text);
    this.cache.set(hash, result);
  }

  /**
   * Retrieves and clears the current asynchronous queue.
   */
  flushQueue(): string[] {
    const queue = [...this.asyncQueue];
    this.asyncQueue = [];
    return queue;
  }
}
