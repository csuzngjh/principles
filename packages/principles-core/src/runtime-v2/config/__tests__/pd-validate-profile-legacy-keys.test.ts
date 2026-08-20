/**
 * Profile legacy gate-key validation — PRI-286 retirement + P2-8 aliases
 *
 * gate / progressive_gate / thinking_checkpoint (and the historical plugin
 * normalizer's camelCase aliases progressiveGate / thinkingCheckpoint) are
 * retired profile keys. The validator must:
 *   - keep loading (never hard-reject an old workspace);
 *   - emit a deprecation warning for each occurrence (rc-9: observable);
 *   - NOT pass any of them into the effective config value (ignore, never
 *     restored to canonical config — P2-8).
 */

import { describe, it, expect } from 'vitest';
import { validateProfileConfig } from '../index.js';

/** validateProfileConfig takes the profile object directly (path defaults to 'profile'). */
function messages(raw: Record<string, unknown>): string[] {
  const result = validateProfileConfig(raw);
  if (!result.ok) {
    throw new Error(`validateProfileConfig unexpectedly failed: ${JSON.stringify(result.errors)}`);
  }
  return result.warnings.map((w) => `${w.path}: ${w.message}`);
}

describe('validateProfileConfig legacy gate keys (PRI-286 / P2-8)', () => {
  it('flags snake_case retired keys and drops them from the effective value', () => {
    const result = validateProfileConfig({
      gate: { enabled: true },
      progressive_gate: { enabled: true },
      thinking_checkpoint: { enabled: true },
    });
    expect(result.ok).toBe(true);
    const msgs = result.ok ? result.warnings.map((w) => `${w.path}: ${w.message}`) : [];
    expect(msgs.some((m) => m.includes('profile.gate'))).toBe(true);
    expect(msgs.some((m) => m.includes('profile.progressive_gate'))).toBe(true);
    expect(msgs.some((m) => m.includes('profile.thinking_checkpoint'))).toBe(true);
    if (result.ok) {
      // Retired keys are ignored, never restored into the effective value.
      expect(Object.hasOwn(result.value, 'gate')).toBe(false);
      expect(Object.hasOwn(result.value, 'progressive_gate')).toBe(false);
      expect(Object.hasOwn(result.value, 'thinking_checkpoint')).toBe(false);
      expect(Object.hasOwn(result.value, 'progressiveGate')).toBe(false);
      expect(Object.hasOwn(result.value, 'thinkingCheckpoint')).toBe(false);
    }
  });

  it('flags camelCase aliases progressiveGate / thinkingCheckpoint (P2-8)', () => {
    const msgs = messages({ progressiveGate: { enabled: true }, thinkingCheckpoint: { enabled: true } });
    expect(msgs.some((m) => m.includes('profile.progressiveGate') && m.includes('legacy camelCase alias'))).toBe(true);
    expect(msgs.some((m) => m.includes('profile.thinkingCheckpoint') && m.includes('legacy camelCase alias'))).toBe(true);
  });

  it('emits the canonical-key warning too when both alias forms are present', () => {
    const msgs = messages({ progressive_gate: {}, progressiveGate: {}, thinking_checkpoint: {}, thinkingCheckpoint: {} });
    expect(msgs.filter((m) => m.startsWith('profile.progressive_gate')).length).toBeGreaterThanOrEqual(1);
    expect(msgs.filter((m) => m.startsWith('profile.progressiveGate')).length).toBeGreaterThanOrEqual(1);
    expect(msgs.filter((m) => m.startsWith('profile.thinking_checkpoint')).length).toBeGreaterThanOrEqual(1);
    expect(msgs.filter((m) => m.startsWith('profile.thinkingCheckpoint')).length).toBeGreaterThanOrEqual(1);
  });

  it('does not warn on a clean profile and keeps its valid keys', () => {
    const result = validateProfileConfig({ audit_level: 'low', risk_paths: ['src/**'] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toEqual([]);
      expect(result.value.audit_level).toBe('low');
      expect(result.value.risk_paths).toEqual(['src/**']);
    }
  });

  it('ignores lookalike camelCase keys that are not retired aliases', () => {
    const result = validateProfileConfig({ progressiveGateKeeper: true, thinkingCheckpointV2: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const msgs = result.warnings.map((w) => w.message);
      expect(msgs.some((m) => m.includes('legacy camelCase alias'))).toBe(false);
    }
  });
});
