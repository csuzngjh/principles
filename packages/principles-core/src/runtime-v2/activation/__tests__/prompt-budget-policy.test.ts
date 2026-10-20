import { describe, it, expect } from 'vitest';
import {
  PROMPT_BUDGET_FALLBACK_CHARS,
  PROMPT_BUDGET_MAX_CHARS,
  PROMPT_BUDGET_MIN_CHARS,
  classifySingleItemBudgetTier,
  isValidContextWindowTokens,
  promptBudgetCharsForContextWindow,
  resolvePromptBudget,
  type PromptModelCatalog,
} from '../prompt-budget-policy.js';
import { getPromptModelCatalog } from '../../adapter/pi-ai-catalog.js';

/** Deterministic fake catalog for the priority/ambiguity matrix. */
function fakeCatalog(entries: { provider: string; modelId: string; contextWindowTokens: number }[]): PromptModelCatalog {
  return {
    exact(providerId, modelId) {
      return entries.find((e) => e.provider === providerId && e.modelId === modelId);
    },
    byModelId(modelId) {
      return entries.filter((e) => e.modelId === modelId);
    },
  };
}

describe('promptBudgetCharsForContextWindow (SPEC §4.2 formula)', () => {
  it('maps the reference table exactly', () => {
    expect(promptBudgetCharsForContextWindow(32_000)).toBe(500);
    expect(promptBudgetCharsForContextWindow(64_000)).toBe(1000);
    expect(promptBudgetCharsForContextWindow(128_000)).toBe(2000);
    expect(promptBudgetCharsForContextWindow(256_000)).toBe(4000);
    expect(promptBudgetCharsForContextWindow(1_000_000)).toBe(4000);
  });

  it('floors below the minimum tier and never exceeds the hard ceiling', () => {
    // 16K would scale to 250 chars — clamped up to the 500 floor.
    expect(promptBudgetCharsForContextWindow(16_384)).toBe(PROMPT_BUDGET_MIN_CHARS);
    // A plausibly-large window would scale far beyond 4000 — clamped down.
    expect(promptBudgetCharsForContextWindow(10_000_000)).toBe(PROMPT_BUDGET_MAX_CHARS);
    // Non-integer scaling floors down: 200K → 3125.
    expect(promptBudgetCharsForContextWindow(200_000)).toBe(3125);
  });

  it('returns the legacy fallback for invalid windows instead of a fake tier', () => {
    for (const invalid of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1023, 100_000_001]) {
      expect(promptBudgetCharsForContextWindow(invalid)).toBe(PROMPT_BUDGET_FALLBACK_CHARS);
    }
  });
});

describe('isValidContextWindowTokens (rc-1/rc-2 runtime validation)', () => {
  it('accepts plausible integer windows', () => {
    expect(isValidContextWindowTokens(1024)).toBe(true);
    expect(isValidContextWindowTokens(128_000)).toBe(true);
    expect(isValidContextWindowTokens(100_000_000)).toBe(true);
  });

  it('rejects zero, negatives, non-integers, non-finite, non-number and out-of-range values', () => {
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '200000', null, undefined, {}, 1023, 100_000_001]) {
      expect(isValidContextWindowTokens(invalid)).toBe(false);
    }
  });
});

describe('classifySingleItemBudgetTier (SPEC §6.3)', () => {
  it('classifies against the supported [min, max] budget range', () => {
    expect(classifySingleItemBudgetTier(0)).toBe('fits_all_tiers');
    expect(classifySingleItemBudgetTier(500)).toBe('fits_all_tiers');
    expect(classifySingleItemBudgetTier(501)).toBe('model_dependent');
    expect(classifySingleItemBudgetTier(2000)).toBe('model_dependent');
    expect(classifySingleItemBudgetTier(4000)).toBe('model_dependent');
    expect(classifySingleItemBudgetTier(4001)).toBe('exceeds_max_tier');
  });
});

