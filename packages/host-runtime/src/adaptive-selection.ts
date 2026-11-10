/**
 * Adaptive Activation — shared selection protocol (SPEC v0.6 §4/§7/§9).
 *
 * ONE implementation of the bounded "current turn → pick at most one candidate"
 * protocol, shared by the selector lab and the production host runtimes.
 *
 * Contract highlights (PRI-1122 measurement findings):
 * - Candidates are sent with a LOCALLY PRECOMPUTED digest. The model can only
 *   copy it; it is never asked to compute a hash. A payload without digests
 *   makes every `selected` answer invalid by construction.
 * - The incremental deadline is a FIRST-BYTE deadline, not a whole-generation
 *   wall clock. Once the endpoint has started answering, generation is bounded
 *   by its own window; late completions are still discarded.
 * - One real send per turn, zero retries, zero repair, zero provider fallback.
 * - Diagnostics never carry the raw prompt, the raw response, or credentials.
 */
import crypto from 'node:crypto';
import {
  PiAiRuntimeAdapter,
  StoreEventEmitter,
  type ActivatedPrinciple,
} from '@principles/core/runtime';
import {readPromptActivationCandidates} from './active-principle-prompt.js';
import {revalidateAdaptivePrinciple} from './adaptive-principle-revalidation.js';

export const ADAPTIVE_SELECTION_LIMITS = {
  maxCandidates: 12,
  maxCandidateChars: 600,
  maxPriorMessages: 4,
  maxPriorMessageChars: 1200,
  maxInputChars: 6000,
  /** Admission (time-to-first-byte) deadline for the incremental step. */
  firstByteTimeoutMs: 10_000,
  /** Bounded completion window once the endpoint has started answering. */
  generationTimeoutMs: 10_000,
  maxOutputTokens: 512,
} as const;

export type AdaptiveSelectionModel = {
  readonly provider: string;
  readonly model: string;
  readonly apiKeyEnv: string;
  /** Exact request URL when the caller already knows it (lab). */
  readonly url?: string;
  /** Outbound allowlist prefix when only a base URL is known (production). */
  readonly baseUrl?: string;
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
    /** `digest` is precomputed locally and only copied by the model. */
    readonly candidates: readonly {readonly ref: string; readonly text: string; readonly digest: string}[];
  };
  readonly entries: readonly AdaptiveCandidate[];
  readonly priorDropped: number;
}

export type BuildBoundedInputResult =
  | {readonly ok: true; readonly input: BoundedSelectionInput}
  | {readonly ok: false; readonly reason: string};

export type SelectionShape =
  | {readonly status: 'selected'; readonly id: string; readonly digest: string}
  | {readonly status: 'none_applicable' | 'uncertain'; readonly id: null; readonly digest: null};

export type ValidateSelectionResult =
  | {
      readonly ok: true;
      readonly selected: AdaptiveCandidate | null;
      readonly outcome: 'selected' | 'no_increment' | 'uncertain';
    }
  | {readonly ok: false; readonly reason: string; readonly refValid: boolean | null; readonly digestValid: boolean | null};

export type AdaptiveFailureCode =
  | 'SELECTION_REFERENCE_INVALID'
  | 'SELECTION_DIGEST_INVALID'
  | 'SELECTION_OUTPUT_INVALID'
  | 'SELECTION_AMBIGUOUS'
  | 'SELECTION_EXPIRED'
  | 'TRANSPORT_NOT_SENT'
  | 'TRANSPORT_FAILED'
  | 'INPUT_REFUSED';

export type AdaptiveSelectionStage =
  | 'idle'
  | 'admission'
  | 'generation'
  | 'validate'
  | 'revalidate'
  | 'done';

export interface AdaptiveSelectionDiagnostics {
  stage: AdaptiveSelectionStage;
  readonly admissionDeadlineAt: number;
  completionDeadlineAt: number | null;
  firstByteAt: number | null;
  generationEndedAt: number | null;
  cancelledAt: number | null;
  httpStatus: number | null;
  /** Server-reported finish reason, or 'unknown' when the transport does not expose one. */
  finishReason: string;
  usage: {inputTokens: number | null; outputTokens: number | null} | null;
  failures: AdaptiveFailureCode[];
}

