/**
 * ArtificerL2Adapter (RuleHost MVP Activation, ADR-0014 Amendment 2026-06-17,
 * PRD Decision 8, PRI-424).
 *
 * A PDRuntimeAdapter that runs Artificer through a write-test-fix loop:
 *   generate code (LLM) → validate → sandbox replay → on failure, inject
 *   RefinerSandboxFailedCase[] feedback into the next attempt → regenerate.
 *   Max 3 attempts. On exhaustion, degrade to a V1 output (plan only, no code
 *   fields) so the downstream Evaluator's isArtificerOutputV2() returns false
 *   and the principle-artifact path remains usable.
 *
 * Why the loop lives in the adapter (not in BasePeerRunner.succeedTask):
 *   BasePeerRunner.run() is strictly linear (lease → buildContext → invokeRuntime
 *   → poll → fetch → validate → succeedTask). succeedTask runs AFTER invokeRuntime
 *   returns a terminal output and cannot loop back to invokeRuntime. Encapsulating
 *   the write-test-fix loop inside a PDRuntimeAdapter (like Dreamer's
 *   L2AgentLoopAdapter) keeps BasePeerRunner unchanged — it still sees a single
 *   startRun() that blocks until the loop finishes.
 *
 * Testability: the LLM call is an injected `generateCode` function (mockable).
 * Sandbox replay uses the real evaluateRefinerRuleHostGate with an injected
 * RefinerRuleHostGateDeps. No real LLM calls in tests.
 *
 * ERR considerations (EP-05 Loop State Freshness):
 *   - Each attempt reads FRESH sandbox errors. The feedback string injected into
 *     attempt N+1 is built from attempt N's RefinerSandboxFailedCase[], never
 *     from a stale earlier attempt. (ERR-015/018/019)
 *   - The recorded output is always from the attempt that produced it, not a
 *     blend of multiple attempts.
 */
import { randomUUID } from 'node:crypto';
import { completeSimple } from '@earendil-works/pi-ai';
import type { Context } from '@earendil-works/pi-ai';
import type {
  PDRuntimeAdapter,
  RuntimeKind,
  RuntimeCapabilities,
  RuntimeHealth,
  RunHandle,
  RunStatus,
  StartRunInput,
  StructuredRunOutput,
  RuntimeArtifactRef,
  ContextItem,
} from '../runtime-protocol.js';
import type { RefinerRuleHostGateDeps, RefinerRuleHostGateResult } from '../internalization/refiner-rulehost-gate.js';
import { evaluateRefinerRuleHostGate } from '../internalization/refiner-rulehost-gate.js';
import type { RefinerSandboxFailedCase } from '../internalization/refiner-sandbox-wrapper.js';
import type { ArtificerValidator, ArtificerOutputV1, ArtificerOutputV2 } from '../internalization/artificer-output.js';
import { isArtificerOutputV2 } from '../internalization/artificer-output.js';
import { buildGoldenTraceFromArtificer } from '../golden-trace.js';
import { PDRuntimeError } from '../error-categories.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import { storeEmitter } from '../store/event-emitter.js';
import { safeStringifyPreview, truncatePreview } from './output-repair-contract.js';
import { resolveL2Model } from './l2-agent-loop-adapter.js';
import { extractJsonObject } from './json-extractor.js';

/**
 * Mockable LLM call. Receives the assembled prompt (initial prompt + optional
 * sandbox failure feedback) and returns an UNTRUSTED candidate output. The
 * caller (adapter) validates it before use — never trust the shape here.
 */
export type ArtificerL2GenerateCodeFn = (prompt: string) => Promise<unknown>;

/**
 * Factory: build a production `generateCode` function from LLM config.
 *
 * Uses `resolveL2Model` + `completeSimple` from @earendil-works/pi-ai. The
 * returned function takes a prompt string, calls the LLM, extracts text content,
 * parses JSON, and returns it as `unknown` (the adapter validates it).
 *
 * This factory lives in principles-core (not pd-cli) so the LLM wiring logic
 * stays in one place and pd-cli doesn't need a direct @earendil-works/pi-ai
 * dependency.
 *
 * ERR refs:
 *   - ERR-001: returned value is `unknown` — caller must validate
 *   - ERR-014: response content is safely extracted (no raw JSON.stringify on unknown)
 */

