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

/** One selectable model in the console's provider picker. Catalog-derived only. */
export interface ProviderModelPreset {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  /** Transport format of this model (`openai-completions`, `anthropic-messages`, …). */
  api: string;
  /** Catalog default endpoint. Shown read-only; never persisted for preset providers. */
  baseUrl: string;
}

export interface ProviderPreset {
  id: string;
  /** Most common transport format for this provider, for display. */
  api: string;
  baseUrl: string;
  models: ProviderModelPreset[];
}

/**
 * Console provider/model presets — a READ-ONLY projection of the installed
 * pi-ai catalog (PRI-1213). There is no second truth: the console never edits
 * provider endpoints or model lists, it only selects from this projection.
 *
 * Providers whose catalog endpoint is a placeholder (`{resource}`, empty) are
 * skipped: they need account/region parameters that "pick a provider + paste a
 * key" cannot express, and they stay reachable through the advanced custom
 * endpoint path.
 */
export function listProviderPresets(): ProviderPreset[] {
  const presets: ProviderPreset[] = [];
  for (const provider of getProviders()) {
    const models = getModels(provider as never);
    if (!Array.isArray(models) || models.length === 0) continue;
    const seenModelIds = new Set<string>();
    const modelPresets: ProviderModelPreset[] = [];
    for (const model of models) {
      if (typeof model?.id !== 'string' || model.id === '') continue;
      if (seenModelIds.has(model.id)) continue;
      const baseUrl = typeof model.baseUrl === 'string' ? model.baseUrl : '';
      // Placeholder endpoints cannot be called without operator-supplied values.
      if (!/^https?:\/\//i.test(baseUrl) || baseUrl.includes('{')) continue;
      seenModelIds.add(model.id);
      modelPresets.push({
        id: model.id,
        name: typeof model.name === 'string' && model.name.trim() !== '' ? model.name : model.id,
        contextWindow: typeof model.contextWindow === 'number' ? model.contextWindow : 0,
        maxTokens: typeof model.maxTokens === 'number' ? model.maxTokens : 0,
        reasoning: model.reasoning === true,
        api: String(model.api),
        baseUrl,
      });
    }
    const [first] = modelPresets;
    if (first === undefined) continue;
    presets.push({
      id: provider,
      api: first.api,
      baseUrl: first.baseUrl,
      models: modelPresets,
    });
  }
  return presets;
}

/** Look up one catalog model, for validation/probe without trusting user input. */
export function findProviderModelPreset(
  provider: string,
  modelId: string,
): ProviderModelPreset | undefined {
  if (!isBuiltinPiAiProvider(provider)) return undefined;
  return (
    listProviderPresets()
      .find((preset) => preset.id === provider)
      ?.models.find((model) => model.id === modelId) ?? undefined
  );
}

/**
 * Public facade exported as `pdProviderCatalog` from `@principles/core/runtime`.
 * The console gets the whole preset surface through ONE admitted symbol.
 */
export const pdProviderCatalog = {
  list: listProviderPresets,
  findModel: findProviderModelPreset,
  providerIds: builtinPiAiProviderIds,
  isBuiltinProvider: isBuiltinPiAiProvider,
} as const;

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

/**
 * PRI-1066 exact-key normalization: host-supplied model ids reach PD as
 * arbitrary strings (hooks, configs, wrappers). Trim + case-fold is a
 * DETERMINISTIC exact-key normalization, not a fuzzy match — it only makes
 * `GLM-5.3-Flash ` and `glm-5.3-flash` resolve to the SAME catalog entry,
 * never to a different model. Provider ids are normalized the same way.
 */
function normalizeCatalogKey(value: string): string {
  return value.trim().toLowerCase();
}

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
      const key = normalizeCatalogKey(model.id);
      const bucket = byModelIdIndex.get(key);
      if (bucket) bucket.push(entry);
      else byModelIdIndex.set(key, [entry]);
    }
  }
  promptModelCatalogMemo = {
    exact(providerId, modelId) {
      // getModel is the same generated-table read as the index; go through
      // the index so `exact` and `byModelId` can never disagree.
      const normalizedProvider = normalizeCatalogKey(providerId);
      return byModelIdIndex
        .get(normalizeCatalogKey(modelId))
        ?.find((entry) => normalizeCatalogKey(entry.provider) === normalizedProvider);
    },
    byModelId(modelId) {
      return byModelIdIndex.get(normalizeCatalogKey(modelId)) ?? [];
    },
  };
  return promptModelCatalogMemo;
}
