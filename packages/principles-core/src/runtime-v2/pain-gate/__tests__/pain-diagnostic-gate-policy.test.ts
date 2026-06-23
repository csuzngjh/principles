/**
 * Pain Diagnostic Gate Policy Tests — PRI-446
 *
 * Tests the pure core decision logic directly (not through the plugin adapter).
 * The plugin's pain-diagnostic-gate.test.ts (40 tests) exercises the same logic
 * via the stateful adapter; this file gives core its own direct coverage with
 * deterministic time (nowMs passed in, no Date.now).
 *
 * ERR checklist:
 * - ERR-001: inputs validated with Number.isFinite.
 * - ERR-002: every decision carries reason + detail.
 * - ERR-025: tests the real evaluatePainDiagnosticGateDecision path.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluatePainDiagnosticGateDecision,
  buildEpisodeKey,
  normalizedSource,
  isCooldownActive,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_PAIN_TRIGGER,
  DEFAULT_HIGH_SEVERITY,
  DEFAULT_REPEATED_FAILURE,
  type PainDiagnosticGateInput,
} from '../pain-diagnostic-gate-policy.js';

function makeInput(overrides: Partial<PainDiagnosticGateInput> = {}): PainDiagnosticGateInput {
  return {
    source: 'tool_failure',
    score: 0,
    currentGfi: 0,
    nowMs: 1_000_000,
    ...overrides,
  };
}

describe('normalizedSource', () => {
  it('maps llm_* (not llm_paralysis) to semantic', () => {
    expect(normalizedSource('llm_repetition').source).toBe('semantic');
    expect(normalizedSource('llm_repetition').unknown).toBe(false);
  });

  it('keeps llm_paralysis as llm_paralysis', () => {
    expect(normalizedSource('llm_paralysis').source).toBe('llm_paralysis');
  });

  it('flags unknown sources', () => {
    const r = normalizedSource('totally_unknown');
    expect(r.source).toBe('totally_unknown');
    expect(r.unknown).toBe(true);
  });

  it('recognizes all known sources', () => {
    for (const s of ['manual', 'tool_failure', 'gate_blocked', 'semantic', 'subagent_error']) {
      expect(normalizedSource(s).unknown).toBe(false);
    }
  });
});

describe('buildEpisodeKey', () => {
  it('scopes by session, source, and hash', () => {
    const key = buildEpisodeKey({ source: 'tool_failure', sessionId: 's1', errorHash: 'h1', score: 0, currentGfi: 0 });
    expect(key).toBe('s1:tool_failure:h1');
  });

  it('falls back to unknown session and no-hash', () => {
    const key = buildEpisodeKey({ source: 'manual', score: 0, currentGfi: 0 });
    expect(key).toBe('unknown:manual:no-hash');
  });

  it('normalizes llm_* source to semantic in the key', () => {
    const key = buildEpisodeKey({ source: 'llm_loop', sessionId: 's', score: 0, currentGfi: 0 });
    expect(key).toBe('s:semantic:no-hash');
  });
});

describe('evaluatePainDiagnosticGateDecision: source branches', () => {
  it('manual always approves (bypasses automatic gate)', () => {
    const d = evaluatePainDiagnosticGateDecision(makeInput({ source: 'manual', score: 0 }));
    expect(d.shouldDiagnose).toBe(true);
    expect(d.reason).toBe('manual');
  });

  it('subagent_error approves when score >= painTrigger', () => {
    const d = evaluatePainDiagnosticGateDecision(makeInput({ source: 'subagent_error', score: 40 }));
    expect(d.shouldDiagnose).toBe(true);
    expect(d.reason).toBe('subagent_error');
  });

  it('subagent_error below gate stays below_gate', () => {
    const d = evaluatePainDiagnosticGateDecision(makeInput({ source: 'subagent_error', score: 39 }));
    expect(d.shouldDiagnose).toBe(false);
    expect(d.reason).toBe('below_gate');
  });

  it('llm_paralysis approves when score >= painTrigger', () => {
    const d = evaluatePainDiagnosticGateDecision(makeInput({ source: 'llm_paralysis', score: 40 }));
    expect(d.reason).toBe('llm_paralysis');
  });

  it('gate_blocked approves when score >= painTrigger', () => {
    const d = evaluatePainDiagnosticGateDecision(makeInput({ source: 'gate_blocked', score: 40 }));
    expect(d.reason).toBe('gate_blocked');
  });

  it('semantic / user_empathy approve when score >= semanticPain', () => {
    const d = evaluatePainDiagnosticGateDecision(makeInput({ source: 'semantic', score: 60 }));
    expect(d.reason).toBe('semantic_pain');
  });

  it('risky high-score approves (isRisky && score >= 70)', () => {
    const d = evaluatePainDiagnosticGateDecision(makeInput({ source: 'tool_failure', score: 70, isRisky: true }));
    expect(d.shouldDiagnose).toBe(true);
    expect(d.reason).toBe('risky_high_score');
  });

  it('repeated failure approves (consecutiveErrors >= 4)', () => {
    const d = evaluatePainDiagnosticGateDecision(makeInput({ source: 'tool_failure', score: 0, consecutiveErrors: 4 }));
    expect(d.shouldDiagnose).toBe(true);
    expect(d.reason).toBe('repeated_failure');
  });

  it('high GFI approves (currentGfi >= highGfi)', () => {
    const d = evaluatePainDiagnosticGateDecision(makeInput({ source: 'tool_failure', currentGfi: 100 }));
    expect(d.shouldDiagnose).toBe(true);
    expect(d.reason).toBe('high_gfi');
  });

  it('nothing triggers → below_gate', () => {
    const d = evaluatePainDiagnosticGateDecision(makeInput({ source: 'tool_failure', score: 0, currentGfi: 0 }));
    expect(d.shouldDiagnose).toBe(false);
    expect(d.reason).toBe('below_gate');
    expect(d.detail).toContain('score=0');
  });
});

describe('evaluatePainDiagnosticGateDecision: input hardening', () => {
  it('NaN score treated as 0', () => {
    const d = evaluatePainDiagnosticGateDecision(makeInput({ source: 'subagent_error', score: Number.NaN }));
    expect(d.reason).toBe('below_gate');
    expect(d.detail).toContain('score=0');
  });

  it('NaN currentGfi treated as 0', () => {
    const d = evaluatePainDiagnosticGateDecision(makeInput({ source: 'tool_failure', currentGfi: Number.NaN }));
    expect(d.reason).toBe('below_gate');
  });

  it('NaN consecutiveErrors treated as 0', () => {
    const d = evaluatePainDiagnosticGateDecision(makeInput({ source: 'tool_failure', consecutiveErrors: Number.NaN }));
    expect(d.reason).toBe('below_gate');
  });
});

describe('evaluatePainDiagnosticGateDecision: cooldown', () => {
  it('within cooldown returns shouldDiagnose=false with reason cooldown', () => {
    const nowMs = 10_000;
    const last = 9_000; // 1000ms ago, well within 15min default
    const d = evaluatePainDiagnosticGateDecision(makeInput({ source: 'manual', nowMs }), last);
    expect(d.shouldDiagnose).toBe(false);
    expect(d.reason).toBe('cooldown');
    expect(d.detail).toContain('recently diagnosed');
  });

  it('outside cooldown approves and the caller should record nowMs', () => {
    const nowMs = 10_000_000;
    const last = 0; // very old
    const d = evaluatePainDiagnosticGateDecision(makeInput({ source: 'manual', nowMs }), last);
    expect(d.shouldDiagnose).toBe(true);
    expect(d.reason).toBe('manual');
  });

  it('cooldownMs <= 0 disables cooldown entirely', () => {
    const nowMs = 10_000;
    const last = 9_999; // 1ms ago
    const d = evaluatePainDiagnosticGateDecision(
      makeInput({ source: 'manual', nowMs, cooldownMs: 0 }),
      last,
    );
    expect(d.shouldDiagnose).toBe(true);
    expect(d.reason).toBe('manual');
  });

  it('never-diagnosed episode (last undefined) is never in cooldown', () => {
    const d = evaluatePainDiagnosticGateDecision(makeInput({ source: 'manual' }), undefined);
    expect(d.shouldDiagnose).toBe(true);
  });
});

describe('isCooldownActive', () => {
  it('true when within window', () => {
    expect(isCooldownActive({ source: 'manual', sessionId: 's', errorHash: 'h', nowMs: 10_000, lastDiagnosedAtMs: 9_000 })).toBe(true);
  });

  it('false when outside window', () => {
    expect(isCooldownActive({ source: 'manual', sessionId: 's', errorHash: 'h', nowMs: 10_000_000, lastDiagnosedAtMs: 0 })).toBe(false);
  });

  it('false when never diagnosed (last undefined)', () => {
    expect(isCooldownActive({ source: 'manual', sessionId: 's', errorHash: 'h', nowMs: 10_000 })).toBe(false);
  });

  it('false when cooldownMs <= 0', () => {
    expect(isCooldownActive({ source: 'manual', sessionId: 's', errorHash: 'h', cooldownMs: 0, nowMs: 10_000, lastDiagnosedAtMs: 9_999 })).toBe(false);
  });
});

describe('default thresholds (migrated constants)', () => {
  it('DEFAULT_COOLDOWN_MS is 15 minutes', () => {
    expect(DEFAULT_COOLDOWN_MS).toBe(15 * 60 * 1000);
  });
  it('DEFAULT_PAIN_TRIGGER is 40', () => {
    expect(DEFAULT_PAIN_TRIGGER).toBe(40);
  });
  it('DEFAULT_HIGH_SEVERITY is 70', () => {
    expect(DEFAULT_HIGH_SEVERITY).toBe(70);
  });
  it('DEFAULT_REPEATED_FAILURE is 4', () => {
    expect(DEFAULT_REPEATED_FAILURE).toBe(4);
  });
});
