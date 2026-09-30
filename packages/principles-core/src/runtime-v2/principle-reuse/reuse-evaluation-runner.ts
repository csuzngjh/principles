/**
 * ReuseEvaluationRunner — the Semantic Reuse Evaluation Capability's execution
 * path (PRI-917 SPEC v0.3.2 §7, Phase 3C-3).
 *
 * A PROPOSAL-ONLY runner. It compares a candidate against a bounded shortlist
 * of existing Principles and returns a RECOMMENDATION. It has no path to any
 * ledger writer: this module imports no ledger mutation API, and nothing here
 * can create, modify, or record a Principle. The Owner decides (SPEC §5).
 *
 * Design constraints honoured here (SPEC §7):
 *   - ALL LLM execution goes through the injected PDRuntimeAdapter. This
 *     module creates no client, no inference abstraction, and no provider
 *     seam of its own; the repair loop drives the SAME adapter.
 *   - Structured output repair reuses `structured-output-repair` (the
 *     runtime-agnostic loop) with an adapter-backed `llmCaller`.
 *   - The output contract is the Phase 3C-1 schema, and the Phase 3C-1
 *     validator is the trust boundary (closed field set + cross-field rules).
 *
 * Failure is always fail-closed and observable: a timed-out run, unparsable
 * output, or a payload that still violates the contract after repair throws a
 * {@link ReuseEvaluationError}. It NEVER degrades into "no candidates, so
 * create" — that is the caller's (review surface's) decision, not this
 * runner's silent default (SPEC §9).
 */
import type { PDRuntimeAdapter } from '../runtime-protocol.js';
import {
  ReuseEvaluationOutputV1Schema,
  validateReuseEvaluationOutput,
  type ReuseEvaluationOutputV1,
} from './reuse-evaluation-output.js';
import {
  attemptStructuredOutputRepair,
  type SchemaValidationError,
} from '../adapter/structured-output-repair.js';
import { Value } from '@sinclair/typebox/value';

// ── Input contract (SPEC §4.2) ──────────────────────────────────────────────

/** The candidate's semantic claim — the same claim intake resolves (4b/4c). */
export interface ReuseEvaluationCandidateInput {
  text: string;
  triggerPattern: string;
  action: string;
}

/** One existing Principle from the deterministic shortlist. */
export interface ReuseEvaluationShortlistEntry {
  principleId: string;
  text: string;
  triggerPattern: string;
  action: string;
}

export interface ReuseEvaluationInput {
  candidate: ReuseEvaluationCandidateInput;
  /** Bounded Top-K from reuse-shortlist (caller guarantees ≤ 3). */
  candidates: ReuseEvaluationShortlistEntry[];
}

// ── Failure contract ─────────────────────────────────────────────────────────

export type ReuseEvaluationFailureReason =
  | 'timeout'
  | 'run_failed'
  | 'output_unavailable'
  | 'output_invalid'
  | 'repair_failed';

/**
 * Fail-closed error from the evaluation runner. Carries a structured reason
 * and next action so the review surface can degrade OBSERVABLY (SPEC §9)
 * instead of pretending the shortlist was semantically judged.
 */
export class ReuseEvaluationError extends Error {
  public readonly reason: ReuseEvaluationFailureReason;
  public readonly nextAction: string;
  public readonly detail?: string;
  public readonly repairAttempts: number;

  constructor(args: {
    reason: ReuseEvaluationFailureReason;
    message: string;
    nextAction: string;
    detail?: string;
    repairAttempts?: number;
  }) {
    super(args.message);
    this.name = 'ReuseEvaluationError';
    this.reason = args.reason;
    this.nextAction = args.nextAction;
    this.detail = args.detail;
    this.repairAttempts = args.repairAttempts ?? 0;
  }
}

// ── Runner ──────────────────────────────────────────────────────────────────

export interface ReuseEvaluationRunnerDeps {
  /** The one and only LLM execution path (never constructed here). */
  readonly runtimeAdapter: PDRuntimeAdapter;
}

