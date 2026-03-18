import { describe, expect, it } from 'vitest';
import {
  type Principle,
  type PrincipleStatus,
  type EvolutionLoopEvent,
  type EvolutionLoopEventType,
} from '../../src/core/evolution-types.js';

describe('evolution loop types', () => {
  it('supports principle lifecycle status union', () => {
    const status: PrincipleStatus = 'probation';
    expect(status).toBe('probation');
  });

  it('accepts structured principle schema', () => {
    const principle: Principle = {
      id: 'P_001',
      version: 1,
      text: 'When edit fails, inspect diff before retry.',
      source: {
        painId: 'pain-1',
        painType: 'tool_failure',
        timestamp: new Date().toISOString(),
      },
      trigger: 'edit tool failed',
      action: 'validate file path and retry once',
      contextTags: ['edit'],
      validation: { successCount: 0, conflictCount: 0 },
      status: 'candidate',
      feedbackScore: 0,
      usageCount: 0,
      createdAt: new Date().toISOString(),
    };

    expect(principle.status).toBe('candidate');
  });

  it('supports evolution loop event types', () => {
    const eventType: EvolutionLoopEventType = 'candidate_created';
    const event: EvolutionLoopEvent = {
      ts: new Date().toISOString(),
      type: eventType,
      data: { painId: 'pain-1' },
    };

    expect(event.type).toBe('candidate_created');
  });
});
