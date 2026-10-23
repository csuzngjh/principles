import type { ArtificerTrustedFactsPort } from '@principles/core/runtime-v2';
import { describeCodexRuleContextFact } from './design-gate-facts.js';

/**
 * Codex generation can author rules against the same DesignGateFact schema
 * that the native PreToolUse provider supplies. This declares capability only;
 * it never resolves the current generated PI task as approved.
 */
export function createCodexArtificerTrustedFactsPort(): ArtificerTrustedFactsPort {
  return {
    resolveRequiredFact: ({ factKind }) => ({
      resolution: 'unknown',
      detail: factKind === 'design_approval'
        ? 'Generation verifies host fact capability; current task approval is resolved only at native PreToolUse.'
        : `Codex has no trusted source for required fact '${factKind}'.`,
    }),
    describeRequiredFact: describeCodexRuleContextFact,
  };
}
