import {
  RUNTIME_V2_PRINCIPLE_BUDGET,
  computeFeatureFlagsFromConfig,
  trimToBudget,
  type ActivatedPrinciple,
  type PromptSelectionPolicy,
} from '@principles/core/runtime-v2';
import { escapeXml } from '@principles/core/prompt-builder';
import { loadPdConfigForPlugin } from './pd-config.js';
import { buildActivePrinciplePromptContext, readPromptActivationCandidates } from './active-principle-prompt.js';

export interface PromptInjectionProjection {
  /** Which real injection route the workspace is on (abstraction_layer_v1 flag). */
  route: 'legacy_trim' | 'shared_render';
  budget: number;
  /**
   * Char count the REAL prompt path would consume: legacy route counts the
   * trimToBudget lines joined as injected content (the render wrapper does
   * NOT consume budget on that route); shared route counts the rendered
   * directive context in full.
   */
  usedChars: number;
  truncated: boolean;
  injectedPrincipleIds: string[];
  injectedActivationIds: string[];
  warnings: string[];
  /**
   * PRI-935: the budget-packing policy that produced THIS projection
   * (`legacy_fifo_prefix_v1` | `fair_rotation_v1`). The console must not
   * describe a fair-rotation workspace in FIFO terms, so the policy travels
   * with the projection instead of being re-derived by each consumer.
   */
  selectionPolicy: PromptSelectionPolicy;
  /**
   * PRI-935: activations that the production route will inject under SOME
   * round key, i.e. activations that are merely rotated out of the current
   * window rather than structurally starved.
   *
   * Reachability is a property of the SELECTION POLICY, not of any single
   * round: a fair-rotation workspace reaches every non-oversized eligible
   * entry within N turns. So this is computed under the production policy
   * (fair rotation whenever the route actually rotates) and is therefore
   * non-empty even for a caller that supplied no round key — which is
   * exactly the console's situation. Empty only when the production route
   * genuinely does not rotate (shared route) or nothing is eligible.
   */
  eventuallyInjectedActivationIds: string[];
  /** Number of eligible candidates that reached the selector. */
  eligibleCount: number;
  /**
   * PRI-935: whether the PRODUCTION route for this workspace rotates.
   * The forecast's own `selectionPolicy` answers "which policy did THIS
   * projection run", which is legacy for a console that holds no session
   * round key; this answers "will the agent's real injection rotate",
   * which is what determines whether an out-of-window activation is queued
   * or starved. They differ exactly in the case this whole fix is about.
   */
  productionRotates: boolean;
}

/**
 * PRI-935: which activations a fair-rotation selector injects across the
 * whole ring. The plugin's round key advances by one per recorded user turn
 * within a continuously advancing session, so N consecutive turns cover all
 * N ring positions: an activation absent from the current window but present
 * in ANY round is reachable, not starved.
 *
 * Kept here (not in the console) so the production selector's own arithmetic
 * stays the single authority for what "reachable" means.
 */
function collectReachableActivationIds(
  principles: ActivatedPrinciple[],
  budget: number,
): string[] {
  const reachable = new Set<string>();
  for (let roundKey = 0; roundKey < principles.length; roundKey += 1) {
    const result = trimToBudget(principles, budget, escapeXml, roundKey);
    for (const principleId of result.injectedIds) {
      const match = principles.find((p) => p.principleId === principleId);
      if (match) reachable.add(match.activationId);
    }
  }
  return [...reachable];
}

