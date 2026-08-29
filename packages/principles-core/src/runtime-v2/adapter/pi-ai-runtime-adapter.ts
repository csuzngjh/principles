/**
 * PiAiRuntimeAdapter — PDRuntimeAdapter implementation for direct LLM completion.
 *
 * Uses @earendil-works/pi-ai (compat facade) to call LLM providers directly, bypassing the OpenClaw CLI.
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
// PRI-621 PR2: migrated @mariozechner/pi-ai 0.73.1 → @earendil-works/pi-ai 0.84.2.
// Values come from the /compat facade (getModel is the builtin-catalog read;
// completeSimple unchanged); types come from the root — the root `types.ts`
// remains the unified Model/Context/Message contract in 0.84.
import { getModel, completeSimple } from '@earendil-works/pi-ai/compat';
import { builtinPiAiProviderIds } from './pi-ai-catalog.js';
import type { Context, UserMessage, AssistantMessage, Model, SimpleStreamOptions } from '@earendil-works/pi-ai';
import { Value } from '@sinclair/typebox/value';
import type { TSchema } from '@sinclair/typebox';
import { PDRuntimeError } from '../error-categories.js';
import { extractJsonObject, extractJsonObjectForSchema, extractJsonObjects, selectBestJsonObject } from './json-extractor.js';
import { resolveOutputSchema } from './output-schema-registry.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import { storeEmitter } from '../store/event-emitter.js';
import { attemptStructuredOutputRepair, deriveSchemaSummary } from './structured-output-repair.js';
import { typeboxToOpenAIJsonSchema, sanitizeSchemaName } from './schema-json-converter.js';
import type { OutputEvidencePack, OutputValidationErrorEntry } from './output-repair-contract.js';
import { formatValidationErrorEntry, safeStringifyPreview, stripLineageFields } from './output-repair-contract.js';
import { buildSchemaToolDefinition } from './tools/diagnostician-tool.js';
import { DefaultSchemaPromptAdapter } from './schema-prompt-adapter.js';
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

/** Output path strategy for structured output (PRI-271 B3). */
export type OutputPathStrategy = 'tool_call_first' | 'json_mode_first' | 'free_form_only';

/** Result of a specific output path attempt (PRI-271 B3). */
export type OutputPathLabel = 'tool_call' | 'json_object_mode' | 'free_form_with_repair';

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
  /** Reasoning/thinking level. Set to false to disable thinking for models that enable it by default. Default: undefined (use model default). */
  reasoning?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | false;
  /**
   * Output path strategy for structured output (PRI-271 B3).
   * - 'tool_call_first': Try tool calling → JSON mode → free-form + repair (default)
   * - 'json_mode_first': Try JSON mode → free-form + repair (skip tool calling)
   * - 'free_form_only': Only use current free-form + repair path
   */
  outputPathStrategy?: OutputPathStrategy;
  /** Maximum repair attempts for structured output repair loop (PRI-271 A1). Default: 3. */
  maxRepairAttempts?: number;
  /**
   * Explicit profile-level completion budget override (PRI-621).
   * When unset, the budget is delegated to pi-ai's native defaulting
   * (`min(model.maxTokens, 32000)` + thinking-budget management) instead of
   * a PD-side heuristic cap.
   */
  maxTokens?: number;
  /**
   * Optional system prompt passed to pi-ai Context.systemPrompt.
   * When set, the LLM receives it as a dedicated system-role message,
   * enabling Anthropic system-prompt caching and OpenAI developer-role priority.
   * When unset, behavior is unchanged (no systemPrompt field in Context).
   * Design intent: "system prompt is agent profile's responsibility" (DPB-07).
   */
  systemPrompt?: string;
  /** Internal override for the retry delay backoff, primarily for fast unit testing. */
  _testBackoffDelayMs?: number;
}

/**
 * Resolve a pi-ai Model from dynamic config values.
 *
 * Catalog-first resolution (PRI-621):
 * 1. Built-in provider (no baseUrl) — getModel(), fail loud when the model id
 *    is unknown to the catalog (getModel returns undefined; downstream
 *    resolveApiProvider would TypeError on an undefined Model).
 * 2. Custom provider with baseUrl — look the model id up across ALL built-in
 *    provider catalogs. A hit means the endpoint serves a catalog-known model
 *    (e.g. Bai relaying deepseek-v4-flash), so reuse the catalog metadata
 *    (reasoning, contextWindow, maxTokens, compat, thinkingFormat) and only
 *    override provider (keep the configured name for auth/telemetry) and
 *    baseUrl. This prevents hardcoded fallback metadata from silently
 *    misclassifying reasoning models.
 * 3. Unknown model id anywhere — conservative hardcoded fallback (unchanged).
 */
function resolveModel(provider: string, modelId: string, baseUrl?: string) {
  const knownProviders = builtinPiAiProviderIds();
  if (knownProviders.includes(provider) && !baseUrl) {
    // Built-in provider — use getModel()
    // @ts-expect-error — getModel requires literal provider/model ID types; runtime strings from config are acceptable
    const builtin = getModel(provider, modelId);
    if (!builtin) {
      throw new PDRuntimeError(
        'runtime_unavailable',
        `Model '${modelId}' is not in the pi-ai catalog for provider '${provider}'. ` +
        `Check the model id, or configure a baseUrl to use a custom OpenAI-compatible endpoint.`,
      );
    }
    return builtin;
  }

  // Custom provider — baseUrl is required
  if (!baseUrl) {
    throw new PDRuntimeError(
      'runtime_unavailable',
      `Provider '${provider}' is not a built-in pi-ai provider and requires a custom baseUrl. ` +
      `Pass --baseUrl <url> or add 'baseUrl' to your workflows.yaml policy.`,
    );
  }

  // Catalog-first: a custom endpoint relaying a catalog-known model keeps the
  // catalog's metadata (reasoning/maxTokens/compat) with only the transport
  // (provider name + baseUrl) overridden. getModel is a Map lookup per
  // provider, so scanning the registry is cheap. Guard: only openai-completions
  // catalog entries are adopted — a custom baseUrl is assumed OpenAI-compatible,
  // and reusing e.g. an anthropic-messages entry against it would send the
  // wrong protocol.
  for (const catalogProvider of knownProviders) {
    // @ts-expect-error — runtime strings from config are acceptable against the literal-typed signature
    const catalogModel = getModel(catalogProvider, modelId);
    if (catalogModel && catalogModel.api === 'openai-completions') {
      return { ...catalogModel, provider, baseUrl };
    }
  }

  // Unknown model id — construct a conservative Model object directly
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
  return model;
}

