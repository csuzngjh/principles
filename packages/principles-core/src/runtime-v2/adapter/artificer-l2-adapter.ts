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
import type { StoreEventEmitter } from '../store/event-emitter.js';
import { storeEmitter } from '../store/event-emitter.js';
import { safeStringifyPreview, truncatePreview } from './output-repair-contract.js';
import { resolveL2Model, pdStreamSimple } from './l2-agent-loop-adapter.js';
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
  /** Optional event emitter; defaults to the shared singleton. */
  readonly eventEmitter?: StoreEventEmitter;
}

interface ArtificerL2RunState {
  readonly runId: string;
  readonly startedAt: string;
  endedAt: string;
  status: 'succeeded' | 'failed' | 'timed_out';
  output: StructuredRunOutput | null;
  reason?: string;
}

const DEFAULT_MAX_TURNS = 12;
const DEFAULT_TOTAL_BUDGET_MS = 300_000;
const DEFAULT_MAX_TOKENS = 8192;
const MAX_RETAINED_RUNS = 100;

export class ArtificerL2Adapter implements PDRuntimeAdapter {
  private readonly config: ArtificerL2AdapterConfig;
  private readonly gateDeps: RefinerRuleHostGateDeps;
  private readonly validator: ArtificerValidator;
  private readonly eventEmitter: StoreEventEmitter;
  private readonly runs = new Map<string, ArtificerL2RunState>();
  private readonly abortControllers = new Map<string, AbortController>();

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

    const toolInstruction =
      '\n\n--- Tool protocol (Artificer L2 mode, PRI-439) ---\n' +
      'You have 4 tools to write and verify RuleCode:\n' +
      '  - read_rulecode_spec: read the RuleCode dialect spec (canonical form, forbidden patterns, return shape). Call FIRST.\n' +
      '  - validate_rulecode: statically validate a code string (forbidden patterns + return shape). Call after drafting code.\n' +
      '  - replay_rulecode: sandbox-replay code against a golden trace. Call after validate passes.\n' +
      '  - submit_rulecode: submit your final ArtificerRuleOutput. You MUST call this exactly once with a complete object; the loop stops after you call it.\n' +
      'Do not emit your final answer as free text — call submit_rulecode.';

    const prompts: AgentMessage[] = [
      { role: 'user', content: messageContent + toolInstruction, timestamp: Date.now() },
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
      systemPrompt: '',
      messages: prompts,
      tools,
    };

    const loopConfig: AgentLoopConfig = {
      model: resolveL2Model(this.config.provider, this.config.model, this.config.baseUrl),
      apiKey,
      maxTokens,
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
    };

    this.eventEmitter.emitTelemetry({
      eventType: 'artificer_l2_turn',
      traceId: taskId,
      timestamp: new Date().toISOString(),
      sessionId: 'l2-adapter',
      agentId: 'artificer-l2',
      payload: { runId, phase: 'loop_started', maxTurns, totalBudgetMs, maxTokens },
    });

    let timedOut = false;
    let loopError: string | null = null;
    try {
      await runAgentLoop(
        prompts,
        agentContext,
        loopConfig,
        async (event: AgentEvent) => { void event; },
        abortController.signal,
        pdStreamSimple,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      timedOut = budgetTimedOut;
      loopError = reason;
    }

    clearTimeout(budgetTimer);
    this.abortControllers.delete(runId);

    // Extract output from the capture (set by submit_rulecode).
    if (outputCapture.output !== null) {
      runState.status = 'succeeded';
      runState.endedAt = new Date().toISOString();
      runState.output = { runId, payload: outputCapture.output };
      this.emitComplete({ taskId, runId, turnCount, toolsInvoked, succeeded: true, timedOut: false });
      return this.runHandle(runId, startedAt);
    }

    // No output captured — fail loud (Runtime Contract Rule 9, ERR-002).
    // PRI-439: no V1/L1 fallback. Missing/invalid/replay-failing RuleCode
    // creates no rule artifact, approval, or activation.
    const failureReason = loopError !== null
      ? `Artificer L2 agent loop threw: ${loopError}`
      : `Artificer L2 agent loop ended without a submit_rulecode call after ${turnCount} turn(s)`;
    runState.status = timedOut ? 'timed_out' : 'failed';
    runState.endedAt = new Date().toISOString();
    runState.reason = failureReason;
    this.emitComplete({ taskId, runId, turnCount, toolsInvoked, succeeded: false, timedOut });
    throw new PDRuntimeError(
      timedOut ? 'timeout' : 'output_invalid',
      failureReason,
      {
        nextAction: timedOut
          ? 'increase totalBudgetMs or use a faster model; verify the model supports tool use'
          : 'inspect artificer L2 telemetry; verify the model calls submit_rulecode with a valid ArtificerRuleOutput',
      },
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
    const controller = this.abortControllers.get(runId);
    if (controller) {
      controller.abort();
    }
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
    timedOut: boolean;
  }): void {
    this.eventEmitter.emitTelemetry({
      eventType: 'artificer_l2_complete',
      traceId: opts.taskId,
      timestamp: new Date().toISOString(),
      sessionId: 'l2-adapter',
      agentId: 'artificer-l2',
      payload: {
        runId: opts.runId,
        turnCount: opts.turnCount,
        toolsInvoked: opts.toolsInvoked,
        succeeded: opts.succeeded,
        timedOut: opts.timedOut,
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