export interface ReuseEvaluationRunnerOptions {
  /** Per-run budget. Bounded polling never exceeds it. Default 30s. */
  readonly timeoutMs?: number;
  /** Bounded repair attempts after a contract violation. Default 1. */
  readonly maxRepairAttempts?: number;
  /** agentSpec label for telemetry/lineage. Not an agent registration. */
  readonly agentId?: string;
  /** Poll interval while waiting for the run. Default 200ms. */
  readonly pollIntervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 200;
const MAX_POLLED_FIELD_CHARS = 2000;

/** Bounded poll backoff (module-level: no runner state involved). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class ReuseEvaluationRunner {
  private readonly runtimeAdapter: PDRuntimeAdapter;
  private readonly timeoutMs: number;
  private readonly maxRepairAttempts: number;
  private readonly agentId: string;
  private readonly pollIntervalMs: number;

  constructor(deps: ReuseEvaluationRunnerDeps, options: ReuseEvaluationRunnerOptions = {}) {
    this.runtimeAdapter = deps.runtimeAdapter;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRepairAttempts = options.maxRepairAttempts ?? 1;
    this.agentId = options.agentId ?? 'reuse-evaluation';
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /**
   * Role declaration delivered on the system channel (base-layer prompt,
   * following CorrectionObserver's PRI-633 pattern). The "you recommend, the
   * Owner decides" boundary is stated here so the model never narrates itself
   * as a decision authority (SPEC §5).
   */
  static readonly SYSTEM_PROMPT = [
    'You are a semantic reuse evaluator for a principles-disciple knowledge base.',
    'You compare a NEW candidate claim against EXISTING principles and RECOMMEND whether an existing principle already covers the same experience.',
    'You are a recommender, NOT a decision maker: the Owner decides. Never claim a decision was made, never instruct that a principle be written, and never emit fields outside the requested JSON shape.',
  ].join(' ');

  /** Build the evaluation prompt (deterministic, bounded). */
  static buildPrompt(input: ReuseEvaluationInput): string {
    const clip = (s: string): string => (s.length > MAX_POLLED_FIELD_CHARS ? `${s.slice(0, MAX_POLLED_FIELD_CHARS)}…` : s);
    const candidateBlock = [
      `  text:    ${clip(input.candidate.text)}`,
      `  trigger: ${clip(input.candidate.triggerPattern)}`,
      `  action:  ${clip(input.candidate.action)}`,
    ].join('\n');
    const existingBlock = input.candidates.length === 0
      ? '  (none)'
      : input.candidates
        .map((c, i) => [
          `  [${i + 1}] principleId: ${c.principleId}`,
          `      text:    ${clip(c.text)}`,
          `      trigger: ${clip(c.triggerPattern)}`,
          `      action:  ${clip(c.action)}`,
        ].join('\n'))
        .join('\n');
    return [
      '## TASK',
      'Decide whether ONE existing principle already expresses the same experience as the candidate claim.',
      '',
      '## Candidate claim',
      candidateBlock,
      '',
      `## Existing principles (${input.candidates.length})`,
      existingBlock,
      '',
      '## Rules',
      '- Judge SEMANTIC coverage, not word overlap: shared vocabulary alone is NOT the same experience.',
      '- recommendation=reuse: an existing principle already covers this claim. Set selectedPrincipleId to that principle\'s id (required).',
      '- recommendation=create: no existing principle covers this claim; a new one is warranted.',
      '- recommendation=uncertain: the evidence is genuinely ambiguous. Do NOT set selectedPrincipleId.',
      '- rationale: one or two sentences naming WHY the coverage holds or fails.',
      '- confidence: 0..1 in your recommendation.',
      '- Emit ONLY these fields: recommendation, selectedPrincipleId (only for reuse), rationale, confidence.',
      '',
      'Return strict JSON (no markdown):',
      '{"recommendation": "reuse" | "create" | "uncertain", "selectedPrincipleId": string, "rationale": string, "confidence": number}',
    ].join('\n');
  }

  /**
   * Run one semantic evaluation and return the validated RECOMMENDATION.
   *
   * @throws ReuseEvaluationError — timeout / run failure / unparsable output /
   *         contract violation surviving repair. Never a silent fallback.
   */
  async recommend(input: ReuseEvaluationInput): Promise<ReuseEvaluationOutputV1> {
    const payload = await this.invoke(ReuseEvaluationRunner.buildPrompt(input), 'evaluate');
    const validated = validateReuseEvaluationOutput(payload);
    if (validated.ok) {
      return validated.output;
    }

    // Contract violation (unknown field, bad cross-field pairing, bad types):
    // the schema itself is permissive about extra keys, so this is where the
    // closed field set bites. One bounded repair round, then fail closed.
    return this.repairAndValidate(payload, validated.reason);
  }

