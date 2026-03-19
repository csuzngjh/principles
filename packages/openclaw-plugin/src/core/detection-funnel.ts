import { createHash } from 'crypto';
import { shouldIgnorePainProtocolText, type PainDictionary } from './dictionary.js';

export interface DetectionResult {
    detected: boolean;
    severity?: number;
    ruleId?: string;
    source: 'l1_exact' | 'l2_cache' | 'l3_async_queued' | 'l3_semantic_hit';
}

/**
 * A simple LRU Cache implementation using Map.
 */
class SimpleLRU<K, V> {
    private cache: Map<K, V>;
    constructor(private maxSize: number = 100) {
        this.cache = new Map();
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

/**
 * Orchestrates the three-layer detection funnel for pain signals.
 */
export class DetectionFunnel {
    private cache = new SimpleLRU<string, { detected: boolean; severity?: number }>(100);
    private asyncQueue: string[] = [];

    constructor(private dictionary: PainDictionary) {}

    /**
     * Detects pain in the given text using L1 (Exact), L2 (Cache), and L3 (Async).
     */
    detect(text: string): DetectionResult {
        if (shouldIgnorePainProtocolText(text)) {
            return { detected: false, source: 'l1_exact' };
        }

        // --- Layer 1: Exact Match (Sync) ---
        const exactMatch = this.dictionary.match(text);
        if (exactMatch) {
            return {
                detected: true,
                severity: exactMatch.severity,
                ruleId: exactMatch.ruleId,
                source: 'l1_exact'
            };
        }

        // --- Layer 2: LRU Cache (Sync) ---
        const hash = this.computeHash(text);
        const cached = this.cache.get(hash);
        if (cached) {
            return {
                detected: cached.detected,
                severity: cached.severity,
                source: 'l2_cache'
            };
        }

        // --- Layer 3: Async Semantic Queue ---
        this.enqueueAsync(text);
        
        return {
            detected: false,
            source: 'l3_async_queued'
        };
    }

    private computeHash(text: string): string {
        return createHash('sha256').update(text).digest('hex');
    }

    private enqueueAsync(text: string): void {
        if (this.asyncQueue.length < 1000) {
            this.asyncQueue.push(text);
        }
        // Worker will pick this up and perform semantic search via createMemorySearchTool
    }

    /**
     * Internal method for the worker to update the cache after a semantic hit.
     */
    updateCache(text: string, result: { detected: boolean; severity?: number }): void {
        const hash = this.computeHash(text);
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
