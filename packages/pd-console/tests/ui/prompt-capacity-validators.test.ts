import { describe, expect, it } from 'vitest';
import {
  validatePromptInjectionBudgetStatus,
  validateActivations,
  validateApprovalsGrouped,
} from '../../src/ui/utils/validators.js';

/**
 * PD_PROMPT_CAPACITY_V1: wire-contract validators for the capacity forecast
 * (grouped) and the per-activation injection statuses (activations page).
 * rc-1..rc-4: present-but-invalid fields are DROPPED (or null the payload),
 * never propagated.
 */

function baseStatus(): Record<string, unknown> {
  return { budget: 2000, usedChars: 1476, truncated: false };
}

describe('validatePromptInjectionBudgetStatus — PD_PROMPT_CAPACITY_V1 fields', () => {
  it('keeps every valid capacity field (confirmed payload)', () => {
    const v = validatePromptInjectionBudgetStatus({
      ...baseStatus(),
      productionRotates: true,
      eligibleCount: 12,
      capacityStatus: 'confirmed',
      hostKind: 'openclaw',
      route: 'legacy_trim',
      unit: 'utf16_code_units',
      budgetScope: 'selected_lines',
      fullRenderChars: 3812,
      oversizedActivationIds: ['act-a', 'act-b'],
      oversizedDiagnosticTruncated: false,
    });
    expect(v).not.toBeNull();
    expect(v?.capacityStatus).toBe('confirmed');
    expect(v?.hostKind).toBe('openclaw');
    expect(v?.route).toBe('legacy_trim');
    expect(v?.unit).toBe('utf16_code_units');
    expect(v?.budgetScope).toBe('selected_lines');
    expect(v?.fullRenderChars).toBe(3812);
    expect(v?.oversizedActivationIds).toEqual(['act-a', 'act-b']);
    expect(v?.oversizedDiagnosticTruncated).toBe(false);
  });

  it('keeps the unconfirmed payload with per-host forecasts for ALL roster hosts and reasons', () => {
    const v = validatePromptInjectionBudgetStatus({
      ...baseStatus(),
      capacityStatus: 'unconfirmed',
      unconfirmedReason: 'multi_host_routes_differ: openclaw legacy vs codex/workbuddy shared',
      nextAction: 'pass an explicit target host (openclaw|codex|workbuddy)',
      perHost: [
        { hostKind: 'openclaw', route: 'legacy_trim', usedChars: 1855, truncated: true },
        { hostKind: 'codex', route: 'shared_render', usedChars: 1980, truncated: true },
        { hostKind: 'workbuddy', route: 'shared_render', usedChars: 1980, truncated: true },
      ],
    });
    expect(v?.capacityStatus).toBe('unconfirmed');
    expect(v?.perHost).toHaveLength(3);
    expect(v?.perHost?.[0]).toEqual({ hostKind: 'openclaw', route: 'legacy_trim', usedChars: 1855, truncated: true });
    expect(v?.perHost?.[2]).toEqual({ hostKind: 'workbuddy', route: 'shared_render', usedChars: 1980, truncated: true });
  });

  it('keeps workbuddy as a valid hostKind on the confirmed payload (roster third host)', () => {
    const v = validatePromptInjectionBudgetStatus({
      ...baseStatus(),
      capacityStatus: 'confirmed',
      hostKind: 'workbuddy',
      route: 'shared_render',
      budgetScope: 'full_directive_context',
    });
    expect(v?.hostKind).toBe('workbuddy');
    expect(v?.route).toBe('shared_render');
    expect(v?.budgetScope).toBe('full_directive_context');
  });

  it.each([
    ['capacityStatus', 'maybe'],
    ['hostKind', 'vscode'],
    ['route', 'fifo'],
    ['unit', 'tokens'],
    ['budgetScope', 'whole_request'],
    ['fullRenderChars', -1],
    ['fullRenderChars', 12.5],
    ['oversizedDiagnosticTruncated', 'yes'],
  ])('drops invalid %s (%p)', (field, value) => {
    const v = validatePromptInjectionBudgetStatus({ ...baseStatus(), [field]: value });
    expect(v).not.toBeNull();
    expect(v?.[field as keyof typeof v]).toBeUndefined();
  });

  it('drops invalid oversizedActivationIds (non-string element or non-array)', () => {
    expect(validatePromptInjectionBudgetStatus({ ...baseStatus(), oversizedActivationIds: ['a', 3] })?.oversizedActivationIds).toBeUndefined();
    expect(validatePromptInjectionBudgetStatus({ ...baseStatus(), oversizedActivationIds: 'act-a' })?.oversizedActivationIds).toBeUndefined();
  });

  it('nulls the payload on a malformed perHost ELEMENT; a non-array perHost is dropped (established drop-on-invalid style)', () => {
    expect(validatePromptInjectionBudgetStatus({
      ...baseStatus(),
      perHost: [{ hostKind: 'openclaw', route: 'legacy_trim', usedChars: -5, truncated: false }],
    })).toBeNull();
    expect(validatePromptInjectionBudgetStatus({
      ...baseStatus(),
      perHost: [{ hostKind: 'openclaw' }],
    })).toBeNull();
    const dropped = validatePromptInjectionBudgetStatus({
      ...baseStatus(),
      perHost: 'act-a',
    });
    expect(dropped).not.toBeNull();
    expect(dropped?.perHost).toBeUndefined();
  });

  it('drops unconfirmedReason/nextAction when not strings', () => {
    const v = validatePromptInjectionBudgetStatus({ ...baseStatus(), unconfirmedReason: 42, nextAction: {} });
    expect(v?.unconfirmedReason).toBeUndefined();
    expect(v?.nextAction).toBeUndefined();
  });
});

