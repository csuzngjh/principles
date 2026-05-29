import { describe, it, expect } from 'vitest';
import { resolveRecommendationKind, VALID_RECOMMENDATION_KINDS } from '../recommendation-kind-resolver.js';

describe('resolveRecommendationKind', () => {
  it('returns valid kinds as-is', () => {
    expect(resolveRecommendationKind('principle')).toBe('principle');
    expect(resolveRecommendationKind('rule')).toBe('rule');
    expect(resolveRecommendationKind('implementation')).toBe('implementation');
    expect(resolveRecommendationKind('prompt')).toBe('prompt');
    expect(resolveRecommendationKind('defer')).toBe('defer');
  });

  it('falls back to principle for strings outside whitelist', () => {
    expect(resolveRecommendationKind('skill')).toBe('principle');
    expect(resolveRecommendationKind('model_training')).toBe('principle');
    expect(resolveRecommendationKind('')).toBe('principle');
    expect(resolveRecommendationKind('PRINCIPLE')).toBe('principle');
  });

  it('falls back to principle for non-string types', () => {
    expect(resolveRecommendationKind(null)).toBe('principle');
    expect(resolveRecommendationKind(undefined)).toBe('principle');
    expect(resolveRecommendationKind(42)).toBe('principle');
    expect(resolveRecommendationKind(true)).toBe('principle');
    expect(resolveRecommendationKind({})).toBe('principle');
    expect(resolveRecommendationKind([])).toBe('principle');
  });

  it('VALID_RECOMMENDATION_KINDS contains exactly the five known kinds', () => {
    expect(VALID_RECOMMENDATION_KINDS.size).toBe(5);
    expect(VALID_RECOMMENDATION_KINDS.has('principle')).toBe(true);
    expect(VALID_RECOMMENDATION_KINDS.has('rule')).toBe(true);
    expect(VALID_RECOMMENDATION_KINDS.has('implementation')).toBe(true);
    expect(VALID_RECOMMENDATION_KINDS.has('prompt')).toBe(true);
    expect(VALID_RECOMMENDATION_KINDS.has('defer')).toBe(true);
  });
});
