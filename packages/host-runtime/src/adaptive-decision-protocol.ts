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
 * condition. A candidate that would replace an activation answers TWO
 * independent conditions instead (incoming value, outgoing safety), because a
 * single blended score cannot tell "this principle does not fit" apart from
 * "dropping the other principle is unsafe". Each answer is an independent
 * `noul` score in [0, 1] — not a distribution — so PD adjudicates locally
 * instead of trusting the model to emit a decision.
 *
 * Everything here is pure: no I/O, no clock, no transport. The caller owns
 * scheduling, cancellation and diagnostics.
 */

export const ADAPTIVE_DECISION_MAX_CANDIDATE_CHARS = 600;
export const ADAPTIVE_DECISION_INSUFFICIENT_QUESTION = 'insufficient_context';

/**
 * Preset applicability and context guards. Scores are model judgments, not
 * calibrated probabilities.
 *
 * v3: a replaceable candidate is scored by TWO independent conditions
 * (incoming value, outgoing safety). The append path keeps the single
 * condition of v2 unchanged, which is why the version bump is required to
 * tell the two evidence generations apart.
 */
export const ADAPTIVE_DECISION_CRITERIA = {
  version: 'v3-20261112',
  /** A candidate (and, when it replaces something, its safety condition) must reach this score. */
  selectThreshold: 0.7,
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
  readonly candidates: readonly {readonly ref: string; readonly text: string; readonly digest: string; readonly replaces?: string}[];
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

/** Replaceable candidates answer the incoming-value question under this id. */
export function candidateValueQuestionId(ref: string): string {
  return `candidate_${ref}_value`;
}

/** Replaceable candidates answer the outgoing-safety question under this id. */
export function candidateSafetyQuestionId(ref: string): string {
  return `candidate_${ref}_safety`;
}

/**
 * One question per candidate (its applicability condition) plus one
 * "insufficient context" question. Instructions refer to the snapshot by ref;
 * the candidate text itself travels once, in `state`.
 *
 * A candidate that would REPLACE an activation answers two independent
 * conditions instead of one: whether the incoming principle helps the user's
 * next required step, and whether this turn can afford to drop the outgoing
 * principle. Both must clear the same threshold. The append path is untouched.
 */
export function buildDecisionQuestions(
  candidates: readonly {readonly ref: string; readonly text: string; readonly replaces?: string}[],
): DecisionQuestions {
  const questions: Record<string, DecisionQuestion> = {};
  for (const candidate of candidates) {
    if (candidate.replaces === undefined) {
      questions[candidateQuestionId(candidate.ref)] = {
        type: 'noul',
        instructions:
          `依据 currentInstruction 判断用户现在要做什么，并比较 state.candidates。候选 ${candidate.ref} 是否直接适用于这项任务，且最能改善下一步具体行动？`
          + '能避免当前任务的具体失误或补上关键步骤时给高分。仅主题相近、重复用户已明确的要求、或对下一步没有实质帮助时给低分。没有合适候选时全部给低分。',
      };
      continue;
    }
    questions[candidateValueQuestionId(candidate.ref)] = {
      type: 'noul',
      instructions:
        `依据 currentInstruction 判断用户现在要求完成的下一步，并比较 state.candidates。候选 ${candidate.ref} 是否直接帮助完成这一步？`
        + '为完成这一步所需的核对、验证和证据整理也算直接帮助，即使用户没有逐字说出这些动作。'
        + '仅主题相近、重复用户已明确的要求、或对下一步没有实质帮助时给低分。没有合适候选时全部给低分。',
    };
    questions[candidateSafetyQuestionId(candidate.ref)] = {
      type: 'noul',
      instructions:
        `只判断本轮：state.candidates 中候选 ${candidate.ref} 的 replaces 记录了启用它将让位的原原则。`
        + '若启用该候选，本轮能否在保留任务所需约束的前提下省掉这条原原则？'
        + '原原则对本轮仍可能有用、或无法确认可以省掉时给低分；确认本轮不需要它时才给高分。只判断当前轮，不考虑以后。',
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
      ...(candidate.replaces !== undefined ? {replaces: candidate.replaces} : {}),
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
 * Model identity is exact against an explicit allowlist when one is frozen
 * (the acceptance batch does this). Otherwise one bounded alias class is
 * accepted: a `:free` tag may be absent, and a dated canonical slug
 * (`<base>-YYYYMMDD`) is accepted — the two aliases the lab verified.
 *
 * An unregistered DATE is never accepted through the allowlist path: the
 * observed id must be one of the frozen strings, so a same-prefix slug with a
 * different date is a mismatch.
 */
export function isDecisionModelIdentity(
  configured: string,
  observed: string,
  allowedResponseModels?: readonly string[],
): boolean {
  if (allowedResponseModels !== undefined && allowedResponseModels.length > 0) {
    return allowedResponseModels.includes(observed);
  }
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
    /** Frozen exact response-model allowlist. Present = exact membership only. */
    readonly allowedResponseModels?: readonly string[];
  },
): DecisionValidationResult {
  if (!isRecord(value)) return {ok: false, reason: 'DECISION_OUTPUT_INVALID'};
  const {model} = value;
  if (typeof model !== 'string'
    || !isDecisionModelIdentity(expected.model, model, expected.allowedResponseModels)) {
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
      readonly reason:
        | 'below_selection_threshold'
        /** The incoming candidate fits, but dropping the listed outgoing principle was not shown safe this turn. */
        | 'replacement_unsafe'
        | 'candidate_tied'
        | 'information_insufficient';
      readonly scores: Readonly<Record<string, number>>;
    };

/**
 * Local adjudication of the INDEPENDENT condition scores. Order matters:
 * insufficient information first (it invalidates any candidate ranking), then
 * eligibility, then the applicability ranking.
 *
 * A candidate that replaces something is eligible only when BOTH its value and
 * its safety condition clear the threshold. PD never lets a high incoming
 * score override an unsafe removal, and `replacement_unsafe` keeps that
 * failure distinguishable from "the candidate itself did not fit".
 */
export function adjudicateDecision(
  scores: Readonly<Record<string, number>>,
  candidates: readonly {readonly ref: string; readonly replaces?: string}[],
  criteria: typeof ADAPTIVE_DECISION_CRITERIA = ADAPTIVE_DECISION_CRITERIA,
): DecisionOutcome {
  const insufficient = scores[ADAPTIVE_DECISION_INSUFFICIENT_QUESTION];
  if (insufficient !== undefined && insufficient >= criteria.insufficientThreshold) {
    return {status: 'uncertain', ref: null, reason: 'information_insufficient', scores};
  }
  const evaluated = candidates.map((candidate) => {
    const replaceable = candidate.replaces !== undefined;
    const value = scores[replaceable
      ? candidateValueQuestionId(candidate.ref)
      : candidateQuestionId(candidate.ref)] ?? 0;
    const safety = replaceable ? scores[candidateSafetyQuestionId(candidate.ref)] ?? 0 : null;
    return {
      ref: candidate.ref,
      value,
      eligible: value >= criteria.selectThreshold
        && (safety === null || safety >= criteria.selectThreshold),
    };
  });
  const ranked = evaluated
    .filter((candidate) => candidate.eligible)
    .sort((left, right) => right.value - left.value);
  const [top, runnerUp] = ranked;
  if (!top) {
    const applicable = evaluated.some((candidate) => candidate.value >= criteria.selectThreshold);
    return {
      status: 'none_applicable',
      ref: null,
      reason: applicable ? 'replacement_unsafe' : 'below_selection_threshold',
      scores,
    };
  }
  if (runnerUp && top.value === runnerUp.value) {
    return {status: 'uncertain', ref: null, reason: 'candidate_tied', scores};
  }
  return {status: 'selected', ref: top.ref, reason: 'selected', scores};
}
