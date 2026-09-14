/**
 * ArtificerL2Adapter (PRI-439 Phase 4 — tool-using L2 agent).
 *
 * A PDRuntimeAdapter that runs Artificer through a multi-turn agent loop
 * (@earendil-works/pi-agent-core) with 4 tools:
 *   - read_rulecode_spec : RuleCode dialect spec (canonical form, forbidden patterns)
 *   - validate_rulecode  : static validation (forbidden patterns + return shape)
 *   - replay_rulecode    : sandbox replay against a golden trace
 *   - submit_rulecode    : final ArtificerRuleOutput submission (terminates loop)
 *
 * Why runAgentLoop (not completeSimple):
 *   The former completeSimple write-test-fix loop required the adapter to
 *   re-prompt the LLM with sandbox failure feedback. runAgentLoop lets the
 *   model call validate_rulecode + replay_rulecode itself, inspect the
 *   violations, and iterate inside a single agent loop — no external retry
 *   wiring. This matches the Dreamer L2 precedent (L2AgentLoopAdapter).
 *
 * Why the loop lives in the adapter (not in BasePeerRunner.succeedTask):
 *   BasePeerRunner.run() is strictly linear (lease → buildContext → invokeRuntime
 *   → poll → fetch → validate → succeedTask). succeedTask runs AFTER invokeRuntime
 *   returns a terminal output and cannot loop back to invokeRuntime. Encapsulating
 *   the agent loop inside a PDRuntimeAdapter keeps BasePeerRunner unchanged — it
 *   still sees a single startRun() that blocks until the loop finishes.
 *
 * No V1/L1 fallback (PRI-439):
 *   Missing/invalid/replay-failing RuleCode fails loud (PDRuntimeError). No
 *   degradation to a plan-only output, no completeSimple fallback. The loop
 *   either produces a valid ArtificerRuleOutput via submit_rulecode, or throws.
 *
 * ERR considerations:
 *   - EP-05 Loop State Freshness: each runAgentLoop call uses a fresh
 *     outputCapture + turnCount (never stale loop state across runs).
 *   - EP-03 Fail Loud: exhaustion throws PDRuntimeError with a structured
 *     nextAction (Runtime Contract Rule 9).
 *   - EP-01 Trust Boundary: submit_rulecode validates params via the injected
 *     ArtificerValidator before storing (Runtime Contract Rule 1/2).
 */
import { randomUUID } from 'node:crypto';
import { runAgentLoop } from '@earendil-works/pi-agent-core';
import type { AgentMessage, AgentLoopConfig, AgentEvent } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';
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
import type { RefinerRuleHostGateDeps } from '../internalization/refiner-rulehost-gate.js';
import type { ArtificerValidator } from '../internalization/artificer-output.js';
import { PDRuntimeError } from '../error-categories.js';
import type { PDErrorCategory } from '../error-categories.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import { storeEmitter } from '../store/event-emitter.js';
import { safeStringifyPreview, truncatePreview } from './output-repair-contract.js';
import { resolveL2Model, pdStreamSimple } from './l2-agent-loop-adapter.js';
import { mergeSystemPromptLayers } from '../system-prompt-merge.js';
import {
  buildArtificerL2Tools,
  ARTIFICER_L2_TOOL_WHITELIST,
  type ArtificerL2ToolContext,
  type ArtificerL2OutputCapture,
} from '../tools/artificer-l2-tool-contract.js';

export interface ArtificerL2AdapterConfig {
  /** Provider id (e.g. 'openai', 'anthropic'). */
  readonly provider: string;
  /** Model id. */
  readonly model: string;
  /** Env var name holding the API key. */
  readonly apiKeyEnv: string;
  /** Optional custom base URL (OpenAI-compatible endpoints). */
  readonly baseUrl?: string;
  /** Sandbox replay deps (real or test double). */
  readonly gateDeps: RefinerRuleHostGateDeps;
  /** Artificer output validator (used by submit_rulecode). */
  readonly validator: ArtificerValidator;
  /** Max agent-loop turns before forced stop (default 8). */
  readonly maxTurns?: number;
  /** Total wall-clock budget for the whole loop in ms (default 300_000). */
  readonly totalBudgetMs?: number;
  /** Max output tokens per LLM call (default 8192). */
  readonly maxTokens?: number;
  /**
   * PRI-795: optional pi-ai reasoning/thinking level from the runtime profile.
   * Forwarded into the loop's stream options so always-thinking models (e.g.
   * zai glm-5.3-flash) get a bounded thinking level instead of their most
   * expensive default. `false` explicitly disables reasoning. Mirrors the
   * PiAiRuntimeAdapter config field (profile contract, pd-config-types.ts).
   */
  readonly reasoning?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | false;
  /** Optional event emitter; defaults to the shared singleton. */
  readonly eventEmitter?: StoreEventEmitter;
  /**
   * PRI-633: optional profile-level system prompt (append layer, DPB-07).
   * Appended AFTER the run's base-layer systemPrompt and the Artificer L2
   * tool protocol in agentContext.systemPrompt. Omitted when unset.
   */
  readonly systemPrompt?: string;
}

