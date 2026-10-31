import { describe, it, expect } from 'vitest';
import {
  PROMPT_BUDGET_FALLBACK_CHARS,
  PROMPT_BUDGET_MAX_CHARS,
  PROMPT_BUDGET_MIN_CHARS,
  classifySingleItemBudgetTier,
  isValidContextWindowTokens,
  promptBudgetCharsForContextWindow,
  resolvePromptBudget,
  resolveTotalInjectionBudgetChars,
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

describe('promptBudgetCharsForContextWindow (SPEC §4.2 formula, v0.2 bounds)', () => {
  it('maps the reference table exactly (32K/64K clamp UP to the measured floor)', () => {
    // Raw formula values: 32K→500, 64K→1000 — both below the measured
    // usable floor (1250), so both clamp UP. Below the floor the shared
    // route injects ZERO principles (audited defect).
    expect(promptBudgetCharsForContextWindow(32_000)).toBe(1250);
    expect(promptBudgetCharsForContextWindow(64_000)).toBe(1250);
    expect(promptBudgetCharsForContextWindow(128_000)).toBe(2000);
    expect(promptBudgetCharsForContextWindow(256_000)).toBe(4000);
    // 1M maps to floor(2000 × 1_000_000 / 128_000) = 15625 — the 16000 cap
    // is an upper bound, not a value the formula must reach.
    expect(promptBudgetCharsForContextWindow(1_000_000)).toBe(15625);
    // The cap is reached only at ≥ 1.024M tokens.
    expect(promptBudgetCharsForContextWindow(1_024_000)).toBe(16000);
    expect(promptBudgetCharsForContextWindow(2_000_000)).toBe(16000);
  });

  it('floors below the minimum tier and never exceeds the hard ceiling', () => {
    // 16K would scale to 250 chars — clamped up to the 1250 floor.
    expect(promptBudgetCharsForContextWindow(16_384)).toBe(PROMPT_BUDGET_MIN_CHARS);
    // A plausibly-large window would scale far beyond 16000 — clamped down.
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

describe('classifySingleItemBudgetTier (SPEC §6.3, v0.2 bounds)', () => {
  it('classifies against the supported [1250, 16000] budget range', () => {
    expect(classifySingleItemBudgetTier(0)).toBe('fits_all_tiers');
    expect(classifySingleItemBudgetTier(1249)).toBe('fits_all_tiers');
    expect(classifySingleItemBudgetTier(1250)).toBe('fits_all_tiers');
    expect(classifySingleItemBudgetTier(1251)).toBe('model_dependent');
    expect(classifySingleItemBudgetTier(2000)).toBe('model_dependent');
    expect(classifySingleItemBudgetTier(16000)).toBe('model_dependent');
    expect(classifySingleItemBudgetTier(16001)).toBe('exceeds_max_tier');
  });
});

describe('resolvePromptBudget priority chain (SPEC §4.3 v0.2)', () => {
  const catalog = fakeCatalog([
    { provider: 'p1', modelId: 'model-x', contextWindowTokens: 200_000 },
    { provider: 'p2', modelId: 'model-x', contextWindowTokens: 200_000 },
    { provider: 'p3', modelId: 'model-x', contextWindowTokens: 64_000 },
    { provider: 'p1', modelId: 'model-y', contextWindowTokens: 1_000_000 },
  ]);

  it('resolves the legacy fallback with a bounded reason code when no facts exist', () => {
    const result = resolvePromptBudget();
    expect(result).toMatchObject({
      budgetChars: 2000,
      capacitySource: 'legacy_fallback',
      capacityStatus: 'unknown',
      contextWindowTokens: null,
      policyVersion: 'model_aware_v1',
    });
    expect(result.fallbackReason).toBe('host_capacity_absent');
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
    expect(result.fallbackReason).toBeUndefined();
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

  it('unknown/absent host source values are untrusted; the code survives a catalog rescue', () => {
    for (const source of ['weird-future-value', undefined, '']) {
      const result = resolvePromptBudget({
        hostCapacity: { contextTokenBudget: 128_000, contextWindowSource: source },
        modelIdentity: { providerId: 'p1', modelId: 'model-x' },
        catalog,
      });
      // The catalog CAN rescue the budget, but the reported reason stays the
      // host-stage failure (why the trusted window was not used).
      expect(result.capacitySource, `source=${String(source)}`).toBe('pi_catalog_exact');
      expect(result.fallbackReason, `source=${String(source)}`).toBeUndefined();
    }
    // Without a catalog rescue the host-stage reason is the one reported.
    const unrescued = resolvePromptBudget({
      hostCapacity: { contextTokenBudget: 128_000, contextWindowSource: 'weird' },
    });
    expect(unrescued.capacitySource).toBe('legacy_fallback');
    expect(unrescued.fallbackReason).toBe('host_capacity_source_untrusted');
  });

  it('a trusted source with an invalid value degrades instead of clamping the lie', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = resolvePromptBudget({
        hostCapacity: { contextTokenBudget: bad, contextWindowSource: 'model' },
      });
      expect(result.capacitySource, `value=${String(bad)}`).toBe('legacy_fallback');
      expect(result.fallbackReason).toBe('host_capacity_invalid_value');
    }
  });

  it('priority 2: exact provider+modelId catalog match (host-declared provider)', () => {
    const result = resolvePromptBudget({
      modelIdentity: { providerId: 'p1', modelId: 'model-y' },
      catalog,
    });
    expect(result).toMatchObject({
      budgetChars: 15625,
      capacitySource: 'pi_catalog_exact',
      capacityStatus: 'confirmed',
      contextWindowTokens: 1_000_000,
    });
  });

  it('priority 2 miss: provider declared but absent from the catalog', () => {
    const result = resolvePromptBudget({
      modelIdentity: { providerId: 'p1', modelId: 'no-such-model' },
      catalog,
    });
    expect(result.capacitySource).toBe('legacy_fallback');
    expect(result.fallbackReason).toBe('catalog_no_exact_match');
  });

  it('v0.2 trust amendment: provider-less lookups NEVER confirm — ambiguous names report ambiguity', () => {
    const result = resolvePromptBudget({
      modelIdentity: { modelId: 'model-x' },
      catalog,
    });
    expect(result.capacitySource).toBe('legacy_fallback');
    expect(result.capacityStatus).toBe('unknown');
    expect(result.fallbackReason).toBe('catalog_ambiguous_model_id');
    expect(result.budgetChars).toBe(2000);
  });

  it('provider-less unanimous names STILL fall back (custom-endpoint risk), with their own code', () => {
    const result = resolvePromptBudget({
      modelIdentity: { modelId: 'model-y' },
      catalog,
    });
    expect(result.capacitySource).toBe('legacy_fallback');
    expect(result.fallbackReason).toBe('catalog_provider_absent');
    expect(result.budgetChars).toBe(2000);
  });

  it('provider-less with no catalog hits falls back honestly', () => {
    const result = resolvePromptBudget({ modelIdentity: { modelId: 'no-such-model' }, catalog });
    expect(result.capacitySource).toBe('legacy_fallback');
    expect(result.fallbackReason).toBe('catalog_no_match_for_model_id');
  });

  it('empty-string identity fields are absent identities, not identities (unified absence code)', () => {
    const result = resolvePromptBudget({ modelIdentity: { providerId: '', modelId: '' }, catalog });
    expect(result.capacitySource).toBe('legacy_fallback');
    // An all-empty identity claim carries no usable fact — the resolver
    // reports the root cause (nothing to resolve from), not a catalog error.
    expect(result.fallbackReason).toBe('host_capacity_absent');
  });

  it('without a catalog binding, model identity alone cannot produce a dynamic budget', () => {
    const result = resolvePromptBudget({ modelIdentity: { providerId: 'p1', modelId: 'model-y' } });
    expect(result.capacitySource).toBe('legacy_fallback');
    expect(result.fallbackReason).toBe('catalog_unavailable');
    expect(result.budgetChars).toBe(2000);
  });

  it('invalid catalog metadata degrades rather than poisoning the budget', () => {
    const broken = fakeCatalog([
      { provider: 'p1', modelId: 'model-bad', contextWindowTokens: Number.NaN },
    ]);
    expect(
      resolvePromptBudget({ modelIdentity: { providerId: 'p1', modelId: 'model-bad' }, catalog: broken }).fallbackReason,
    ).toBe('catalog_metadata_invalid');
  });

  it('fallback reasons stay within the closed code set (event-safe)', () => {
    const CODES = new Set([
      'host_capacity_absent', 'host_capacity_source_untrusted', 'host_capacity_invalid_value',
      'catalog_unavailable', 'model_identity_absent', 'catalog_no_exact_match',
      'catalog_no_match_for_model_id', 'catalog_ambiguous_model_id', 'catalog_provider_absent',
      'catalog_metadata_invalid',
    ]);
    const probes = [
      resolvePromptBudget(),
      resolvePromptBudget({ hostCapacity: { contextTokenBudget: 1, contextWindowSource: 'model' }, catalog }),
      resolvePromptBudget({ hostCapacity: { contextTokenBudget: 128_000, contextWindowSource: 'default' } }),
      resolvePromptBudget({ modelIdentity: { modelId: 'model-x' }, catalog }),
      resolvePromptBudget({ modelIdentity: { modelId: 'model-y' }, catalog }),
      resolvePromptBudget({ modelIdentity: { modelId: 'zzz' }, catalog }),
      resolvePromptBudget({ modelIdentity: { providerId: 'p1', modelId: 'zzz' }, catalog }),
      resolvePromptBudget({ modelIdentity: { providerId: 'p1', modelId: '' }, catalog }),
      resolvePromptBudget({ modelIdentity: { providerId: 'p1', modelId: 'model-y' } }),
    ];
    for (const r of probes) {
      if (r.fallbackReason !== undefined) {
        expect(CODES.has(r.fallbackReason), `code=${r.fallbackReason}`).toBe(true);
      }
    }
  });
});

describe('getPromptModelCatalog against the installed pi-ai 1.2.0 catalog', () => {
  it('resolves a real exact provider+model match to its contextWindow', () => {
    const catalog = getPromptModelCatalog();
    const exact = catalog.exact('anthropic', 'claude-sonnet-4-5');
    expect(exact).toBeDefined();
    expect(exact?.contextWindowTokens).toBe(200_000);
    // 200K → floor(2000 × 200000 / 128000) = 3125, under the 16000 ceiling.
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

  it('a real conflicting cross-provider id (gpt-5) falls back with the ambiguity code', () => {
    const resolved = resolvePromptBudget({
      modelIdentity: { modelId: 'gpt-5' },
      catalog: getPromptModelCatalog(),
    });
    expect(resolved.capacitySource).toBe('legacy_fallback');
    expect(resolved.fallbackReason).toBe('catalog_ambiguous_model_id');
  });

  it('custom/nonexistent provider ids never inherit another provider capacity (SPEC §2.2)', () => {
    const resolved = resolvePromptBudget({
      modelIdentity: { providerId: 'my-private-proxy', modelId: 'claude-sonnet-4-5' },
      catalog: getPromptModelCatalog(),
    });
    expect(resolved.capacitySource).toBe('legacy_fallback');
    expect(resolved.fallbackReason).toBe('catalog_no_exact_match');
    expect(resolved.budgetChars).toBe(2000);
  });
});

describe('resolvePromptBudget tier 0: operator_declared (PRI-1020)', () => {
  it('an Owner declaration outranks a trusted host window and the catalog', () => {
    const result = resolvePromptBudget({
      operatorDeclared: { contextWindowTokens: 262_144 },
      hostCapacity: { contextTokenBudget: 128_000, contextWindowSource: 'model' },
      modelIdentity: { providerId: 'p1', modelId: 'model-y' },
    });
    expect(result).toMatchObject({
      budgetChars: 4096,
      capacitySource: 'operator_declared',
      capacityStatus: 'confirmed',
      contextWindowTokens: 262_144,
      policyVersion: 'model_aware_v1',
    });
    expect(result.fallbackReason).toBeUndefined();
  });

  it('resolves confirmed from the declaration alone (no host facts, no catalog)', () => {
    const result = resolvePromptBudget({ operatorDeclared: { contextWindowTokens: 1_000_000 } });
    expect(result).toMatchObject({
      budgetChars: 15_625,
      capacitySource: 'operator_declared',
      capacityStatus: 'confirmed',
      contextWindowTokens: 1_000_000,
    });
  });

  it('clamps at the policy ceiling (1M+ windows cap at 16000 chars)', () => {
    const result = resolvePromptBudget({ operatorDeclared: { contextWindowTokens: 10_000_000 } });
    expect(result.budgetChars).toBe(16_000);
    expect(result.capacitySource).toBe('operator_declared');
  });

  it('an invalid declaration is ignored defensively: the chain runs as if undeclared', () => {
    for (const bad of [500, 200_000.5, 200_000_000, '262144', null]) {
      const result = resolvePromptBudget({ operatorDeclared: { contextWindowTokens: bad } });
      expect(result.capacitySource, `declared=${String(bad)}`).toBe('legacy_fallback');
      expect(result.budgetChars).toBe(2000);
      expect(result.fallbackReason).toBe('host_capacity_absent');
    }
  });

  it('an invalid declaration does not mask trusted host facts downstream', () => {
    const result = resolvePromptBudget({
      operatorDeclared: { contextWindowTokens: 500 },
      hostCapacity: { contextTokenBudget: 256_000, contextWindowSource: 'modelsConfig' },
    });
    expect(result.capacitySource).toBe('host_effective_window');
    expect(result.budgetChars).toBe(4000);
  });
});

describe('resolveTotalInjectionBudgetChars (PRI-1065 total-ceiling reconciliation)', () => {
  it('keeps the historical 9000 total at the reference window (backward compatible)', () => {
    // 128K → principle budget 2000 + 7000 background allowance = the legacy
    // hard-coded size-guard constant. Existing behavior must not change.
    expect(resolveTotalInjectionBudgetChars(promptBudgetCharsForContextWindow(128_000))).toBe(9000);
    expect(resolveTotalInjectionBudgetChars(PROMPT_BUDGET_FALLBACK_CHARS)).toBe(9000);
  });

  it('grows the ceiling with the model window instead of pinning it', () => {
    expect(resolveTotalInjectionBudgetChars(PROMPT_BUDGET_MIN_CHARS)).toBe(8250);
    expect(resolveTotalInjectionBudgetChars(promptBudgetCharsForContextWindow(1_000_000))).toBe(22_625);
    expect(resolveTotalInjectionBudgetChars(PROMPT_BUDGET_MAX_CHARS)).toBe(23_000);
  });

  it('composes with the resolver: a 1M window leaves room for background blocks', () => {
    // The audited failure: 15625 principle budget with 5145 injected chars
    // left only 9000-5865=3135 for background under the old constant. The
    // reconciled ceiling leaves 22625-5865=16760.
    const resolution = resolvePromptBudget({ operatorDeclared: { contextWindowTokens: 1_000_000 } });
    const total = resolveTotalInjectionBudgetChars(resolution.budgetChars);
    expect(resolution.budgetChars).toBe(15_625);
    expect(total).toBe(22_625);
    expect(total - (720 + 5145)).toBeGreaterThan(10_000);
  });

  it('is monotonic: a larger principle budget never lowers the total ceiling', () => {
    let previous = -Infinity;
    for (let budget = PROMPT_BUDGET_MIN_CHARS; budget <= PROMPT_BUDGET_MAX_CHARS; budget += 125) {
      const total = resolveTotalInjectionBudgetChars(budget);
      expect(total).toBeGreaterThan(previous);
      previous = total;
    }
  });
});
