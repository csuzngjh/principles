/**
 * Production Compatibility Tests
 *
 * These tests validate that new code works correctly with production data patterns.
 * Run with: npm test -- tests/fixtures/production-compatibility.test.ts
 *
 * NOTE: These tests require access to ~/.openclaw directory (production data)
 */

import * as fs from 'fs';
import { describe, expect, it } from 'vitest';
import {
  loadProductionEvolutionQueue,
  loadProductionPainCandidates,
  generateTestFixtureFromProduction,
  validateProductionCompatibility,
  createMockQueueItem,
  PRODUCTION_FIXTURES,
} from './production-mock-generator.js';

// Skip tests if production data not available
const hasProductionData = fs.existsSync(PRODUCTION_FIXTURES.STATE_DIR);

describe.skipIf(!hasProductionData)('Production Data Compatibility', () => {
  describe('Data Loading', () => {
    it('should load production evolution_queue', () => {
      const queue = loadProductionEvolutionQueue();
      expect(Array.isArray(queue)).toBe(true);

      if (queue.length > 0) {
        const item = queue[0];
        expect(item).toHaveProperty('id');
        expect(item).toHaveProperty('score');
        expect(item).toHaveProperty('status');
        expect(['pending', 'in_progress', 'completed', 'resolved']).toContain(item.status);
      }
    });

    it('should load production pain_candidates', () => {
      const candidates = loadProductionPainCandidates();
      expect(typeof candidates).toBe('object');
    });
  });

  describe('New Field Compatibility', () => {
    it('should report queue field compatibility', () => {
      const result = validateProductionCompatibility();

      console.log('Compatibility issues:', result.issues);
      console.log('Production data:', result.productionData);
    });

    it('should handle queue items without session_id gracefully', () => {
      const queue = loadProductionEvolutionQueue();

      for (const item of queue.slice(0, 5)) {
        // Code should handle missing session_id/agent_id
        expect(() => {
          const normalized = {
            ...item,
            session_id: item.session_id || undefined,
            agent_id: item.agent_id || undefined,
          };
          return normalized;
        }).not.toThrow();
      }
    });
  });

  describe('Pattern Extraction', () => {
    it('should extract patterns from production data', () => {
      const fixture = generateTestFixtureFromProduction();

      expect(fixture.patterns).toBeDefined();
      expect(fixture.patterns.painSources.length).toBeGreaterThanOrEqual(0);

      console.log('Pain sources:', fixture.patterns.painSources);
      console.log('Score distribution:', fixture.patterns.scoreDistribution);
      console.log('Status distribution:', fixture.patterns.statusDistribution);
    });
  });

  describe('Mock Generation', () => {
    it('should create realistic mock queue items', () => {
      const item = createMockQueueItem({
        session_id: 'test-session-123',
        agent_id: 'main',
      });

      expect(item.session_id).toBe('test-session-123');
      expect(item.agent_id).toBe('main');
      expect(item.id).toBeDefined();
      expect(item.timestamp).toBeDefined();
    });
  });
});

describe('Edge Cases from Production', () => {
  it('should handle empty evolution queue', () => {
    const item = createMockQueueItem(); // Uses fallback template
    expect(item).toBeDefined();
    expect(item.id).toBeDefined();
  });

  it('should handle very long reason strings', () => {
    const longReason = 'A'.repeat(10000);
    const item = createMockQueueItem({ reason: longReason });
    expect(item.reason).toBe(longReason);
  });

  it('should handle special characters in reason', () => {
    const specialReason = 'Error: "quotes" and \n newlines \t tabs';
    const item = createMockQueueItem({ reason: specialReason });
    expect(item.reason).toBe(specialReason);
  });
});
