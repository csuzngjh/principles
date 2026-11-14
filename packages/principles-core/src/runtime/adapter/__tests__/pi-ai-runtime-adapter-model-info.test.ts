/**
 * SPEC §6.1 — the adapter reports the model window it can prove. When the
 * catalog cannot resolve the model, it must report NO window (so callers record
 * `contextWindowSource: 'unknown'`) instead of inventing one.
 */
import { describe, expect, it } from 'vitest';
import { PiAiRuntimeAdapter } from '../pi-ai-runtime-adapter.js';

function makeAdapter(provider: string, model: string, baseUrl?: string): PiAiRuntimeAdapter {
  return new PiAiRuntimeAdapter({
    provider,
    model,
    ...(baseUrl ? { baseUrl } : {}),
    apiKeyEnv: 'PI_AI_MODEL_INFO_TEST_KEY',
    timeoutMs: 5_000,
    outputPathStrategy: 'free_form_only',
  });
}

describe('PiAiRuntimeAdapter.getModelInfo', () => {
  it('returns only the configured identity when the catalog cannot resolve the model', () => {
    const adapter = makeAdapter('provider-not-in-catalog', 'model-not-in-catalog');

    expect(adapter.getModelInfo()).toEqual({
      provider: 'provider-not-in-catalog',
      model: 'model-not-in-catalog',
    });
  });
});
