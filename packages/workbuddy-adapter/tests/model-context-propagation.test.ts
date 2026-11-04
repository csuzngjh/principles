import { describe, expect, it } from 'vitest';
import { decodeWorkbuddyInput } from '../src/codec/index.js';
import { getPromptModelCatalog, promptBudgetCharsForContextWindow, resolvePromptBudget } from '@principles/core/runtime-v2';

/**
 * SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 §5.3 (WorkBuddy): `model` is an
 * OBSERVED OPTIONAL field of the frozen host contract — the only model
 * identity this host exposes; no capacity field exists. Consumed softly:
 * absent or malformed → undefined → fixed-budget fallback (SPEC §8.6:
 * metadata failure must never block the host conversation). Dynamic support
 * is catalog-unambiguous-match-only — never a guessed capacity. v0.3 adds the
 * `pi_catalog_model_id` tier: a name-only id the catalog answers unanimously
 * derives a real window, while any disagreement stays on the honest fallback.
 */

function userPromptPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'wb-session-1',
    transcript_path: null,
    generation_id: 'wb-gen-1',
    cwd: 'D:\\ws\\workbuddy-demo',
    permission_mode: 'default',
    prompt: '帮我检查这个仓库',
    ...overrides,
  };
}

describe('WorkBuddy decoder carries optional model identity (soft, non-blocking)', () => {
  it('a present model string rides the context under modelContext.modelId', () => {
    const event = decodeWorkbuddyInput(userPromptPayload({ model: 'glm-4.7' }));
    expect(event.context.modelContext?.modelId).toBe('glm-4.7');
  });

  it('absent model → no modelContext at all (fixed-budget semantics)', () => {
    const event = decodeWorkbuddyInput(userPromptPayload());
    expect(event.context.modelContext).toBeUndefined();
  });

  it('empty-string and non-string model values degrade to undefined WITHOUT failing the hook (§8.6)', () => {
    const empty = decodeWorkbuddyInput(userPromptPayload({ model: '' }));
    expect(empty.context.modelContext).toBeUndefined();
    const nonString = decodeWorkbuddyInput(userPromptPayload({ model: 12345 }));
    expect(nonString.context.modelContext).toBeUndefined();
  });

  it('tool events carry the same optional identity', () => {
    const event = decodeWorkbuddyInput({
      hook_event_name: 'PreToolUse',
      session_id: 'wb-session-1',
      transcript_path: null,
      generation_id: 'wb-gen-2',
      cwd: 'D:\\ws\\workbuddy-demo',
      permission_mode: 'default',
      tool_name: 'Read',
      tool_input: { path: 'D:\\ws\\workbuddy-demo\\README.md' },
      call_id: 'wb-call-1',
      model: 'claude-sonnet-4-5',
    });
    expect(event.context.modelContext?.modelId).toBe('claude-sonnet-4-5');
  });

  it('an unresolvable id resolves the legacy fixed budget — no fabricated dynamic support (AC-04)', () => {
    // claude-sonnet-4-5 is catalog-ambiguous (200000 vs radius 1000000), so a
    // WorkBuddy workspace sending it must fall back honestly.
    const event = decodeWorkbuddyInput(userPromptPayload({ model: 'claude-sonnet-4-5' }));
    const resolution = resolvePromptBudget({
      modelIdentity: { modelId: event.context.modelContext?.modelId },
      catalog: getPromptModelCatalog(),
    });
    expect(resolution.budgetChars).toBe(4000);
    expect(resolution.capacitySource).toBe('legacy_fallback');
    expect(resolution.capacityStatus).toBe('unknown');
    expect(resolution.fallbackReason).toBe('catalog_ambiguous_model_id');

    // v0.3 derivation: a catalog-unanimous id (glm-4.7, only zai, 204800
    // tokens) now derives a real window even though the WorkBuddy contract
    // exposes no provider identity. The source label records that the basis is
    // name-only, so the Owner can still override with a tier-0 declaration.
    const unanimous = resolvePromptBudget({
      modelIdentity: { modelId: 'glm-4.7' },
      catalog: getPromptModelCatalog(),
    });
    expect(unanimous.capacitySource).toBe('pi_catalog_model_id');
    expect(unanimous.capacityStatus).toBe('confirmed');
    expect(unanimous.contextWindowTokens).toBe(204800);
    expect(unanimous.budgetChars).toBe(promptBudgetCharsForContextWindow(204800));
    expect(unanimous.fallbackReason).toBeUndefined();
  });
});
