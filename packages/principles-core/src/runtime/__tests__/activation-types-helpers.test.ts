/**
 * Activation Types Helper Functions Tests
 *
 * Unit tests for helper functions in activation-types.ts:
 * - makeIdempotencyKey()
 * - isLowRiskChannel()
 * - getChannelRiskLevel()
 * - mapConfidenceToLabel()
 *
 * These functions are critical for activation dispatch decisions and
 * approval queue operations. Tests verify boundary conditions and
 * all possible input combinations.
 *
 * ERR checklist:
 * - ERR-002: Every decision path carries reason + nextAction
 * - ERR-009: Malformed state fails loud
 * - ERR-025: Production-path tests, not just helpers
 */

import { describe, it, expect } from 'vitest';
import {
  makeIdempotencyKey,
  isLowRiskChannel,
  getChannelRiskLevel,
  mapConfidenceToLabel,
  LOW_RISK_CHANNELS,
  HIGH_RISK_CHANNEL_MAP,
  AUTO_PROMOTION_CONFIDENCE_THRESHOLD,
  AUTO_PROMOTABLE_CHANNELS,
} from '../activation/activation-types';
import type { ConfidenceLabel } from '../activation/activation-types';
import type { InternalizationChannel } from '../internalization/peer-runner-contracts';

// ── makeIdempotencyKey Tests ──────────────────────────────────────────────────

describe('makeIdempotencyKey', () => {
  it('produces expected format: artifactId::channel', () => {
    expect(makeIdempotencyKey('art-001', 'prompt')).toBe('art-001::prompt');
    expect(makeIdempotencyKey('art-abc', 'code_tool_hook')).toBe('art-abc::code_tool_hook');
    expect(makeIdempotencyKey('art-xyz', 'defer_archive')).toBe('art-xyz::defer_archive');
  });

  it('handles empty artifactId', () => {
    expect(makeIdempotencyKey('', 'prompt')).toBe('::prompt');
  });

  it('handles artifactId with special characters', () => {
    expect(makeIdempotencyKey('art-with-dashes', 'prompt')).toBe('art-with-dashes::prompt');
    expect(makeIdempotencyKey('art_with_underscores', 'prompt')).toBe('art_with_underscores::prompt');
    expect(makeIdempotencyKey('art.with.dots', 'prompt')).toBe('art.with.dots::prompt');
  });

  it('handles artifactId with colons (edge case)', () => {
    // Colons in artifactId could cause ambiguity, but function doesn't escape
    expect(makeIdempotencyKey('art:001', 'prompt')).toBe('art:001::prompt');
  });

  it('handles all valid channels', () => {
    const channels: InternalizationChannel[] = [
      'prompt', 'defer_archive', 'skill', 'code_tool_hook',
    ];
    for (const channel of channels) {
      const key = makeIdempotencyKey('art-001', channel);
      expect(key).toContain('::');
      expect(key.endsWith(channel)).toBe(true);
    }
  });

  it('is deterministic — same inputs produce same output', () => {
    const key1 = makeIdempotencyKey('art-001', 'prompt');
    const key2 = makeIdempotencyKey('art-001', 'prompt');
    expect(key1).toBe(key2);
  });

  it('is reversible — can parse back artifactId and channel', () => {
    const key = makeIdempotencyKey('art-001', 'prompt');
    const [artifactId, channel] = key.split('::');
    expect(artifactId).toBe('art-001');
    expect(channel).toBe('prompt');
  });
});

// ── isLowRiskChannel Tests ───────────────────────────────────────────────────

describe('isLowRiskChannel', () => {
  it('returns true for prompt channel', () => {
    expect(isLowRiskChannel('prompt')).toBe(true);
  });

  it('returns true for defer_archive channel', () => {
    expect(isLowRiskChannel('defer_archive')).toBe(true);
  });

  it('returns false for skill channel', () => {
    expect(isLowRiskChannel('skill')).toBe(false);
  });

  it('returns false for code_tool_hook channel', () => {
    expect(isLowRiskChannel('code_tool_hook')).toBe(false);
  });

  it('LOW_RISK_CHANNELS contains exactly prompt and defer_archive', () => {
    expect(LOW_RISK_CHANNELS).toHaveLength(2);
    expect(LOW_RISK_CHANNELS).toContain('prompt');
    expect(LOW_RISK_CHANNELS).toContain('defer_archive');
  });

  it('isLowRiskChannel matches LOW_RISK_CHANNELS membership', () => {
    const allChannels: InternalizationChannel[] = [
      'prompt', 'defer_archive', 'skill', 'code_tool_hook',
    ];
    for (const channel of allChannels) {
      expect(isLowRiskChannel(channel)).toBe(LOW_RISK_CHANNELS.includes(channel));
    }
  });

  it('returns false for unknown channel (safe default)', () => {
    expect(isLowRiskChannel('unknown' as InternalizationChannel)).toBe(false);
  });
});

// ── getChannelRiskLevel Tests ────────────────────────────────────────────────