/**
 * PR #1844 follow-up: forecast the prompt-injection budget from the SAME
 * projection the agent injection itself uses, routed by the same
 * `abstraction_layer_v1` flag the OpenClaw plugin's runtime gate reads:
 *
 * - legacy route (live default, flag OFF): activation candidates from
 *   `readPromptActivationCandidates` (same FIFO query + artifact resolve as
 *   the plugin's `PromptActivationReader`) trimmed by the REAL
 *   `trimToBudget` — identical input × ordering × trim logic as
 *   `openclaw-plugin/src/hooks/prompt.ts`.
 * - shared route (flag ON): delegate to `buildActivePrinciplePromptContext`,
 *   which IS the production shared path's projection source.
 *
 * Known conservative gap: the plugin's legacy route additionally dedups
 * candidates against the legacy evolution ledger before trimming; the
 * console cannot replay that reducer read-only, so this projection may
 * forecast slightly MORE consumption than the real injection (never less).
 *
 * PRI-935 — round-key alignment. The plugin derives its fair-rotation round
 * key from the CURRENT session's turn ordinal
 * (`nextSessionTurnOrdinal`), which the console has no access to. Passing no
 * key therefore does NOT make the forecast "more conservative": it selects a
 * DIFFERENT policy (`legacy_fifo_prefix_v1`) than the one production runs, and
 * legacy FIFO structurally excludes the newest activation from every
 * truncated selection. The console must either supply the round key or
 * report the policy honestly, so this function takes the key as an explicit
 * input and exposes `selectionPolicy` on the result.
 */
export async function buildLivePromptInjectionProjection(input: {
  workspaceDir: string;
  excludePrincipleIds?: ReadonlySet<string>;
  /**
   * PRI-935: the fair-rotation round key the production route is using this
   * turn. Callers that hold one (the plugin) pass it; callers that do not
   * (the console) omit it and MUST read `selectionPolicy` off the result
   * rather than assuming FIFO.
   */
  roundKey?: number;
}): Promise<PromptInjectionProjection> {
  const sharedRoute = computeFeatureFlagsFromConfig(
    loadPdConfigForPlugin(input.workspaceDir).effective,
  ).flags.abstraction_layer_v1?.enabled === true;

  if (sharedRoute) {
    const context = await buildActivePrinciplePromptContext(input);
    return {
      route: 'shared_render',
      budget: context.budget,
      usedChars: context.additionalContext.length,
      truncated: context.truncated,
      injectedPrincipleIds: context.principleIds,
      injectedActivationIds: context.activationIds,
      warnings: context.warnings,
      // The shared production path deliberately passes no round key
      // (host-runtime/src/index.ts), so this route genuinely does not rotate
      // and claims nothing about eventual reachability.
      selectionPolicy: context.selectionPolicy ?? 'legacy_fifo_prefix_v1',
      eventuallyInjectedActivationIds: [],
      eligibleCount: context.eligibleCount ?? 0,
      productionRotates: false,
    };
  }

  const candidates = await readPromptActivationCandidates(input);
  const { principles, warnings } = candidates;
  if (candidates.aborted || principles.length === 0) {
    return {
      route: 'legacy_trim',
      budget: RUNTIME_V2_PRINCIPLE_BUDGET,
      usedChars: 0,
      truncated: false,
      injectedPrincipleIds: [],
      injectedActivationIds: [],
      warnings,
      selectionPolicy: 'legacy_fifo_prefix_v1',
      eventuallyInjectedActivationIds: [],
      eligibleCount: 0,
      productionRotates: false,
    };
  }
  // PRI-935: pass the caller's round key so the forecast runs the SAME
  // packing policy production runs this turn.
  const trimmed = trimToBudget(principles, RUNTIME_V2_PRINCIPLE_BUDGET, escapeXml, input.roundKey);
  const injected = principles.filter((p) => trimmed.injectedIds.has(p.principleId));
  // PRI-935: the legacy_trim route IS the OpenClaw plugin-local route, which
  // rotates on every recorded user turn (PRI-904). Reachability is therefore
  // computed under fair rotation regardless of whether THIS forecast holds a
  // round key — a console without a session key must still be able to tell
  // "queued behind rotation" apart from "structurally starved", otherwise it
  // keeps telling the Owner to deactivate healthy principles.
  const eventuallyInjectedActivationIds = collectReachableActivationIds(
    principles,
    RUNTIME_V2_PRINCIPLE_BUDGET,
  );
  return {
    route: 'legacy_trim',
    budget: RUNTIME_V2_PRINCIPLE_BUDGET,
    usedChars: trimmed.lines.join('\n').length,
    truncated: trimmed.truncated,
    injectedPrincipleIds: [...trimmed.injectedIds],
    injectedActivationIds: injected.map((p) => p.activationId),
    warnings,
    selectionPolicy: trimmed.selectionPolicy,
    eventuallyInjectedActivationIds,
    eligibleCount: trimmed.eligibleCount,
    productionRotates: true,
  };
}
