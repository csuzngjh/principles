/**
 * PiAiRuntimeAdapter — PDRuntimeAdapter implementation for direct LLM completion.
 *
 * Uses @mariozechner/pi-ai to call LLM providers directly, bypassing the OpenClaw CLI.
 * Solves the m8-03 UAT blocker where the main agent takes >300s.
 *
 * One-shot run: startRun() calls pi-ai complete(), blocks until LLM responds,
 * stores output in memory. pollRun()/fetchOutput() operate on stored state.
 *
 * Error mapping:
 *   AbortError (signal.timeout) → timeout
 *   JSON extraction failure → output_invalid
 *   DiagnosticianOutputV1Schema validation failure → output_invalid
 *   Missing apiKeyEnv → runtime_unavailable
 *   Retries exhausted → execution_failed
 */
import { getModel, getProviders, complete } from '@mariozechner/pi-ai';
import type { KnownProvider, Context, UserMessage, AssistantMessage, Model } from '@mariozechner/pi-ai';
import { Value } from '@sinclair/typebox/value';
import { PDRuntimeError } from '../error-categories.js';
import { DiagnosticianOutputV1Schema } from '../diagnostician-output.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import { storeEmitter } from '../store/event-emitter.js';
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

/**
 * Configuration for PiAiRuntimeAdapter.
 *
 * provider, model, apiKeyEnv — required, consumed from workflows.yaml policy.
 * maxRetries, timeoutMs — optional overrides with sensible defaults.
 */
export interface PiAiRuntimeAdapterConfig {
  /** LLM provider name (e.g., 'openrouter', 'anthropic'). Must be a valid KnownProvider. */
  provider: string;
  /** Model ID (e.g., 'anthropic/claude-sonnet-4'). */
  model: string;
  /** Name of the environment variable containing the API key. */
  apiKeyEnv: string;
  /** Maximum retry attempts for transient LLM failures. Default: 2. */
  maxRetries?: number;
  /** Timeout in milliseconds for LLM completion. Default: 300_000 (5 min). */
  timeoutMs?: number;
  /** Custom base URL for OpenAI-compatible providers not in pi-ai's built-in registry. */
  baseUrl?: string;
  /** Optional workspace directory (reserved for future use). */
  workspace?: string;
  /** Optional StoreEventEmitter for telemetry. Falls back to global storeEmitter. */
  eventEmitter?: StoreEventEmitter;
}

/**
 * Resolve a pi-ai Model from dynamic config values.
 *
 * For built-in providers (openrouter, anthropic, etc.), uses getModel().
 * For custom providers (e.g., xiaomi-coding with custom baseUrl), creates
 * a Model<Api> object directly. This enables pi-ai to call OpenAI-compatible
 * endpoints that aren't in pi-ai's built-in provider registry.
 */
function resolveModel(provider: string, modelId: string, baseUrl?: string) {
  const knownProviders = getProviders();
  if (knownProviders.includes(provider as KnownProvider) && !baseUrl) {
    // Built-in provider — use getModel()
    // @ts-expect-error — getModel requires literal model ID types; runtime strings from config are acceptable
    return getModel(provider as KnownProvider, modelId);
  }

  // Custom provider — baseUrl is required
  if (!baseUrl) {
    throw new PDRuntimeError(
      'runtime_unavailable',
      `Provider '${provider}' is not a built-in pi-ai provider and requires a custom baseUrl. ` +
      `Pass --baseUrl <url> or add 'baseUrl' to your workflows.yaml policy.`,
    );
  }

  // Custom provider with baseUrl — construct Model object directly
  // Default to openai-completions API for custom OpenAI-compatible endpoints
  const model: Model<'openai-completions'> = {
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
  };
  return model;
}

/**
 * Detection for abort/timeout errors from provider SDKs.
 *
 * Checks:
 *   1. AbortSignal already aborted
 *   2. DOMException AbortError (native fetch/Node abort)
 *   3. Error objects with name === 'AbortError' (some SDKs)
 *   4. Non-PDRuntimeError Error with "timeout" or "abort" in message
 *      (provider SDKs that throw plain Error on timeout)
 *
 * Excludes PDRuntimeError to avoid false positives from our own wrapped
 * error messages that may contain "timed out".
 */
function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  if (typeof err === 'object' && err !== null && 'name' in err && (err as { name?: unknown }).name === 'AbortError') return true;
  if (err instanceof Error && !(err instanceof PDRuntimeError) && (/abort/i.test(err.message) || /timeout/i.test(err.message))) return true;
  return false;
}