describe('getChannelRiskLevel', () => {
  it('returns low for prompt channel', () => {
    expect(getChannelRiskLevel('prompt')).toBe('low');
  });

  it('returns low for defer_archive channel', () => {
    expect(getChannelRiskLevel('defer_archive')).toBe('low');
  });

  it('returns medium for skill channel', () => {
    expect(getChannelRiskLevel('skill')).toBe('medium');
  });

  it('returns high for code_tool_hook channel', () => {
    expect(getChannelRiskLevel('code_tool_hook')).toBe('high');
  });

  it('returns high for unknown channel (safe default)', () => {
    expect(getChannelRiskLevel('unknown' as InternalizationChannel)).toBe('high');
  });

  it('HIGH_RISK_CHANNEL_MAP has correct entries', () => {
    expect(HIGH_RISK_CHANNEL_MAP.skill).toBe('medium');
    expect(HIGH_RISK_CHANNEL_MAP.code_tool_hook).toBe('high');
  });

  it('getChannelRiskLevel returns low for LOW_RISK_CHANNELS', () => {
    for (const channel of LOW_RISK_CHANNELS) {
      expect(getChannelRiskLevel(channel)).toBe('low');
    }
  });

  it('getChannelRiskLevel returns HIGH_RISK_CHANNEL_MAP value for high-risk channels', () => {
    for (const [channel, riskLevel] of Object.entries(HIGH_RISK_CHANNEL_MAP)) {
      expect(getChannelRiskLevel(channel as InternalizationChannel)).toBe(riskLevel);
    }
  });

  it('risk levels are ordered: low < medium < high', () => {
    // This is a semantic ordering test, not a numeric comparison
    const levels = ['low', 'medium', 'high'];
    expect(getChannelRiskLevel('prompt')).toBe(levels[0]);
    expect(getChannelRiskLevel('skill')).toBe(levels[1]);
    expect(getChannelRiskLevel('code_tool_hook')).toBe(levels[2]);
  });
});

// ── mapConfidenceToLabel Tests ───────────────────────────────────────────────

describe('mapConfidenceToLabel', () => {
  it('returns high for confidence >= 0.8', () => {
    expect(mapConfidenceToLabel(0.8)).toBe('high');
    expect(mapConfidenceToLabel(0.85)).toBe('high');
    expect(mapConfidenceToLabel(0.9)).toBe('high');
    expect(mapConfidenceToLabel(1.0)).toBe('high');
  });

  it('returns medium for confidence >= 0.5 and < 0.8', () => {
    expect(mapConfidenceToLabel(0.5)).toBe('medium');
    expect(mapConfidenceToLabel(0.55)).toBe('medium');
    expect(mapConfidenceToLabel(0.6)).toBe('medium');
    expect(mapConfidenceToLabel(0.7)).toBe('medium');
    expect(mapConfidenceToLabel(0.79)).toBe('medium');
  });

  it('returns low for confidence < 0.5', () => {
    expect(mapConfidenceToLabel(0.0)).toBe('low');
    expect(mapConfidenceToLabel(0.1)).toBe('low');
    expect(mapConfidenceToLabel(0.2)).toBe('low');
    expect(mapConfidenceToLabel(0.3)).toBe('low');
    expect(mapConfidenceToLabel(0.4)).toBe('low');
    expect(mapConfidenceToLabel(0.49)).toBe('low');
  });

  it('returns medium for undefined confidence', () => {
    expect(mapConfidenceToLabel(undefined)).toBe('medium');
  });

  it('returns medium for null confidence', () => {
    expect(mapConfidenceToLabel(null as unknown as undefined)).toBe('medium');
  });

  // Boundary tests
  it('returns high at exact boundary 0.8', () => {
    expect(mapConfidenceToLabel(0.8)).toBe('high');
  });

  it('returns medium just below boundary 0.79', () => {
    expect(mapConfidenceToLabel(0.79)).toBe('medium');
  });

  it('returns medium at exact boundary 0.5', () => {
    expect(mapConfidenceToLabel(0.5)).toBe('medium');
  });

  it('returns low just below boundary 0.49', () => {
    expect(mapConfidenceToLabel(0.49)).toBe('low');
  });

  // Edge cases
  it('returns low for negative confidence (invalid but handled)', () => {
    expect(mapConfidenceToLabel(-0.1)).toBe('low');
  });

  it('returns high for confidence > 1.0 (invalid but handled)', () => {
    expect(mapConfidenceToLabel(1.5)).toBe('high');
  });

  it('all possible return values are valid ConfidenceLabels', () => {
    const validLabels: ConfidenceLabel[] = ['high', 'medium', 'low'];
    const testValues = [undefined, null, 0, 0.25, 0.5, 0.75, 1.0];
    for (const val of testValues) {
      const label = mapConfidenceToLabel(val as number | undefined);
      expect(validLabels).toContain(label);
    }
  });
});

// ── Constants Tests ──────────────────────────────────────────────────────────

describe('constants', () => {
  it('AUTO_PROMOTION_CONFIDENCE_THRESHOLD is 0.95', () => {
    expect(AUTO_PROMOTION_CONFIDENCE_THRESHOLD).toBe(0.95);
  });

  it('AUTO_PROMOTABLE_CHANNELS contains only skill', () => {
    expect(AUTO_PROMOTABLE_CHANNELS).toEqual(['skill']);
    expect(AUTO_PROMOTABLE_CHANNELS).toHaveLength(1);
  });

  it('LOW_RISK_CHANNELS and HIGH_RISK_CHANNEL_MAP are disjoint', () => {
    for (const channel of LOW_RISK_CHANNELS) {
      expect(HIGH_RISK_CHANNEL_MAP[channel as keyof typeof HIGH_RISK_CHANNEL_MAP]).toBeUndefined();
    }
  });

  it('all InternalizationChannel values are covered', () => {
    const allChannels: InternalizationChannel[] = [
      'prompt', 'defer_archive', 'skill', 'code_tool_hook',
    ];
    // Every channel should have a defined risk level
    for (const channel of allChannels) {
      const riskLevel = getChannelRiskLevel(channel);
      expect(['low', 'medium', 'high']).toContain(riskLevel);
    }
  });
});