/**
 * PRI-419 §M2+§M3 — L2AgentLoopAdapter.
 *
 * A PDRuntimeAdapter that runs the dreamer through a multi-turn agent loop
 * (@earendil-works/pi-agent-core) with read-only tools, instead of the one-shot
 * completeSimple path in PiAiRuntimeAdapter.
 *
 * Why the low-level runAgentLoop() and not the Agent class (review P0-1):
 *   Agent.createLoopConfig() does NOT forward shouldStopAfterTurn (agent.ts:422-449),
 *   which is exactly the hook we need to (a) cap turns and (b) terminate the loop when
 *   submit_output captures output. runAgentLoop gives us shouldStopAfterTurn +
 *   beforeToolCall + tools + abort signal in one config, and returns the final
 *   transcript directly. The Agent class adds steering/followup/session machinery the
 *   headless dreamer runner does not need.
 *
 * Why submit_output termination is NOT left to terminate: (review P0-2)
 *   agent-loop's shouldTerminateToolBatch uses .every(r => r.result.terminate) over the
 *   whole batch (agent-loop.ts:544). If the model calls read_principles + submit_output
 *   in the same turn, the batch does not terminate. We instead stop via
 *   shouldStopAfterTurn checking the L2OutputCapture, which is turn-granular.
 *
 * Output extraction:
 *   1. Primary: the params captured by the submit_output tool (deterministic, the
 *      model called the tool with a full DreamerOutputV1).
 *   2. Fallback: if the loop ends without a capture, walk the transcript backwards to
 *      the last assistant message containing text content, then extract JSON via the
 *      same extractJsonObject used by the L1 path. This preserves behaviour when a
 *      model emits free text instead of calling submit_output.
 *
 * Boundary: this adapter lives in core (it is pure orchestration of pi-agent-core +
 * the in-process tool contract from §M1; no node:* imports, no fs). The injected
 * readers (PdL2ArtifactReader / PdL2PrincipleReader) are supplied by the factory with
 * concrete stores that satisfy them structurally.
 */
import { runAgentLoop } from '@earendil-works/pi-agent-core';
import type { AgentMessage, AgentLoopConfig, AgentEvent } from '@earendil-works/pi-agent-core';
import { getModel, getProviders, completeSimple, streamSimple } from '@earendil-works/pi-ai/compat';
import type { Model, Message, KnownProvider, Context } from '@earendil-works/pi-ai/compat';
import type { SimpleStreamOptions } from '@earendil-works/pi-ai';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import { storeEmitter } from '../store/event-emitter.js';
import { PDRuntimeError } from '../error-categories.js';
import { extractJsonObject } from './json-extractor.js';
import { safeStringifyPreview } from './output-repair-contract.js';
import { getPiAiFetchForApi } from './pi-ai-http-transport.js';
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
} from '../runtime-protocol.js';
import {
  buildDreamerL2Tools,
  DREAMER_L2_TOOL_WHITELIST,
  type PdL2ToolContext,
  type PdL2ArtifactReader,
  type PdL2PrincipleReader,
  type L2OutputCapture,
} from '../tools/agent-tool-contract.js';

/** Configuration for L2AgentLoopAdapter. */
export interface L2AgentLoopAdapterConfig {
  /** Provider id (e.g. 'openai', 'anthropic'). */
  provider: string;
  /** Model id. */
  model: string;
  /** Env var name holding the API key. */
  apiKeyEnv: string;
  /** Optional custom base URL (OpenAI-compatible endpoints). */
  baseUrl?: string;
  /** Optional workspace path (for diagnostics only). */
  workspace?: string;
  /** Optional event emitter; defaults to the shared singleton. */
  eventEmitter?: StoreEventEmitter;
  /** Max agent-loop turns before forced stop (default 5). */
  maxTurns?: number;
  /** Total wall-clock budget for the whole loop in ms (default 300_000). */
  totalBudgetMs?: number;
  /**
   * PRI-420: max auto-retries when the agent loop returns an empty response (no submit_output
   * capture and no parseable text). The model API occasionally returns content=[] on long prompts;
   * retrying with fresh state recovers ~100%. Default 2. Set to 0 to disable.
   */
  maxEmptyRetries?: number;
  /**
   * PRI-420: when true (default), if all L2 attempts fail, fall back to a one-shot completeSimple
   * call (L1 equivalent) so the dreamer still produces output. Emits dreamer_l2_fallback_to_l1.
   * Set to false to fail loud without fallback.
   */
  l2FallbackToL1?: boolean;
}