interface ArtificerL2RunState {
  readonly runId: string;
  readonly startedAt: string;
  endedAt: string;
  status: 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
  output: StructuredRunOutput | null;
  reason?: string;
  /** PRI-795: who aborted the run's AbortController, when anyone did. */
  abortOwner?: L2AbortOwner;
  /** PRI-795: wall-clock duration of the agent loop in ms. */
  elapsedMs?: number;
}

/**
 * PRI-795 abort-ownership model. The adapter's AbortController has exactly
 * two internal aborters (budget timer, cancelRun); pi-ai reports
 * stopReason='aborted' whenever OUR signal is aborted, and pi-agent-core
 * then ends the loop with a silent return (agent-loop.js: no throw). The
 * previous code assigned `timedOut = budgetTimedOut` only inside the catch
 * block — dead code on the silent-return path — so every abort was
 * misclassified as output_invalid. Ownership is now resolved AFTER the
 * loop from these flags, never from which control path returned.
 */
type L2AbortOwner = 'pd_budget' | 'cancelled' | 'unknown';

/**
 * PRI-795 fine-grained failure classification. The coarse PDErrorCategory
 * thrown to the runner stays (timeout / cancelled / execution_failed /
 * output_invalid — existing union, no schema change); the fine-grained
 * kind rides in the failure reason + telemetry payload for diagnosis.
 */
type L2FailureKind =
  | 'pd_budget_timeout'
  | 'provider_timeout'
  | 'cancelled'
  | 'stream_aborted'
  | 'provider_error'
  | 'no_submit';

const DEFAULT_MAX_TURNS = 12;
const DEFAULT_TOTAL_BUDGET_MS = 300_000;
const DEFAULT_MAX_TOKENS = 8192;
const MAX_RETAINED_RUNS = 100;

// ── PRI-795 runtime evidence helpers ─────────────────────────────────────────

/** Token usage summary; the string form marks "honestly unavailable". */
type L2TokenUsage =
  | { status: 'ok'; inputTokens: number; outputTokens: number; totalTokens: number }
  | { status: 'unavailable' };

/**
 * Sum pi-ai Usage off the loop transcript's assistant messages. The transcript
 * is produced by pi-agent-core in-process (not a trust boundary), but the walk
 * still guards shapes (rc-1/rc-4): any non-finite field disqualifies that
 * message; zero qualifying messages yields `unavailable` — never fabricated.
 */
function summarizeTranscriptUsage(transcript: AgentMessage[]): L2TokenUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let sawUsage = false;
  for (const msg of transcript) {
    if (!msg || typeof msg !== 'object' || (msg as { role?: unknown }).role !== 'assistant') continue;
    const {usage} = (msg as { usage?: unknown });
    if (!usage || typeof usage !== 'object') continue;
    const input = Reflect.get(usage, 'input');
    const output = Reflect.get(usage, 'output');
    const total = Reflect.get(usage, 'totalTokens');
    if (typeof input === 'number' && Number.isFinite(input)) {
      inputTokens += input;
      sawUsage = true;
    }
    if (typeof output === 'number' && Number.isFinite(output)) {
      outputTokens += output;
      sawUsage = true;
    }
    if (typeof total === 'number' && Number.isFinite(total)) {
      sawUsage = true;
    }
  }
  return sawUsage ? { status: 'ok', inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } : { status: 'unavailable' };
}

