/**
 * Pain Adapter Conformance Test Factory
 *
 * Validates that a PainSignalAdapter<TRawEvent> implementation satisfies
 * the interface contract.
 *
 * Usage:
 *   import { describePainAdapterConformance } from './pain-adapter-conformance.js';
 *   import { OpenClawPainAdapter } from '../../src/adapters/coding/openclaw-pain-adapter.js';
 *
 *   describePainAdapterConformance('OpenClawPainAdapter', () => new OpenClawPainAdapter(), {
 *     validFailureEvent: { toolName: 'write', error: 'ENOENT' },
 *     nonFailureEvent: { toolName: 'read', result: 'data' },
 *     malformedEvent: { error: 'has error but no toolName' } as any,
 *     domain: 'coding',
 *   });
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { PainSignalAdapter } from '../../src/pain-signal-adapter.js';
import { validatePainSignal } from '../../src/pain-signal.js';

export interface PainAdapterFixtures<T> {
  /** Event that should produce a valid PainSignal (failure scenario) */
  validFailureEvent: T;
  /** Event that should return null (non-failure, clean scenario) */
  nonFailureEvent: T;
  /** Malformed event that should return null */
  malformedEvent: T;
  /** Expected domain string */
  domain: string;
}

export type PainAdapterFactory<T> = () => PainSignalAdapter<T>;

/**
 * Conformance test suite for PainSignalAdapter implementations.
 *
 * Validates:
 * 1. returns null for non-failure event
 * 2. returns null for malformed event
 * 3. returns valid PainSignal for failure event
 * 4. output passes validatePainSignal()
 * 5. domain field is set correctly
 * 6. severity is derived from score
 * 7. context preserves relevant fields
 * 8. source field is set appropriately
 */
export function describePainAdapterConformance<T>(
  name: string,
  factory: PainAdapterFactory<T>,
  fixtures: PainAdapterFixtures<T>,
): void {
  describe(`Pain Adapter Conformance: ${name}`, () => {
    let adapter: PainSignalAdapter<T>;

    beforeEach(() => {
      adapter = factory();
    });

    // 1. Non-failure: returns null
    it('returns null for non-failure event', () => {
      const result = adapter.capture(fixtures.nonFailureEvent);
      expect(result).toBeNull();
    });

    // 2. Malformed: returns null
    it('returns null for malformed event', () => {
      const result = adapter.capture(fixtures.malformedEvent);
      expect(result).toBeNull();
    });

    // 3. Failure: returns valid PainSignal
    it('returns valid PainSignal for failure event', () => {
      const result = adapter.capture(fixtures.validFailureEvent);
      expect(result).not.toBeNull();
    });

    // 4. Output passes validatePainSignal
    it('output passes validatePainSignal()', () => {
      const result = adapter.capture(fixtures.validFailureEvent);
      expect(result).not.toBeNull();
      const validation = validatePainSignal(result);
      expect(validation.valid).toBe(true);
    });

    // 5. Domain is set correctly
    it('sets PainSignal.domain to the expected domain', () => {
      const result = adapter.capture(fixtures.validFailureEvent);
      expect(result!.domain).toBe(fixtures.domain);
    });

    // 6. Severity is derived from score
    it('derives severity from score (severity field is present)', () => {
      const result = adapter.capture(fixtures.validFailureEvent);
      expect(result!.severity).toMatch(/^(low|medium|high|critical)$/);
    });

    // 7. Context preserves relevant fields
    it('includes context in PainSignal', () => {
      const result = adapter.capture(fixtures.validFailureEvent);
      expect(result!.context).toBeDefined();
      expect(typeof result!.context).toBe('object');
    });

    // 8. Source field is set
    it('sets PainSignal.source to a non-empty string', () => {
      const result = adapter.capture(fixtures.validFailureEvent);
      expect(typeof result!.source).toBe('string');
      expect(result!.source.length).toBeGreaterThan(0);
    });

    // 9. Timestamp is present and valid ISO string
    it('sets PainSignal.timestamp to a valid ISO string', () => {
      const result = adapter.capture(fixtures.validFailureEvent);
      expect(result!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    // 10. sessionId is present
    it('sets PainSignal.sessionId', () => {
      const result = adapter.capture(fixtures.validFailureEvent);
      expect(result!.sessionId).toBeDefined();
    });
  });
}