describe('resolvePromptBudget priority chain (SPEC §4.3)', () => {
  const catalog = fakeCatalog([
    { provider: 'p1', modelId: 'model-x', contextWindowTokens: 200_000 },
    { provider: 'p2', modelId: 'model-x', contextWindowTokens: 200_000 },
    { provider: 'p3', modelId: 'model-x', contextWindowTokens: 64_000 },
    { provider: 'p1', modelId: 'model-y', contextWindowTokens: 1_000_000 },
  ]);

  it('resolves the legacy fallback when no facts exist at all', () => {
    const result = resolvePromptBudget();
    expect(result).toMatchObject({
      budgetChars: 2000,
      capacitySource: 'legacy_fallback',
      capacityStatus: 'unknown',
      contextWindowTokens: null,
      policyVersion: 'model_aware_v1',
    });
    expect(result.fallbackReason).toContain('host_capacity_absent');
  });

  it('priority 1: a trusted host window wins over everything else', () => {
    const result = resolvePromptBudget({
      hostCapacity: { contextTokenBudget: 256_000, contextWindowSource: 'model' },
      modelIdentity: { providerId: 'p1', modelId: 'model-y' },
      catalog,
    });
    expect(result).toMatchObject({
      budgetChars: 4000,
      capacitySource: 'host_effective_window',
      capacityStatus: 'confirmed',
      contextWindowTokens: 256_000,
    });
  });

  it('trusts every model-specific upstream source (model | modelsConfig | agentContextTokens)', () => {
    for (const source of ['model', 'modelsConfig', 'agentContextTokens']) {
      const result = resolvePromptBudget({
        hostCapacity: { contextTokenBudget: 128_000, contextWindowSource: source },
      });
      expect(result.capacitySource, `source=${source}`).toBe('host_effective_window');
      expect(result.capacityStatus).toBe('confirmed');
    }
  });

  it('source "default" is NOT trusted: falls through to catalog metadata', () => {
    const result = resolvePromptBudget({
      hostCapacity: { contextTokenBudget: 999_999, contextWindowSource: 'default' },
      modelIdentity: { providerId: 'p1', modelId: 'model-x' },
      catalog,
    });
    expect(result.capacitySource).toBe('pi_catalog_exact');
    expect(result.budgetChars).toBe(3125);
  });

  it('unknown/absent host source values are treated as untrusted, not guessed', () => {
    for (const source of ['weird-future-value', undefined, '']) {
      const result = resolvePromptBudget({
        hostCapacity: { contextTokenBudget: 128_000, contextWindowSource: source },
      });
      expect(result.capacitySource, `source=${String(source)}`).toBe('legacy_fallback');
      expect(result.fallbackReason).toContain('host_capacity_source_untrusted');
    }
  });

  it('a trusted source with an invalid value degrades instead of clamping the lie', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = resolvePromptBudget({
        hostCapacity: { contextTokenBudget: bad, contextWindowSource: 'model' },
      });
      expect(result.capacitySource, `value=${String(bad)}`).toBe('legacy_fallback');
      expect(result.fallbackReason).toContain('host_capacity_invalid_value');
    }
  });

  it('priority 2: exact provider+modelId catalog match', () => {
    const result = resolvePromptBudget({
      modelIdentity: { providerId: 'p1', modelId: 'model-y' },
      catalog,
    });
    expect(result).toMatchObject({
      budgetChars: 4000,
      capacitySource: 'pi_catalog_exact',
      capacityStatus: 'confirmed',
      contextWindowTokens: 1_000_000,
    });
  });

  it('priority 3: provider-less lookup only with a unanimous catalog', () => {
    const unanimous = resolvePromptBudget({
      modelIdentity: { modelId: 'model-y' },
      catalog,
    });
    expect(unanimous.capacitySource).toBe('pi_catalog_unambiguous');
    expect(unanimous.contextWindowTokens).toBe(1_000_000);

    const ambiguous = resolvePromptBudget({
      modelIdentity: { modelId: 'model-x' },
      catalog,
    });
    expect(ambiguous.capacitySource).toBe('legacy_fallback');
    expect(ambiguous.fallbackReason).toContain('catalog_ambiguous_model_id');
  });

  it('provider-less lookup with no catalog hits and exact-miss both fall back honestly', () => {
    expect(
      resolvePromptBudget({ modelIdentity: { modelId: 'no-such-model' }, catalog }).fallbackReason,
    ).toContain('catalog_no_match_for_model_id');
    expect(
      resolvePromptBudget({ modelIdentity: { providerId: 'p1', modelId: 'no-such-model' }, catalog }).fallbackReason,
    ).toContain('catalog_no_exact_match');
  });

  it('empty-string identity fields are absent identities, not identities', () => {
    const result = resolvePromptBudget({ modelIdentity: { providerId: '', modelId: '' }, catalog });
    expect(result.capacitySource).toBe('legacy_fallback');
    expect(result.fallbackReason).toContain('model_identity_absent');
  });

  it('without a catalog binding, model identity alone cannot produce a dynamic budget', () => {
    const result = resolvePromptBudget({ modelIdentity: { providerId: 'p1', modelId: 'model-y' } });
    expect(result.capacitySource).toBe('legacy_fallback');
    expect(result.fallbackReason).toContain('catalog_unavailable');
    expect(result.budgetChars).toBe(2000);
  });

  it('invalid catalog metadata degrades rather than poisoning the budget', () => {
    const broken = fakeCatalog([
      { provider: 'p1', modelId: 'model-bad', contextWindowTokens: Number.NaN },
    ]);
    expect(
      resolvePromptBudget({ modelIdentity: { providerId: 'p1', modelId: 'model-bad' }, catalog: broken }).fallbackReason,
    ).toContain('catalog_metadata_invalid');
  });
});

