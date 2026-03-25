import { type PainDictionary } from './dictionary.js';
export interface DetectionResult {
    detected: boolean;
    severity?: number;
    ruleId?: string;
    source: 'l1_exact' | 'l2_cache' | 'l3_async_queued' | 'l3_semantic_hit';
}
/**
 * Orchestrates the three-layer detection funnel for pain signals.
 */
export declare class DetectionFunnel {
    private dictionary;
    private cache;
    private asyncQueue;
    constructor(dictionary: PainDictionary);
    /**
     * Detects pain in the given text using L1 (Exact), L2 (Cache), and L3 (Async).
     */
    detect(text: string): DetectionResult;
    private computeHash;
    private enqueueAsync;
    /**
     * Internal method for the worker to update the cache after a semantic hit.
     */
    updateCache(text: string, result: {
        detected: boolean;
        severity?: number;
    }): void;
    /**
     * Retrieves and clears the current asynchronous queue.
     */
    flushQueue(): string[];
}
