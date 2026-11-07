import { describe, expect, it } from 'vitest';
import {
  RUNTIME_PRINCIPLE_BUDGET,
  renderPrinciplesToDirectives,
  resolvePromptBudget,
  trimToBudget,
} from '@principles/core/runtime';
import { escapeXml } from '@principles/core/prompt-builder';
import { packSharedDirectives, type ActivatedPrinciple } from '@principles/host-runtime';

const script = await import('../../scripts/prompt-capacity-measurement.mjs') as unknown as {
  countOversizedCandidates: (
    principles: ActivatedPrinciple[],
    selfReportEnabled: boolean,
    budgetChars?: number,
  ) => number;
  modelAwareTierScenario: (
    windowTokens: number | null,
    selfReport: boolean,
  ) => Promise<{ budgetChars: number; shared: { oversized: number } }>;
};

function principle(text: string, activationId = 'act-boundary'): ActivatedPrinciple {
  return {
    principleId: `P-${activationId}`,
    activationId,
    artifactId: `art-${activationId}`,
    text,
    authority: 'owner',
  };
}

function renderOne(input: ActivatedPrinciple, selfReportInstruction: boolean): string {
  return renderPrinciplesToDirectives([input], new Set([input.principleId]), {
    escapeFn: escapeXml,
    selfReportInstruction,
  });
}

describe('PRI-1137 prompt capacity measurement — shared packer is the only oversized authority', () => {
  it('shows a candidate the retired list route accepts but the shared route rejects', () => {
    // 3500 chars: legacy list cost ≈ text + short id header < 4000, while the
    // shared full directive wrapper (755) + authority attribute pushes it over.
    const candidate = principle('x'.repeat(3500));

    const legacyOversized = trimToBudget([candidate], RUNTIME_PRINCIPLE_BUDGET, escapeXml).oversizedActivationIds;
    expect(legacyOversized).not.toContain('act-boundary');

    const shared = packSharedDirectives({
      scanOrder: [candidate],
      budgetChars: RUNTIME_PRINCIPLE_BUDGET,
      selfReportEnabled: false,
      continueOnNonFit: true,
    });
    expect(shared.oversized).toContain('act-boundary');

    // The script must follow the shared route, not the retired arithmetic.
    expect(script.countOversizedCandidates([candidate], false)).toBe(1);
  });

  it('counts both oversized 32K candidates using the tier budget', async () => {
    const budget32k = resolvePromptBudget({
      hostCapacity: { contextTokenBudget: 32_000, contextWindowSource: 'model' },
    }).budgetChars;
    expect(budget32k).toBe(1250);

    const longA = principle('l'.repeat(1200), 'act-long-a');
    const longB = principle('l'.repeat(1200), 'act-long-b');

    // The report must inspect the entire corpus independently, at the actual
    // 32K tier budget (not the 4K fallback used by other scenarios). Each
    // 1200-character body is oversized once the full directive wrapper is
    // charged against the 1250-character 32K tier budget.
    expect(script.countOversizedCandidates([longA, longB], false, budget32k)).toBe(2);
    expect(script.countOversizedCandidates([longA, longB], false)).toBe(0);

    // Exercise the exact tier-report call site with the real 16-candidate
    // workspace fixture, not only the counting helper in isolation.
    const scenario = await script.modelAwareTierScenario(32_000, false);
    expect(scenario.budgetChars).toBe(1250);
    expect(scenario.shared.oversized).toBe(2);
  });

  it('charges the authority annotation and the real self-report state to the budget', () => {
    const base = principle('');
    const withoutAuthority: ActivatedPrinciple = { ...base, authority: undefined };

    const withAuthorityLen = renderOne(base, false).length;
    const withoutAuthorityLen = renderOne(withoutAuthority, false).length;
    // `authority="owner"` is 18 chars in the full directive serialization.
    expect(withAuthorityLen - withoutAuthorityLen).toBe(18);

    const selfReportDelta = renderOne(base, true).length - withAuthorityLen;
    expect(selfReportDelta).toBeGreaterThan(0);

    // Just fits with self-report OFF, oversized with self-report ON.
    const boundaryText = 'x'.repeat(RUNTIME_PRINCIPLE_BUDGET - withAuthorityLen - 1);
    const candidate = principle(boundaryText);
    const off = packSharedDirectives({
      scanOrder: [candidate],
      budgetChars: RUNTIME_PRINCIPLE_BUDGET,
      selfReportEnabled: false,
      continueOnNonFit: true,
    });
    const on = packSharedDirectives({
      scanOrder: [candidate],
      budgetChars: RUNTIME_PRINCIPLE_BUDGET,
      selfReportEnabled: true,
      continueOnNonFit: true,
    });
    expect(off.oversized).not.toContain('act-boundary');
    expect(on.oversized).toContain('act-boundary');
    expect(script.countOversizedCandidates([candidate], false)).toBe(0);
    expect(script.countOversizedCandidates([candidate], true)).toBe(1);
  });
});