/** stopReason of the last assistant message in the transcript, guarded. */
function lastAssistantStopReason(transcript: AgentMessage[]): string | null {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const msg = transcript[i];
    if (!msg || (msg as { role?: unknown }).role !== 'assistant') continue;
    const {stopReason} = (msg as { stopReason?: unknown });
    return typeof stopReason === 'string' && stopReason.length > 0 ? stopReason : null;
  }
  return null;
}

/** PRI-795 failure classification inputs. */
interface L2FailureClassificationInput {
  abortOwner: L2AbortOwner | undefined;
  budgetMs: number;
  elapsedMs: number;
  turnCount: number;
  stopReason: string | null;
  loopError: string | null;
  tokenUsage: L2TokenUsage;
}

/**
 * Map a loop failure to (coarse PDErrorCategory, fine-grained kind, reason,
 * nextAction). Coarse categories reuse the existing union — 'timeout' and
 * 'execution_failed' are retriable, 'cancelled' permanent — fixing the old
 * behavior where every abort/provider error was permanently 'output_invalid'.
 */
function classifyL2Failure(input: L2FailureClassificationInput): {
  category: PDErrorCategory;
  kind: L2FailureKind;
  reason: string;
  nextAction: string;
} {
  const evidence = `abortOwner=${input.abortOwner ?? 'none'} budgetMs=${input.budgetMs} elapsedMs=${input.elapsedMs} stopReason=${input.stopReason ?? 'unavailable'} turns=${input.turnCount} tokenUsage=${input.tokenUsage.status === 'ok' ? `${input.tokenUsage.inputTokens}in/${input.tokenUsage.outputTokens}out` : 'unavailable'}`;
  if (input.abortOwner === 'pd_budget') {
    return {
      category: 'timeout',
      kind: 'pd_budget_timeout',
      reason: `Artificer L2 total budget (${input.budgetMs}ms) exhausted; failureKind=pd_budget_timeout; ${evidence}`,
      nextAction: 'increase totalBudgetMs (--timeout-ms or profile timeoutMs) or lower the profile reasoning level; verify the model supports tool use',
    };
  }
  if (input.abortOwner === 'cancelled') {
    return {
      category: 'cancelled',
      kind: 'cancelled',
      reason: `Artificer L2 run cancelled; failureKind=cancelled; ${evidence}`,
      nextAction: 're-invoke the pipeline when the run is intended',
    };
  }
  if (input.abortOwner === 'unknown') {
    // The signal was aborted but neither known aborter fired — an ownership
    // gap. Scream loudly instead of guessing (rc-9); never output_invalid.
    return {
      category: 'execution_failed',
      kind: 'stream_aborted',
      reason: `Artificer L2 abort signal aborted with UNKNOWN owner (budgetTimedOut=false, cancelRequested=false)${input.loopError !== null ? `: ${input.loopError}` : ''}; failureKind=stream_aborted; ${evidence}`,
      nextAction: 'report this run: abort ownership gap — an aborter outside the adapter contract fired the AbortController',
    };
  }
  if (input.loopError !== null) {
    // Provider-side timeout recognition (bounded match on our own recorded
    // loopError text, not a trust boundary). With the SDK ceiling now explicit
    // (= budget), a provider timeout surfacing without an abort is a
    // provider-side failure; both kinds share the retriable category.
    const isTimeoutLike = /timed?[ _-]?out|timeout/i.test(input.loopError);
    return {
      category: 'execution_failed',
      kind: isTimeoutLike ? 'provider_timeout' : 'provider_error',
      reason: `Artificer L2 agent loop threw: ${input.loopError}; failureKind=${isTimeoutLike ? 'provider_timeout' : 'provider_error'}; ${evidence}`,
      nextAction: 'check provider availability / API key / network; retry when the provider recovers',
    };
  }
  return {
    category: 'output_invalid',
    kind: 'no_submit',
    reason: `Artificer L2 agent loop ended without a submit_rulecode call after ${input.turnCount} turn(s); failureKind=no_submit; ${evidence}`,
    nextAction: 'inspect artificer L2 telemetry; verify the model calls submit_rulecode with a valid ArtificerRuleOutput',
  };
}


export class ArtificerL2Adapter implements PDRuntimeAdapter {
  private readonly config: ArtificerL2AdapterConfig;
  private readonly gateDeps: RefinerRuleHostGateDeps;
  private readonly validator: ArtificerValidator;
  private readonly eventEmitter: StoreEventEmitter;
  private readonly runs = new Map<string, ArtificerL2RunState>();
  private readonly abortControllers = new Map<string, AbortController>();
  /** PRI-795: runIds whose cancelRun() was invoked (abort ownership flag). */
  private readonly cancelledRuns = new Set<string>();