/**
 * Resolve a pi-ai Model from provider/model/baseUrl config (L2 variant of
 * PiAiRuntimeAdapter's internal resolveModel — kept separate because L2 runs
 * on a streaming agent loop rather than one-shot completeSimple; both now live
 * on the single @earendil-works scope, so the historical "no cross-import"
 * reason for full duplication is gone and a dedupe is planned as PR3 follow-up).
 * Deliberately NOT catalog-first: L2's strict Model<string> return shape and
 * its streaming loop semantics are untested against borrowed catalog entries.
 * Built-in providers use getModel(); custom OpenAI-compatible endpoints
 * construct a Model object directly.
 */
export function resolveL2Model(provider: string, modelId: string, baseUrl?: string): Model<string> {
  const knownProviders = getProviders();
  if ((knownProviders as string[]).includes(provider) && !baseUrl) {
    // @ts-expect-error — getModel requires literal model ID types; runtime strings from config are acceptable
    return getModel(provider as KnownProvider, modelId);
  }
  if (!baseUrl) {
    throw new PDRuntimeError(
      'runtime_unavailable',
      `Provider '${provider}' is not a built-in pi-ai provider and requires a custom baseUrl.`,
    );
  }
  // Custom provider with baseUrl — construct a Model object directly (openai-completions API).
  // The literal object doesn't fully satisfy Model<string>'s discriminant union, so narrow via unknown.
  const customModel = {
    id: modelId,
    name: modelId,
    api: 'openai-completions' as const,
    provider,
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 32000,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
      maxTokensField: 'max_tokens',
      requiresToolResultName: false,
      requiresAssistantAfterToolResult: false,
      requiresThinkingAsText: false,
      requiresReasoningContentOnAssistantMessages: false,
      thinkingFormat: 'deepseek',
      supportsStrictMode: false,
    },
  };
  // RUNTIME_CONTRACT: this double-assertion narrows a literal object to Model<string>'s
  // discriminant union (the literal doesn't fully satisfy every union arm). If pi-agent-core
  // changes Model's shape after an upgrade, this will NOT be caught at compile time — re-verify
  // resolveL2Model's return against the live provider path after any @earendil-works/pi-ai bump.
  return customModel as unknown as Model<string>;
}

/** Read-only readers injected by the factory (bound to the dreamer's task + stores). */
export interface L2AgentLoopAdapterDeps {
  artifactReader: PdL2ArtifactReader;
  principleReader: PdL2PrincipleReader;
}

interface L2RunState {
  runId: string;
  startedAt: string;
  endedAt: string;
  status: 'succeeded' | 'failed' | 'timed_out';
  reason?: string;
  output?: StructuredRunOutput;
}

const DEFAULT_MAX_TURNS = 5;
const DEFAULT_TOTAL_BUDGET_MS = 300_000;
const DEFAULT_MAX_EMPTY_RETRIES = 2;

/**
 * PRI-420: result of a single agentLoop attempt. The `status` field discriminates the
 * three outcomes: 'ok' (output extracted), 'empty' (no output — retry or fallback),
 * 'error' (loop threw — stop retrying).
 */
type L2AttemptResult =
  | { status: 'ok'; output: unknown; usedTextFallback: boolean }
  | { status: 'empty' }
  | { status: 'error'; reason: string; timedOut: boolean };
/**
 * Maximum number of completed run records retained in memory. The runs Map is bounded to
 * prevent unbounded growth in long-running services (e.g. the auto-consumer wakes every 120s).
 * When exceeded, the oldest entries are evicted. fetchOutput/pollRun only need recent runs.
 */
const MAX_RETAINED_RUNS = 100;

/** Walk the transcript backwards to the last assistant message containing text content. */
function extractLastAssistantText(messages: AgentMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== 'assistant') continue;
    const content: unknown = (msg as { content?: unknown }).content;
    if (typeof content === 'string' && content.trim().length > 0) {
      return content;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === 'object' && Object.hasOwn(part, 'type')) {
          const typeValue = Reflect.get(part, 'type');
          if (typeValue === 'text') {
            const textValue = Reflect.get(part, 'text');
            if (typeof textValue === 'string' && textValue.trim().length > 0) return textValue;
          }
        }
      }
    }
  }
  return null;
}

