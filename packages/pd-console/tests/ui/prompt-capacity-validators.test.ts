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

  it('keeps the unconfirmed payload with per-host forecasts and reasons', () => {
    const v = validatePromptInjectionBudgetStatus({
      ...baseStatus(),
      capacityStatus: 'unconfirmed',
      unconfirmedReason: 'multi_host_routes_differ: openclaw legacy vs codex shared',
      nextAction: 'pass an explicit target host (openclaw|codex)',
      perHost: [
        { hostKind: 'openclaw', route: 'legacy_trim', usedChars: 1855, truncated: true },
        { hostKind: 'codex', route: 'shared_render', usedChars: 1980, truncated: true },
      ],
    });
    expect(v?.capacityStatus).toBe('unconfirmed');
    expect(v?.perHost).toHaveLength(2);
    expect(v?.perHost?.[0]).toEqual({ hostKind: 'openclaw', route: 'legacy_trim', usedChars: 1855, truncated: true });
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

  it('parses route_unconfirmed rows with per-host fits and reason', () => {
    const v = validateActivations({
      activations: [
        { ...baseActivation(), promptInjection: { activationId: 'act-1', status: 'route_unconfirmed', reason: 'multi_host_routes_differ', perHostFits: [{ hostKind: 'openclaw', fits: true }, { hostKind: 'codex', fits: false }] } },
      ],
      status: 'ok',
    });
    expect(v?.activations[0]?.promptInjection?.perHostFits).toEqual([
      { hostKind: 'openclaw', fits: true }, { hostKind: 'codex', fits: false },
    ]);
    expect(v?.activations[0]?.promptInjection?.reason).toBe('multi_host_routes_differ');
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
      activations: [{ ...baseActivation(), promptInjection: { activationId: 'act-1', status: 'injectable', perHostFits: [{ hostKind: 'vscode', fits: true }] } }],
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
