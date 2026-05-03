/**
 * Internalization Route Model — Maps recommendation kinds to pipeline routes
 *
 * PURPOSE: Pure, deterministic mapping from DiagnosticianRecommendation kinds
 * to internalization pipeline routes. No I/O, no filesystem, no side effects.
 *
 * ROUTES:
 *   principle-ledger          — wisdom/principle write path
 *   rule-candidate            — rule compilation pipeline (requires trigger + action)
 *   implementation-candidate  — code implementation pipeline
 *   prompt-injection-candidate — prompt/skill injection pipeline
 *   deferred                  — intentionally skipped, never enters executable pipeline
 */

import type { DiagnosticianRecommendation, RecommendationKind } from '../diagnostician-output.js';

// ── Route kinds ─────────────────────────────────────────────────────────────

export type InternalizationRouteKind =
  | 'principle-ledger'
  | 'rule-candidate'
  | 'implementation-candidate'
  | 'prompt-injection-candidate'
  | 'deferred';

// ── Decision output ─────────────────────────────────────────────────────────

export interface InternalizationRouteDecision {
  /** Whether this recommendation can enter its next internalization pipeline */
  ready: boolean;
  route: InternalizationRouteKind;
  missingFields: string[];
  reason: string;
  nextAction: string;
}

// ── Canonical kind-to-route mapping ─────────────────────────────────────────

const KIND_ROUTE_MAP: Record<RecommendationKind, InternalizationRouteKind> = {
  principle: 'principle-ledger',
  rule: 'rule-candidate',
  implementation: 'implementation-candidate',
  prompt: 'prompt-injection-candidate',
  defer: 'deferred',
};

// ── Pure decision function ──────────────────────────────────────────────────

export function decideInternalizationRoute(
  recommendation: DiagnosticianRecommendation,
): InternalizationRouteDecision {
  const route = KIND_ROUTE_MAP[recommendation.kind] ?? 'deferred';

  // Handle unknown/invalid kinds
  if (route === 'deferred' && recommendation.kind !== 'defer') {
    return {
      ready: false,
      route: 'deferred',
      missingFields: [],
      reason: `Unrecognized recommendation kind "${recommendation.kind}" — deferred to safe default.`,
      nextAction: 'Review diagnostician output for unsupported recommendation kind.',
    };
  }

  // defer: always not ready, intentionally skips pipeline
  if (recommendation.kind === 'defer') {
    return {
      ready: false,
      route: 'deferred',
      missingFields: [],
      reason: 'Recommendation explicitly deferred — no internalization action required.',
      nextAction: 'No action needed. Re-evaluate if context changes.',
    };
  }

  // principle: requires abstractedPrinciple
  if (recommendation.kind === 'principle') {
    const missingFields: string[] = [];
    if (!recommendation.abstractedPrinciple) {
      missingFields.push('abstractedPrinciple');
    }
    return {
      ready: missingFields.length === 0,
      route: 'principle-ledger',
      missingFields,
      reason: missingFields.length > 0
        ? `Principle recommendation incomplete: missing ${missingFields.join(', ')}.`
        : 'Principle recommendation ready for ledger write path.',
      nextAction: missingFields.length > 0
        ? 'Re-run diagnostician with PHASE 4 taxonomy to generate abstractedPrinciple.'
        : 'Proceed with principle-ledger intake.',
    };
  }

  // rule: requires triggerPattern + action
  if (recommendation.kind === 'rule') {
    const missingFields: string[] = [];
    if (!recommendation.triggerPattern) {
      missingFields.push('triggerPattern');
    }
    if (!recommendation.action) {
      missingFields.push('action');
    }
    return {
      ready: missingFields.length === 0,
      route: 'rule-candidate',
      missingFields,
      reason: missingFields.length > 0
        ? `Rule recommendation incomplete: missing ${missingFields.join(', ')}.`
        : 'Rule recommendation ready for candidate pipeline.',
      nextAction: missingFields.length > 0
        ? 'Re-run diagnostician with PHASE 4 taxonomy to generate missing rule fields.'
        : 'Proceed with rule-candidate compilation.',
    };
  }

  // implementation: always ready
  if (recommendation.kind === 'implementation') {
    return {
      ready: true,
      route: 'implementation-candidate',
      missingFields: [],
      reason: 'Implementation recommendation ready for candidate pipeline.',
      nextAction: 'Proceed with implementation-candidate intake and compilation.',
    };
  }

  // prompt: always ready
  if (recommendation.kind === 'prompt') {
    return {
      ready: true,
      route: 'prompt-injection-candidate',
      missingFields: [],
      reason: 'Prompt recommendation ready for injection candidate pipeline.',
      nextAction: 'Proceed with prompt-injection-candidate intake.',
    };
  }

  // Exhaustive fallback — TypeScript ensures this is unreachable for valid kinds
  return {
    ready: false,
    route: 'deferred',
    missingFields: [],
    reason: `Unhandled recommendation kind "${recommendation.kind}" — deferred to safe default.`,
    nextAction: 'Review diagnostician output for unsupported recommendation kind.',
  };
}