/**
 * PRI-683: streamSimple bound to a transport whose undici idle caps are
 * disabled, so agent-loop LLM calls are not silently aborted at Node fetch's
 * implicit 300s boundary before the configured budget fires.
 * PR #1524 review follow-up: the fetch is resolved per model API — the
 * google-generative-ai / google-vertex adapters reject any non-globalThis
 * fetch at entry, so those APIs keep Node's global fetch instead of failing
 * every L2 call. Exported for ArtificerL2Adapter, which runs the same loop.
 */
export function pdStreamSimple(model: Model<string>, context: Context, options?: SimpleStreamOptions) {
  return streamSimple(model, context, { ...options, fetch: getPiAiFetchForApi(model.api) });
}

export class L2AgentLoopAdapter implements PDRuntimeAdapter {
  private readonly config: L2AgentLoopAdapterConfig;
  private readonly deps: L2AgentLoopAdapterDeps;
  private readonly eventEmitter: StoreEventEmitter;
  private readonly runs = new Map<string, L2RunState>();
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(config: L2AgentLoopAdapterConfig, deps: L2AgentLoopAdapterDeps) {
    this.config = config;
    this.deps = deps;
    this.eventEmitter = config.eventEmitter ?? storeEmitter;
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- required by PDRuntimeAdapter interface
  kind(): RuntimeKind {
    return 'pi-ai-l2';
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- required by PDRuntimeAdapter interface
  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      supportsStructuredJsonOutput: true,
      supportsToolUse: true, // L2 is defined by tool use
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
    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const apiKey = process.env[this.config.apiKeyEnv];
    if (!apiKey) {
      throw new PDRuntimeError(
        'runtime_unavailable',
        `API key not found in env: ${this.config.apiKeyEnv}`,
      );
    }

    const taskId = input.taskRef?.taskId ?? runId;
    const runState: L2RunState = { runId, startedAt, endedAt: startedAt, status: 'failed' };
    this.runs.set(runId, runState);
    this.evictOldRuns();

    const totalBudgetMs = this.config.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS;
    const maxTurns = this.config.maxTurns ?? DEFAULT_MAX_TURNS;
    const maxEmptyRetries = this.config.maxEmptyRetries ?? DEFAULT_MAX_EMPTY_RETRIES;
    const l2FallbackToL1 = this.config.l2FallbackToL1 ?? true;
    const abortController = new AbortController();
    this.abortControllers.set(runId, abortController);
    const budgetTimer = setTimeout(() => abortController.abort(), totalBudgetMs);

    // Build the prompt message (the dreamer prompt builder already produces one JSON-string message).
    // Serialized before the try block: if inputPayload is non-serializable (circular/BigInt),
    // fail loud with cleanup so budgetTimer/abortController don't leak.
    let messageContent: string;
    try {
      messageContent = typeof input.inputPayload === 'string'
        ? input.inputPayload
        : JSON.stringify(input.inputPayload);
    } catch (err) {
      clearTimeout(budgetTimer);
      this.abortControllers.delete(runId);
      const reason = err instanceof Error ? err.message : String(err);
      runState.status = 'failed';
      runState.reason = `inputPayload not serializable: ${reason}`;
      runState.endedAt = new Date().toISOString();
      throw new PDRuntimeError(
        'input_invalid',
        `L2 inputPayload is not serializable: ${reason}`,
        { nextAction: 'ensure StartRunInput.inputPayload is a string or JSON-serializable object' },
      );
    }

    // Tool usage instruction appended so the model knows the tool protocol.
    const toolInstruction =
      '\n\n--- Tool protocol (L2 mode) ---\n' +
      'You have read-only tools to ground your output:\n' +
      '  - read_principles: read the core axioms (T-01..T-10) + already-internalized principles. Call BEFORE proposing candidates.\n' +
      '  - read_artifact: read a predecessor pipeline artifact by artifactId or sourceTaskId to verify the evidence chain.\n' +
      '  - submit_output: submit your final DreamerOutputV1. You MUST call this exactly once with a complete object; the loop stops after you call it.\n' +
      'Do not emit your final answer as free text — call submit_output.';

    const prompts: AgentMessage[] = [
      { role: 'user', content: messageContent + toolInstruction, timestamp: Date.now() },
    ];

    // Telemetry accumulator shared across all L2 attempts (PRI-420 retry loop).
    const toolsInvoked: Record<string, number> = {};
    let totalRetryCount = 0;
    let totalTurnCount = 0;

    const emitLoopStarted = (): void => {
      this.eventEmitter.emitTelemetry({
        eventType: 'dreamer_l2_turn',
        traceId: taskId,
        timestamp: new Date().toISOString(),
        sessionId: 'l2-adapter',
        agentId: 'dreamer-l2',
        payload: { runId, phase: 'loop_started', maxTurns, totalBudgetMs, maxEmptyRetries },
      });
    };

    /**
     * PRI-420: run a single agentLoop attempt with fresh state (EP-05: each retry uses fresh
     * outputCapture/turnCount, never stale loop state).
     * Returns a result with a `status` discriminator: 'ok' (output extracted), 'empty'
     * (no output — triggers retry/fallback), or 'error' (loop threw).
     */
    const runSingleAttempt = async (): Promise<L2AttemptResult> => {
      // Fresh capture + turn counter per attempt (EP-05 loop-state freshness).
      const outputCapture: L2OutputCapture = { output: null };
      let turnCount = 0;

      const toolContext: PdL2ToolContext = {
        artifactReader: this.deps.artifactReader,
        principleReader: this.deps.principleReader,
        outputCapture,
        onToolExecution: (info) => {
          toolsInvoked[info.toolName] = (toolsInvoked[info.toolName] ?? 0) + 1;
          this.eventEmitter.emitTelemetry({
            eventType: 'dreamer_l2_turn',
            traceId: taskId,
            timestamp: new Date().toISOString(),
            sessionId: 'l2-adapter',
            agentId: 'dreamer-l2',
            payload: { runId, toolName: info.toolName, ok: info.ok, error: info.error, turn: turnCount },
          });
        },
      };

      const tools = buildDreamerL2Tools(toolContext);
      const agentContext = {
        systemPrompt: '',
        messages: prompts,
        tools,
      };

      const loopConfig: AgentLoopConfig = {
        model: resolveL2Model(this.config.provider, this.config.model, this.config.baseUrl),
        apiKey,
        convertToLlm: (msgs: AgentMessage[]): Message[] => msgs.map((m): Message => {
          if (m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult') {
            return m as Message;
          }
          throw new PDRuntimeError('output_invalid', `L2 convertToLlm encountered an unsupported message role: ${String((m as { role?: string }).role)}`);
        }),
        beforeToolCall: async (ctx) => {
          if (!DREAMER_L2_TOOL_WHITELIST.has(ctx.toolCall.name)) {
            return { block: true, reason: `tool '${ctx.toolCall.name}' is not in the dreamer L2 whitelist` };
          }
          return undefined;
        },
        shouldStopAfterTurn: () => {
          turnCount += 1;
          return outputCapture.output !== null || turnCount >= maxTurns;
        },
      };

      let transcript: AgentMessage[];
      try {
        transcript = await runAgentLoop(
          prompts,
          agentContext,
          loopConfig,
          async (event: AgentEvent) => { void event; },
          abortController.signal,
          pdStreamSimple,
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { status: 'error', reason, timedOut: abortController.signal.aborted };
      }

      totalTurnCount += turnCount;

      // Extract output: primary = submit_output capture; secondary = last text-bearing assistant message.
      if (outputCapture.output !== null) {
        return { status: 'ok', output: outputCapture.output, usedTextFallback: false };
      }
      const fallbackText = extractLastAssistantText(transcript);
      const extracted = fallbackText ? extractJsonObject(fallbackText) : null;
      if (extracted) {
        return { status: 'ok', output: extracted, usedTextFallback: true };
      }
      return { status: 'empty' };
    };

    emitLoopStarted();

    // PRI-420: retry loop — attempt the agent loop up to 1 + maxEmptyRetries times.
    // Each retry uses fresh state (EP-05). Empty responses (no submit_output, no parseable
    // text) trigger a retry; the model API returns content=[] ~57% of the time on long prompts.
    let l2Result: L2AttemptResult | null = null;
    let lastError: { reason: string; timedOut: boolean } | null = null;
    const maxAttempts = 1 + maxEmptyRetries;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        totalRetryCount += 1;
        this.eventEmitter.emitTelemetry({
          eventType: 'dreamer_l2_turn',
          traceId: taskId,
          timestamp: new Date().toISOString(),
          sessionId: 'l2-adapter',
          agentId: 'dreamer-l2',
          payload: { runId, phase: 'empty_response_retry', attempt },
        });
      }

      l2Result = await runSingleAttempt();

      if (l2Result.status === 'ok') {
        break; // Success — output extracted.
      }
      if (l2Result.status === 'error') {
        // Loop threw (timeout or execution error). Stop retrying — retrying a timeout wastes budget.
        lastError = { reason: l2Result.reason, timedOut: l2Result.timedOut };
        break;
      }
      // status === 'empty' → retry if attempts remain (loop continues).
    }

    clearTimeout(budgetTimer);
    this.abortControllers.delete(runId);

    // Handle the L2 result.
    if (l2Result?.status === 'ok') {
      // L2 succeeded (possibly after retries).
      runState.status = 'succeeded';
      runState.endedAt = new Date().toISOString();
      runState.output = { runId, payload: l2Result.output };
      this.emitComplete({ taskId, runId, turnCount: totalTurnCount, toolsInvoked, usedFallback: l2Result.usedTextFallback, timedOut: false, retryCount: totalRetryCount });
      return { runId, runtimeKind: 'pi-ai-l2', startedAt };
    }

    // L2 failed (empty response on all attempts, or a throw). Try L1 fallback if enabled.
    const failureReason = lastError ? lastError.reason : 'L2 loop produced empty response on all attempts (no submit_output, no parseable JSON)';
    const failureTimedOut = lastError ? lastError.timedOut : false;

    if (l2FallbackToL1) {
      this.eventEmitter.emitTelemetry({
        eventType: 'dreamer_l2_fallback_to_l1',
        traceId: taskId,
        timestamp: new Date().toISOString(),
        sessionId: 'l2-adapter',
        agentId: 'dreamer-l2',
        payload: { runId, reason: failureReason, retryCount: totalRetryCount, timedOut: failureTimedOut },
      });

      // L1 one-shot fallback: same prompt, single completeSimple call, JSON extraction.
      try {
        const l1Output = await this.runL1Fallback(messageContent, apiKey);
        runState.status = 'succeeded';
        runState.endedAt = new Date().toISOString();
        runState.output = { runId, payload: l1Output };
        this.emitComplete({ taskId, runId, turnCount: totalTurnCount, toolsInvoked, usedFallback: true, timedOut: false, retryCount: totalRetryCount });
        return { runId, runtimeKind: 'pi-ai-l2', startedAt };
      } catch (l1Err) {
        // Both L2 and L1 failed — fail loud with both reasons (R9: observable degradation).
        const l1Reason = l1Err instanceof Error ? l1Err.message : String(l1Err);
        runState.status = 'failed';
        runState.reason = `L2 failed (${failureReason}); L1 fallback also failed (${l1Reason})`;
        runState.endedAt = new Date().toISOString();
        this.emitComplete({ taskId, runId, turnCount: totalTurnCount, toolsInvoked, usedFallback: false, timedOut: failureTimedOut, retryCount: totalRetryCount });
        throw new PDRuntimeError(
          'execution_failed',
          `L2 dreamer failed and L1 fallback also failed. L2: ${failureReason}. L1: ${l1Reason}`,
          { nextAction: 'check model availability and API key; review telemetry for retry/fallback details' },
        );
      }
    }

    // No fallback — fail loud (R9).
    runState.status = failureTimedOut ? 'timed_out' : 'failed';
    runState.reason = failureReason;
    runState.endedAt = new Date().toISOString();
    this.emitComplete({ taskId, runId, turnCount: totalTurnCount, toolsInvoked, usedFallback: false, timedOut: failureTimedOut, retryCount: totalRetryCount });
    throw new PDRuntimeError(
      failureTimedOut ? 'timeout' : 'output_invalid',
      `L2 dreamer failed after ${totalRetryCount} retries: ${failureReason}`,
      { nextAction: failureTimedOut ? 'increase totalBudgetMs or use a faster model' : 'check model tool-use support or enable l2FallbackToL1' },
    );
  }

