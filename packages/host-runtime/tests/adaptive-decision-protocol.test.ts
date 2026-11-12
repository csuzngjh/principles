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
  candidateSafetyQuestionId,
  candidateValueQuestionId,
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

  it('selects the highest score when it clears the applicability threshold', () => {
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

  it('selects the more applicable candidate when two clear the threshold', () => {
    expect(adjudicateDecision(scores(0.9652318, 0.8417906, 0.1), candidates)).toMatchObject({
      status: 'selected', ref: 'c1', reason: 'selected',
    });
  });

  it('does not choose by snapshot order when both candidates tie', () => {
    expect(adjudicateDecision(scores(0.91, 0.91, 0.1), candidates)).toMatchObject({
      status: 'uncertain', ref: null, reason: 'candidate_tied',
    });
  });

  it('returns uncertain when information is insufficient, even with a high candidate score', () => {
    expect(adjudicateDecision(scores(0.91, 0.02, 0.83), candidates)).toMatchObject({
      status: 'uncertain', ref: null, reason: 'information_insufficient',
    });
  });

  it('uses the frozen criteria version, not a per-call tuning knob', () => {
    expect(ADAPTIVE_DECISION_CRITERIA).toEqual({
      version: 'v3-20261112',
      selectThreshold: 0.7,
      insufficientThreshold: 0.6,
    });
  });
});

describe('two-judgment replacement questions', () => {
  const replaceable = [
    { ref: 'c1', text: '交付验收前以可观察证据自检。', digest: 'd1', replaces: '起草阶段先列假设清单。' },
  ];

  it('asks incoming value and outgoing safety as separate conditions', () => {
    const built = buildDecisionRequest(requestInput({ candidates: replaceable }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.questionIds).toEqual([
      candidateValueQuestionId('c1'),
      candidateSafetyQuestionId('c1'),
      ADAPTIVE_DECISION_INSUFFICIENT_QUESTION,
    ]);
    const value = built.body.questions[candidateValueQuestionId('c1')].instructions;
    const safety = built.body.questions[candidateSafetyQuestionId('c1')].instructions;
    expect(value).toContain('直接帮助');
    expect(safety).toContain('replaces');
    // The blended v2 condition is gone for replaceable candidates.
    expect(built.body.questions[candidateQuestionId('c1')]).toBeUndefined();
    expect(JSON.parse(built.body.state)).toMatchObject({ candidates: replaceable });
  });

  it('leaves the append question exactly as before', () => {
    const append = buildDecisionRequest(requestInput());
    const single = buildDecisionRequest(requestInput({
      candidates: [{ ref: 'c1', text: '交付验收前以可观察证据自检。', digest: 'd1' }],
    }));
    expect(append.ok && single.ok).toBe(true);
    if (!append.ok || !single.ok) return;
    expect(single.questionIds).toEqual([candidateQuestionId('c1'), ADAPTIVE_DECISION_INSUFFICIENT_QUESTION]);
    // Same prefix for both refs, so the append wording is byte-identical.
    expect(single.body.questions[candidateQuestionId('c1')].instructions)
      .toBe(append.body.questions[candidateQuestionId('c1')].instructions);
  });

  const one = [{ ref: 'c1', replaces: 'DRAFT' }];
  const answers = (value: number, safety: number, insufficient = 0.05) => ({
    [candidateValueQuestionId('c1')]: value,
    [candidateSafetyQuestionId('c1')]: safety,
    [ADAPTIVE_DECISION_INSUFFICIENT_QUESTION]: insufficient,
  });

  it('selects only when both judgments clear the same line', () => {
    expect(adjudicateDecision(answers(0.82, 0.71), one)).toMatchObject({
      status: 'selected', ref: 'c1', reason: 'selected',
    });
  });

  it('refuses a valuable candidate when the outgoing principle was not shown safe', () => {
    expect(adjudicateDecision(answers(0.93, 0.12), one)).toEqual({
      status: 'none_applicable', ref: null, reason: 'replacement_unsafe', scores: answers(0.93, 0.12),
    });
  });

  it('reports an inapplicable candidate as inapplicable, not as an unsafe removal', () => {
    expect(adjudicateDecision(answers(0.21, 0.9), one)).toMatchObject({
      status: 'none_applicable', reason: 'below_selection_threshold',
    });
  });
});
