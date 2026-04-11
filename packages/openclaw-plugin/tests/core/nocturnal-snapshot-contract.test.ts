import { describe, expect, it } from 'vitest';
import { validateNocturnalSnapshotIngress } from '../../src/core/nocturnal-snapshot-contract.js';

describe('validateNocturnalSnapshotIngress', () => {
  it('accepts a fully shaped runtime snapshot', () => {
    const result = validateNocturnalSnapshotIngress({
      sessionId: 'session-1',
      startedAt: '2026-04-10T00:00:00.000Z',
      updatedAt: '2026-04-10T00:01:00.000Z',
      assistantTurns: [],
      userTurns: [],
      toolCalls: [],
      painEvents: [],
      gateBlocks: [],
      stats: {
        totalAssistantTurns: 1,
        totalToolCalls: 2,
        totalPainEvents: 0,
        totalGateBlocks: 0,
        failureCount: 0,
      },
    });

    expect(result.status).toBe('valid');
    expect(result.snapshot?.sessionId).toBe('session-1');
  });

  it('rejects reduced pseudo-snapshots that omit canonical fields', () => {
    const result = validateNocturnalSnapshotIngress({
      sessionId: 'session-1',
      sessionStart: '2026-04-10T00:00:00.000Z',
      stats: {
        totalAssistantTurns: 1,
        totalToolCalls: 2,
        totalPainEvents: 0,
        totalGateBlocks: 0,
        failureCount: 0,
      },
      recentPain: [],
    });

    expect(result.status).toBe('invalid');
    expect(result.reasons).toContain('snapshot.startedAt must be a non-empty string');
    expect(result.reasons).toContain('snapshot.assistantTurns must be an array');
  });

  it('rejects fallback snapshots with no pain signal', () => {
    const result = validateNocturnalSnapshotIngress({
      sessionId: 'session-1',
      startedAt: '2026-04-10T00:00:00.000Z',
      updatedAt: '2026-04-10T00:00:00.000Z',
      assistantTurns: [],
      userTurns: [],
      toolCalls: [],
      painEvents: [],
      gateBlocks: [],
      stats: {
        totalAssistantTurns: null,
        totalToolCalls: null,
        totalPainEvents: 0,
        totalGateBlocks: null,
        failureCount: null,
      },
      _dataSource: 'pain_context_fallback',
    });

    expect(result.status).toBe('invalid');
    expect(result.reasons).toContain('fallback snapshot must contain at least one pain signal');
  });
});
