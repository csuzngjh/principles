/**
 * Adaptive Activation — shared selection protocol (SPEC v0.6 §4/§7/§9).
 *
 * ONE implementation of the bounded "current turn → pick at most one candidate"
 * protocol, shared by the selector lab and the production host runtimes.
 *
 * PRI-1182 replaced the free-form chat-completions selector with the verified
 * Decisions scoring protocol (`scripts/dev/adaptive-selector-lab/diagnostic.mjs`):
 * one POST carries every candidate's applicability condition plus one
 * "insufficient context" condition; the model returns an INDEPENDENT score per
 * question; PD validates and adjudicates locally
 * (`adaptive-decision-protocol.ts`). The model is never asked to emit a
 * decision, a ref, or a digest.
 *
 * Contract highlights, unchanged from PRI-1122:
 * - The incremental deadline is a FIRST-BYTE deadline, not a whole-generation
 *   wall clock. Once the endpoint has started answering, generation is bounded
 *   by its own window; late completions are still discarded.
 * - One real send per turn, zero retries, zero repair, zero provider fallback.
 * - The host deadline can only shorten the request's own short limit.
 * - Diagnostics never carry the raw prompt, the raw response, or credentials.
 */
import crypto from 'node:crypto';
import type {ActivatedPrinciple} from '@principles/core/runtime';
import {readPromptActivationCandidates} from './active-principle-prompt.js';
import {revalidateAdaptivePrinciple} from './adaptive-principle-revalidation.js';
import {
  adjudicateDecision,
  buildDecisionRequest,
  validateDecisionResponse,
  type DecisionOutcome,
  type DecisionProtocolError,
  type DecisionRequestEnvelope,
} from './adaptive-decision-protocol.js';

export const ADAPTIVE_SELECTION_LIMITS = {
  maxCandidates: 12,
  maxCandidateChars: 600,
  maxPriorMessages: 4,
  maxPriorMessageChars: 1200,
  maxInputChars: 6000,
  /** Total time from sending a decision request to validating the full response. */
  requestTimeoutMs: 2000,
  /** Bounded outbound payload (current instruction + candidate snapshot + conditions). */
  maxPayloadChars: 20_000,
  /** Bounded response body; a Decisions answer table is a few KB at most. */
  maxResponseBytes: 65_536,
  /** Bounded provider usage projection is unnecessary: only token counts are kept. */
} as const;

export type AdaptiveSelectionModel = {
  /** Exact Decisions endpoint (for example https://openrouter.ai/api/alpha/decisions). */
  readonly endpoint: string;
  readonly model: string;
  readonly apiKeyEnv: string;
  /** Optional provider allowlist label (for example Respan). */
  readonly provider?: string;
  /**
   * Frozen exact response-model allowlist for the acceptance batch. When set,
   * a response whose `model` is not one of these strings is rejected — a
   * same-prefix slug with an unregistered date does not pass.
   */
  readonly allowedResponseModels?: readonly string[];
};

export type AdaptiveCandidateSource = ActivatedPrinciple;

export interface AdaptiveCandidate {
  readonly ref: string;
  readonly text: string;
  readonly digest: string;
  readonly principle: AdaptiveCandidateSource;
}

export interface BoundedSelectionInput {
  readonly payload: {
    readonly currentInstruction: string;
    readonly priorMessages: readonly {readonly text: string; readonly source: string; readonly index: number}[];
    readonly candidates: readonly {readonly ref: string; readonly text: string; readonly digest: string}[];
  };
  readonly entries: readonly AdaptiveCandidate[];
  readonly priorDropped: number;
}

export type BuildBoundedInputResult =
  | {readonly ok: true; readonly input: BoundedSelectionInput}
  | {readonly ok: false; readonly reason: string};

