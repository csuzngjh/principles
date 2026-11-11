/**
 * PRI-1182 — Decisions scoring protocol and local adjudication.
 *
 * The criteria are a PRESET for this acceptance batch. The recorded 2026-11-05
 * numbers below are used only to replay the adjudicator; they did not derive
 * the thresholds.
 */
import { describe, expect, it } from 'vitest';
import {
  ADAPTIVE_DECISION_CRITERIA,
  ADAPTIVE_DECISION_INSUFFICIENT_QUESTION,
  adjudicateDecision,
  buildDecisionRequest,
  candidateQuestionId,
  isDecisionModelIdentity,
  validateDecisionResponse,
} from '../src/adaptive-decision-protocol.js';

const candidates = [
  { ref: 'c1', text: '交付前必须独立验证。', digest: 'd1' },
  { ref: 'c2', text: '修改前先读现状。', digest: 'd2' },
];
const questionIds = [
  candidateQuestionId('c1'),
  candidateQuestionId('c2'),
  ADAPTIVE_DECISION_INSUFFICIENT_QUESTION,
];

function requestInput(overrides: Record<string, unknown> = {}) {
  return {
    model: 'respan/span-01-lite:free',
    provider: 'Respan',
    currentInstruction: '把快速决策端点接上并完成离线验收',
    priorMessages: [],
    candidates,
    maxPayloadChars: 20_000,
    ...overrides,
  };
}

describe('buildDecisionRequest', () => {
  it('sends one request envelope with one condition per candidate plus insufficient_context', () => {
    const built = buildDecisionRequest(requestInput());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.questionIds).toEqual(questionIds);
    expect(Object.keys(built.body.questions)).toHaveLength(3);
    expect(built.body.questions[candidateQuestionId('c1')].type).toBe('noul');
    expect(built.body.questions[candidateQuestionId('c1')].instructions).toContain('c1');
    expect(built.body.questions[ADAPTIVE_DECISION_INSUFFICIENT_QUESTION].instructions).toContain('信息不足');
    // The candidate snapshot travels once, in state — including the digest.
    const state: unknown = JSON.parse(built.body.state);
    expect(state).toMatchObject({ candidates });
    expect(built.body.provider).toEqual({ only: ['Respan'], allow_fallbacks: false });
  });

  it('refuses a payload above the local bound instead of truncating it silently', () => {
    expect(buildDecisionRequest(requestInput({ maxPayloadChars: 50 })))
      .toEqual({ ok: false, reason: 'INPUT_REFUSED' });
  });

  it('refuses an empty candidate set', () => {
    expect(buildDecisionRequest(requestInput({ candidates: [] })))
      .toEqual({ ok: false, reason: 'INPUT_REFUSED' });
  });
});

