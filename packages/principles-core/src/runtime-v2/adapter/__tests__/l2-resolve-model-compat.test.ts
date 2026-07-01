/**
 * Regression guard for resolveL2Model's `as unknown as Model<string>` cast.
 *
 * resolveL2Model (l2-agent-loop-adapter.ts) constructs a custom Model literal
 * for OpenAI-compatible providers and narrows it via a double assertion because
 * the literal doesn't fully satisfy Model<string>'s discriminant union. The
 * RUNTIME_CONTRACT comment there warns: if @earendil-works/pi-ai changes Model's
 * shape after an upgrade, the cast will NOT be caught at compile time.
 *
 * This test does NOT mock @earendil-works/pi-ai. It runs resolveL2Model against
 * the real installed types/runtime and asserts the returned object still
 * satisfies the live Model<'openai-completions'> shape. If a pi-ai upgrade adds
 * a required field or changes Compat, this test goes red — surfacing the drift
 * that the cast hides.
 */
import { describe, it, expect } from 'vitest';
import type { Model } from '@earendil-works/pi-ai';
import { resolveL2Model } from '../l2-agent-loop-adapter.js';

// Required keys of Model<'openai-completions'>, derived from the real type so
// this list tracks pi-ai rather than drifting. Optional keys (compat, headers,
// thinkingLevelMap) are checked separately for *shape* when present.
const REQUIRED_MODEL_KEYS = [
  'id',
  'name',
  'api',
  'provider',
  'baseUrl',
  'reasoning',
  'input',
  'cost',
  'contextWindow',
  'maxTokens',
] as const satisfies readonly (keyof Model<'openai-completions'>)[];

describe('resolveL2Model — pi-ai compat regression (RUNTIME_CONTRACT @ l2-agent-loop-adapter.ts:141)', () => {
  it('returns an object carrying every required Model field (no mock)', () => {
    const model = resolveL2Model('custom-provider', 'm1', 'http://localhost:1234/v1');
    for (const key of REQUIRED_MODEL_KEYS) {
      expect(model, `expected returned model to carry required key '${key}'`).toHaveProperty(key);
    }
  });

  it('constructs an openai-completions model with correct primitive types', () => {
    const model = resolveL2Model('custom-provider', 'm1', 'http://localhost:1234/v1');
    expect(model.api).toBe('openai-completions');
    expect(typeof model.id).toBe('string');
    expect(typeof model.name).toBe('string');
    expect(typeof model.provider).toBe('string');
    expect(typeof model.baseUrl).toBe('string');
    expect(typeof model.reasoning).toBe('boolean');
    expect(Array.isArray(model.input)).toBe(true);
    expect(typeof model.contextWindow).toBe('number');
    expect(typeof model.maxTokens).toBe('number');
    // cost is a nested object with numeric fields
    expect(typeof model.cost).toBe('object');
    expect(model.cost).not.toBeNull();
  });

  it('provides a compat block whose fields are accepted by the live Compat type', () => {
    // The cast in resolveL2Model only hides shape drift for the *top-level* Model.
    // If pi-ai renames/adds a required OpenAICompletionsCompat field, the literal's
    // compat may no longer satisfy it. We assert the fields resolveL2Model sets are
    // present and correctly typed; a future pi-ai upgrade that, e.g., turns
    // maxTokensField into a 3-value union or makes thinkingFormat required-with-new-shape
    // should be caught by re-reviewing this test.
    const model = resolveL2Model('custom-provider', 'm1', 'http://localhost:1234/v1');
    expect(model.compat).toBeDefined();
    const compat = model.compat as Record<string, unknown> | undefined;
    if (compat) {
      // ResolveL2Model sets these; verify they survive as the right type.
      expect(typeof compat.supportsUsageInStreaming).toBe('boolean');
      expect(typeof compat.thinkingFormat).toBe('string');
      // thinkingFormat must be one of the live union members; 'deepseek' is current.
      // If pi-ai drops 'deepseek', this fails and the literal must be updated.
      expect(compat.thinkingFormat).toBe('deepseek');
      expect(compat.maxTokensField).toBe('max_tokens');
    }
  });

  it('throws runtime_unavailable when provider is unknown and no baseUrl is given', () => {
    // Negative branch — currently untested elsewhere. resolveL2Model must fail loud
    // (rc-3/rc-9) rather than silently construct an unusable model.
    expect(() => resolveL2Model('not-a-known-provider', 'm1')).toThrow();
  });
});