/**
 * Extract text content from an AssistantMessage, or throw PDRuntimeError.
 *
 * pi-ai complete() may RESOLVE (not reject) with stopReason:'error' when
 * the provider returns an error response (e.g., 401, rate limit).
 * This helper normalizes those resolved-error responses into PDRuntimeError
 * so downstream code never sees a "successful" response that is actually broken.
 *
 * Error classification:
 *   stopReason:'aborted'                              → timeout
 *   stopReason:'error' + timeout/abort in errorMessage → timeout
 *   stopReason:'error' + other                        → execution_failed
 *   no text content block                              → output_invalid
 */
function extractAssistantTextOrThrow(
  response: { content: { type: string; text?: string }[]; stopReason?: string; errorMessage?: string },
  signal?: AbortSignal,
): string {
  // Handle resolved-error responses from pi-ai
  if (response.stopReason === 'error' || response.stopReason === 'aborted') {
    const rawMessage = response.errorMessage ?? 'unknown provider error';
    // Truncate to 300 chars to avoid leaking huge payloads into logs/telemetry
    const boundedMessage = rawMessage.length > 300 ? rawMessage.substring(0, 300) + '...' : rawMessage;

    const isTimeout = response.stopReason === 'aborted'
      || signal?.aborted
      || /timeout|timed\s*out/i.test(rawMessage)
      || /abort/i.test(rawMessage);

    throw new PDRuntimeError(
      isTimeout ? 'timeout' : 'execution_failed',
      isTimeout
        ? `LLM request timed out: ${boundedMessage}`
        : `LLM execution failed: ${boundedMessage}`,
    );
  }

  const textContent = response.content.find(c => c.type === 'text');
  if (!textContent || textContent.type !== 'text' || !textContent.text) {
    throw new PDRuntimeError('output_invalid', 'No text content in LLM response');
  }

  return textContent.text;
}

/**
 * Balanced-bracket JSON extraction from LLM output.
 * Handles prose-wrapped and code-fenced JSON (```json ... ```).
 * Returns the parsed object, or null if no valid JSON found.
 */