export function hash(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export const ADAPTIVE_SELECTOR_SYSTEM = [
  '你是 Principles Disciple 的原则选择器。只判断：当前用户输入是否需要追加一条已批准原则。',
  '候选只在「当前输入明确要求交付、实现、修复、审查或验证，且这条原则会改变你这一步的做法」时才算适用。',
  '通用礼貌、闲聊、元问题、与当前任务无关的原则一律不选。',
  '只能返回下面三种 JSON 之一，不要 Markdown、不要解释：',
  '{"status":"selected","id":"候选引用（例如 c1）","digest":"该候选随附的 digest 原样复制；不要计算或改写","reason":"一句话理由"}',
  '{"status":"none_applicable","id":null,"digest":null,"reason":"一句话理由"}',
  '{"status":"uncertain","id":null,"digest":null,"reason":"一句话理由"}',
  'digest 由本地预计算并随候选下发；必须逐字符原样返回所选候选的 digest。',
  '最多只能选一条。',
].join('\n');

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
      // Digest the body exactly as it goes on the wire, so the model can copy it
      // and anyone can recompute it from the request it actually received.
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
        // The digest is part of the outbound contract: the model copies it.
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

export function parseSelectionShape(value: unknown):
  | {readonly ok: true; readonly selection: SelectionShape}
  | {readonly ok: false; readonly reason: string} {
  if (!isRecord(value)) {
    return {ok: false, reason: 'SELECTION_OUTPUT_INVALID'};
  }
  const {status} = value;
  const {id} = value;
  const {digest} = value;
  if (status === 'selected') {
    if (typeof id !== 'string' || !id) return {ok: false, reason: 'SELECTION_OUTPUT_INVALID'};
    if (typeof digest !== 'string' || !digest) return {ok: false, reason: 'SELECTION_DIGEST_INVALID'};
    return {ok: true, selection: {status: 'selected', id, digest}};
  }
  if (status === 'none_applicable' || status === 'uncertain') {
    if (id !== null && id !== undefined) return {ok: false, reason: 'SELECTION_OUTPUT_INVALID'};
    if (digest !== null && digest !== undefined) return {ok: false, reason: 'SELECTION_OUTPUT_INVALID'};
    return {ok: true, selection: {status, id: null, digest: null}};
  }
  return {ok: false, reason: 'SELECTION_OUTPUT_INVALID'};
}

export function validateSelectionResult(
  value: unknown,
  entries: readonly AdaptiveCandidate[],
): ValidateSelectionResult {
  const parsed = parseSelectionShape(value);
  if (!parsed.ok) {
    return {
      ok: false,
      reason: parsed.reason,
      refValid: null,
      digestValid: null,
    };
  }
  const {selection} = parsed;
  if (selection.status !== 'selected') {
    return {
      ok: true,
      selected: null,
      outcome: selection.status === 'uncertain' ? 'uncertain' : 'no_increment',
    };
  }
  const entry = entries.find((candidate) => candidate.ref === selection.id);
  if (!entry) {
    return {ok: false, reason: 'SELECTION_REFERENCE_INVALID', refValid: false, digestValid: null};
  }
  // Two independent computations of the wire-body digest must agree: the value
  // frozen into the candidate table and a fresh hash of the frozen body.
  if (selection.digest !== entry.digest || selection.digest !== hash(entry.text)) {
    return {ok: false, reason: 'SELECTION_DIGEST_INVALID', refValid: true, digestValid: false};
  }
  if (entries.some((candidate) => candidate !== entry && candidate.principle.principleId === entry.principle.principleId)) {
    return {ok: false, reason: 'SELECTION_AMBIGUOUS', refValid: true, digestValid: true};
  }
  return {ok: true, selected: entry, outcome: 'selected'};
}

export function localFailureCode(reason: string): AdaptiveFailureCode {
  if (reason === 'SELECTION_OUTPUT_INVALID') return 'SELECTION_OUTPUT_INVALID';
  if (reason === 'SELECTION_DIGEST_INVALID') return 'SELECTION_DIGEST_INVALID';
  if (reason === 'SELECTION_REFERENCE_INVALID') return 'SELECTION_REFERENCE_INVALID';
  if (reason === 'SELECTION_AMBIGUOUS') return 'SELECTION_AMBIGUOUS';
  if (reason === 'SELECTION_EXPIRED') return 'SELECTION_EXPIRED';
  return 'SELECTION_OUTPUT_INVALID';
}

export interface SingleModelSelectorOptions {
  readonly PiAiRuntimeAdapterImpl?: typeof PiAiRuntimeAdapter;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  /** Absolute deadline for the first byte of the model response. */
  readonly admissionDeadlineAt: number;
  readonly generationTimeoutMs?: number;
  readonly model: AdaptiveSelectionModel;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

export interface SingleModelSelector {
  readonly select: (input: BoundedSelectionInput) => Promise<unknown>;
  readonly report: () => {
    readonly sends: number;
    readonly status: 'not_sent' | 'sent' | 'failed';
    readonly failure: AdaptiveFailureCode | null;
    readonly diagnostics: AdaptiveSelectionDiagnostics;
  };
}

interface FinishMetadata {
  finishReason: string;
  usage: {inputTokens: number | null; outputTokens: number | null} | null;
}

function emptyDiagnostics(admissionDeadlineAt: number): AdaptiveSelectionDiagnostics {
  return {
    stage: 'idle',
    admissionDeadlineAt,
    completionDeadlineAt: null,
    firstByteAt: null,
    generationEndedAt: null,
    cancelledAt: null,
    httpStatus: null,
    finishReason: 'unknown',
    usage: null,
    failures: [],
  };
}

function parseFinishMetadata(raw: string): FinishMetadata {
  const result: FinishMetadata = {finishReason: 'unknown', usage: null};
  const absorb = (parsed: unknown): void => {
    if (!isRecord(parsed)) return;
    const {choices} = parsed;
    if (Array.isArray(choices) && choices.length > 0) {
      const [first] = choices;
      if (isRecord(first)) {
        const finish = first.finish_reason;
        if (typeof finish === 'string' && finish) result.finishReason = finish;
      }
    }
    const {usage} = parsed;
    if (isRecord(usage)) {
      const input = usage.prompt_tokens ?? usage.input_tokens;
      const output = usage.completion_tokens ?? usage.output_tokens;
      result.usage = {
        inputTokens: typeof input === 'number' ? input : null,
        outputTokens: typeof output === 'number' ? output : null,
      };
    }
  };
  const trimmed = raw.trim();
  if (!trimmed) return result;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      absorb(JSON.parse(trimmed));
      return result;
    } catch {
      return result;
    }
  }
  for (const line of trimmed.split(/\r?\n/u)) {
    const payload = line.startsWith('data:') ? line.slice(5).trim() : '';
    if (!payload || payload === '[DONE]') continue;
    try {
      absorb(JSON.parse(payload));
    } catch {
      // Ignore non-JSON keep-alives; diagnostics stay 'unknown' rather than guessing.
    }
  }
  return result;
}