/**
 * PRI-1017: runtime budget OBSERVATION fields on the wire contract.
 * The observation is a PAST runtime fact — additive optional fields,
 * drop-on-invalid; a pre-PRI-1017 payload (no new fields) still validates.
 */
describe('validatePromptInjectionBudgetStatus — PRI-1017 budget observation fields', () => {
  it('keeps a confirmed payload backed by a runtime observation (source + window + observedAt)', () => {
    const v = validatePromptInjectionBudgetStatus({
      ...baseStatus(),
      capacityStatus: 'confirmed',
      hostKind: 'openclaw',
      budget: 4000,
      budgetCapacitySource: 'host_effective_window',
      budgetCapacityStatus: 'confirmed',
      budgetContextWindowTokens: 256_000,
      budgetObservedAt: '2026-10-21T04:00:00.000Z',
    });
    expect(v?.budgetCapacitySource).toBe('host_effective_window');
    expect(v?.budgetContextWindowTokens).toBe(256_000);
    expect(v?.budgetObservedAt).toBe('2026-10-21T04:00:00.000Z');
  });

  it('keeps the console-side stale reason code alongside the closed core reason set', () => {
    const stale = validatePromptInjectionBudgetStatus({
      ...baseStatus(),
      budgetCapacityStatus: 'unknown',
      budgetFallbackReason: 'runtime_budget_observation_stale',
    });
    expect(stale?.budgetFallbackReason).toBe('runtime_budget_observation_stale');
    const core = validatePromptInjectionBudgetStatus({
      ...baseStatus(),
      budgetCapacityStatus: 'unknown',
      budgetFallbackReason: 'host_capacity_source_untrusted',
    });
    expect(core?.budgetFallbackReason).toBe('host_capacity_source_untrusted');
  });

  it.each([
    ['budgetObservedAt', 'yesterday'],
    ['budgetObservedAt', 1750000000000],
    ['budgetObservedAt', ''],
    ['budgetFallbackReason', 'made_up_reason'],
    ['budgetCapacitySource', 'vibes'],
    ['budgetCapacityStatus', 'probably'],
    ['budgetContextWindowTokens', 0],
  ])('drops invalid %s (%p) without nulling the payload', (field, value) => {
    const v = validatePromptInjectionBudgetStatus({ ...baseStatus(), [field]: value });
    expect(v).not.toBeNull();
    expect(v?.[field as keyof typeof v]).toBeUndefined();
  });

  it('per-host forecasts carry their own budget basis (additive, drop-on-invalid per field)', () => {
    const v = validatePromptInjectionBudgetStatus({
      ...baseStatus(),
      capacityStatus: 'unconfirmed',
      perHost: [
        {
          hostKind: 'openclaw', route: 'legacy_trim', usedChars: 1855, truncated: true,
          budget: 4000, budgetCapacitySource: 'host_effective_window', budgetCapacityStatus: 'confirmed',
          budgetObservedAt: '2026-10-21T04:00:00.000Z',
        },
        { hostKind: 'codex', route: 'shared_render', usedChars: 1980, truncated: false },
      ],
    });
    expect(v?.perHost?.[0]).toEqual({
      hostKind: 'openclaw', route: 'legacy_trim', usedChars: 1855, truncated: true,
      budget: 4000, budgetCapacitySource: 'host_effective_window', budgetCapacityStatus: 'confirmed',
      budgetObservedAt: '2026-10-21T04:00:00.000Z',
    });
    // A host without an observation keeps the pre-PRI-1017 shape exactly.
    expect(v?.perHost?.[1]).toEqual({ hostKind: 'codex', route: 'shared_render', usedChars: 1980, truncated: false });
  });

  it('drops invalid per-host additive fields without nulling the entry', () => {
    const v = validatePromptInjectionBudgetStatus({
      ...baseStatus(),
      capacityStatus: 'unconfirmed',
      perHost: [
        {
          hostKind: 'openclaw', route: 'legacy_trim', usedChars: 1855, truncated: true,
          budget: -1, budgetCapacitySource: 'nope', budgetCapacityStatus: 'maybe',
          budgetObservedAt: 'last tuesday', budgetFallbackReason: 'not_a_reason',
        },
      ],
    });
    expect(v?.perHost?.[0]).toEqual({ hostKind: 'openclaw', route: 'legacy_trim', usedChars: 1855, truncated: true });
  });

  it('per-host fallback reason travels through the closed whitelist (each host keeps its own)', () => {
    const v = validatePromptInjectionBudgetStatus({
      ...baseStatus(),
      capacityStatus: 'unconfirmed',
      perHost: [
        { hostKind: 'openclaw', route: 'legacy_trim', usedChars: 1855, truncated: true, budgetFallbackReason: 'runtime_budget_observation_stale' },
        { hostKind: 'codex', route: 'shared_render', usedChars: 1980, truncated: true, budgetFallbackReason: 'host_capacity_absent' },
      ],
    });
    expect(v?.perHost?.[0]?.budgetFallbackReason).toBe('runtime_budget_observation_stale');
    expect(v?.perHost?.[1]?.budgetFallbackReason).toBe('host_capacity_absent');
    // Top-level reason is NOT populated from the first host (no impersonation).
    expect(v?.budgetFallbackReason).toBeUndefined();
  });

  it('a pre-PRI-1017 payload (no observation fields) still validates unchanged', () => {
    const v = validatePromptInjectionBudgetStatus({
      ...baseStatus(),
      capacityStatus: 'confirmed',
      hostKind: 'codex',
      budgetCapacitySource: 'legacy_fallback',
      budgetCapacityStatus: 'unknown',
      budgetFallbackReason: 'host_capacity_absent',
    });
    expect(v?.budgetObservedAt).toBeUndefined();
    expect(v?.budgetFallbackReason).toBe('host_capacity_absent');
  });
});

