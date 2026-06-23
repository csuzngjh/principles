/**
 * Detection Funnel — PRI-446 thin adapter
 *
 * The pure three-layer funnel logic (LRU cache, async queue, layer dispatch)
 * now lives in principles-core
 * (runtime-v2/detection/detection-funnel-policy.ts). This file is a thin shell
 * that wires DetectionFunnelCore with the two environment-coupled dependencies
 * the plugin owns:
 *   - crypto.createHash (the L2 cache key hasher)
 *   - PainDictionary.match (the L1 exact matcher)
 *   - shouldIgnorePainProtocolText (the protocol-token gate)
 *
 * It re-exports DetectionFunnel (same class name + constructor signature) and
 * DetectionResult so DetectionService, llm.ts, and evolution-worker keep working
 * unchanged.
 *
 * ERR checklist:
 * - ERR-011: this is a thin adapter delegating to core pure logic.
 */

import { createHash } from 'crypto';
import { shouldIgnorePainProtocolText, type PainDictionary } from './dictionary.js';
import {
  DetectionFunnelCore,
  type DetectionResult,
} from '@principles/core/runtime-v2';

export type { DetectionResult };

/**
 * Orchestrates the three-layer detection funnel for pain signals.
 *
 * Delegates to the core DetectionFunnelCore, injecting the crypto hasher,
 * the dictionary matcher, and the protocol-token gate.
 */
export class DetectionFunnel {
  private readonly core: DetectionFunnelCore;

  constructor(dictionary: PainDictionary) {
    this.core = new DetectionFunnelCore({
      match: (text) => dictionary.match(text),
      hash: (text) => createHash('sha256').update(text).digest('hex'),
      shouldIgnoreProtocol: shouldIgnorePainProtocolText,
    });
  }

  /**
   * Detects pain in the given text using L1 (Exact), L2 (Cache), and L3 (Async).
   */
  detect(text: string): DetectionResult {
    return this.core.detect(text);
  }

  /**
   * Internal method for the worker to update the cache after a semantic hit.
   */
  updateCache(text: string, result: { detected: boolean; severity?: number }): void {
    this.core.updateCache(text, result);
  }

  /**
   * Retrieves and clears the current asynchronous queue.
   */
  flushQueue(): string[] {
    return this.core.flushQueue();
  }
}
