import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { decodeCodexInput } from '../src/codec/index.js';
import { getPromptModelCatalog, resolvePromptBudget } from '@principles/core/runtime-v2';

/**
 * SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 §5.2 (Codex): the decoder keeps the
 * VALIDATED `model` identity on the unified context (was: checked then
 * discarded); the id is an identity string, never a capacity — the budget
 * resolver decides via the installed catalog, falling back to the fixed
 * budget on unknown/ambiguous ids. Model metadata must not block the hook
 * or touch tool allow/deny decisions.
 */

const fixturesDir = path.resolve(__dirname, 'fixtures', 'g1-contract', 'hook-payloads', 'v0.162.1');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8'));
}

describe('Codex decoder carries model identity for the model-aware budget', () => {
  it('every decoded event carries the validated model id under context.modelContext', () => {
    for (const name of [
      '01-session-start.json',
      '02-user-prompt-submit.json',
      '03-pre-tool-use.json',
      '04-post-tool-use.json',
      '05-stop.json',
    ]) {
      const event = decodeCodexInput(fixture(name));
      expect(event.context.modelContext?.modelId, name).toBe('gpt-6-astra');
    }
  });

  it('model identity is nested only — no stray flat field on the context', () => {
    const event = decodeCodexInput(fixture('02-user-prompt-submit.json'));
    expect(Object.hasOwn(event.context, 'modelId')).toBe(false);
    expect(Object.hasOwn(event.context, 'modelContext')).toBe(true);
  });

  it('a missing model still fails the frozen contract (rc-3, unchanged gate)', () => {
    const payload = fixture('02-user-prompt-submit.json') as Record<string, unknown>;
    delete payload.model;
    expect(() => decodeCodexInput(payload)).toThrow(/model/);
  });

  it('the REAL Codex model id is catalog-ambiguous → honest fixed-budget fallback (AC-03)', () => {
    // gpt-6-astra exists under azure/openai (272000) AND cloudflare-ai-gateway/
    // github-copilot/opencode (1050000) — provider-less lookup MUST refuse to
    // pick a winner. Verified against the installed pi-ai 1.2.0 catalog.
    const event = decodeCodexInput(fixture('02-user-prompt-submit.json'));
    const resolution = resolvePromptBudget({
      modelIdentity: { modelId: event.context.modelContext?.modelId },
      catalog: getPromptModelCatalog(),
    });
    expect(resolution.budgetChars).toBe(2000);
    expect(resolution.capacitySource).toBe('legacy_fallback');
    expect(resolution.fallbackReason).toBe('catalog_ambiguous_model_id');
  });

  it('v0.2 trust amendment: even a catalog-unanimous model id without a provider falls back (custom-endpoint risk)', () => {
    const payload = fixture('02-user-prompt-submit.json') as Record<string, unknown>;
    payload.model = 'glm-4.7';
    const event = decodeCodexInput(payload);
    const resolution = resolvePromptBudget({
      modelIdentity: { modelId: event.context.modelContext?.modelId },
      catalog: getPromptModelCatalog(),
    });
    // glm-4.7 exists only under provider zai (contextWindow 204800), but the
    // Codex hook contract carries NO provider identity — a name-only match
    // cannot prove the deployment is not a custom endpoint, so the budget
    // stays the honest fixed fallback (never a guessed dynamic capacity).
    expect(resolution.capacitySource).toBe('legacy_fallback');
    expect(resolution.fallbackReason).toBe('catalog_provider_absent');
    expect(resolution.budgetChars).toBe(2000);
  });
});
