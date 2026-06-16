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
import { getModel, getProviders } from '@earendil-works/pi-ai';
import type { Model, Message, KnownProvider } from '@earendil-works/pi-ai';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import { storeEmitter } from '../store/event-emitter.js';
import { PDRuntimeError } from '../error-categories.js';
import { extractJsonObject } from './json-extractor.js';
import { safeStringifyPreview } from './output-repair-contract.js';
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
}

/**
 * Resolve a pi-ai Model from provider/model/baseUrl config (mirrors PiAiRuntimeAdapter's
 * internal resolveModel). Built-in providers use getModel(); custom OpenAI-compatible
 * endpoints construct a Model object directly.
 */
function resolveL2Model(provider: string, modelId: string, baseUrl?: string): Model<string> {
  const knownProviders = getProviders();
  if (knownProviders.includes(provider as KnownProvider) && !baseUrl) {
    // @ts-expect-error — getModel requires literal model ID types; runtime strings from config are acceptable
    return getModel(provider as KnownProvider, modelId);
  }
  if (!baseUrl) {
    throw new PDRuntimeError(
      'runtime_unavailable',
      `Provider '${provider}' is not a built-in pi-ai provider and requires a custom baseUrl.`,
    );
  }
  // Custom provider with baseUrl — construct Model object directly (openai-completions API).
  return {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
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
    } as unknown as Model<string>;
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
        if (part && typeof part === 'object' && 'type' in part && (part as { type: string }).type === 'text') {
          const {text} = (part as { text?: unknown });
          if (typeof text === 'string' && text.trim().length > 0) return text;
        }
      }
    }
  }
  return null;
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

    const totalBudgetMs = this.config.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS;
    const maxTurns = this.config.maxTurns ?? DEFAULT_MAX_TURNS;
    const abortController = new AbortController();
    this.abortControllers.set(runId, abortController);
    const budgetTimer = setTimeout(() => abortController.abort(), totalBudgetMs);

    // Build the prompt message (the dreamer prompt builder already produces one JSON-string message).
    const messageContent = typeof input.inputPayload === 'string'
      ? input.inputPayload
      : JSON.stringify(input.inputPayload);

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

    // Output capture + telemetry accumulator.
    const outputCapture: L2OutputCapture = { output: null };
    const toolsInvoked: Record<string, number> = {};
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
          payload: {
            runId,
            toolName: info.toolName,
            ok: info.ok,
            error: info.error,
            turn: turnCount,
          },
        });
      },
    };

    const tools = buildDreamerL2Tools(toolContext);

    const agentContext = {
      systemPrompt: '', // dreamer prompt is already a complete instruction in the user message
      messages: prompts,
      tools,
    };

    const loopConfig: AgentLoopConfig = {
      model: resolveL2Model(this.config.provider, this.config.model, this.config.baseUrl),
      apiKey,
      // AgentMessage is `Message | CustomAgentMessages`; for the dreamer's standard
      // user/assistant/toolResult shape, the identity map is correct. Custom message
      // kinds are not used here, so we assert each message is a standard Message via
      // a narrowing check rather than a blind `as`.
      convertToLlm: (msgs: AgentMessage[]): Message[] => msgs.map((m): Message => {
        if (m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult') {
          return m as Message;
        }
        // Unknown custom message kind — should not occur for the dreamer; surface loudly.
        throw new PDRuntimeError('output_invalid', `L2 convertToLlm encountered an unsupported message role: ${String((m as { role?: string }).role)}`);
      }),
      beforeToolCall: async (ctx) => {
        // Defense-in-depth whitelist (primary boundary is read-only-by-construction readers).
        if (!DREAMER_L2_TOOL_WHITELIST.has(ctx.toolCall.name)) {
          return { block: true, reason: `tool '${ctx.toolCall.name}' is not in the dreamer L2 whitelist` };
        }
        return undefined;
      },
      shouldStopAfterTurn: () => {
        turnCount += 1;
        // Stop when submit_output captured output, or the turn cap is hit.
        return outputCapture.output !== null || turnCount >= maxTurns;
      },
    };

    this.eventEmitter.emitTelemetry({
      eventType: 'dreamer_l2_turn',
      traceId: taskId,
      timestamp: startedAt,
      sessionId: 'l2-adapter',
      agentId: 'dreamer-l2',
      payload: {
        runId,
        phase: 'loop_started',
        maxTurns,
        totalBudgetMs,
        toolNames: tools.map(t => t.name),
      },
    });

    let transcript: AgentMessage[];
    try {
      transcript = await runAgentLoop(
        prompts,
        agentContext,
        loopConfig,
        async (event: AgentEvent) => { void event; /* telemetry emitted via onToolExecution */ },
        abortController.signal,
      );
    } catch (err) {
      clearTimeout(budgetTimer);
      this.abortControllers.delete(runId);
      const {aborted} = abortController.signal;
      const reason = err instanceof Error ? err.message : String(err);
      runState.status = aborted ? 'timed_out' : 'failed';
      runState.reason = reason;
      runState.endedAt = new Date().toISOString();
      this.emitComplete({ taskId, runId, turnCount, toolsInvoked, usedFallback: false, timedOut: aborted });
      throw new PDRuntimeError(
        aborted ? 'timeout' : 'execution_failed',
        `L2 dreamer agent loop ${aborted ? 'timed out' : 'failed'}: ${reason}`,
        { nextAction: aborted ? 'increase totalBudgetMs or use a faster model' : 'check model tool-use support (P1.0a spike)' },
      );
    }

    clearTimeout(budgetTimer);
    this.abortControllers.delete(runId);

    // Extract output: primary = submit_output capture; fallback = last text-bearing assistant message.
    let validatedOutput: unknown;
    let usedFallback = false;
    if (outputCapture.output !== null) {
      validatedOutput = outputCapture.output;
    } else {
      const fallbackText = extractLastAssistantText(transcript);
      const extracted = fallbackText ? extractJsonObject(fallbackText) : null;
      if (extracted) {
        validatedOutput = extracted;
        usedFallback = true;
      } else {
        runState.status = 'failed';
        runState.reason = 'L2 loop ended without submit_output and no parseable JSON in final assistant message';
        runState.endedAt = new Date().toISOString();
        this.emitComplete({ taskId, runId, turnCount, toolsInvoked, usedFallback: false, timedOut: false });
        throw new PDRuntimeError(
          'output_invalid',
          'L2 dreamer loop completed but produced no output: submit_output was not called and the final assistant message had no parseable JSON.',
          { nextAction: 'verify the model supports tool-calling and the prompt instructs submit_output' },
        );
      }
    }

    runState.status = 'succeeded';
    runState.endedAt = new Date().toISOString();
    runState.output = { runId, payload: validatedOutput };
    this.emitComplete({ taskId, runId, turnCount, toolsInvoked, usedFallback, timedOut: false });

    return { runId, runtimeKind: 'pi-ai-l2', startedAt };
  }

  async pollRun(runId: string): Promise<RunStatus> {
    const state = this.runs.get(runId);
    if (!state) {
      return { runId, status: 'failed', reason: 'unknown runId' };
    }
    return {
      runId,
      status: state.status === 'succeeded' ? 'succeeded' : state.status === 'timed_out' ? 'timed_out' : 'failed',
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

  private emitComplete(opts: {
    taskId: string;
    runId: string;
    turnCount: number;
    toolsInvoked: Record<string, number>;
    usedFallback: boolean;
    timedOut: boolean;
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
        outputPreview: safeStringifyPreview(this.runs.get(opts.runId)?.output?.payload, 300),
      },
    });
  }
}