  /** Bounded repair using the SAME adapter (no second LLM path). */
  private async repairAndValidate(
    invalidOutput: unknown,
    reason: string,
  ): Promise<ReuseEvaluationOutputV1> {
    if (this.maxRepairAttempts <= 0) {
      throw new ReuseEvaluationError({
        reason: 'repair_failed',
        message: `Reuse evaluation output violated its contract (${reason}) and repair is disabled`,
        nextAction: 'Review the evaluation output contract; repair attempts are configured to 0',
        detail: reason,
      });
    }
    const schemaErrors: SchemaValidationError[] = [{ path: '/', message: reason, value: invalidOutput }];
    const repair = await attemptStructuredOutputRepair<ReuseEvaluationOutputV1>(
      invalidOutput,
      schemaErrors,
      {
        // The repair LLM is the SAME adapter — this callback only marshals
        // prompt in and raw JSON text out.
        llmCaller: async (prompt: string): Promise<string | null> => {
          const repaired = await this.invoke(prompt, 'repair');
          return JSON.stringify(repaired);
        },
        schemaCheck: (value: unknown) => validateReuseEvaluationOutput(value).ok,
      },
      {
        maxRepairAttempts: this.maxRepairAttempts,
        schemaRef: 'reuse-evaluation-output-v1',
        schemaJson: JSON.stringify(ReuseEvaluationOutputV1Schema),
        requiredKeys: ['recommendation', 'rationale', 'confidence'],
      },
    );

    if (repair.repaired && repair.output) {
      // The repair loop's schemaCheck is our validator, but re-validate the
      // returned value explicitly: a caller-visible contract must never rely
      // on a callback's internal check alone.
      const revalidated = validateReuseEvaluationOutput(repair.output);
      if (revalidated.ok) {
        return revalidated.output;
      }
    }
    throw new ReuseEvaluationError({
      reason: 'repair_failed',
      message: `Reuse evaluation output violated its contract (${reason}) and could not be repaired`,
      nextAction: 'Re-run the review; if it persists, inspect the evaluation prompt/runtime output format',
      detail: `${reason}; ${repair.repairSummary}`,
      repairAttempts: repair.attemptsUsed,
    });
  }

  /**
   * One adapter round-trip: start → bounded poll → fetch. This is the ONLY
   * place the runner touches the runtime, for both the initial call and each
   * repair attempt.
   */
  private async invoke(prompt: string, phase: 'evaluate' | 'repair'): Promise<unknown> {
    const runHandle = await this.runtimeAdapter.startRun({
      agentSpec: { agentId: this.agentId, schemaVersion: 'v1' },
      taskRef: { taskId: `reuse_eval_${phase}_${Date.now()}` },
      inputPayload: prompt,
      contextItems: [],
      outputSchemaRef: 'reuse-evaluation-output-v1',
      timeoutMs: this.timeoutMs,
      systemPrompt: ReuseEvaluationRunner.SYSTEM_PROMPT,
    });

    const deadline = Date.now() + this.timeoutMs;
    let terminal = false;
    while (Date.now() < deadline) {
      const status = await this.runtimeAdapter.pollRun(runHandle.runId);
      if (status.status === 'succeeded') {
        terminal = true;
        break;
      }
      if (status.status === 'failed' || status.status === 'timed_out' || status.status === 'cancelled') {
        throw new ReuseEvaluationError({
          reason: status.status === 'timed_out' ? 'timeout' : 'run_failed',
          message: `Reuse evaluation ${phase} run finished as '${status.status}'`,
          nextAction: 'Check the configured reuseEvaluation runtime profile and LLM channel health',
          detail: status.reason,
        });
      }
      await sleep(this.pollIntervalMs);
    }
    if (!terminal) {
      try {
        await this.runtimeAdapter.cancelRun(runHandle.runId);
      } catch { /* best effort: the run is already past its budget */ }
      throw new ReuseEvaluationError({
        reason: 'timeout',
        message: `Reuse evaluation ${phase} run exceeded ${this.timeoutMs}ms`,
        nextAction: 'Raise reuseEvaluation.timeoutMs or check the configured runtime profile',
      });
    }

    let output: { payload?: unknown } | null;
    try {
      output = await this.runtimeAdapter.fetchOutput(runHandle.runId);
    } catch (err: unknown) {
      // The adapter validates against outputSchemaRef and can also perform its
      // own internal repair (pi-ai does). If it still fails, the raw text is
      // unavailable for a runner-level repair — surface it fail-closed.
      throw new ReuseEvaluationError({
        reason: 'output_invalid',
        message: `Reuse evaluation ${phase} output could not be parsed or validated by the runtime`,
        nextAction: 'Inspect the runtime output format; the adapter rejected it against reuse-evaluation-output-v1',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    if (!output || output.payload === undefined || output.payload === null) {
      throw new ReuseEvaluationError({
        reason: 'output_unavailable',
        message: `Reuse evaluation ${phase} run produced no output payload`,
        nextAction: 'Re-run the review; the runtime returned an empty payload',
      });
    }
    return output.payload;
  }
}

// Re-exported for callers that want a plain boolean pre-check without
// constructing a runner (e.g. a surface deciding whether to show a warning).
export function isValidReuseEvaluationOutput(value: unknown): boolean {
  return Value.Check(ReuseEvaluationOutputV1Schema, value);
}