export type AdaptiveFailureCode =
  | 'SELECTION_OUTPUT_INVALID'
  | DecisionProtocolError
  /** The host's outer hook window ended Adaptive; distinct from the model's own timeout. */
  | 'TURN_DEADLINE_EXCEEDED'
  /** The request's own short admission/completion window ended. */
  | 'SELECTION_EXPIRED'
  /**
   * Configuration fault: the credential named by `apiKeyEnv` is absent at send
   * time. Deliberately NOT in the TRANSPORT_* family — an operator must be able
   * to tell "we never had a key" apart from "the network broke".
   */
  | 'DECISION_CREDENTIAL_MISSING'
  | 'TRANSPORT_NOT_SENT'
  | 'TRANSPORT_FAILED'
  | 'TRANSPORT_HTTP_ERROR';

export type AdaptiveSelectionStage =
  | 'idle'
  | 'admission'
  | 'generation'
  | 'validate'
  | 'revalidate'
  | 'done';

export interface AdaptiveSelectionDiagnostics {
  stage: AdaptiveSelectionStage;
  readonly requestDeadlineAt: number | null;
  /** Epoch ms at which the single POST was actually issued (null = never sent). */
  requestSentAt: number | null;
  completionDeadlineAt: number | null;
  firstByteAt: number | null;
  generationEndedAt: number | null;
  /** Epoch ms at which the WHOLE answer table passed validation (null = never). */
  validatedAt: number | null;
  cancelledAt: number | null;
  httpStatus: number | null;
  /** `decisions` once a valid answer table was read; `unknown` otherwise. */
  finishReason: string;
  /** Exact response model observed (null until a body was parsed). */
  modelObserved: string | null;
  /** Response provider label observed; null both before parsing and when absent. */
  providerObserved: string | null;
  usage: {inputTokens: number | null; outputTokens: number | null} | null;
  /**
   * Local adjudication of the independent condition scores. Bounded: question
   * ids are `c1..cN` plus `insufficient_context`, never prompt text.
   */
  decision: {
    status: string;
    ref: string | null;
    reason: string;
    scores: Readonly<Record<string, number>>;
  } | null;
  failures: AdaptiveFailureCode[];
}