/**
 * Required top-level keys of a registry TypeBox object schema, for
 * schema-aware JSON candidate selection (PRI-621 RC3). Registry schemas are
 * internal trusted definitions (not untrusted runtime data), so a plain
 * structural read is sufficient — no schema validation needed here.
 */
function schemaRequiredKeys(schema: TSchema | undefined): readonly string[] | undefined {
  if (!schema || typeof schema !== 'object' || !Object.hasOwn(schema, 'required')) return undefined;
  const { required } = schema as { required?: unknown };
  if (!Array.isArray(required)) return undefined;
  const keys = required.filter((k): k is string => typeof k === 'string');
  return keys.length > 0 ? keys : undefined;
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
function isObjectWithKey<K extends string>(obj: unknown, key: K): obj is Record<K, unknown> {
  return typeof obj === 'object' && obj !== null && Object.hasOwn(obj, key);
}

function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  if (isObjectWithKey(err, 'name')) {
    const rawName = err.name;
    if (typeof rawName === 'string' && rawName === 'AbortError') {
      return true;
    }
  }
  if (err instanceof Error && !(err instanceof PDRuntimeError) && (/abort/i.test(err.message) || /timeout/i.test(err.message))) return true;
  return false;
}

interface TimeoutClassificationResult {
  category: 'timeout' | 'execution_failed';
  classification: 'provider_transient_timeout' | 'client_timeout_budget_exhausted' | 'timeout_unclassified' | 'not_applicable';
}