export function buildArtificerL2GenerateCode(config: {
  readonly provider: string;
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}): ArtificerL2GenerateCodeFn {
  const model = resolveL2Model(config.provider, config.model, config.baseUrl);
  const timeoutMs = config.timeoutMs ?? 120_000;

  return async (prompt: string): Promise<unknown> => {
    const context: Context = {
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
    };
    const response = await completeSimple(model, context, {
      apiKey: config.apiKey,
      signal: AbortSignal.timeout(timeoutMs),
    });

    // Extract text content from the response (ERR-014: safe extraction).
    let text: string | null = null;
    if (typeof response.content === 'string') {
      text = response.content;
    } else if (Array.isArray(response.content)) {
      const textPart = response.content.find(
        (c): c is { type: 'text'; text: string } =>
          typeof c === 'object' && c !== null && Object.hasOwn(c, 'type') && Reflect.get(c, 'type') === 'text',
      );
      text = textPart?.text ?? null;
    }
    if (!text) {
      throw new Error('ArtificerL2 generateCode: response had no text content');
    }

    // Parse JSON from the text. The adapter validates the shape — we just
    // return the parsed value as unknown.
    const extracted = extractJsonObject(text);
    if (!extracted) {
      throw new Error('ArtificerL2 generateCode: response had no parseable JSON');
    }
    return extracted;
  };
}

export interface ArtificerL2AdapterConfig {
  /** Injected LLM call (mockable; production wires completeSimple). */
  readonly generateCode: ArtificerL2GenerateCodeFn;
  /** Sandbox replay deps (real or test double). */
  readonly gateDeps: RefinerRuleHostGateDeps;
  /** Artificer output validator (V1/V2 accepting). */
  readonly validator: ArtificerValidator;
  /** Max write-test-fix attempts (default 3). */
  readonly maxAttempts?: number;
  /** Optional event emitter; defaults to the shared singleton. */
  readonly eventEmitter?: StoreEventEmitter;
}

interface ArtificerL2RunState {
  readonly runId: string;
  readonly startedAt: string;
  endedAt: string;
  status: 'succeeded' | 'failed';
  output: StructuredRunOutput | null;
  reason?: string;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_RETAINED_RUNS = 100;

/** Build the feedback string injected into the next LLM attempt. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Ensure the candidate carries the expected taskId (LLM may echo a stale or
 * example id). Only fills when absent via Object.hasOwn — present-but-wrong
 * values reach the validator and fail loud (Runtime Contract Rule 3).
 */
function injectTaskId(candidate: unknown, taskId: string): unknown {
  if (isRecord(candidate) && !Object.hasOwn(candidate, 'taskId')) {
    candidate.taskId = taskId;
  }
  return candidate;
}

function formatSandboxFeedback(failedCases: RefinerSandboxFailedCase[]): string {
  const lines = failedCases.map(
    (c) => `- caseId: ${c.caseId} | errorType: ${c.errorType} | message: ${c.message}`,
  );
  return [
    '--- Previous sandbox replay failures (fix these) ---',
    ...lines,
    '--- end failures ---',
  ].join('\n');
}

/**
 * Strip the V2 code fields from an output, producing a V1-compatible object
 * (plan + lineage only). Used on L2 exhaustion so the principle-artifact path
 * still works. Returns a fresh object; does not mutate the input.
 */
function degradeToV1(v2: ArtificerOutputV2): ArtificerOutputV1 {
  const { implementationCode: _code, goldenTraceCases: _cases, affectedTools: _tools, ...v1 } = v2;
  void _code;
  void _cases;
  void _tools;
  return v1;
}

export class ArtificerL2Adapter implements PDRuntimeAdapter {
  private readonly config: Required<Omit<ArtificerL2AdapterConfig, 'generateCode' | 'gateDeps' | 'validator' | 'eventEmitter'>>;
  private readonly generateCode: ArtificerL2GenerateCodeFn;
  private readonly gateDeps: RefinerRuleHostGateDeps;
  private readonly validator: ArtificerValidator;
  private readonly eventEmitter: StoreEventEmitter;
  private readonly runs = new Map<string, ArtificerL2RunState>();

  constructor(config: ArtificerL2AdapterConfig) {
    const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
      throw new RangeError('maxAttempts must be a positive integer');
    }
    this.generateCode = config.generateCode;
    this.gateDeps = config.gateDeps;
    this.validator = config.validator;
    this.eventEmitter = config.eventEmitter ?? storeEmitter;
    this.config = { maxAttempts };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- required by interface
  kind(): RuntimeKind {
    return 'pi-ai-l2';
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- required by interface
  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      supportsStructuredJsonOutput: true,
      supportsToolUse: false,
      supportsWorkingDirectory: false,
      supportsModelSelection: true,
      supportsLongRunningSessions: false,
      supportsCancellation: true,
      supportsArtifactWriteBack: false,
      supportsConcurrentRuns: false,
      supportsStreaming: false,
    };
  }

