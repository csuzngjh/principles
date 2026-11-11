/**
 * PRI-1182 — Adaptive Activation: the real Decisions scoring protocol.
 *
 * Extracted from the already-verified lab implementation
 * (`scripts/dev/adaptive-selector-lab/diagnostic.mjs`): one POST with
 * `{model, state, questions, provider}`, one `{model, answers}` response.
 *
 * The difference from the lab experiment is the QUESTION SET: the lab asked
 * four task-level questions, while production asks one independent
 * applicability condition per candidate plus one "insufficient context"
 * condition. Each answer is an independent `noul` score in [0, 1] — not a
 * distribution — so PD adjudicates locally instead of trusting the model to
 * emit a decision.
 *
 * Everything here is pure: no I/O, no clock, no transport. The caller owns
 * scheduling, cancellation and diagnostics.
 */

export const ADAPTIVE_DECISION_INSUFFICIENT_QUESTION = 'insufficient_context';

/**
 * FROZEN evaluation criteria (PRI-1182 §1: thresholds are set from the
 * development samples, then frozen).
 *
 * Basis — the only real Decisions samples recorded on this path
 * (results.json, OpenRouter `respan/span-01-lite:free`, 2026-11-05):
 *   dev-02  new_task .9594  goal_shift .9565  phase_shift .0708  insufficient .1962
 *   dev-03  new_task .0496  goal_shift .9958  phase_shift .2068  insufficient .1375
 *   dev-04  new_task .0624  goal_shift .0340  phase_shift .9888  insufficient .2668
 *
 * Applicable conditions are >= .9565, non-applicable <= .2068, and
 * "insufficient" never exceeded .2668. `selectThreshold` sits between those
 * bands; `leadMargin` rejects the dev-02 shape (a near-tie between two
 * conditions, .9565 vs .9594); `insufficientThreshold` keeps >2x headroom above
 * every observed "sufficient" answer.
 *
 * Do NOT tune these per failing turn: changing them is a product decision that
 * requires a new version string and fresh dev samples.
 */
export const ADAPTIVE_DECISION_CRITERIA = {
  version: 'v1-20261111',
  /** A candidate must reach this independent score to be eligible. */
  selectThreshold: 0.7,
  /** The winner must lead the runner-up by this much, or the turn is ambiguous. */
  leadMargin: 0.25,
  /** Above this "information is insufficient" score, PD refuses to select. */
  insufficientThreshold: 0.6,
} as const;

export interface DecisionQuestion {
  readonly type: 'noul';
  readonly instructions: string;
}

export type DecisionQuestions = Record<string, DecisionQuestion>;

export interface DecisionRequestEnvelope {
  readonly model: string;
  readonly state: string;
  readonly questions: DecisionQuestions;
  readonly provider?: {readonly only: readonly string[]; readonly allow_fallbacks: false};
}

export type DecisionProtocolError =
  | 'DECISION_MODEL_MISMATCH'
  | 'DECISION_PROVIDER_MISMATCH'
  | 'DECISION_OUTPUT_INVALID'
  | 'DECISION_QUESTION_MISMATCH'
  | 'DECISION_SCORE_INVALID'
  | 'INPUT_REFUSED';

export interface BuildDecisionRequestInput {
  readonly model: string;
  readonly provider?: string;
  readonly currentInstruction: string;
  readonly priorMessages: readonly {readonly text: string; readonly source: string; readonly index: number}[];
  readonly candidates: readonly {readonly ref: string; readonly text: string; readonly digest: string}[];
  /** Bounded by the caller; a request larger than this is refused locally. */
  readonly maxPayloadChars: number;
}

export type BuildDecisionRequestResult =
  | {
      readonly ok: true;
      readonly body: DecisionRequestEnvelope;
      readonly questionIds: readonly string[];
    }
  | {readonly ok: false; readonly reason: DecisionProtocolError};

export function candidateQuestionId(ref: string): string {
  return `candidate_${ref}`;
}

/**
 * One question per candidate (its applicability condition) plus one
 * "insufficient context" question. Instructions refer to the snapshot by ref;
 * the candidate text itself travels once, in `state`.
 */
export function buildDecisionQuestions(
  candidates: readonly {readonly ref: string; readonly text: string}[],
): DecisionQuestions {
  const questions: Record<string, DecisionQuestion> = {};
  for (const candidate of candidates) {
    questions[candidateQuestionId(candidate.ref)] = {
      type: 'noul',
      instructions:
        `候选 ${candidate.ref} 的适用性：仅当当前输入明确要求交付、实现、修复、审查或验证，`
        + `且这条候选（见 state.candidates.${candidate.ref}）会改变这一步的具体做法时，概率接近 1；`
        + '仅礼貌、闲聊、元问题或与当前任务无关时，概率接近 0。',
    };
  }
  questions[ADAPTIVE_DECISION_INSUFFICIENT_QUESTION] = {
    type: 'noul',
    instructions:
      '信息不足：当前输入是否缺少判断候选是否适用所需的信息（例如只有确认词、指代不明、'
      + '不知道在问哪一个任务）？信息不足时概率接近 1；能够明确判断时为 0。',
  };
  return questions;
}