  /**
   * PRI-420: L1 one-shot fallback. Runs a single completeSimple call with the same prompt
   * (without tool instructions) and extracts JSON from the response. This is the safety net
   * when all L2 attempts fail — it ensures the dreamer still produces output.
   */
  private async runL1Fallback(messageContent: string, apiKey: string): Promise<unknown> {
    const model = resolveL2Model(this.config.provider, this.config.model, this.config.baseUrl);
    const userMessage = { role: 'user' as const, content: messageContent, timestamp: Date.now() };
    const context: Context = { messages: [userMessage] };
    const response = await completeSimple(model, context, { apiKey, signal: AbortSignal.timeout(120_000), fetch: getPiAiFetchForApi(model.api) });
    // Extract the text content from the response and parse JSON.
    let text: string | null = null;
    if (typeof response.content === 'string') {
      text = response.content;
    } else if (Array.isArray(response.content)) {
      const textPart = (response.content as unknown[]).find(
        (c): c is { type: 'text'; text: string } =>
          typeof c === 'object' && c !== null && Object.hasOwn(c, 'type') && Reflect.get(c, 'type') === 'text',
      );
      text = textPart?.text ?? null;
    }
    if (!text) {
      throw new Error('L1 fallback response had no text content');
    }
    const extracted = extractJsonObject(text);
    if (!extracted) {
      throw new Error('L1 fallback response had no parseable JSON');
    }
    return extracted;
  }

