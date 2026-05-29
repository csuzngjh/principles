import type { RecommendationKind } from '../../diagnostician-output.js';

export const VALID_RECOMMENDATION_KINDS: ReadonlySet<string> = new Set([
  'principle',
  'rule',
  'implementation',
  'prompt',
  'defer',
]);

export function resolveRecommendationKind(raw: unknown): RecommendationKind {
  if (typeof raw === 'string' && VALID_RECOMMENDATION_KINDS.has(raw)) {
    return raw as RecommendationKind;
  }
  return 'principle';
}
