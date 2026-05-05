/**
 * Internalization Routing Policy — Re-exported from @principles/core (PRI-54)
 *
 * Canonical definitions moved to:
 *   packages/principles-core/src/runtime-v2/internalization/routing-policy.ts
 *
 * Types renamed to avoid conflict with InternalizationRouteKind (PRI-43):
 *   InternalizationRoute → LifecycleRoute
 *   InternalizationRouteRecommendation → LifecycleRouteRecommendation
 *   InternalizationRouteEvidenceSummary → LifecycleRouteEvidenceSummary
 *   recommendInternalizationRoute → recommendLifecycleRoute
 */

import type {
  LifecycleRoute,
  LifecycleRouteEvidenceSummary,
  LifecycleRouteRecommendation,
} from '@principles/core/runtime-v2';
import { recommendLifecycleRoute } from '@principles/core/runtime-v2';

export type {
  LifecycleRoute,
  LifecycleRouteEvidenceSummary,
  LifecycleRouteRecommendation,
}
export { recommendLifecycleRoute };

// Backward-compatible aliases (deprecated — use Lifecycle* names)
/** @deprecated Use LifecycleRoute */
export type InternalizationRoute = LifecycleRoute;
/** @deprecated Use LifecycleRouteEvidenceSummary */
export type InternalizationRouteEvidenceSummary = LifecycleRouteEvidenceSummary;
/** @deprecated Use LifecycleRouteRecommendation */
export type InternalizationRouteRecommendation = LifecycleRouteRecommendation;
/** @deprecated Use recommendLifecycleRoute */
export const recommendInternalizationRoute = recommendLifecycleRoute;