  async refreshCapabilities(): Promise<RuntimeCapabilities> {
    return this.getCapabilities();
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- required by interface
  async healthCheck(): Promise<RuntimeHealth> {
    return {
      healthy: true,
      degraded: false,
      warnings: [],
      lastCheckedAt: new Date().toISOString(),
    };
  }

  async startRun(input: StartRunInput): Promise<RunHandle> {
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const taskId = input.taskRef?.taskId ?? runId;
    const initialPrompt = typeof input.inputPayload === 'string'
      ? truncatePreview(input.inputPayload, 50_000)
      : safeStringifyPreview(input.inputPayload, 50_000);

    const runState: ArtificerL2RunState = {
      runId,
      startedAt,
      endedAt: startedAt,
      status: 'failed',
      output: null,
    };
    this.runs.set(runId, runState);
    this.evictOldRuns();

    let lastValidV2: ArtificerOutputV2 | null = null;
    let lastFailureFeedback: string | null = null;

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) {
      // Build prompt: initial + (on retry) the IMMEDIATELY-PRIOR attempt's failure feedback.
      // EP-05: lastFailureFeedback is reassigned each iteration from the current attempt's
      // sandbox result, so attempt N+1 always sees attempt N's errors, never stale ones.
      const prompt = lastFailureFeedback === null
        ? initialPrompt
        : `${initialPrompt}\n\n${lastFailureFeedback}`;

      let candidateRaw: unknown;
      try {
        candidateRaw = await this.generateCode(prompt);
      } catch (err) {
        // LLM call threw — record and continue to next attempt (or degrade).
        const llmError = err instanceof Error ? err.message : String(err);
        lastFailureFeedback = `--- LLM call failed ---\n${llmError}`;
        this.emitAttempt({ taskId, runId, attempt, decision: 'llm_error' });
        continue;
      }

      // Validate the candidate. taskId is injected for lineage consistency.
      const candidateWithTaskId = injectTaskId(candidateRaw, taskId);
      const validation = await this.validator.validate(candidateWithTaskId, taskId);
      if (!validation.valid) {
        // Malformed output (e.g. missing affectedTools). Feed the validator errors back.
        // P2 fix: do NOT update lastValidV2 here — degradation must only trust candidates
        // that PASSED validation, otherwise we'd emit an unvalidated V1 downstream.
        lastFailureFeedback = `--- Validator rejected previous output ---\n${validation.errors.join('\n')}`;
        this.emitAttempt({ taskId, runId, attempt, decision: 'validator_rejected' });
        continue;
      }

      // V1 output (no code fields) — nothing to replay. Accept as-is (L1 equivalent).
      if (!isArtificerOutputV2(candidateWithTaskId)) {
        this.emitAttempt({ taskId, runId, attempt, decision: 'v1_accepted' });
        this.emitComplete({ taskId, runId, attempts: attempt, degraded: false, succeeded: true });
        this.completeRun(runId, 'succeeded', candidateWithTaskId);
        return this.runHandle(runId, startedAt);
      }

      const v2 = candidateWithTaskId;
      lastValidV2 = v2;

      // Build the GoldenTrace for sandbox replay.
      const traceResult = buildGoldenTraceFromArtificer({
        cases: v2.goldenTraceCases,
        sourceArtifactId: undefined,
      });
      if (!traceResult.ok) {
        lastFailureFeedback = `--- Golden trace build failed ---\n${traceResult.reason}`;
        this.emitAttempt({ taskId, runId, attempt, decision: 'trace_build_failed' });
        continue;
      }

      // Sandbox replay.
      const gateResult: RefinerRuleHostGateResult = evaluateRefinerRuleHostGate(
        { code: v2.implementationCode, goldenTrace: traceResult.trace },
        this.gateDeps,
      );

      if (gateResult.decision === 'accepted_shadow') {
        // Success — store the V2 output.
        this.emitAttempt({ taskId, runId, attempt, decision: 'replay_passed' });
        this.emitComplete({ taskId, runId, attempts: attempt, degraded: false, succeeded: true });
        this.completeRun(runId, 'succeeded', v2);
        return this.runHandle(runId, startedAt);
      }

      // Replay failed — capture THIS attempt's failures for the next prompt (EP-05).
      const { failedCases } = gateResult.sandboxResult;
      lastFailureFeedback = failedCases.length > 0
        ? formatSandboxFeedback(failedCases)
        : `--- Sandbox replay failed ---\n${gateResult.decision}: ${gateResult.reasons.join('; ')}`;
      this.emitAttempt({ taskId, runId, attempt, decision: 'replay_failed' });
    }

    // Exhaustion: degrade to V1 if we ever saw a VALIDATED V2 candidate, else fail.
    if (lastValidV2) {
      const v1 = degradeToV1(lastValidV2);
      this.emitComplete({ taskId, runId, attempts: this.config.maxAttempts, degraded: true, succeeded: false });
      this.completeRun(runId, 'succeeded', v1);
      return this.runHandle(runId, startedAt);
    }

    // No validated candidate ever produced — fail loud (Runtime Contract Rule 9).
    // Throw PDRuntimeError so BasePeerRunner's handlePostLeaseError handles it
    // (aligns with Dreamer L2's failure pattern in L2AgentLoopAdapter).
    runState.status = 'failed';
    runState.endedAt = new Date().toISOString();
    runState.reason = `Artificer L2 exhausted ${this.config.maxAttempts} attempts without a validated candidate`;
    this.emitComplete({ taskId, runId, attempts: this.config.maxAttempts, degraded: false, succeeded: false });
    throw new PDRuntimeError(
      'output_invalid',
      runState.reason,
      { nextAction: 'inspect artificer L2 feedback chain; verify LLM produces parseable ArtificerOutputV1/V2' },
    );
  }