describe('validateDecisionResponse', () => {
  const valid = {
    model: 'respan/span-01-lite:free',
    answers: {
      [candidateQuestionId('c1')]: { type: 'noul', noul: 0.96 },
      [candidateQuestionId('c2')]: { type: 'noul', noul: 0.04 },
      [ADAPTIVE_DECISION_INSUFFICIENT_QUESTION]: { type: 'noul', noul: 0.1 },
    },
  };

  it('accepts a complete, in-range answer table', () => {
    expect(validateDecisionResponse(valid, { model: 'respan/span-01-lite:free', questionIds }))
      .toEqual({
        ok: true,
        scores: {
          [candidateQuestionId('c1')]: 0.96,
          [candidateQuestionId('c2')]: 0.04,
          [ADAPTIVE_DECISION_INSUFFICIENT_QUESTION]: 0.1,
        },
      });
  });

  it('rejects a different model identity', () => {
    expect(validateDecisionResponse({ ...valid, model: 'someone/else' }, {
      model: 'respan/span-01-lite:free', questionIds,
    })).toEqual({ ok: false, reason: 'DECISION_MODEL_MISMATCH' });
  });

  it('accepts only the verified alias classes for model identity', () => {
    expect(isDecisionModelIdentity('respan/span-01-lite:free', 'respan/span-01-lite')).toBe(true);
    expect(isDecisionModelIdentity('respan/span-01-lite:free', 'respan/span-01-lite-20260925')).toBe(true);
    expect(isDecisionModelIdentity('respan/span-01-lite:free', 'respan/span-01-lite-2026')).toBe(false);
    expect(isDecisionModelIdentity('respan/span-01-lite:free', 'respan/span-01-lite-evil')).toBe(false);
  });

  it('rejects a same-prefix model id whose date is not registered in the frozen allowlist', () => {
    const allowedResponseModels = ['respan/span-01-lite:free', 'respan/span-01-lite-20260925'];
    // The registered canonical slug passes.
    expect(validateDecisionResponse({ ...valid, model: 'respan/span-01-lite-20260925' }, {
      model: 'respan/span-01-lite:free', questionIds, allowedResponseModels,
    }).ok).toBe(true);
    // Same prefix, unregistered date: the alias rule must NOT rescue it.
    expect(validateDecisionResponse({ ...valid, model: 'respan/span-01-lite-20260101' }, {
      model: 'respan/span-01-lite:free', questionIds, allowedResponseModels,
    })).toEqual({ ok: false, reason: 'DECISION_MODEL_MISMATCH' });
    expect(isDecisionModelIdentity(
      'respan/span-01-lite:free',
      'respan/span-01-lite-20260101',
      allowedResponseModels,
    )).toBe(false);
  });

  it('rejects a missing question id', () => {
    const { answers, ...rest } = valid;
    const { [candidateQuestionId('c2')]: _missing, ...partial } = answers;
    expect(validateDecisionResponse({ ...rest, answers: partial }, {
      model: 'respan/span-01-lite:free', questionIds,
    })).toEqual({ ok: false, reason: 'DECISION_QUESTION_MISMATCH' });
  });

  it('rejects an unknown question id, even when all expected ids are present', () => {
    const answers = { ...valid.answers, candidate_c9: { type: 'noul', noul: 0.5 } };
    expect(validateDecisionResponse({ ...valid, answers }, {
      model: 'respan/span-01-lite:free', questionIds,
    })).toEqual({ ok: false, reason: 'DECISION_QUESTION_MISMATCH' });
  });

  it('rejects an out-of-range score', () => {
    const answers = {
      ...valid.answers,
      [candidateQuestionId('c2')]: { type: 'noul', noul: 1.2 },
    };
    expect(validateDecisionResponse({ ...valid, answers }, {
      model: 'respan/span-01-lite:free', questionIds,
    })).toEqual({ ok: false, reason: 'DECISION_SCORE_INVALID' });
  });

  it('rejects a non-noul answer shape', () => {
    const answers = {
      ...valid.answers,
      [candidateQuestionId('c2')]: { type: 'probability', noul: 0.4 },
    };
    expect(validateDecisionResponse({ ...valid, answers }, {
      model: 'respan/span-01-lite:free', questionIds,
    })).toEqual({ ok: false, reason: 'DECISION_OUTPUT_INVALID' });
  });

  it('rejects a provider outside the configured allowlist', () => {
    expect(validateDecisionResponse({ ...valid, provider: 'Other' }, {
      model: 'respan/span-01-lite:free', questionIds, provider: 'Respan',
    })).toEqual({ ok: false, reason: 'DECISION_PROVIDER_MISMATCH' });
  });

  it('accepts the provider identity case-insensitively', () => {
    expect(validateDecisionResponse({ ...valid, provider: 'respan' }, {
      model: 'respan/span-01-lite:free', questionIds, provider: 'Respan',
    }).ok).toBe(true);
  });
});

describe('adjudicateDecision', () => {
  const scores = (c1: number, c2: number, insufficient: number) => ({
    [candidateQuestionId('c1')]: c1,
    [candidateQuestionId('c2')]: c2,
    [ADAPTIVE_DECISION_INSUFFICIENT_QUESTION]: insufficient,
  });

  it('selects the highest score when it clears the threshold and the lead margin', () => {
    // Replay of a recorded score table (2026-11-05): one condition dominates.
    expect(adjudicateDecision(scores(0.9888, 0.0624, 0.2668), candidates)).toMatchObject({
      status: 'selected', ref: 'c1', reason: 'selected',
    });
  });

  it('returns none_applicable when no candidate reaches the threshold', () => {
    // Social / unrelated turn: all applicability conditions stay low.
    expect(adjudicateDecision(scores(0.12, 0.21, 0.18), candidates)).toEqual({
      status: 'none_applicable', ref: null, reason: 'below_selection_threshold',
      scores: scores(0.12, 0.21, 0.18),
    });
  });

  it('returns uncertain when the top two are within the lead margin', () => {
    // Replay of a recorded near-tie: .9565 vs .9594.
    expect(adjudicateDecision(scores(0.9565, 0.9594, 0.1962), candidates)).toMatchObject({
      status: 'uncertain', ref: null, reason: 'lead_below_margin',
    });
  });

  it('returns uncertain when information is insufficient, even with a high candidate score', () => {
    expect(adjudicateDecision(scores(0.91, 0.02, 0.83), candidates)).toMatchObject({
      status: 'uncertain', ref: null, reason: 'information_insufficient',
    });
  });

  it('uses the frozen criteria version, not a per-call tuning knob', () => {
    expect(ADAPTIVE_DECISION_CRITERIA).toEqual({
      version: 'v1-20261111',
      selectThreshold: 0.7,
      leadMargin: 0.25,
      insufficientThreshold: 0.6,
    });
  });
});