function classifyFailure(
  err: unknown,
  signal?: AbortSignal,
): TimeoutClassificationResult {
  if (signal?.aborted) {
    return {
      category: 'timeout',
      classification: 'client_timeout_budget_exhausted',
    };
  }

  let errorMsg = '';
  let name = '';
  if (err instanceof Error) {
    const { message, name: errName } = err;
    errorMsg = message;
    name = errName;
  } else if (typeof err === 'object' && err !== null) {
    if (isObjectWithKey(err, 'message')) {
      const rawMessage = err.message;
      if (typeof rawMessage === 'string') {
        errorMsg = rawMessage;
      }
    }
    if (isObjectWithKey(err, 'name')) {
      const rawName = err.name;
      if (typeof rawName === 'string') {
        name = rawName;
      }
    }
  } else {
    errorMsg = String(err);
  }

  const isAbort = name === 'AbortError' || (err instanceof DOMException && err.name === 'AbortError');
  const hasTimeoutKeywords = /timeout|timed\s*out/i.test(errorMsg) || /abort/i.test(errorMsg);

  if (isAbort || hasTimeoutKeywords) {
    return {
      category: 'timeout',
      classification: 'provider_transient_timeout',
    };
  }

  return {
    category: 'execution_failed',
    classification: 'not_applicable',
  };
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
 *   stopReason:'length' + no extractable content      → output_invalid (truncated)
 *   no text or thinking content block                  → output_invalid
 *
 * Reasoning-model fallback (BUG-007a):
 *   When all content blocks have empty text (common with reasoning models that
 *   spend the entire token budget on thinking), extract JSON from ThinkingContent
 *   blocks. The thinking text is treated as untrusted (EP-01) and must go through
 *   the same extractJsonObject → schema validation path as normal text.
 */
function extractAssistantTextOrThrow(
  response: { content: { type: string; text?: string; thinking?: string }[]; stopReason?: string; errorMessage?: string },
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

  // Find text content (may be mixed with thinking content from reasoning-enabled models)
  const textContent = response.content.find(c => c.type === 'text' && c.text && c.text.trim().length > 0);
  if (textContent && textContent.type === 'text' && textContent.text) {
    return textContent.text;
  }

  // BUG-007a: Reasoning-model fallback — extract from ThinkingContent blocks
  // When reasoning models spend all token budget on thinking, content is empty
  // but thinking (reasoning_content) may contain the structured output.
  // EP-01: thinking field is untrusted LLM output — validate type before use.
  const thinkingBlock = response.content.find(c => c.type === 'thinking' && typeof c.thinking === 'string' && c.thinking.trim().length > 0);
  if (thinkingBlock && thinkingBlock.type === 'thinking' && typeof thinkingBlock.thinking === 'string' && thinkingBlock.thinking.trim().length > 0) {
    return thinkingBlock.thinking;
  }

  // BUG-007b: finish_reason=length with no extractable content → fail-loud (EP-03)
  if (response.stopReason === 'length') {
    throw new PDRuntimeError(
      'output_invalid',
      'LLM response truncated (finish_reason=length); no extractable content',
      { nextAction: 'reduce input size or increase maxTokens in .pd/config.yaml' },
    );
  }

  throw new PDRuntimeError(
    'output_invalid',
    `No text or reasoning content in LLM response. Content types: ${response.content.map(c => c.type).join(', ')}`,
    { nextAction: 'check if the model supports structured output or increase maxTokens' },
  );
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

  /**
   * Resolve the effective max_tokens budget for LLM calls.
   *
   * PRI-621: pass through ONLY the explicit profile config. When unset, the
   * budget is left to pi-ai's native defaulting — `options.maxTokens ??
   * min(model.maxTokens, 32000)` with thinking-budget management that keeps
   * answer tokens available when chain-of-thought shares the ceiling. The old
   * heuristic (forced 4096, or 16K when `/deepseek/i` matched the PROVIDER
   * name) misfired on relays (provider "Bai" serving deepseek-v4-flash got
   * the 4096 cap that BUG-007a was written to prevent) and bypassed pi-ai's
   * catalog metadata entirely. Catalog-first resolveModel() now supplies the
   * correct per-model ceiling, so the heuristic is retired.
   */
  private resolveMaxTokens(): number | undefined {
    return this.config.maxTokens;
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

      const response = await completeSimple(model, probeContext, {
        signal,
        apiKey,
        timeoutMs,
        maxRetries: 0,
        maxTokens: this.resolveMaxTokens(),
      });

      // extractAssistantTextOrThrow normalizes resolved-error responses
      const text = extractAssistantTextOrThrow(response, signal);
      const parsed = extractJsonObject(text);
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !Object.hasOwn(parsed, 'ok') ||
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
   *
   * Timeout priority: input.timeoutMs (from runner) > this.config.timeoutMs (from workflows.yaml) > 300_000 (default)
   * The resolved effectiveTimeoutMs is passed through to completeWithRetry and pi-ai complete()
   * so that the provider request timeout always matches the runner's intent.
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
    // Priority: input.timeoutMs (runner) > config.timeoutMs (workflows.yaml) > 300_000 (default)
    const effectiveTimeoutMs = input.timeoutMs ?? this.config.timeoutMs ?? 300_000;
    const timeoutSource: 'runner_input' | 'adapter_config' | 'default' =
      input.timeoutMs !== undefined ? 'runner_input'
        : this.config.timeoutMs !== undefined ? 'adapter_config'
        : 'default';
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
    const context: Context = {
      messages: [userMessage],
      ...(this.config.systemPrompt ? { systemPrompt: this.config.systemPrompt } : {}),
    };

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
        runnerKind: input.agentSpec.agentId,
        provider: this.config.provider,
        model: this.config.model,
        timeoutMs: effectiveTimeoutMs,
        timeoutSource,
        outputSchemaRef: input.outputSchemaRef ?? 'unknown',
      },
    });

    try {
      // PRI-271 B3: Three-path fallback chain for structured output
      const schemaRef = input.outputSchemaRef;
      const schema = resolveOutputSchema(schemaRef);
      // rc-3-fail-loud-missing: a non-empty outputSchemaRef that cannot be
      // resolved is a bug (typo or unregistered schema). Fail loud instead of
      // silently skipping schema-gated validation paths. Consistent with
      // OpenClawCliRuntimeAdapter.fetchOutput.
      if (schemaRef && !schema) {
        throw new PDRuntimeError(
          'output_invalid',
          `Unknown outputSchemaRef: ${schemaRef}`,
          {
            parseFailureReason: 'unknown_output_schema_ref',
            outputSchemaRef: schemaRef,
            nextAction: `Register the schema in OUTPUT_SCHEMA_REGISTRY or pass a known ref (e.g. 'diag-rootcause-output-v1')`,
          },
        );
      }
      const strategy = this.config.outputPathStrategy ?? 'tool_call_first';

      let validatedOutput: unknown = undefined;
      const schemaSummary = (schema && schemaRef) ? deriveSchemaSummary(schema) : undefined;
      // PRI-621 RC2: full serialized schema for the repair loop — the summary
      // alone leaves nested enums/constraints invisible to the repair LLM.
      // Serialization is defensive: if it ever fails, the repair loop falls
      // back to the summary instead of losing the repair path entirely.
      let schemaJson: string | undefined;
      if (schema && schemaRef) {
        try {
          schemaJson = JSON.stringify(typeboxToOpenAIJsonSchema(schema));
        } catch {
          schemaJson = undefined;
        }
      }

      // ── Path 1: Tool calling (PRI-271 B2) ──
      if (strategy === 'tool_call_first' && schema && schemaRef) {
        const toolResult = await this.tryToolCallPath({ model, baseContext: context, schemaRef, schema, signal, apiKey, effectiveTimeoutMs, input, runId });
        if (toolResult.success && toolResult.output !== undefined) {
          validatedOutput = toolResult.output;
          this.emitOutputPathTelemetry({ runId, input, path: 'tool_call', fallbackReason: null });
        } else {
          this.emitOutputPathTelemetry({ runId, input, path: null, fallbackReason: toolResult.fallbackReason ?? 'provider_no_tool_use' });
        }
      }

      // ── Path 2: JSON mode (PRI-271 B1) ──
      if (!validatedOutput && (strategy === 'tool_call_first' || strategy === 'json_mode_first') && schema && schemaRef) {
        const jsonResult = await this.tryJsonModePath({ model, baseContext: context, schemaRef, schema, signal, apiKey, effectiveTimeoutMs, input, runId });
        if (jsonResult.success && jsonResult.output !== undefined) {
          validatedOutput = jsonResult.output;
          this.emitOutputPathTelemetry({ runId, input, path: 'json_object_mode', fallbackReason: null });
        } else {
          this.emitOutputPathTelemetry({ runId, input, path: null, fallbackReason: jsonResult.fallbackReason ?? 'json_parse_failed' });
        }
      }

      // ── Path 3: Free-form + repair (current behavior, enhanced) ──
      if (!validatedOutput) {
        const response = await this.completeWithRetry(model, context, { signal, apiKey, effectiveTimeoutMs, timeoutSource, input, runId });
        const text = extractAssistantTextOrThrow(response, signal);
        // PRI-621 RC3: schema-aware selection — when the answer contains
        // several complete objects (truncated outer answer + parseable inner
        // fragment), pick the one matching the schema's required keys instead
        // of whichever balanced brace came first.
        const extractionCandidates = extractJsonObjects(text);
        const requiredKeys = schemaRequiredKeys(schema);
        let parsedOutput = selectBestJsonObject(extractionCandidates, requiredKeys);
        const extractionCandidateCount = extractionCandidates.length;
        // Classic truncation signature: the selected object carries NONE of
        // the schema's required top-level keys.
        const truncationSuspected = requiredKeys !== undefined
          && parsedOutput !== null
          && !requiredKeys.some((key) => Object.hasOwn(parsedOutput as Record<string, unknown>, key));

        if (!parsedOutput) {
          this.eventEmitter.emitTelemetry({
            eventType: 'output_extraction_failed',
            traceId: input.taskRef?.taskId ?? runId,
            timestamp: new Date().toISOString(),
            sessionId: 'pi-ai-adapter',
            agentId: 'pi-ai-adapter',
            payload: {
              runId,
              runtimeKind: 'pi-ai',
              provider: this.config.provider,
              model: this.config.model,
              outputSchemaRef: input.outputSchemaRef ?? 'unknown',
              rawOutputPreview: text.slice(0, 500),
            },
          });
          throw new PDRuntimeError('output_invalid', 'No valid JSON found in LLM response');
        }

        if (schema && !Value.Check(schema, parsedOutput)) {
          // Schema validation failed — attempt repair with enhanced config (PRI-271 A1/A2/A3)
          const schemaErrors = [...Value.Errors(schema, parsedOutput)]
            .map(e => ({ path: e.path, message: e.message, value: e.value }));

          const validationErrorEntries: OutputValidationErrorEntry[] = schemaErrors
            .slice(0, 10)
            .map(e => formatValidationErrorEntry(e.path, e.message, e.value));

          const rawOutputPreview = safeStringifyPreview(parsedOutput);

          this.eventEmitter.emitTelemetry({
            eventType: 'output_schema_invalid',
            traceId: input.taskRef?.taskId ?? runId,
            timestamp: new Date().toISOString(),
            sessionId: 'pi-ai-adapter',
            agentId: 'pi-ai-adapter',
            payload: {
              runId,
              runtimeKind: 'pi-ai',
              outputSchemaRef: schemaRef ?? 'unknown',
              provider: this.config.provider,
              model: this.config.model,
              rawOutputPreview,
              validationErrors: validationErrorEntries,
            },
          });

          const originalOutput = typeof parsedOutput === 'object' && parsedOutput !== null
            ? parsedOutput as Record<string, unknown>
            : undefined;

          const repairResult = await attemptStructuredOutputRepair<Record<string, unknown>>(
            parsedOutput,
            schemaErrors,
            {
              llmCaller: (prompt: string) => this.repairLLMCall(model, prompt, { signal, apiKey }),
              schemaCheck: (value: unknown) => Value.Check(schema, value),
              schemaErrors: (value: unknown) =>
                [...Value.Errors(schema, value)].map(e => ({ path: e.path, message: e.message, value: e.value })),
            },
            {
              schemaRef: schemaRef ?? 'unknown',
              originalOutput,
              schemaSummary,
              schemaJson,
              requiredKeys,
              maxRepairAttempts: this.config.maxRepairAttempts,
            },
          );

          this.eventEmitter.emitTelemetry({
            eventType: 'output_repair_attempted',
            traceId: input.taskRef?.taskId ?? runId,
            timestamp: new Date().toISOString(),
            sessionId: 'pi-ai-adapter',
            agentId: 'pi-ai-adapter',
            payload: {
              runId,
              runtimeKind: 'pi-ai',
              outputSchemaRef: schemaRef ?? 'unknown',
              repaired: repairResult.repaired,
              attemptsUsed: repairResult.attemptsUsed,
              repairSummary: repairResult.repairSummary,
              repairAttempts: repairResult.repairAttempts,
              outputPath: 'free_form_with_repair',
            },
          });

          if (repairResult.repaired && repairResult.output) {
            parsedOutput = repairResult.output;
          } else {
            const evidencePack: OutputEvidencePack = {
              schemaRef: schemaRef ?? 'unknown',
              provider: this.config.provider,
              model: this.config.model,
              rawOutputPreview,
              validationErrors: validationErrorEntries,
              repairAttempts: repairResult.repairAttempts,
              finalFailureReason: 'repair_exhausted',
              // PRI-621 RC3 diagnostics: how many complete objects the answer
              // contained, and whether the selected one matches none of the
              // schema's required keys (classic truncation signature).
              extractionCandidateCount,
              truncationSuspected: truncationSuspected || undefined,
            };

            this.eventEmitter.emitTelemetry({
              eventType: 'output_repair_exhausted',
              traceId: input.taskRef?.taskId ?? runId,
              timestamp: new Date().toISOString(),
              sessionId: 'pi-ai-adapter',
              agentId: 'pi-ai-adapter',
              payload: {
                runId,
                runtimeKind: 'pi-ai',
                outputSchemaRef: schemaRef ?? 'unknown',
                provider: this.config.provider,
                model: this.config.model,
                rawOutputPreview,
                validationErrors: validationErrorEntries,
                repairAttempts: evidencePack.repairAttempts,
                finalFailureReason: evidencePack.finalFailureReason,
              },
            });

            throw new PDRuntimeError(
              'output_invalid',
              `LLM output does not match ${schemaRef ?? 'unknown'} schema`,
              { evidencePack },
            );
          }
        }

        // Lineage fields (taskId/sourcePainId/sourceTaskId/etc.) are
        // intentionally stripped from LLM output. Downstream consumers
        // (DiagnosticianRunner, committer) MUST get these values from
        // RunnerContext / TaskRecord, never from validated output.
        // This prevents LLM-supplied lineage from poisoning downstream
        // commits (ERR-008 family). See PRI-272.
        const protectedFreeForm = typeof parsedOutput === 'object' && parsedOutput !== null
          ? stripLineageFields(parsedOutput)
          : parsedOutput;

        validatedOutput = protectedFreeForm;
        this.emitOutputPathTelemetry({ runId, input, path: 'free_form_with_repair', fallbackReason: null });
      }

      // Update run state to succeeded
      const endedAt = new Date().toISOString();
      runState.status = 'succeeded';
      runState.endedAt = endedAt;
      runState.output = { runId, payload: validatedOutput };

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

      const elapsedMs = Date.now() - Date.parse(startedAt);
      const maxRetries = this.config.maxRetries ?? 2;
      let timeoutClassification = 'not_applicable';
      let providerEvidence = '';
      let retryAttempt = 0;

      if (err instanceof PDRuntimeError && err.details) {
        const { details } = err;
        if (isObjectWithKey(details, 'timeoutClassification')) {
          const { timeoutClassification: tc } = details;
          if (typeof tc === 'string') timeoutClassification = tc;
        }
        if (isObjectWithKey(details, 'providerEvidence')) {
          const { providerEvidence: pe } = details;
          if (typeof pe === 'string') providerEvidence = pe;
        }
        if (isObjectWithKey(details, 'retryAttempt')) {
          const { retryAttempt: ra } = details;
          if (typeof ra === 'number') retryAttempt = ra;
        }
      }

      if (isAbortError(err, signal)) {
        runState.status = 'timed_out';
        runState.reason = `[timeout] LLM request timed out after ${effectiveTimeoutMs}ms (timeoutSource=${timeoutSource})`;
        if (timeoutClassification === 'not_applicable') {
          timeoutClassification = signal?.aborted ? 'client_timeout_budget_exhausted' : 'provider_transient_timeout';
        }
        if (!providerEvidence) {
          providerEvidence = safeStringifyPreview(err, 300);
        }
      } else if (err instanceof PDRuntimeError) {
        runState.status = 'failed';
        runState.reason = err.message;
        if (err.category === 'timeout') {
          runState.status = 'timed_out';
          if (timeoutClassification === 'not_applicable') {
            timeoutClassification = 'provider_transient_timeout';
          }
        }
        if (!providerEvidence) {
          providerEvidence = safeStringifyPreview(err, 300);
        }
      } else {
        runState.status = 'failed';
        runState.reason = err instanceof Error ? err.message : String(err);
        providerEvidence = safeStringifyPreview(err, 300);
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
          runnerKind: input.agentSpec.agentId,
          provider: this.config.provider,
          model: this.config.model,
          effectiveTimeoutMs,
          timeoutSource,
          elapsedMs,
          timeoutClassification,
          retryAttempt,
          maxRetries,
          providerEvidence,
          errorMessage: runState.reason,
          errorCategory,
          finalFailure: true,
        },
      });

      // Re-throw PDRuntimeError as-is, wrap others
      if (err instanceof PDRuntimeError) {
        throw err;
      }
      throw new PDRuntimeError(
        'execution_failed',
        `LLM completion failed: ${err instanceof Error ? err.message : String(err)}`,
        {
          elapsedMs,
          providerEvidence,
        }
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

  // ── PRI-271: Three-path output extraction ──

  /**
   * Path 1: Tool calling (PRI-271 B2).
   *
   * Passes a schema-derived tool definition via context.tools and injects
   * `tool_choice: 'required'` via onPayload. If the provider supports tool
   * calling, the response contains ToolCall content blocks with pre-parsed
   * arguments that we validate against the schema.
   *
   * PRI-284: Tool definition uses params.schema (per-runner) instead of
   * hardcoded DiagnosticianOutputV1Schema.
   */
   
  private async tryToolCallPath(
    params: {
      model: ReturnType<typeof resolveModel>;
      baseContext: Context;
      schemaRef: string;
      schema: TSchema;
      signal: AbortSignal;
      apiKey: string;
      effectiveTimeoutMs: number;
      input: StartRunInput;
      runId: string;
    },
  ): Promise<{ success: boolean; output?: unknown; fallbackReason?: string }> {
    try {
      const toolContext: Context = {
        ...params.baseContext,
        tools: [buildSchemaToolDefinition(params.schemaRef, params.schema, new DefaultSchemaPromptAdapter())],
      };

      const completeOptions: SimpleStreamOptions = {
        signal: params.signal,
        apiKey: params.apiKey,
        timeoutMs: params.effectiveTimeoutMs,
        maxRetries: 0,
        maxTokens: this.resolveMaxTokens(),
        onPayload: (payload: unknown) => {
          if (typeof payload === 'object' && payload !== null) {
            const p = payload as Record<string, unknown>;
            p.tool_choice = 'required';
          }
          return payload;
        },
      };

      const response = await completeSimple(params.model, toolContext, completeOptions);

      if (response.stopReason !== 'toolUse') {
        return { success: false, fallbackReason: 'provider_no_tool_use' };
      }

      const toolCallBlock = response.content.find(
        (block): block is { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> } =>
          typeof block === 'object' && block !== null && Object.hasOwn(block, 'type') && block.type === 'toolCall',
      );

      if (!toolCallBlock) {
        return { success: false, fallbackReason: 'tool_call_extraction_failed' };
      }

      const toolArgs = toolCallBlock.arguments;

      if (!Value.Check(params.schema, toolArgs)) {
        return { success: false, fallbackReason: 'tool_call_schema_invalid' };
      }

      // Lineage fields (taskId/sourcePainId/sourceTaskId/etc.) are
      // intentionally stripped from LLM output. Downstream consumers
      // (DiagnosticianRunner, committer) MUST get these values from
      // RunnerContext / TaskRecord, never from validated output.
      // This prevents LLM-supplied lineage from poisoning downstream
      // commits (ERR-008 family). See PRI-271 D4 in PR description.
      const protectedArgs = typeof toolArgs === 'object' && toolArgs !== null
        ? stripLineageFields(toolArgs)
        : toolArgs;

      return { success: true, output: protectedArgs };
    } catch (err) {
      if (err instanceof PDRuntimeError && (err.category === 'timeout' || err.category === 'runtime_unavailable')) {
        throw err;
      }
      const reason = err instanceof PDRuntimeError && err.category === 'output_invalid'
        ? 'tool_call_extraction_failed'
        : 'provider_no_tool_use';
      return { success: false, fallbackReason: reason };
    }
  }

  /**
   * Path 2: JSON mode (PRI-271 B1).
   *
   * Injects `response_format: { type: 'json_object' }` via onPayload
   * to force the provider to output valid JSON. Then parses and validates.
   */
   
  private async tryJsonModePath(
    params: {
      model: ReturnType<typeof resolveModel>;
      baseContext: Context;
      schemaRef: string;
      schema: TSchema;
      signal: AbortSignal;
      apiKey: string;
      effectiveTimeoutMs: number;
      input: StartRunInput;
      runId: string;
    },
  ): Promise<{ success: boolean; output?: unknown; fallbackReason?: string }> {
    try {
      const completeOptions: SimpleStreamOptions = {
        signal: params.signal,
        apiKey: params.apiKey,
        timeoutMs: params.effectiveTimeoutMs,
        maxRetries: 0,
        maxTokens: this.resolveMaxTokens(),
        onPayload: (payload: unknown) => {
          if (typeof payload === 'object' && payload !== null) {
            const p = payload as Record<string, unknown>;
            // PRI-559: json_object 只保证“是 JSON”，不保证符合 schema（实测丢字段）。
            // 升级为 json_schema 约束：llamacpp / OpenAI 兼容端点原生支持，
            // 由模型侧约束解码，输出直接符合 schema。
            p.response_format = {
              type: 'json_schema',
              json_schema: {
                name: sanitizeSchemaName(params.schemaRef),
                schema: typeboxToOpenAIJsonSchema(params.schema),
              },
            };
          }
          return payload;
        },
      };

      const response = await completeSimple(params.model, params.baseContext, completeOptions);
      const text = extractAssistantTextOrThrow(response, params.signal);

      // PRI-621 RC3: schema-aware selection (same rationale as Path 3).
      const parsed = extractJsonObjectForSchema(text, schemaRequiredKeys(params.schema));
      if (!parsed) {
        return { success: false, fallbackReason: 'json_parse_failed' };
      }

      if (!Value.Check(params.schema, parsed)) {
        return { success: false, fallbackReason: 'json_schema_invalid' };
      }

      // Lineage fields (taskId/sourcePainId/sourceTaskId/etc.) are
      // intentionally stripped from LLM output. Downstream consumers
      // (DiagnosticianRunner, committer) MUST get these values from
      // RunnerContext / TaskRecord, never from validated output.
      // This prevents LLM-supplied lineage from poisoning downstream
      // commits (ERR-008 family). See PRI-271 D4 in PR description.
      const protectedParsed = typeof parsed === 'object' && parsed !== null
        ? stripLineageFields(parsed)
        : parsed;

      return { success: true, output: protectedParsed };
    } catch (err) {
      if (err instanceof PDRuntimeError && (err.category === 'timeout' || err.category === 'runtime_unavailable')) {
        throw err;
      }
      if (err instanceof PDRuntimeError && err.category === 'output_invalid') {
        return { success: false, fallbackReason: 'json_parse_failed' };
      }
      return { success: false, fallbackReason: 'provider_no_json_mode' };
    }
  }

  /**
   * Emit output_path_chosen telemetry (PRI-271 B3).
   *
   * Every path selection and fallback emits structured telemetry.
   * `path` is set when a path succeeds; null when recording a fallback reason.
   */
  private emitOutputPathTelemetry(
    params: {
      runId: string;
      input: StartRunInput;
      path: OutputPathLabel | null;
      fallbackReason: string | null;
    },
  ): void {
    this.eventEmitter.emitTelemetry({
      eventType: params.path ? 'output_path_chosen' : 'output_path_fallback',
      traceId: params.input.taskRef?.taskId ?? params.runId,
      timestamp: new Date().toISOString(),
      sessionId: 'pi-ai-adapter',
      agentId: 'pi-ai-adapter',
      payload: {
        runId: params.runId,
        runtimeKind: 'pi-ai',
        provider: this.config.provider,
        model: this.config.model,
        outputSchemaRef: params.input.outputSchemaRef ?? 'unknown',
        outputPath: params.path,
        fallbackReason: params.fallbackReason,
      },
    });
  }

  /**
   * Make a single LLM call for output repair (PRI-71).
   * Returns extracted text response or null if no content.
   * Reuses same provider/model/apiKey as the original call.
   *
   * Uses an independent AbortSignal (fixed 60s timeout) to avoid the repair
   * call immediately timing out when the original call consumed most of the
   * original timeout budget (e.g., 5min original → 4m50s elapsed → 10s left).
   */
   
  private async repairLLMCall(
    model: ReturnType<typeof resolveModel>,
    prompt: string,
    options: { signal: AbortSignal; apiKey: string },
  ): Promise<string | null> {
    const REPAIR_TIMEOUT_MS = 60_000;
    const repairSignal = AbortSignal.timeout(REPAIR_TIMEOUT_MS);

    const repairMessage: UserMessage = {
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    };
    const repairContext: Context = { messages: [repairMessage] };

    const response = await completeSimple(model, repairContext, {
      signal: repairSignal,
      apiKey: options.apiKey,
      timeoutMs: REPAIR_TIMEOUT_MS,
      maxRetries: 0,
      maxTokens: this.resolveMaxTokens(),
    });

    // extractAssistantTextOrThrow throws:
    //   - output_invalid: no text content in response
    //   - timeout: aborted/timed out (caller's signal or pi-ai internal)
    //   - execution_failed: provider error (non-timeout)
    // We only swallow output_invalid, letting timeout/execution_failed propagate.
    try {
      return extractAssistantTextOrThrow(response, options.signal);
    } catch (err) {
      if (err instanceof PDRuntimeError && err.category === 'output_invalid') {
        return null;
      }
      throw err;
    }
  }

  /**
   * Call pi-ai complete() with retry and exponential backoff.
   * Disables pi-ai built-in retry (maxRetries: 0) to avoid double-retry.
   */
  private async completeWithRetry(
    model: ReturnType<typeof resolveModel>,
    context: Context,
    options: {
      signal: AbortSignal;
      apiKey: string;
      effectiveTimeoutMs?: number;
      timeoutSource?: string;
      input?: StartRunInput;
      runId?: string;
    },
  ): Promise<AssistantMessage> {
    const maxRetries = this.config.maxRetries ?? 2;
    const {
      effectiveTimeoutMs = this.config.timeoutMs ?? 300_000,
      timeoutSource = 'default',
      input,
      runId = crypto.randomUUID(),
    } = options;
    let lastError: unknown = undefined;
    const overallStartTime = Date.now();
    const getDelay = (attemptIndex: number) => {
      return this.config._testBackoffDelayMs !== undefined
        ? this.config._testBackoffDelayMs
        : Math.min(1000 * Math.pow(2, attemptIndex), 30_000);
    };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const elapsedMs = Date.now() - overallStartTime;
      const remainingMs = effectiveTimeoutMs - elapsedMs;

      // Fail fast if overall budget signal is aborted, or if we have already run out of budget time
      if (options.signal?.aborted || remainingMs <= 0) {
        const errorDetails = {
          timeoutClassification: 'client_timeout_budget_exhausted',
          effectiveTimeoutMs,
          timeoutSource,
          elapsedMs,
          retryAttempt: attempt,
          maxRetries,
          providerEvidence: options.signal?.aborted
            ? 'Client budget signal aborted'
            : `Overall timeout budget exhausted (elapsed ${elapsedMs}ms of ${effectiveTimeoutMs}ms)`,
        };
        throw new PDRuntimeError(
          'timeout',
          `LLM request timed out after ${effectiveTimeoutMs}ms (timeoutSource=client_budget_exhausted)`,
          errorDetails,
        );
      }

      // Cap the individual attempt timeout to the remaining budget to honor the timeout budget contract
      const currentTimeoutMs = Math.min(effectiveTimeoutMs, remainingMs);

      try {
        const completeOptions: SimpleStreamOptions = {
          signal: options.signal,
          apiKey: options.apiKey,
          timeoutMs: currentTimeoutMs,
          maxRetries: 0, // disable pi-ai built-in retry to avoid double-retry
          maxTokens: this.resolveMaxTokens(), // PRI-621: undefined = pi-ai native model ceiling
        };
        if (this.config.reasoning !== undefined && this.config.reasoning !== false) {
          completeOptions.reasoning = this.config.reasoning;
        }
        const response = await completeSimple(model, context, completeOptions);

        // If provider resolved with an error response, classify and potentially retry.
        if (response.stopReason === 'error' || response.stopReason === 'aborted') {
          const rawMessage = response.errorMessage ?? 'unknown provider error';
          const elapsedMsAfter = Date.now() - overallStartTime;

          const isTimeout = response.stopReason === 'aborted'
            || options.signal?.aborted
            || /timeout|timed\s*out/i.test(rawMessage)
            || /abort/i.test(rawMessage);

          const classification = (options.signal?.aborted || elapsedMsAfter >= effectiveTimeoutMs)
            ? 'client_timeout_budget_exhausted'
            : isTimeout
              ? 'provider_transient_timeout'
              : 'not_applicable';

          if (isTimeout) {
            const errorDetails = {
              timeoutClassification: classification,
              effectiveTimeoutMs,
              timeoutSource,
              elapsedMs: elapsedMsAfter,
              retryAttempt: attempt,
              maxRetries,
              providerEvidence: safeStringifyPreview(rawMessage, 300),
            };

            const pdErr = new PDRuntimeError(
              'timeout',
              `[timeout] LLM request timed out after ${effectiveTimeoutMs}ms (timeoutSource=provider_request)`,
              errorDetails,
            );
            lastError = pdErr;

            if (classification === 'provider_transient_timeout' && attempt < maxRetries) {
              if (input) {
                this.emitAttemptTelemetry({
                  input,
                  runId,
                  attempt,
                  maxRetries,
                  err: pdErr,
                  elapsedMs: elapsedMsAfter,
                  timeoutSource,
                  effectiveTimeoutMs,
                });
              }
              const delay = getDelay(attempt);
              await new Promise(r => setTimeout(r, delay));
              continue;
            }

            throw pdErr;
          }

          // execution_failed — retryable if attempts remain
          // ADR-0019: detect rate-limit signatures first and classify as rate_limit
          // (distinct from execution_failed) so downstream retryOrFail can degrade.
          const isRateLimit = /rate.?limit|429|quota|too many requests/i.test(rawMessage);
          const errorCategory = isRateLimit ? 'rate_limit' : 'execution_failed';
          const pdErr = new PDRuntimeError(
            errorCategory,
            `${isRateLimit ? 'LLM rate limit hit' : 'LLM execution failed'}: ${rawMessage.substring(0, 300)}`,
            {
              retryAttempt: attempt,
              maxRetries,
              elapsedMs: elapsedMsAfter,
              providerEvidence: safeStringifyPreview(rawMessage, 300),
            },
          );
          lastError = pdErr;

          if (attempt < maxRetries) {
            if (input) {
              this.emitAttemptTelemetry({
                input,
                runId,
                attempt,
                maxRetries,
                err: pdErr,
                elapsedMs: elapsedMsAfter,
                timeoutSource,
                effectiveTimeoutMs,
              });
            }
            // ADR-0019: rate-limit uses 2× backoff since limits need more time to clear
            const delay = isRateLimit ? getDelay(attempt) * 2 : getDelay(attempt);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          throw pdErr;
        }

        return response;
      } catch (err) {
        const elapsedMsAfter = Date.now() - overallStartTime;
        let classificationResult = classifyFailure(err, options.signal);

        if (options.signal?.aborted || elapsedMsAfter >= effectiveTimeoutMs) {
          classificationResult = {
            category: 'timeout',
            classification: 'client_timeout_budget_exhausted',
          };
        }

        // If it's a client budget exhaustion, throw immediately (no retry)
        if (classificationResult.classification === 'client_timeout_budget_exhausted') {
          const errorDetails = {
            timeoutClassification: 'client_timeout_budget_exhausted',
            effectiveTimeoutMs,
            timeoutSource,
            elapsedMs: elapsedMsAfter,
            retryAttempt: attempt,
            maxRetries,
            providerEvidence: safeStringifyPreview(err, 300),
          };
          throw new PDRuntimeError('timeout', `LLM request timed out after ${effectiveTimeoutMs}ms`, errorDetails);
        }

        if (classificationResult.category === 'timeout') {
          const errorDetails = {
            timeoutClassification: 'provider_transient_timeout',
            effectiveTimeoutMs,
            timeoutSource,
            elapsedMs: elapsedMsAfter,
            retryAttempt: attempt,
            maxRetries,
            providerEvidence: safeStringifyPreview(err, 300),
          };
          const pdErr = new PDRuntimeError('timeout', `LLM request timed out after ${effectiveTimeoutMs}ms`, errorDetails);
          lastError = pdErr;

          if (attempt < maxRetries) {
            if (input) {
              this.emitAttemptTelemetry({
                input,
                runId,
                attempt,
                maxRetries,
                err: pdErr,
                elapsedMs: elapsedMsAfter,
                timeoutSource,
                effectiveTimeoutMs,
              });
            }
            const delay = getDelay(attempt);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          throw pdErr;
        }

        if (err instanceof PDRuntimeError) {
          throw err; // don't retry standard PDRuntimeError if it is permanent or already handled
        }

        // It is an execution_failed (network, etc.)
        // ADR-0019: detect rate-limit signatures in thrown errors too (SDK may throw 429)
        const errMsg = err instanceof Error ? err.message : String(err);
        const isRateLimitCatch = /rate.?limit|429|quota|too many requests/i.test(errMsg);
        const catchCategory = isRateLimitCatch ? 'rate_limit' : 'execution_failed';
        const errorDetails = {
          retryAttempt: attempt,
          maxRetries,
          elapsedMs: elapsedMsAfter,
          providerEvidence: safeStringifyPreview(err, 300),
        };
        const pdErr = new PDRuntimeError(
          catchCategory,
          `${isRateLimitCatch ? 'LLM rate limit hit' : 'LLM completion failed'}: ${errMsg.substring(0, 300)}`,
          errorDetails,
        );
        lastError = pdErr;

        if (attempt < maxRetries) {
          if (input) {
            this.emitAttemptTelemetry({
              input,
              runId,
              attempt,
              maxRetries,
              err: pdErr,
              elapsedMs: elapsedMsAfter,
              timeoutSource,
              effectiveTimeoutMs,
            });
          }
          // ADR-0019: rate-limit uses 2× backoff
          const delay = isRateLimitCatch ? getDelay(attempt) * 2 : getDelay(attempt);
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

  private emitAttemptTelemetry(params: {
    input: StartRunInput;
    runId: string;
    attempt: number;
    maxRetries: number;
    err: PDRuntimeError;
    elapsedMs: number;
    timeoutSource: string;
    effectiveTimeoutMs: number;
  }) {
    const {
      input,
      runId,
      attempt,
      maxRetries,
      err,
      elapsedMs,
      timeoutSource,
      effectiveTimeoutMs,
    } = params;
    const endedAt = new Date().toISOString();
    const { details } = err;
    let timeoutClassification = 'not_applicable';
    let providerEvidence = '';
    if (details && typeof details === 'object') {
      if (isObjectWithKey(details, 'timeoutClassification')) {
        const { timeoutClassification: tc } = details;
        if (typeof tc === 'string') timeoutClassification = tc;
      }
      if (isObjectWithKey(details, 'providerEvidence')) {
        const { providerEvidence: pe } = details;
        if (typeof pe === 'string') providerEvidence = pe;
      }
    }

    this.eventEmitter.emitTelemetry({
      eventType: 'runtime_invocation_failed',
      traceId: input.taskRef?.taskId ?? runId,
      timestamp: endedAt,
      sessionId: 'pi-ai-adapter',
      agentId: 'pi-ai-adapter',
      payload: {
        runId,
        runtimeKind: 'pi-ai',
        runnerKind: input.agentSpec.agentId,
        provider: this.config.provider,
        model: this.config.model,
        effectiveTimeoutMs,
        timeoutSource,
        elapsedMs,
        timeoutClassification,
        retryAttempt: attempt,
        maxRetries,
        providerEvidence,
        errorMessage: err.message,
        isRetryAttempt: true,
      },
    });
  }
}
