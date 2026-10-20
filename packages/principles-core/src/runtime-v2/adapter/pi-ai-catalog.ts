/**
 * PRI-621 PR2 review: single owner of "which providers are in the pi-ai
 * builtin catalog". Exported as a core capability so cross-package callers
 * (pd-cli baseUrl validation) query it instead of importing pi-ai directly
 * (EP-06: a package declares the runtime deps it imports; the CLI only
 * declares @principles/core).
 */
import { getModels, getProviders } from '@earendil-works/pi-ai/compat';
import type { PromptModelCatalog, PromptModelCatalogEntry } from '../activation/prompt-budget-policy.js';

/**
 * Provider ids in the pi-ai builtin static catalog. 0.84 semantics: dynamic
 * providers registered at runtime are NOT part of this list.
 */
export function builtinPiAiProviderIds(): readonly string[] {
  return getProviders();
}

export function isBuiltinPiAiProvider(provider: string): boolean {
  return builtinPiAiProviderIds().includes(provider);
}

/**
 * SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001: the production PromptModelCatalog
 * binding over the installed pi-ai 1.2.0 static catalog (verified in-repo:
 * pure synchronous generated-JSON reads — no network, no refresh).
 *
 * The by-modelId index is built once and memoized: the generated catalog is
 * immutable at runtime, and the prompt hook must stay O(1)-ish per build.
 * Entries are validated through the policy's plausibility guard at the
 * consumer (`resolvePromptBudget`), so a malformed generated entry degrades
 * to the fallback budget instead of poisoning the injection.
 */
let promptModelCatalogMemo: PromptModelCatalog | undefined;

export function getPromptModelCatalog(): PromptModelCatalog {
  if (promptModelCatalogMemo !== undefined) return promptModelCatalogMemo;
  const byModelIdIndex = new Map<string, PromptModelCatalogEntry[]>();
  for (const provider of getProviders()) {
    // Runtime provider/model strings cannot satisfy the generated literal
    // generics of the catalog getters (same tradeoff as
    // l2-agent-loop-adapter's resolveL2Model); the results are re-validated
    // by the budget policy, never trusted blind (rc-1/rc-2).
    const models = getModels(provider as never);
    for (const model of models) {
      const entry: PromptModelCatalogEntry = {
        provider,
        modelId: model.id,
        contextWindowTokens: model.contextWindow,
      };
      const bucket = byModelIdIndex.get(model.id);
      if (bucket) bucket.push(entry);
      else byModelIdIndex.set(model.id, [entry]);
    }
  }
  promptModelCatalogMemo = {
    exact(providerId, modelId) {
      // getModel is the same generated-table read as the index; go through
      // the index so `exact` and `byModelId` can never disagree.
      return byModelIdIndex
        .get(modelId)
        ?.find((entry) => entry.provider === providerId);
    },
    byModelId(modelId) {
      return byModelIdIndex.get(modelId) ?? [];
    },
  };
  return promptModelCatalogMemo;
}