function baseActivation(): Record<string, unknown> {
  return {
    activationId: 'act-1', artifactId: 'art-1', principleId: 'p-1', channel: 'prompt',
    action: 'prompt_activate', targetRef: 'ledger://p-1', activatedAt: '2026-10-07T08:00:00.000Z',
    status: 'active',
  };
}

describe('validateActivations — per-activation injection status (R-A3)', () => {
  it('parses injectable/oversized/window_excluded rows with their evidence fields', () => {
    const v = validateActivations({
      activations: [
        { ...baseActivation(), promptInjection: { activationId: 'act-1', status: 'injectable', inCurrentWindow: true, costChars: 480, budget: 2000, budgetScope: 'selected_lines', route: 'legacy_trim' } },
      ],
      status: 'ok',
      promptInjectionRoute: { status: 'confirmed', hostKind: 'openclaw', route: 'legacy_trim', flagEnabled: false },
    });
    expect(v?.activations[0]?.promptInjection).toEqual({
      activationId: 'act-1', status: 'injectable', inCurrentWindow: true, costChars: 480, budget: 2000, budgetScope: 'selected_lines', route: 'legacy_trim',
    });
    expect(v?.promptInjectionRoute).toEqual({ status: 'confirmed', hostKind: 'openclaw', route: 'legacy_trim', flagEnabled: false });
  });

  it('parses route_unconfirmed rows with per-host tier fits and reason', () => {
    const v = validateActivations({
      activations: [
        { ...baseActivation(), promptInjection: { activationId: 'act-1', status: 'route_unconfirmed', reason: 'multi_host_routes_differ', perHostFits: [{ hostKind: 'openclaw', tierFit: 'fits_all_tiers' }, { hostKind: 'codex', tierFit: 'model_dependent' }] } },
      ],
      status: 'ok',
    });
    expect(v?.activations[0]?.promptInjection?.perHostFits).toEqual([
      { hostKind: 'openclaw', tierFit: 'fits_all_tiers' }, { hostKind: 'codex', tierFit: 'model_dependent' },
    ]);
    expect(v?.activations[0]?.promptInjection?.reason).toBe('multi_host_routes_differ');
  });

  it('SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 §7: passes budgetFallbackReason through the closed whitelist and drops foreign codes', () => {
    const ok = validatePromptInjectionBudgetStatus({
      budget: 2000, usedChars: 0, truncated: false,
      budgetCapacitySource: 'legacy_fallback', budgetCapacityStatus: 'unknown',
      budgetFallbackReason: 'catalog_ambiguous_model_id',
    });
    expect(ok?.budgetFallbackReason).toBe('catalog_ambiguous_model_id');
    const foreign = validatePromptInjectionBudgetStatus({
      budget: 2000, usedChars: 0, truncated: false,
      budgetFallbackReason: 'some_free_form_detail:with-colons',
    });
    // Drop-on-invalid: a free-form string must never reach the UI.
    expect(foreign?.budgetFallbackReason).toBeUndefined();
    expect(foreign?.budget).toBe(2000);
  });

  it('SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001: parses model_dependent rows (never a definite yes/no)', () => {
    const v = validateActivations({
      activations: [
        { ...baseActivation(), promptInjection: { activationId: 'act-1', status: 'model_dependent', inCurrentWindow: false, costChars: 3200, budget: 2000, budgetScope: 'full_directive_context', route: 'shared_render', reason: 'model_dependent_capacity: ...' } },
      ],
      status: 'ok',
    });
    expect(v?.activations[0]?.promptInjection?.status).toBe('model_dependent');
    expect(v?.activations[0]?.promptInjection?.costChars).toBe(3200);
  });

  it('PRI-1017: route summary carries the runtime budget observation timestamp (drop-on-invalid)', () => {
    const v = validateActivations({
      activations: [
        { ...baseActivation(), promptInjection: { activationId: 'act-1', status: 'injectable', inCurrentWindow: true, costChars: 852, budget: 4000, budgetScope: 'full_directive_context', route: 'shared_render' } },
      ],
      status: 'ok',
      promptInjectionRoute: {
        status: 'confirmed', hostKind: 'codex', route: 'shared_render', flagEnabled: false,
        budgetObservedAt: '2026-10-21T04:00:00.000Z',
      },
    });
    expect(v?.promptInjectionRoute?.budgetObservedAt).toBe('2026-10-21T04:00:00.000Z');
    const invalid = validateActivations({
      activations: [],
      status: 'ok',
      promptInjectionRoute: { status: 'confirmed', flagEnabled: false, budgetObservedAt: 'sometime' },
    });
    expect(invalid?.promptInjectionRoute?.budgetObservedAt).toBeUndefined();
    expect(invalid?.promptInjectionRoute?.status).toBe('confirmed');
  });

  it('PRI-1017: route summary budget provenance is validated field-by-field (source/status/window/reason)', () => {
    const valid = validateActivations({
      activations: [],
      status: 'ok',
      promptInjectionRoute: {
        status: 'confirmed', hostKind: 'codex', route: 'shared_render', flagEnabled: false,
        budgetCapacitySource: 'legacy_fallback', budgetCapacityStatus: 'unknown',
        budgetFallbackReason: 'host_capacity_absent', budgetObservedAt: '2026-10-21T04:00:00.000Z',
      },
    });
    expect(valid?.promptInjectionRoute).toMatchObject({
      budgetCapacitySource: 'legacy_fallback',
      budgetCapacityStatus: 'unknown',
      budgetFallbackReason: 'host_capacity_absent',
    });
    const invalid = validateActivations({
      activations: [],
      status: 'ok',
      promptInjectionRoute: {
        status: 'confirmed', flagEnabled: false,
        budgetCapacitySource: 'vibes', budgetCapacityStatus: 'probably',
        budgetContextWindowTokens: -5, budgetFallbackReason: 'free_form_detail',
      },
    });
    expect(invalid?.promptInjectionRoute).toEqual({ status: 'confirmed', flagEnabled: false });
  });

  it('keeps resolution_failed rows with their structured reason', () => {
    const v = validateActivations({
      activations: [
        { ...baseActivation(), promptInjection: { activationId: 'act-1', status: 'resolution_failed', reason: 'artifact_not_found: artifactId=art-1' } },
      ],
      status: 'ok',
    });
    expect(v?.activations[0]?.promptInjection?.status).toBe('resolution_failed');
  });

  it('drops promptInjection with an unknown status kind (rc-3) and with malformed perHostFits (rc-4, nested drop-on-invalid)', () => {
    const dropped = validateActivations({
      activations: [{ ...baseActivation(), promptInjection: { activationId: 'act-1', status: 'probably_fine' } }],
      status: 'ok',
    });
    expect(dropped?.activations[0]?.promptInjection).toBeUndefined();
    const malformed = validateActivations({
      activations: [{ ...baseActivation(), promptInjection: { activationId: 'act-1', status: 'injectable', perHostFits: [{ hostKind: 'vscode', tierFit: 'model_dependent' }] } }],
      status: 'ok',
    });
    // The status object fails validation → the optional nested field is
    // dropped and the record itself is kept (same style as the grouped
    // promptInjection field on PRI-908).
    expect(malformed?.activations[0]?.promptInjection).toBeUndefined();
    expect(malformed?.activations).toHaveLength(1);
  });

  it('drops an invalid route summary but keeps the rest of the payload', () => {
    const v = validateActivations({
      activations: [baseActivation()],
      status: 'ok',
      promptInjectionRoute: { status: 'perhaps', flagEnabled: 'yes' },
    });
    expect(v?.promptInjectionRoute).toBeUndefined();
    expect(v?.activations).toHaveLength(1);
  });
});

describe('validateApprovalsGrouped — grouped capacity passthrough', () => {
  it('passes the unconfirmed forecast through the grouped payload', () => {
    const v = validateApprovalsGrouped({
      groups: [],
      generatedAt: '2026-10-07T08:00:00.000Z',
      promptInjection: {
        budget: 2000, usedChars: 0, truncated: false,
        capacityStatus: 'unconfirmed', unconfirmedReason: 'no_host_facts_and_flag_off',
        nextAction: 'pass an explicit target host',
        perHost: [
          { hostKind: 'openclaw', route: 'legacy_trim', usedChars: 0, truncated: false },
          { hostKind: 'codex', route: 'shared_render', usedChars: 0, truncated: false },
        ],
      },
    });
    expect(v?.promptInjection?.capacityStatus).toBe('unconfirmed');
    expect(v?.promptInjection?.perHost).toHaveLength(2);
  });
});