  constructor(config: ArtificerL2AdapterConfig) {
    this.config = config;
    this.gateDeps = config.gateDeps;
    this.validator = config.validator;
    this.eventEmitter = config.eventEmitter ?? storeEmitter;
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- required by interface
  kind(): RuntimeKind {
    return 'pi-ai-l2';
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- required by interface
  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      supportsStructuredJsonOutput: true,
      supportsToolUse: true,
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

  async healthCheck(): Promise<RuntimeHealth> {
    const lastCheckedAt = new Date().toISOString();
    const apiKey = process.env[this.config.apiKeyEnv];
    if (!apiKey) {
      return {
        healthy: false,
        degraded: false,
        warnings: [`API key not found in env: ${this.config.apiKeyEnv}`],
        lastCheckedAt,
      };
    }
    return {
      healthy: true,
      degraded: false,
      warnings: [],
      lastCheckedAt,
    };
  }

  async startRun(input: StartRunInput): Promise<RunHandle> {
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const apiKey = process.env[this.config.apiKeyEnv];
    if (!apiKey) {
      throw new PDRuntimeError(
        'runtime_unavailable',
        `API key not found in env: ${this.config.apiKeyEnv}`,
      );
    }

    const taskId = input.taskRef?.taskId ?? runId;
    const runState: ArtificerL2RunState = {
      runId,
      startedAt,
      endedAt: startedAt,
      status: 'failed',
      output: null,
    };
    this.runs.set(runId, runState);
    this.evictOldRuns();

    const totalBudgetMs = this.config.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS;
    const maxTurns = this.config.maxTurns ?? DEFAULT_MAX_TURNS;
    const maxTokens = this.config.maxTokens ?? DEFAULT_MAX_TOKENS;

    const abortController = new AbortController();
    this.abortControllers.set(runId, abortController);
    // Track whether the budget timer fired (vs. cancelRun calling abort).
    // Without this flag, cancelRun() is misidentified as a timeout because
    // both paths set abortController.signal.aborted to true.
    let budgetTimedOut = false;
    const budgetTimer = setTimeout(() => { budgetTimedOut = true; abortController.abort(); }, totalBudgetMs);
    const startedWallMs = Date.now();

    // Build the prompt message. Serialized before the try block so a
    // non-serializable inputPayload fails loud with cleanup (no timer leak).
    let messageContent: string;
    try {
      messageContent = typeof input.inputPayload === 'string'
        ? truncatePreview(input.inputPayload, 50_000)
        : safeStringifyPreview(input.inputPayload, 50_000);
    } catch (err) {
      clearTimeout(budgetTimer);
      this.abortControllers.delete(runId);
      const reason = err instanceof Error ? err.message : String(err);
      runState.status = 'failed';
      runState.reason = `inputPayload not serializable: ${reason}`;
      runState.endedAt = new Date().toISOString();
      throw new PDRuntimeError(
        'input_invalid',
        `Artificer L2 inputPayload is not serializable: ${reason}`,
        { nextAction: 'ensure StartRunInput.inputPayload is a string or JSON-serializable object' },
      );
    }

    // PRI-633: the tool usage protocol is standing behavior contract, so it
    // moved from the tail of the user message into the system prompt — the
    // user message now carries only task data.
    const toolInstruction =
      '--- Tool protocol (Artificer L2 mode, PRI-439) ---\n' +
      'You have 4 tools to write and verify RuleCode:\n' +
      '  - read_rulecode_spec: read the RuleCode dialect spec (canonical form, forbidden patterns, return shape). Call FIRST.\n' +
      '  - validate_rulecode: statically validate a code string (forbidden patterns + return shape). Call after drafting code.\n' +
      '  - replay_rulecode: sandbox-replay code against a golden trace. Call after validate passes.\n' +
      '  - submit_rulecode: submit your final ArtificerRuleOutput. You MUST call this exactly once with a complete object; the loop stops after you call it.\n' +
      'CONFLICT RESOLUTION (EP002-R3 live evidence): this tool-loop session SUPERSEDES any "Output ONLY valid JSON as your message" / "pure JSON, no markdown" instruction from the base protocol. ' +
      'In this session your ArtificerRuleOutput JSON is delivered ONLY as the submit_rulecode tool arguments — never as message text. ' +
      'Every assistant message MUST contain a tool call; an assistant message without one terminates the loop as a failure.\n' +
      'Do not emit your final answer as free text — call submit_rulecode.';

    // Layered system prompt (PRI-633): base layer (prompt-builder role +
    // protocol, via StartRunInput.systemPrompt) → tool protocol → profile
    // append layer (config). Undefined when every layer is absent.
    const systemPrompt = mergeSystemPromptLayers(
      input.systemPrompt,
      toolInstruction,
      this.config.systemPrompt,
    );

    const prompts: AgentMessage[] = [
      { role: 'user', content: messageContent, timestamp: Date.now() },
    ];

    // Fresh capture + turn counter per run (EP-05 loop-state freshness).
    const outputCapture: ArtificerL2OutputCapture = { output: null };
    let turnCount = 0;
    const toolsInvoked: Record<string, number> = {};

    const toolContext: ArtificerL2ToolContext = {
      gateDeps: this.gateDeps,
      validator: this.validator,
      taskId,
      outputCapture,
      onToolExecution: (info) => {
        toolsInvoked[info.toolName] = (toolsInvoked[info.toolName] ?? 0) + 1;
        this.eventEmitter.emitTelemetry({
          eventType: 'artificer_l2_turn',
          traceId: taskId,
          timestamp: new Date().toISOString(),
          sessionId: 'l2-adapter',
          agentId: 'artificer-l2',
          payload: { runId, toolName: info.toolName, ok: info.ok, error: info.error, turn: turnCount },
        });
      },
    };

    const tools = buildArtificerL2Tools(toolContext);
    const agentContext = {
      systemPrompt: systemPrompt ?? '',
      messages: prompts,
      tools,
    };

    const MAX_NO_TOOL_CALL_NUDGES = 2;
    let nudges = 0;
    // PRI-795 timeout contract (three explicit layers, one authority):
    //   1. Artificer total budget  — totalBudgetMs, armed HERE (t0). The single
    //      authoritative deadline for the whole loop.
    //   2. Per-request SDK timeout — `timeoutMs` below. AgentLoopConfig extends
    //      SimpleStreamOptions, so this flows verbatim to pi-ai's
    //      requestOptions.timeout (OpenAI SDK `timeout`), replacing the SDK's
    //      silent 600s default that previously coexisted unobservably with the
    //      budget. Set equal to the budget: the budget timer is always armed
    //      earlier (t0 ≤ any request start), so the budget is provably the
    //      tightest timer on the wire (EP-07) and the SDK ceiling is a pure
    //      backstop that never wins the race.
    //   3. Runner poll deadline   — BasePeerRunner.timeoutMs; polls only after
    //      startRun returns (this adapter blocks through the loop), so it can
    //      never abort mid-loop.
    const loopConfig: AgentLoopConfig = {
      model: resolveL2Model(this.config.provider, this.config.model, this.config.baseUrl, {
        // Model-level maxTokens is the thinking-budget clamp ceiling; keep it
        // coherent with the request-level cap (loopConfig.maxTokens) instead
        // of the hardcoded literal that previously diverged (8192/32000/16000).
        reasoning: this.config.reasoning !== undefined && this.config.reasoning !== false,
        maxTokens,
      }),
      apiKey,
      maxTokens,
      // PRI-795: per-request SDK timeout = total budget (see contract above).
      timeoutMs: totalBudgetMs,
      // Profile thinking level; `false` means "disable" and is expressed by
      // omitting the field (model default), mirroring PiAiRuntimeAdapter.
      ...(this.config.reasoning !== undefined && this.config.reasoning !== false
        ? { reasoning: this.config.reasoning }
        : {}),
      convertToLlm: (msgs: AgentMessage[]): Message[] => msgs.map((m): Message => {
        if (m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult') {
          return m as Message;
        }
        throw new PDRuntimeError('output_invalid', `Artificer L2 convertToLlm encountered an unsupported message role: ${String((m as { role?: string }).role)}`);
      }),
      beforeToolCall: async (ctx) => {
        if (!ARTIFICER_L2_TOOL_WHITELIST.has(ctx.toolCall.name)) {
          return { block: true, reason: `tool '${ctx.toolCall.name}' is not in the Artificer L2 whitelist` };
        }
        return undefined;
      },
      shouldStopAfterTurn: () => {
        turnCount += 1;
        return outputCapture.output !== null || turnCount >= maxTurns;
      },
      // EP002-R3 (live evidence, glm-5.3-flash): the model sometimes ends its
      // turn with a plain-text draft instead of a tool call, which makes the
      // agent loop stop without submit_rulecode. The library-native
      // continuation path is getFollowUpMessages: when the loop would stop,
      // feed a corrective user message (bounded) so the SAME conversation —
      // with the spec/tool results intact — continues. Respects maxTurns and
      // the total budget (rc-7); failure stays loud once nudges are exhausted.
      getFollowUpMessages: async () => {
        if (outputCapture.output !== null) return [];
        if (budgetTimedOut || turnCount >= maxTurns) return [];
        if (nudges >= MAX_NO_TOOL_CALL_NUDGES) return [];
        nudges += 1;
        this.eventEmitter.emitTelemetry({
          eventType: 'artificer_l2_turn',
          traceId: taskId,
          timestamp: new Date().toISOString(),
          sessionId: 'l2-adapter',
          agentId: 'artificer-l2',
          payload: { runId, phase: 'no_tool_call_nudge', nudge: nudges, turn: turnCount },
        });
        return [{
          role: 'user' as const,
          content:
            `Your previous message contained NO tool call — in this session that ends the run as a failure. ` +
            `Respond NOW with a single tool call: validate_rulecode (to check your drafted code) or submit_rulecode ` +
            `(with the complete ArtificerRuleOutput JSON as the tool arguments). Do not write plain text.`,
          timestamp: Date.now(),
        }];
      },
    };

    this.eventEmitter.emitTelemetry({
      eventType: 'artificer_l2_turn',
      traceId: taskId,
      timestamp: new Date().toISOString(),
      sessionId: 'l2-adapter',
      agentId: 'artificer-l2',
      payload: {
        runId,
        phase: 'loop_started',
        maxTurns,
        totalBudgetMs,
        maxTokens,
        requestTimeoutMs: totalBudgetMs,
        reasoning: this.config.reasoning ?? 'unavailable',
        provider: this.config.provider,
        model: this.config.model,
      },
    });

    let loopError: string | null = null;
    // EP002-R3: streamAssistantResponse reports LLM-call failures as a message
    // with stopReason 'error'/'aborted' and the agent loop then ends WITHOUT
    // calling shouldStopAfterTurn — previously invisible (turnCount frozen,
    // no nudge, generic failure reason). Capture it here so the underlying
    // provider error surfaces loudly (rc-9) instead of a generic message.
    let lastErrorMessage: string | null = null;
    let lastStopReason: string | null = null;
    let transcript: AgentMessage[] = [];
    try {
      transcript = await runAgentLoop(
        prompts,
        agentContext,
        loopConfig,
        async (event: AgentEvent) => {
          if (event.type === 'message_end') {
            const { message } = event as { message?: { stopReason?: string; errorMessage?: string } };
            if (message && (message.stopReason === 'error' || message.stopReason === 'aborted')) {
              lastErrorMessage = `LLM stream ended with stopReason=${message.stopReason}${message.errorMessage ? `: ${message.errorMessage}` : ''}`;
              lastStopReason = message.stopReason ?? null;
            }
          }
        },
        abortController.signal,
        pdStreamSimple,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      loopError = reason;
    }
    if (loopError === null && lastErrorMessage !== null) {
      loopError = lastErrorMessage;
    }

    clearTimeout(budgetTimer);
    this.abortControllers.delete(runId);

    // PRI-795: resolve abort ownership AFTER the loop, from the flags — never
    // from which control path returned (the loop returns silently on abort;
    // the old `timedOut = budgetTimedOut` lived only in the catch block and
    // was dead code on that path, misclassifying budget aborts as
    // output_invalid). Deterministic precedence: budget > cancel > unknown.
    const cancelRequested = this.cancelledRuns.delete(runId);
    const abortOwner: L2AbortOwner | undefined = budgetTimedOut
      ? 'pd_budget'
      : cancelRequested
        ? 'cancelled'
        : abortController.signal.aborted
          ? 'unknown'
          : undefined;
    const elapsedMs = Date.now() - startedWallMs;
    const tokenUsage = summarizeTranscriptUsage(transcript);
    const finalStopReason = lastStopReason ?? lastAssistantStopReason(transcript);

    // Extract output from the capture (set by submit_rulecode).
    if (outputCapture.output !== null) {
      runState.status = 'succeeded';
      runState.endedAt = new Date().toISOString();
      runState.output = { runId, payload: outputCapture.output };
      this.emitComplete({
        taskId, runId, turnCount, toolsInvoked, succeeded: true,
        evidence: { abortOwner: undefined, budgetMs: totalBudgetMs, elapsedMs, stopReason: finalStopReason, tokenUsage },
      });
      return this.runHandle(runId, startedAt);
    }

    // No output captured — fail loud (Runtime Contract Rule 9, ERR-002).
    // PRI-439: no V1/L1 fallback. Missing/invalid/replay-failing RuleCode
    // creates no rule artifact, approval, or activation.
    // PRI-795: classify by abort ownership / failure kind, not by control path.
    const { category, kind, reason, nextAction } = classifyL2Failure({
      abortOwner,
      budgetMs: totalBudgetMs,
      elapsedMs,
      turnCount,
      stopReason: finalStopReason,
      loopError,
      tokenUsage,
    });
    runState.status = kind === 'pd_budget_timeout' ? 'timed_out' : kind === 'cancelled' ? 'cancelled' : 'failed';
    runState.endedAt = new Date().toISOString();
    runState.reason = reason;
    runState.abortOwner = abortOwner;
    runState.elapsedMs = elapsedMs;
    this.emitComplete({
      taskId, runId, turnCount, toolsInvoked, succeeded: false,
      evidence: { abortOwner, budgetMs: totalBudgetMs, elapsedMs, stopReason: finalStopReason, tokenUsage, failureKind: kind },
    });
    throw new PDRuntimeError(category, reason, { nextAction });
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
    // PRI-795: flag BEFORE aborting so the in-flight startRun resolves
    // ownership as 'cancelled' after the loop returns silently. Guarded by
    // abortControllers membership so a late cancel of an already-terminal run
    // neither leaks a Set entry nor rewrites the recorded terminal state.
    if (this.abortControllers.has(runId)) {
      this.cancelledRuns.add(runId);
      const controller = this.abortControllers.get(runId);
      controller?.abort();
    }
    const state = this.runs.get(runId);
    if (state && this.abortControllers.has(runId) && state.status !== 'succeeded') {
      state.status = 'cancelled';
      state.endedAt = new Date().toISOString();
      state.reason = 'cancelled';
      state.abortOwner = 'cancelled';
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

  private runHandle(runId: string, startedAt: string): RunHandle {
    return {
      runId,
      runtimeKind: this.kind(),
      startedAt,
    };
  }

  private emitComplete(opts: {
    taskId: string;
    runId: string;
    turnCount: number;
    toolsInvoked: Record<string, number>;
    succeeded: boolean;
    /** PRI-795 runtime evidence block (budget/elapsed/abort ownership/usage). */
    evidence: {
      abortOwner?: L2AbortOwner;
      budgetMs: number;
      elapsedMs: number;
      stopReason: string | null;
      tokenUsage: L2TokenUsage;
      failureKind?: L2FailureKind;
    };
  }): void {
    this.eventEmitter.emitTelemetry({
      eventType: 'artificer_l2_complete',
      traceId: opts.taskId,
      timestamp: new Date().toISOString(),
      sessionId: 'l2-adapter',
      agentId: 'artificer-l2',
      payload: {
        taskId: opts.taskId,
        runId: opts.runId,
        turnCount: opts.turnCount,
        toolsInvoked: opts.toolsInvoked,
        succeeded: opts.succeeded,
        abortOwner: opts.evidence.abortOwner ?? 'none',
        budgetMs: opts.evidence.budgetMs,
        elapsedMs: opts.evidence.elapsedMs,
        stopReason: opts.evidence.stopReason ?? 'unavailable',
        tokenUsage: opts.evidence.tokenUsage,
        ...(opts.evidence.failureKind !== undefined ? { failureKind: opts.evidence.failureKind } : {}),
        model: { provider: this.config.provider, model: this.config.model, maxTokens: this.config.maxTokens ?? DEFAULT_MAX_TOKENS },
        outputPreview: safeStringifyPreview(this.runs.get(opts.runId)?.output?.payload, 300),
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