  async pollRun(runId: string): Promise<RunStatus> {
    const state = this.runs.get(runId);
    if (!state) {
      return { runId, status: 'failed', reason: 'unknown runId' };
    }
    // L2RunState.status values ('succeeded'|'failed'|'timed_out') are already valid RunExecutionStatus.
    return {
      runId,
      status: state.status,
      startedAt: state.startedAt,
      endedAt: state.endedAt,
      reason: state.reason,
    };
  }

  async cancelRun(runId: string): Promise<void> {
    const controller = this.abortControllers.get(runId);
    if (controller) {
      controller.abort();
    }
  }

  async fetchOutput(runId: string): Promise<StructuredRunOutput | null> {
    const state = this.runs.get(runId);
    return state?.output ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- required by PDRuntimeAdapter interface
  async fetchArtifacts(_runId: string): Promise<RuntimeArtifactRef[]> {
    // L2 produces no separate runtime artifacts; output is in fetchOutput.
    return [];
  }

  /**
   * Bound the runs Map to MAX_RETAINED_RUNS to prevent unbounded memory growth in
   * long-running services (the auto-consumer wakes every 120s). Evicts the oldest
   * entries by insertion order (Map preserves it). Called at the start of each run.
   */
  private evictOldRuns(): void {
    if (this.runs.size <= MAX_RETAINED_RUNS) return;
    const excess = this.runs.size - MAX_RETAINED_RUNS;
    let evicted = 0;
    for (const runId of this.runs.keys()) {
      if (evicted >= excess) break;
      this.runs.delete(runId);
      evicted++;
    }
  }

  private emitComplete(opts: {
    taskId: string;
    runId: string;
    turnCount: number;
    toolsInvoked: Record<string, number>;
    usedFallback: boolean;
    timedOut: boolean;
    retryCount: number;
  }): void {
    this.eventEmitter.emitTelemetry({
      eventType: 'dreamer_l2_complete',
      traceId: opts.taskId,
      timestamp: new Date().toISOString(),
      sessionId: 'l2-adapter',
      agentId: 'dreamer-l2',
      payload: {
        runId: opts.runId,
        turnCount: opts.turnCount,
        toolsInvoked: opts.toolsInvoked,
        usedFallback: opts.usedFallback,
        timedOut: opts.timedOut,
        retryCount: opts.retryCount,
        outputPreview: safeStringifyPreview(this.runs.get(opts.runId)?.output?.payload, 300),
      },
    });
  }
}