export function hash(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function boundText(value: string, max: number): string {
  const text = value.replace(/\s+/gu, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function buildBoundedSelectionInput(input: {
  readonly currentInput: string;
  readonly priorMessages?: readonly {readonly text: string; readonly source?: string}[];
  readonly candidates: readonly AdaptiveCandidateSource[];
}): BuildBoundedInputResult {
  const currentInstruction = input.currentInput.trim();
  if (!currentInstruction) return {ok: false, reason: 'CURRENT_INSTRUCTION_EMPTY'};
  if (currentInstruction.length > ADAPTIVE_SELECTION_LIMITS.maxInputChars) {
    return {ok: false, reason: 'CURRENT_INSTRUCTION_TOO_LARGE'};
  }
  const priorMessages = input.priorMessages ?? [];
  const selectedPrior = priorMessages.slice(-ADAPTIVE_SELECTION_LIMITS.maxPriorMessages);
  const boundedPrior = selectedPrior.map((message, index) => ({
    text: boundText(message.text, ADAPTIVE_SELECTION_LIMITS.maxPriorMessageChars),
    source: message.source ?? 'prior',
    index,
  }));
  const entries: AdaptiveCandidate[] = [];
  for (const principle of input.candidates) {
    if (!principle.artifactContentSha256) continue;
    if (!principle.text.trim()) continue;
    const candidateText = boundText(principle.text, ADAPTIVE_SELECTION_LIMITS.maxCandidateChars);
    entries.push({
      ref: `c${entries.length + 1}`,
      text: candidateText,
      // The digest stays part of the frozen candidate snapshot even though the
      // Decisions protocol scores question ids instead of asking for a ref: it
      // lets a later reader recompute exactly what was sent.
      digest: hash(candidateText),
      principle,
    });
    if (entries.length >= ADAPTIVE_SELECTION_LIMITS.maxCandidates) break;
  }
  if (entries.length === 0) return {ok: false, reason: 'NO_CANDIDATES'};
  return {
    ok: true,
    input: {
      payload: {
        currentInstruction,
        priorMessages: boundedPrior,
        candidates: entries.map((entry) => ({ref: entry.ref, text: entry.text, digest: entry.digest})),
      },
      entries,
      priorDropped: Math.max(0, priorMessages.length - selectedPrior.length),
    },
  };
}

/** rc-1/rc-2: parsed payloads are unknown until this guard passes. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function outerDeadlineReached(
  now: () => number,
  outerDeadlineAt: number | undefined,
  signal: AbortSignal | undefined,
): boolean {
  // Without an outer deadline this is an ordinary caller signal; keep the
  // previous SELECTION_EXPIRED / TRANSPORT_FAILED classification for it.
  return outerDeadlineAt !== undefined && (signal?.aborted === true || now() >= outerDeadlineAt);
}

/**
 * The provider caps every model window at the host deadline, so the host
 * deadline can ALSO be the admission/generation deadline. Two timers then end
 * at the same instant: either may run first, and `Date.now()` can still read
 * one millisecond short of the deadline, which made "which controller
 * aborted" decide the diagnostic. The expired window's own deadline is the
 * authority (P4): when it is the host window, the host window is the cause.
 */
function deadlineIsHostWindow(outerDeadlineAt: number | undefined, expiredAt: number | null): boolean {
  return outerDeadlineAt !== undefined && expiredAt !== null && expiredAt >= outerDeadlineAt;
}

interface EmptyDiagnostics {
  stage: AdaptiveSelectionStage;
  requestDeadlineAt: number | null;
  /** Epoch ms at which the single POST was actually issued (null = never sent). */
  requestSentAt: number | null;
  completionDeadlineAt: number | null;
  firstByteAt: number | null;
  generationEndedAt: number | null;
  /** Epoch ms at which the WHOLE answer table passed validation (null = never). */
  validatedAt: number | null;
  cancelledAt: number | null;
  httpStatus: number | null;
  finishReason: string;
  modelObserved: string | null;
  providerObserved: string | null;
  usage: {inputTokens: number | null; outputTokens: number | null} | null;
  /**
   * Local adjudication of the independent condition scores. Bounded: question
   * ids are `c1..cN` plus `insufficient_context`, never prompt text.
   */
  decision: {
    status: string;
    ref: string | null;
    reason: string;
    scores: Readonly<Record<string, number>>;
  } | null;
  failures: AdaptiveFailureCode[];
}

function emptyDiagnostics(): EmptyDiagnostics {
  return {
    stage: 'idle',
    requestDeadlineAt: null,
    requestSentAt: null,
    completionDeadlineAt: null,
    firstByteAt: null,
    generationEndedAt: null,
    validatedAt: null,
    cancelledAt: null,
    httpStatus: null,
    finishReason: 'unknown',
    modelObserved: null,
    providerObserved: null,
    usage: null,
    decision: null,
    failures: [],
  };
}

function projectUsage(value: unknown): {inputTokens: number | null; outputTokens: number | null} | null {
  if (!isRecord(value)) return null;
  const input = value.input_tokens ?? value.prompt_tokens;
  const output = value.output_tokens ?? value.completion_tokens;
  return {
    inputTokens: typeof input === 'number' && Number.isFinite(input) ? input : null,
    outputTokens: typeof output === 'number' && Number.isFinite(output) ? output : null,
  };
}

async function readBoundedBody(response: Response, maxBytes: number, controller: AbortController): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      controller.abort(new Error('RESPONSE_TOO_LARGE'));
      throw new Error('SELECTION_OUTPUT_INVALID');
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) {
        controller.abort(new Error('RESPONSE_TOO_LARGE'));
        throw new Error('SELECTION_OUTPUT_INVALID');
      }
      chunks.push(Buffer.from(part.value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    reader.releaseLock();
  }
}

export interface DecisionSelectorOptions {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly requestTimeoutMs?: number;
  readonly model: AdaptiveSelectionModel;
  readonly signal?: AbortSignal;
  /** Absolute host deadline. Reaching it is NOT the model's generation timeout. */
  readonly outerDeadlineAt?: number;
}

export interface DecisionSelectorInput {
  readonly body: DecisionRequestEnvelope;
  readonly questionIds: readonly string[];
  readonly candidates: readonly AdaptiveCandidate[];
}

export interface DecisionSelector {
  readonly select: (input: DecisionSelectorInput) => Promise<DecisionOutcome>;
  readonly report: () => {
    readonly sends: number;
    readonly status: 'not_sent' | 'sent' | 'failed';
    readonly failure: AdaptiveFailureCode | null;
    readonly diagnostics: AdaptiveSelectionDiagnostics;
  };
}

/**
 * One Decisions POST per turn. Every failure is classified at the transport
 * edge; the caller never sees provider text, headers or credentials.
 */
export function createDecisionSelector(options: DecisionSelectorOptions): DecisionSelector {
  const now = options.now ?? Date.now;
  const requestTimeoutMs = options.requestTimeoutMs ?? ADAPTIVE_SELECTION_LIMITS.requestTimeoutMs;
  const diagnostics = emptyDiagnostics();
  let sends = 0;
  let status: 'not_sent' | 'sent' | 'failed' = 'not_sent';
  let failure: AdaptiveFailureCode | null = null;

  const fail = (code: AdaptiveFailureCode): never => {
    failure = code;
    status = 'failed';
    diagnostics.failures.push(code);
    throw new Error(code);
  };

  const selector = async (input: DecisionSelectorInput): Promise<DecisionOutcome> => {
    if (sends > 0) fail('TRANSPORT_NOT_SENT');
    if (outerDeadlineReached(now, options.outerDeadlineAt, options.signal)) {
      diagnostics.cancelledAt = now();
      fail('TURN_DEADLINE_EXCEEDED');
    }
    const apiKey = process.env[options.model.apiKeyEnv];
    if (!apiKey) fail('DECISION_CREDENTIAL_MISSING');

    const body = JSON.stringify(input.body);
    const sentAt = now();
    if (outerDeadlineReached(() => sentAt, options.outerDeadlineAt, options.signal)) {
      diagnostics.cancelledAt = sentAt;
      fail('TURN_DEADLINE_EXCEEDED');
    }
    const deadlineAt = Math.min(sentAt + requestTimeoutMs, options.outerDeadlineAt ?? Infinity);
    const controller = new AbortController();
    const deadlineError = new Error('DECISION_DEADLINE');
    const timer = setTimeout(() => controller.abort(deadlineError), Math.max(1, deadlineAt - sentAt));
    timer.unref?.();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;

    const expire = (): never => {
      controller.abort(deadlineError);
      diagnostics.cancelledAt = now();
      return fail(outerDeadlineReached(now, options.outerDeadlineAt, options.signal)
        || deadlineIsHostWindow(options.outerDeadlineAt, deadlineAt)
        ? 'TURN_DEADLINE_EXCEEDED'
        : 'SELECTION_EXPIRED');
    };
    const checkDeadline = () => {
      if (outerDeadlineReached(now, options.outerDeadlineAt, options.signal)
        || controller.signal.reason === deadlineError || now() >= deadlineAt) expire();
    };

    sends += 1;
    status = 'sent';
    diagnostics.stage = 'admission';
    diagnostics.requestSentAt = sentAt;
    diagnostics.requestDeadlineAt = deadlineAt;

    try {
      let response: Response;
      try {
        response = await (options.fetchImpl ?? fetch)(options.model.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body,
          signal,
          redirect: 'error',
        });
      } catch {
        checkDeadline();
        return fail('TRANSPORT_FAILED');
      }
      diagnostics.firstByteAt = now();
      diagnostics.httpStatus = response.status;
      checkDeadline();
      if (!response.ok) {
        controller.abort();
        return fail('TRANSPORT_HTTP_ERROR');
      }

      diagnostics.stage = 'generation';
      diagnostics.completionDeadlineAt = deadlineAt;
      let raw: string;
      try {
        raw = await readBoundedBody(response, ADAPTIVE_SELECTION_LIMITS.maxResponseBytes, controller);
      } catch {
        checkDeadline();
        return fail('SELECTION_OUTPUT_INVALID');
      }
      checkDeadline();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return fail('SELECTION_OUTPUT_INVALID');
      }
      const endedAt = now();
      diagnostics.generationEndedAt = endedAt;
      checkDeadline();
      diagnostics.usage = projectUsage(isRecord(parsed) ? parsed.usage : undefined);
      // Record what the endpoint actually claimed BEFORE validating it, so the
      // acceptance report can state observed model/provider instead of
      // inferring a route from the request.
      if (isRecord(parsed)) {
        diagnostics.modelObserved = typeof parsed.model === 'string' ? parsed.model : null;
        diagnostics.providerObserved = typeof parsed.provider === 'string' ? parsed.provider : null;
      }
      diagnostics.stage = 'validate';
      const validated = validateDecisionResponse(parsed, {
        model: options.model.model,
        questionIds: input.questionIds,
        ...(options.model.provider !== undefined ? {provider: options.model.provider} : {}),
        ...(options.model.allowedResponseModels !== undefined
          ? {allowedResponseModels: options.model.allowedResponseModels}
          : {}),
      });
      if (!validated.ok) return fail(validated.reason);
      // The envelope is measured to a VALIDATED table, not to the last byte:
      // a table that only parses after the completion deadline is expired even
      // though the body arrived, so the caller never applies a late decision.
      diagnostics.validatedAt = now();
      checkDeadline();
      diagnostics.finishReason = 'decisions';
      const outcome = adjudicateDecision(validated.scores, input.candidates);
      diagnostics.decision = {
        status: outcome.status,
        ref: outcome.ref,
        reason: outcome.reason,
        scores: validated.scores,
      };
      return outcome;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    select: selector,
    report: () => ({sends, status, failure, diagnostics}),
  };
}

export interface RunAdaptiveSelectionOptions {
  readonly workspaceDir: string;
  readonly currentPrompt: string;
  readonly model: AdaptiveSelectionModel;
  readonly requestTimeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Absolute host deadline shared by selection, revalidation and packing. */
  readonly outerDeadlineAt?: number;
  readonly now?: () => number;
  readonly fetchImpl?: typeof fetch;
}

export interface AdaptiveSelectionOutcome {
  readonly status: 'selected' | 'none' | 'unavailable';
  readonly target: ActivatedPrinciple | null;
  readonly reason: string;
  /** Real transport sends for this turn (0 or 1). */
  readonly sends: number;
  readonly diagnostics: AdaptiveSelectionDiagnostics;
}

/**
 * Minimal host-facing selection step: read the current frozen candidates,
 * make at most one bounded Decisions request, adjudicate locally, then
 * independently revalidate the chosen principle's content/revision/authorization.
 */
export async function runAdaptiveSelection(
  options: RunAdaptiveSelectionOptions,
): Promise<AdaptiveSelectionOutcome> {
  const earlyDiagnostics = emptyDiagnostics();
  const unavailable = (reason: string, stage: AdaptiveSelectionStage): AdaptiveSelectionOutcome => {
    earlyDiagnostics.stage = stage;
    return {status: 'unavailable', target: null, reason, sends: 0, diagnostics: earlyDiagnostics};
  };

  const read = await readPromptActivationCandidates({
    workspaceDir: options.workspaceDir,
    includeAuthority: true,
  });
  if (read.aborted || read.warnings.length > 0) {
    return unavailable(`candidates_unavailable:${read.warnings[0] ?? 'aborted'}`, 'idle');
  }
  const built = buildBoundedSelectionInput({
    currentInput: options.currentPrompt,
    candidates: read.principles,
  });
  if (!built.ok) return unavailable(built.reason, 'idle');
  const request = buildDecisionRequest({
    model: options.model.model,
    ...(options.model.provider !== undefined ? {provider: options.model.provider} : {}),
    currentInstruction: built.input.payload.currentInstruction,
    priorMessages: built.input.payload.priorMessages,
    candidates: built.input.payload.candidates,
    maxPayloadChars: ADAPTIVE_SELECTION_LIMITS.maxPayloadChars,
  });
  if (!request.ok) return unavailable(request.reason, 'idle');

  const selector = createDecisionSelector({
    model: options.model,
    ...(options.requestTimeoutMs !== undefined ? {requestTimeoutMs: options.requestTimeoutMs} : {}),
    ...(options.signal ? {signal: options.signal} : {}),
    ...(options.outerDeadlineAt !== undefined ? {outerDeadlineAt: options.outerDeadlineAt} : {}),
    ...(options.now ? {now: options.now} : {}),
    ...(options.fetchImpl ? {fetchImpl: options.fetchImpl} : {}),
  });

  let decision: DecisionOutcome;
  try {
    decision = await selector.select({
      body: request.body,
      questionIds: request.questionIds,
      candidates: built.input.entries,
    });
  } catch {
    const report = selector.report();
    // The selector owns the failing stage and the failure code; do not
    // overwrite either with a coarser guess.
    const {diagnostics} = report;
    const reason = report.failure ?? 'TRANSPORT_FAILED';
    if (!diagnostics.failures.includes(reason)) diagnostics.failures.push(reason);
    return {status: 'none', target: null, reason, sends: report.sends, diagnostics};
  }
  // The selector owns the timing facts (first byte, completion, cancellation).
  const report = selector.report();
  const {diagnostics} = report;
  const {sends} = report;

  if (decision.status !== 'selected') {
    diagnostics.stage = 'done';
    return {
      status: 'none',
      target: null,
      reason: decision.status === 'uncertain' ? 'uncertain' : 'no_increment',
      sends,
      diagnostics,
    };
  }
  const selected = built.input.entries.find((entry) => entry.ref === decision.ref);
  if (!selected) {
    diagnostics.stage = 'validate';
    diagnostics.failures.push('SELECTION_OUTPUT_INVALID');
    return {status: 'none', target: null, reason: 'SELECTION_OUTPUT_INVALID', sends, diagnostics};
  }

  const target = selected.principle;
  diagnostics.stage = 'revalidate';
  const now = options.now ?? Date.now;
  const revalidationBudgetMs = options.requestTimeoutMs ?? ADAPTIVE_SELECTION_LIMITS.requestTimeoutMs;
  const signal = options.signal ?? AbortSignal.timeout(
    options.outerDeadlineAt === undefined
      ? revalidationBudgetMs
      : Math.max(1, Math.min(revalidationBudgetMs, options.outerDeadlineAt - now())),
  );
  const stillValid = await revalidateAdaptivePrinciple(options.workspaceDir, target, signal);
  const stale = outerDeadlineReached(now, options.outerDeadlineAt, options.signal);
  if (!stillValid || stale) {
    diagnostics.stage = 'done';
    if (stale && !diagnostics.failures.includes('TURN_DEADLINE_EXCEEDED')) {
      diagnostics.failures.push('TURN_DEADLINE_EXCEEDED');
    }
    if (stale) diagnostics.cancelledAt = diagnostics.cancelledAt ?? now();
    return {
      status: 'none',
      target: null,
      reason: stale ? 'TURN_DEADLINE_EXCEEDED' : 'revalidation_failed',
      sends,
      diagnostics,
    };
  }
  diagnostics.stage = 'done';
  return {status: 'selected', target, reason: 'selected', sends, diagnostics};
}
