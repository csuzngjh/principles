import {
  RUNTIME_V2_PRINCIPLE_BUDGET,
  computeFeatureFlagsFromConfig,
  trimToBudget,
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
 */
export async function buildLivePromptInjectionProjection(input: {
  workspaceDir: string;
  excludePrincipleIds?: ReadonlySet<string>;
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
    };
  }
  const trimmed = trimToBudget(principles, RUNTIME_V2_PRINCIPLE_BUDGET, escapeXml);
  const injected = principles.filter((p) => trimmed.injectedIds.has(p.principleId));
  return {
    route: 'legacy_trim',
    budget: RUNTIME_V2_PRINCIPLE_BUDGET,
    usedChars: trimmed.lines.join('\n').length,
    truncated: trimmed.truncated,
    injectedPrincipleIds: [...trimmed.injectedIds],
    injectedActivationIds: injected.map((p) => p.activationId),
    warnings,
  };
}