function extractJsonObject(text: string): unknown | null {
  // Try code-fenced JSON first: ```json ... ``` or ``` ... ```
  const fencedMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?```/.exec(text);
  if (fencedMatch) {
    const [, fencedContent] = fencedMatch;
    if (fencedContent) {
      try { return JSON.parse(fencedContent.trim()); } catch { /* fall through */ }
    }
  }

  // Balanced-bracket scan for first top-level {...}
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { start = -1; }
      }
    }
  }
  return null;
}

/** Internal run state for one-shot pattern. */
interface RunState {
  runId: string;
  startedAt: string;
  endedAt: string;
  status: 'succeeded' | 'failed' | 'timed_out';
  reason?: string;
  output?: StructuredRunOutput;
}

export class PiAiRuntimeAdapter implements PDRuntimeAdapter {
  private readonly config: PiAiRuntimeAdapterConfig;
  private readonly runs = new Map<string, RunState>();
  private readonly eventEmitter: StoreEventEmitter;
  private readonly runtimeKind: RuntimeKind = 'pi-ai';
  private readonly defaultCapabilities: RuntimeCapabilities = {
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

  constructor(config: PiAiRuntimeAdapterConfig) {
    this.config = config;
    this.eventEmitter = config.eventEmitter ?? storeEmitter;
  }

  kind(): RuntimeKind {
    return this.runtimeKind;
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return this.defaultCapabilities;
  }

  /**
   * Three-stage health probe (per M6 lesson: binary/list-only checks are fake probes).
   *
   * 1. apiKey exists in environment
   * 2. getModel validates without throwing
   * 3. Minimal complete probe with {"ok":true} verification
   */
  async healthCheck(): Promise<RuntimeHealth> {
    const lastCheckedAt = new Date().toISOString();

    // Stage 1: apiKey exists
    const apiKey = process.env[this.config.apiKeyEnv];
    if (!apiKey) {
      return {
        healthy: false,
        degraded: false,
        warnings: [`API key not found in env: ${this.config.apiKeyEnv}`],
        lastCheckedAt,
      };
    }

    // Stage 2+3: getModel valid + minimal complete probe
    try {
      const model = resolveModel(this.config.provider, this.config.model, this.config.baseUrl);
      const timeoutMs = this.config.timeoutMs ?? 120_000;
      const signal = AbortSignal.timeout(timeoutMs);
      const probeContext: Context = {
        messages: [{
          role: 'user',
          content: 'Reply with {"ok":true} only.',
          timestamp: Date.now(),
        }],
      };

      const response = await complete(model, probeContext, {
        signal,
        apiKey,
        timeoutMs,
        maxRetries: 0,
      });

      // extractAssistantTextOrThrow normalizes resolved-error responses
      const text = extractAssistantTextOrThrow(response, signal);
      const parsed = extractJsonObject(text);
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('ok' in parsed) ||
        (parsed as { ok?: unknown }).ok !== true
      ) {
        return {
          healthy: false,
          degraded: true,
          warnings: [`probe returned unexpected result: ${text.substring(0, 200)}`],
          lastCheckedAt,
        };
      }
    } catch (err) {
      // PDRuntimeError from extractAssistantTextOrThrow (timeout/execution_failed)
      // or thrown errors from complete() (AbortError, network, etc.)
      if (err instanceof PDRuntimeError && err.category === 'timeout') {
        return {
          healthy: false,
          degraded: true,
          warnings: [`probe timed out: ${err.message}`],
          lastCheckedAt,
        };
      }
      if (err instanceof PDRuntimeError) {
        return {
          healthy: false,
          degraded: err.category === 'output_invalid',
          warnings: [`probe failed: ${err.message}`],
          lastCheckedAt,
        };
      }
      if (isAbortError(err)) {
        return {
          healthy: false,
          degraded: true,
          warnings: ['probe timed out'],
          lastCheckedAt,
        };
      }
      return {
        healthy: false,
        degraded: false,
        warnings: [`probe failed: ${err instanceof Error ? err.message : String(err)}`],
        lastCheckedAt,
      };
    }

    return { healthy: true, degraded: false, warnings: [], lastCheckedAt };
  }

  /**
   * One-shot run: call LLM via pi-ai complete(), parse and validate output.
   * Blocks until LLM responds (or times out). Run is terminal on return.
   */
  async startRun(input: StartRunInput): Promise<RunHandle> {
    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();

    // Read API key
    const apiKey = process.env[this.config.apiKeyEnv];
    if (!apiKey) {
      throw new PDRuntimeError(
        'runtime_unavailable',
        `API key not found in env: ${this.config.apiKeyEnv}`,
      );
    }

    // Create run state immediately — failed runs are always trackable
    const runState: RunState = {
      runId,
      startedAt,
      endedAt: startedAt, // will be updated on completion
      status: 'failed', // default until succeeded
    };
    this.runs.set(runId, runState);

    // AbortSignal.timeout for clean timeout control
    const effectiveTimeoutMs = input.timeoutMs || this.config.timeoutMs || 300_000;
    const signal = AbortSignal.timeout(effectiveTimeoutMs);

    // Build pi-ai Context from inputPayload
    const messageContent = typeof input.inputPayload === 'string'
      ? input.inputPayload
      : JSON.stringify(input.inputPayload);
    const userMessage: UserMessage = {
      role: 'user',
      content: messageContent,
      timestamp: Date.now(),
    };
    const context: Context = { messages: [userMessage] };

    // Get model
    const model = resolveModel(this.config.provider, this.config.model, this.config.baseUrl);

    // Emit runtime_invocation_started telemetry
    this.eventEmitter.emitTelemetry({
      eventType: 'runtime_invocation_started',
      traceId: input.taskRef?.taskId ?? runId,
      timestamp: startedAt,
      sessionId: 'pi-ai-adapter',
      agentId: 'pi-ai-adapter',
      payload: {
        runId,
        runtimeKind: 'pi-ai',
        provider: this.config.provider,
        model: this.config.model,
        timeoutMs: effectiveTimeoutMs,
      },
    });

    try {
      // Call LLM with retry
      const response = await this.completeWithRetry(model, context, { signal, apiKey });

      // extractAssistantTextOrThrow normalizes resolved-error responses
      // (e.g., stopReason:'error' + errorMessage:'401 Unauthorized')
      // into proper PDRuntimeError — prevents misclassifying API errors as output_invalid
      const text = extractAssistantTextOrThrow(response, signal);

      // Parse response — handles prose-wrapped and code-fenced JSON
      const parsed = extractJsonObject(text);
      if (!parsed) {
        throw new PDRuntimeError('output_invalid', 'No valid JSON found in LLM response');
      }

      // Validate with DiagnosticianOutputV1Schema
      if (!Value.Check(DiagnosticianOutputV1Schema, parsed)) {
        throw new PDRuntimeError(
          'output_invalid',
          'LLM output does not match DiagnosticianOutputV1 schema',
        );
      }

      // Update run state to succeeded
      const endedAt = new Date().toISOString();
      runState.status = 'succeeded';
      runState.endedAt = endedAt;
      runState.output = { runId, payload: parsed };

      // Emit runtime_invocation_succeeded telemetry
      this.eventEmitter.emitTelemetry({
        eventType: 'runtime_invocation_succeeded',
        traceId: input.taskRef?.taskId ?? runId,
        timestamp: endedAt,
        sessionId: 'pi-ai-adapter',
        agentId: 'pi-ai-adapter',
        payload: {
          runId,
          runtimeKind: 'pi-ai',
        },
      });
    } catch (err) {
      // Update run state to failed
      const endedAt = new Date().toISOString();
      runState.endedAt = endedAt;

      if (isAbortError(err, signal)) {
        runState.status = 'timed_out';
        runState.reason = `LLM request timed out after ${effectiveTimeoutMs}ms`;
      } else if (err instanceof PDRuntimeError) {
        runState.status = 'failed';
        runState.reason = err.message;
      } else {
        runState.status = 'failed';
        runState.reason = err instanceof Error ? err.message : String(err);
      }

      // Emit runtime_invocation_failed telemetry
      const errorCategory = err instanceof PDRuntimeError ? err.category : 'execution_failed';
      this.eventEmitter.emitTelemetry({
        eventType: 'runtime_invocation_failed',
        traceId: input.taskRef?.taskId ?? runId,
        timestamp: endedAt,
        sessionId: 'pi-ai-adapter',
        agentId: 'pi-ai-adapter',
        payload: {
          runId,
          runtimeKind: 'pi-ai',
          errorCategory,
          errorMessage: runState.reason,
        },
      });

      // Re-throw PDRuntimeError as-is, wrap others
      if (err instanceof PDRuntimeError) {
        throw err;
      }
      throw new PDRuntimeError(
        'execution_failed',
        `LLM completion failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return { runId, runtimeKind: 'pi-ai', startedAt };
  }

  async pollRun(runId: string): Promise<RunStatus> {
    const state = this.runs.get(runId);
    if (!state) {
      throw new PDRuntimeError('input_invalid', `Run ${runId} not found`);
    }

    return {
      runId,
      status: state.status,
      startedAt: state.startedAt,
      endedAt: state.endedAt,
      reason: state.reason,
    };
  }

  async cancelRun(runId: string): Promise<void> {
    // One-shot mode: startRun() blocks until LLM responds, so cancel is always a no-op.
    // The run is already terminal by the time cancelRun could be called.
    const state = this.runs.get(runId);
    if (state && state.status === 'succeeded') {
      return;
    }
  }

  async fetchOutput(runId: string): Promise<StructuredRunOutput | null> {
    const state = this.runs.get(runId);
    if (!state || !state.output) {
      return null;
    }
    return state.output;
  }

  async fetchArtifacts(runId: string): Promise<RuntimeArtifactRef[]> {
    // Artifact refs are not yet exposed by the pi-ai adapter.
    // The DiagnosticianRunner stores artifacts via committer.writeArtifact() directly.
    // Validate runId exists for API consistency with other methods.
    if (!this.runs.has(runId)) {
      throw new PDRuntimeError('input_invalid', `Run '${runId}' not found`);
    }
    return [];
  }

  // ── Private helpers ──

  /**
   * Call pi-ai complete() with retry and exponential backoff.
   * Disables pi-ai built-in retry (maxRetries: 0) to avoid double-retry.
   */
  private async completeWithRetry(
    model: ReturnType<typeof resolveModel>,
    context: Context,
    options: { signal: AbortSignal; apiKey: string },
  ): Promise<AssistantMessage> {
    const maxRetries = this.config.maxRetries ?? 2;
    const effectiveTimeoutMs = this.config.timeoutMs ?? 300_000;
    let lastError: unknown = undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await complete(model, context, {
          signal: options.signal,
          apiKey: options.apiKey,
          timeoutMs: effectiveTimeoutMs,
          maxRetries: 0, // disable pi-ai built-in retry to avoid double-retry
        });

        // If provider resolved with an error response, classify and potentially retry.
        // Only retry execution_failed (transient provider errors); timeout/output_invalid are not retryable.
        if (response.stopReason === 'error' || response.stopReason === 'aborted') {
          const rawMessage = response.errorMessage ?? 'unknown provider error';
          const isTimeout = response.stopReason === 'aborted'
            || options.signal?.aborted
            || /timeout|timed\s*out/i.test(rawMessage)
            || /abort/i.test(rawMessage);

          if (isTimeout) {
            throw new PDRuntimeError('timeout', `LLM request timed out after ${effectiveTimeoutMs}ms`);
          }

          // execution_failed — retryable if attempts remain
          lastError = new PDRuntimeError('execution_failed', `LLM execution failed: ${rawMessage.substring(0, 300)}`);
          if (attempt < maxRetries) {
            const delay = Math.min(1000 * Math.pow(2, attempt), 30_000);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          throw lastError;
        }

        return response;
      } catch (err) {
        lastError = err;
        if (isAbortError(err, options.signal)) {
          throw new PDRuntimeError('timeout', `LLM request timed out after ${effectiveTimeoutMs}ms`);
        }
        if (err instanceof PDRuntimeError) {
          throw err; // PDRuntimeError (timeout from above) — don't retry
        }
        if (attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 30_000);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    // If lastError is already a PDRuntimeError, re-throw it; otherwise wrap it
    if (lastError instanceof PDRuntimeError) {
      throw lastError;
    }
    throw new PDRuntimeError(
      'execution_failed',
      `LLM completion failed after ${maxRetries + 1} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }
}