  async pollRun(runId: string): Promise<RunStatus> {
    const state = this.runs.get(runId);
    if (!state) {
      return { runId, status: 'failed', reason: 'run not found' };
    }
    return {
      runId: state.runId,
      status: state.status,
      startedAt: state.startedAt,
      endedAt: state.endedAt,
      reason: state.reason,
    };
  }

  async cancelRun(runId: string): Promise<void> {
    const state = this.runs.get(runId);
    if (state && state.status !== 'succeeded') {
      state.status = 'failed';
      state.endedAt = new Date().toISOString();
      state.reason = 'cancelled';
    }
  }

  async fetchOutput(runId: string): Promise<StructuredRunOutput | null> {
    const state = this.runs.get(runId);
    return state?.output ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- required by interface
  async fetchArtifacts(_runId: string): Promise<RuntimeArtifactRef[]> {
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- required by interface, no-op for L2 artificer
  async appendContext(_runId: string, _items: ContextItem[]): Promise<void> {
    // No-op: L2 artificer builds its full prompt in startRun.
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private completeRun(runId: string, status: 'succeeded' | 'failed', payload: unknown): void {
    const state = this.runs.get(runId);
    if (!state) return;
    state.status = status;
    state.endedAt = new Date().toISOString();
    state.output = { runId, payload };
  }

  private runHandle(runId: string, startedAt: string): RunHandle {
    // RunHandleSchema = { runId, runtimeKind, startedAt } — no status field.
    // The run's terminal status is reported via pollRun(), not the handle.
    return {
      runId,
      runtimeKind: this.kind(),
      startedAt,
    };
  }

  private emitAttempt(opts: {
    taskId: string;
    runId: string;
    attempt: number;
    decision: string;
  }): void {
    this.eventEmitter.emitTelemetry({
      eventType: 'artificer_l2_attempt',
      traceId: opts.taskId,
      timestamp: new Date().toISOString(),
      sessionId: 'l2-adapter',
      agentId: 'artificer-l2',
      payload: { runId: opts.runId, attempt: opts.attempt, decision: opts.decision },
    });
  }

  private emitComplete(opts: {
    taskId: string;
    runId: string;
    attempts: number;
    degraded: boolean;
    succeeded: boolean;
  }): void {
    this.eventEmitter.emitTelemetry({
      eventType: 'artificer_l2_complete',
      traceId: opts.taskId,
      timestamp: new Date().toISOString(),
      sessionId: 'l2-adapter',
      agentId: 'artificer-l2',
      payload: {
        runId: opts.runId,
        attempts: opts.attempts,
        degraded: opts.degraded,
        succeeded: opts.succeeded,
      },
    });
  }

  private evictOldRuns(): void {
    if (this.runs.size <= MAX_RETAINED_RUNS) return;
    const excess = this.runs.size - MAX_RETAINED_RUNS;
    const keys = [...this.runs.keys()].slice(0, excess);
    for (const key of keys) {
      this.runs.delete(key);
    }
  }
}