export function createSingleModelSelector(options: SingleModelSelectorOptions): SingleModelSelector {
  const now = options.now ?? Date.now;
  const Adapter = options.PiAiRuntimeAdapterImpl ?? PiAiRuntimeAdapter;
  const generationTimeoutMs = options.generationTimeoutMs ?? ADAPTIVE_SELECTION_LIMITS.generationTimeoutMs;
  const maxTokens = options.maxTokens ?? ADAPTIVE_SELECTION_LIMITS.maxOutputTokens;
  const diagnostics = emptyDiagnostics(options.admissionDeadlineAt);
  let sends = 0;
  let status: 'not_sent' | 'sent' | 'failed' = 'not_sent';
  let failure: AdaptiveFailureCode | null = null;
  let finishMetadata: Promise<FinishMetadata> = Promise.resolve({finishReason: 'unknown', usage: null});

  const fail: (code: AdaptiveFailureCode) => never = (code) => {
    failure = code;
    status = 'failed';
    diagnostics.failures.push(code);
    throw new Error(code);
  };

  const selector = async (input: BoundedSelectionInput): Promise<unknown> => {
    if (sends > 0) fail('TRANSPORT_NOT_SENT');
    if (options.signal?.aborted || now() >= options.admissionDeadlineAt) {
      diagnostics.cancelledAt = now();
      fail('SELECTION_EXPIRED');
    }
    const remainingAdmission = Math.max(1, options.admissionDeadlineAt - now());
    const ttfbController = new AbortController();
    const ttfbTimer = setTimeout(() => ttfbController.abort(new Error('ADMISSION_DEADLINE')), remainingAdmission);
    ttfbTimer.unref?.();
    let firstByteAt: number | null = null;
    let completionDeadlineAt: number | null = null;

    const guardedFetch: typeof fetch = async (resource, init) => {
      const url = resource instanceof Request ? resource.url : String(resource);
      const requestInit = init ?? {};
      if (options.model.url) {
        if (url !== options.model.url) fail('TRANSPORT_NOT_SENT');
      } else if (options.model.baseUrl) {
        if (!url.startsWith(options.model.baseUrl)) fail('TRANSPORT_NOT_SENT');
      } else if (!url.startsWith('https://')) {
        fail('TRANSPORT_NOT_SENT');
      }
      let body: Record<string, unknown> | null;
      try {
        const parsed: unknown = typeof requestInit.body === 'string' ? JSON.parse(requestInit.body) : null;
        body = isRecord(parsed) ? parsed : null;
      } catch {
        body = null;
      }
      if (!body || body.model !== options.model.model) fail('TRANSPORT_NOT_SENT');
      if (body.max_tokens !== maxTokens) fail('TRANSPORT_NOT_SENT');
      const apiKey = process.env[options.model.apiKeyEnv];
      if (!apiKey) fail('TRANSPORT_NOT_SENT');

      sends += 1;
      status = 'sent';
      diagnostics.stage = 'admission';
      const combined = AbortSignal.any([
        ...(requestInit.signal ? [requestInit.signal] : []),
        ttfbController.signal,
        ...(options.signal ? [options.signal] : []),
      ]);
      let response: Response;
      try {
        response = await (options.fetchImpl ?? fetch)(url, {...requestInit, signal: combined, redirect: 'error'});
      } catch (error) {
        diagnostics.cancelledAt = now();
        diagnostics.stage = 'admission';
        fail(ttfbController.signal.aborted ? 'SELECTION_EXPIRED' : 'TRANSPORT_FAILED');
        throw error;
      }
      // First byte is here: stop the admission clock, start the completion window.
      firstByteAt = now();
      diagnostics.firstByteAt = firstByteAt;
      diagnostics.httpStatus = response.status;
      clearTimeout(ttfbTimer);
      if (firstByteAt >= options.admissionDeadlineAt) {
        diagnostics.cancelledAt = firstByteAt;
        fail('SELECTION_EXPIRED');
      }
      completionDeadlineAt = firstByteAt + generationTimeoutMs;
      diagnostics.completionDeadlineAt = completionDeadlineAt;
      diagnostics.stage = 'generation';
      try {
        const clone = response.clone();
        finishMetadata = clone
          .text()
          .then((raw) => parseFinishMetadata(raw))
          .catch(() => ({finishReason: 'unknown', usage: null}));
      } catch {
        finishMetadata = Promise.resolve({finishReason: 'unknown', usage: null});
      }
      return response;
    };

    try {
      const adapter = new Adapter({
        provider: options.model.provider,
        model: options.model.model,
        ...(options.model.baseUrl ? {baseUrl: options.model.baseUrl} : {}),
        apiKeyEnv: options.model.apiKeyEnv,
        maxRetries: 0,
        maxRepairAttempts: 0,
        outputPathStrategy: 'free_form_only',
        reasoning: 'low',
        timeoutMs: remainingAdmission + generationTimeoutMs,
        maxTokens,
        fetch: guardedFetch,
        eventEmitter: new StoreEventEmitter(),
      });
      const run = await adapter.startRun({
        agentSpec: {agentId: 'adaptive-principle-selector', schemaVersion: 'current'},
        inputPayload: input.payload,
        contextItems: [],
        timeoutMs: remainingAdmission + generationTimeoutMs,
        maxTokens,
        systemPrompt: ADAPTIVE_SELECTOR_SYSTEM,
      });
      const output = await adapter.fetchOutput(run.runId);
      const endedAt = now();
      diagnostics.generationEndedAt = endedAt;
      if (!output) fail('SELECTION_OUTPUT_INVALID');
      if (options.signal?.aborted || (completionDeadlineAt !== null && endedAt > completionDeadlineAt)) {
        diagnostics.cancelledAt = endedAt;
        fail('SELECTION_EXPIRED');
      }
      const metadata = await finishMetadata;
      diagnostics.finishReason = metadata.finishReason;
      diagnostics.usage = metadata.usage;
      diagnostics.stage = 'validate';
      return output.payload;
    } finally {
      clearTimeout(ttfbTimer);
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
  /** Absolute first-byte deadline for the incremental step. */
  readonly admissionDeadlineAt: number;
  readonly model: AdaptiveSelectionModel;
  readonly generationTimeoutMs?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly fetchImpl?: typeof fetch;
  readonly PiAiRuntimeAdapterImpl?: typeof PiAiRuntimeAdapter;
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
 * make at most one bounded model call, verify ref+digest, then independently
 * revalidate the chosen principle's content/revision/authorization.
 */
export async function runAdaptiveSelection(
  options: RunAdaptiveSelectionOptions,
): Promise<AdaptiveSelectionOutcome> {
  const earlyDiagnostics = emptyDiagnostics(options.admissionDeadlineAt);
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

  const selector = createSingleModelSelector({
    admissionDeadlineAt: options.admissionDeadlineAt,
    model: options.model,
    ...(options.generationTimeoutMs !== undefined ? {generationTimeoutMs: options.generationTimeoutMs} : {}),
    ...(options.maxTokens !== undefined ? {maxTokens: options.maxTokens} : {}),
    ...(options.signal ? {signal: options.signal} : {}),
    ...(options.now ? {now: options.now} : {}),
    ...(options.fetchImpl ? {fetchImpl: options.fetchImpl} : {}),
    ...(options.PiAiRuntimeAdapterImpl
      ? {PiAiRuntimeAdapterImpl: options.PiAiRuntimeAdapterImpl}
      : {}),
  });

  let payload: unknown;
  try {
    payload = await selector.select(built.input);
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

  const validated = validateSelectionResult(payload, built.input.entries);
  if (!validated.ok) {
    diagnostics.stage = 'validate';
    diagnostics.failures.push(localFailureCode(validated.reason));
    return {status: 'none', target: null, reason: validated.reason, sends, diagnostics};
  }
  if (!validated.selected) {
    diagnostics.stage = 'done';
    return {status: 'none', target: null, reason: validated.outcome, sends, diagnostics};
  }

  const target = validated.selected.principle;
  diagnostics.stage = 'revalidate';
  const signal = options.signal ?? AbortSignal.timeout(
    options.generationTimeoutMs ?? ADAPTIVE_SELECTION_LIMITS.generationTimeoutMs,
  );
  const stillValid = await revalidateAdaptivePrinciple(options.workspaceDir, target, signal);
  if (!stillValid) {
    diagnostics.stage = 'done';
    return {status: 'none', target: null, reason: 'revalidation_failed', sends, diagnostics};
  }
  diagnostics.stage = 'done';
  return {status: 'selected', target, reason: 'selected', sends, diagnostics};
}

