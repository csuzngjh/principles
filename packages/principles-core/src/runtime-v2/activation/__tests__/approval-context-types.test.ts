import { describe, it, expect } from 'vitest';
import {
  mapConfidenceToLabel,
  type ApprovalWithContext,
  type ApprovalListFilter,
  type ApprovalListResult,
  type ApprovalStats,
  type ConfidenceLabel,
} from '../activation-types.js';

describe('mapConfidenceToLabel', () => {
  it('returns "high" for confidence >= 0.8', () => {
    expect(mapConfidenceToLabel(0.8)).toBe('high');
    expect(mapConfidenceToLabel(0.9)).toBe('high');
    expect(mapConfidenceToLabel(1.0)).toBe('high');
  });

  it('returns "medium" for confidence >= 0.5 and < 0.8', () => {
    expect(mapConfidenceToLabel(0.5)).toBe('medium');
    expect(mapConfidenceToLabel(0.6)).toBe('medium');
    expect(mapConfidenceToLabel(0.79)).toBe('medium');
  });

  it('returns "low" for confidence < 0.5', () => {
    expect(mapConfidenceToLabel(0.0)).toBe('low');
    expect(mapConfidenceToLabel(0.49)).toBe('low');
    expect(mapConfidenceToLabel(-0.1)).toBe('low');
  });

  it('returns "medium" for undefined confidence', () => {
    expect(mapConfidenceToLabel(undefined)).toBe('medium');
  });

  it('returns "medium" for null confidence', () => {
    expect(mapConfidenceToLabel(null as unknown as number)).toBe('medium');
  });
});

describe('ApprovalWithContext', () => {
  it('extends ApprovalRecord with context fields', () => {
    const record: ApprovalWithContext = {
      approvalId: 'apr_skill_art-1',
      artifactId: 'art-1',
      channel: 'skill',
      riskLevel: 'medium',
      status: 'pending',
      confidence: 0.85,
      requestedAt: '2026-05-18T00:00:00Z',
      summary: 'A new skill will be activated',
      triggerReason: 'Principle "fail loud" recommends this skill',
      confidenceLabel: 'high',
      confidenceExplanation: 'High confidence based on 12 successful validations',
      effectDescription: 'This skill will monitor tool calls for silent failures',
      rejectionEffect: 'The principle will remain without a skill enforcement mechanism',
    };
    expect(record.summary).toBe('A new skill will be activated');
    expect(record.confidenceLabel).toBe('high');
    expect(record.triggerReason).toBe('Principle "fail loud" recommends this skill');
  });

  it('allows context fields to be optional', () => {
    const record: ApprovalWithContext = {
      approvalId: 'apr_skill_art-1',
      artifactId: 'art-1',
      channel: 'skill',
      riskLevel: 'medium',
      status: 'pending',
      requestedAt: '2026-05-18T00:00:00Z',
      confidenceLabel: 'medium',
    };
    expect(record.summary).toBeUndefined();
    expect(record.triggerReason).toBeUndefined();
    expect(record.confidenceExplanation).toBeUndefined();
    expect(record.effectDescription).toBeUndefined();
    expect(record.rejectionEffect).toBeUndefined();
  });
});

describe('ApprovalStats', () => {
  it('has counts for all 4 statuses', () => {
    const stats: ApprovalStats = {
      pending: 5,
      approved: 10,
      rejected: 2,
      cancelled: 0,
    };
    expect(stats.pending).toBe(5);
    expect(stats.approved).toBe(10);
    expect(stats.rejected).toBe(2);
    expect(stats.cancelled).toBe(0);
  });
});

describe('ApprovalListResult', () => {
  it('contains items, total, and stats', () => {
    const result: ApprovalListResult = {
      items: [],
      total: 0,
      stats: { pending: 0, approved: 0, rejected: 0, cancelled: 0 },
    };
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.stats.pending).toBe(0);
  });
});

describe('ApprovalListFilter', () => {
  it('accepts optional status, channel, page, pageSize', () => {
    const filter: ApprovalListFilter = {
      status: 'pending',
      channel: 'skill',
      page: 2,
      pageSize: 10,
    };
    expect(filter.status).toBe('pending');
    expect(filter.channel).toBe('skill');
    expect(filter.page).toBe(2);
    expect(filter.pageSize).toBe(10);
  });

  it('allows empty filter', () => {
    const filter: ApprovalListFilter = {};
    expect(filter.status).toBeUndefined();
  });
});

describe('ConfidenceLabel', () => {
  it('accepts only high, medium, or low', () => {
    const labels: ConfidenceLabel[] = ['high', 'medium', 'low'];
    expect(labels).toHaveLength(3);
    expect(labels).toContain('high');
    expect(labels).toContain('medium');
    expect(labels).toContain('low');
  });
});