export function buildDecisionRequest(
  input: BuildDecisionRequestInput,
): BuildDecisionRequestResult {
  if (input.candidates.length === 0) {
    return {ok: false, reason: 'INPUT_REFUSED'};
  }
  const questions = buildDecisionQuestions(input.candidates);
  const state = {
    currentInstruction: input.currentInstruction,
    priorMessages: input.priorMessages,
    candidates: input.candidates.map((candidate) => ({
      ref: candidate.ref,
      text: candidate.text,
      digest: candidate.digest,
    })),
  };
  const body: DecisionRequestEnvelope = {
    model: input.model,
    state: JSON.stringify(state),
    questions,
    ...(input.provider
      ? {provider: {only: [input.provider], allow_fallbacks: false}}
      : {}),
  };
  if (JSON.stringify({state: body.state, questions}).length > input.maxPayloadChars) {
    return {ok: false, reason: 'INPUT_REFUSED'};
  }
  return {
    ok: true,
    body,
    questionIds: [...Object.keys(questions)],
  };
}

/** rc-1/rc-2: parsed JSON is unknown until these guards pass. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Model identity is exact, plus one bounded alias class: a `:free` tag may be
 * absent, and a dated canonical slug (`<base>-YYYYMMDD`) is accepted — the two
 * aliases the lab verified against the provider catalog. Nothing else.
 */
export function isDecisionModelIdentity(configured: string, observed: string): boolean {
  if (configured === observed) return true;
  const base = configured.endsWith(':free') ? configured.slice(0, -':free'.length) : configured;
  if (base === observed) return true;
  return new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}-\\d{8}$`, 'u').test(observed);
}

export type DecisionValidationResult =
  | {readonly ok: true; readonly scores: Readonly<Record<string, number>>}
  | {readonly ok: false; readonly reason: DecisionProtocolError};

/**
 * Validates model identity, provider identity (when configured), completeness
 * of the exact question set, and every score range. Any missing, extra or
 * malformed answer is a rejected turn — never a partial score table.
 */
export function validateDecisionResponse(
  value: unknown,
  expected: {
    readonly model: string;
    readonly questionIds: readonly string[];
    readonly provider?: string;
  },
): DecisionValidationResult {
  if (!isRecord(value)) return {ok: false, reason: 'DECISION_OUTPUT_INVALID'};
  const {model} = value;
  if (typeof model !== 'string' || !isDecisionModelIdentity(expected.model, model)) {
    return {ok: false, reason: 'DECISION_MODEL_MISMATCH'};
  }
  if (expected.provider !== undefined) {
    const {provider} = value;
    if (provider !== undefined
      && (typeof provider !== 'string' || provider.toLowerCase() !== expected.provider.toLowerCase())) {
      return {ok: false, reason: 'DECISION_PROVIDER_MISMATCH'};
    }
  }
  const {answers} = value;
  if (!isRecord(answers)) return {ok: false, reason: 'DECISION_OUTPUT_INVALID'};
  const answerKeys = Object.keys(answers);
  if (answerKeys.length !== expected.questionIds.length
    || expected.questionIds.some((id) => !Object.hasOwn(answers, id))) {
    return {ok: false, reason: 'DECISION_QUESTION_MISMATCH'};
  }
  const scores: Record<string, number> = {};
  for (const id of expected.questionIds) {
    const answer = answers[id];
    if (!isRecord(answer) || answer.type !== 'noul') {
      return {ok: false, reason: 'DECISION_OUTPUT_INVALID'};
    }
    const {noul} = answer;
    if (typeof noul !== 'number' || !Number.isFinite(noul) || noul < 0 || noul > 1) {
      return {ok: false, reason: 'DECISION_SCORE_INVALID'};
    }
    scores[id] = noul;
  }
  return {ok: true, scores};
}

export type DecisionOutcome =
  | {
      readonly status: 'selected';
      readonly ref: string;
      readonly reason: 'selected';
      readonly scores: Readonly<Record<string, number>>;
    }
  | {
      readonly status: 'none_applicable' | 'uncertain';
      readonly ref: null;
      readonly reason: 'below_selection_threshold' | 'lead_below_margin' | 'information_insufficient';
      readonly scores: Readonly<Record<string, number>>;
    };

/**
 * Local adjudication of the INDEPENDENT condition scores. Order matters:
 * insufficient information first (it invalidates any candidate ranking), then
 * the eligibility threshold, then the lead margin.
 */
export function adjudicateDecision(
  scores: Readonly<Record<string, number>>,
  candidates: readonly {readonly ref: string}[],
  criteria: typeof ADAPTIVE_DECISION_CRITERIA = ADAPTIVE_DECISION_CRITERIA,
): DecisionOutcome {
  const insufficient = scores[ADAPTIVE_DECISION_INSUFFICIENT_QUESTION];
  if (insufficient !== undefined && insufficient >= criteria.insufficientThreshold) {
    return {status: 'uncertain', ref: null, reason: 'information_insufficient', scores};
  }
  const ranked = candidates
    .map((candidate) => ({
      ref: candidate.ref,
      score: scores[candidateQuestionId(candidate.ref)] ?? 0,
    }))
    .sort((left, right) => right.score - left.score);
  const [top, runnerUp] = ranked;
  if (!top || top.score < criteria.selectThreshold) {
    return {status: 'none_applicable', ref: null, reason: 'below_selection_threshold', scores};
  }
  if (runnerUp && top.score - runnerUp.score < criteria.leadMargin) {
    return {status: 'uncertain', ref: null, reason: 'lead_below_margin', scores};
  }
  return {status: 'selected', ref: top.ref, reason: 'selected', scores};
}