describe('getPromptModelCatalog against the installed pi-ai 1.2.0 catalog', () => {
  it('resolves a real exact provider+model match to its contextWindow', () => {
    const catalog = getPromptModelCatalog();
    const exact = catalog.exact('anthropic', 'claude-sonnet-4-5');
    expect(exact).toBeDefined();
    expect(exact?.contextWindowTokens).toBe(200_000);
    // 200K → floor(2000 × 200000 / 128000) = 3125, under the 4000 ceiling.
    const resolved = resolvePromptBudget({
      modelIdentity: { providerId: 'anthropic', modelId: 'claude-sonnet-4-5' },
      catalog,
    });
    expect(resolved).toMatchObject({
      capacitySource: 'pi_catalog_exact',
      budgetChars: 3125,
      contextWindowTokens: 200_000,
    });
  });

  it('keeps exact() and byModelId() consistent for the same model id', () => {
    const catalog = getPromptModelCatalog();
    const byId = catalog.byModelId('claude-sonnet-4-5');
    expect(byId.length).toBeGreaterThan(1);
    for (const entry of byId) {
      expect(catalog.exact(entry.provider, entry.modelId)?.contextWindowTokens).toBe(entry.contextWindowTokens);
    }
  });

  it('a real conflicting cross-provider id (gpt-5) falls back instead of picking a winner', () => {
    const resolved = resolvePromptBudget({
      modelIdentity: { modelId: 'gpt-5' },
      catalog: getPromptModelCatalog(),
    });
    expect(resolved.capacitySource).toBe('legacy_fallback');
    expect(resolved.fallbackReason).toContain('catalog_ambiguous_model_id:gpt-5');
  });

  it('custom/nonexistent provider ids never inherit another provider capacity (SPEC §2.2)', () => {
    const resolved = resolvePromptBudget({
      modelIdentity: { providerId: 'my-private-proxy', modelId: 'claude-sonnet-4-5' },
      catalog: getPromptModelCatalog(),
    });
    expect(resolved.capacitySource).toBe('legacy_fallback');
    expect(resolved.budgetChars).toBe(2000);
  });
});
