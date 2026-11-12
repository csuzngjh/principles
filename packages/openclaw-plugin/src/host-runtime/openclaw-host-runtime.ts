import { createProductionHostRuntime, type ActivePrinciplePromptResult, type HostRuntime, type ProductionRuleContextRequest, type ProductionPainEnrichment } from '@principles/host-runtime';
import type { HostEvent, HostEventContext, HostEventResult, HostModelContext } from '@principles/core/host';
import { OPENCLAW_TOOL_SEMANTICS } from '../constants/tool-semantics.js';
import type {
  PluginHookAgentContext,
  PluginHookAfterToolCallEvent,
  PluginHookBeforePromptBuildEvent,
  PluginHookBeforePromptBuildResult,
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from '../openclaw-sdk.js';

type NativePayload =
  | { kind: 'before_prompt_build'; event: PluginHookBeforePromptBuildEvent; context: PluginHookAgentContext }
  | { kind: 'before_tool_call'; event: PluginHookBeforeToolCallEvent; context: PluginHookToolContext }
  | { kind: 'after_tool_call'; event: PluginHookAfterToolCallEvent; context: PluginHookToolContext };

type NativeResult =
  | { kind: 'before_prompt_build'; value: PluginHookBeforePromptBuildResult | void }
  | { kind: 'before_tool_call'; value: PluginHookBeforeToolCallResult | void }
  | { kind: 'after_tool_call'; value: void; hostResult?: AfterToolCallDispatch };

export interface OpenClawHostRuntimeOptions {
  adaptiveGapProvider?(
    event: PluginHookBeforePromptBuildEvent,
    context: PluginHookAgentContext,
    ...args: Parameters<import('@principles/host-runtime').AdaptivePriorityProvider>
  ): ReturnType<import('@principles/host-runtime').AdaptivePriorityProvider>;
  beforePromptBuild(event: PluginHookBeforePromptBuildEvent, context: PluginHookAgentContext, prompt: ActivePrinciplePromptResult): Promise<PluginHookBeforePromptBuildResult | void>;
  /**
   * PRI-1137: the OpenClaw prompt ROUND authority, supplied by the plugin
   * adapter (`nextSessionTurnOrdinal` after its pre-selection signal
   * collection). Runs before the shared prompt context is built; returning
   * `undefined` (missing sessionId / unreadable trajectory DB / failed
   * ordinal read) is the observable degraded case and selects
   * `legacy_fifo_prefix_v1`. Never fabricate a round here.
   */
  roundKeyProvider?(event: PluginHookBeforePromptBuildEvent, context: PluginHookAgentContext): number | undefined | Promise<number | undefined>;
  adaptivePriorityProvider?(event: PluginHookBeforePromptBuildEvent, context: PluginHookAgentContext): {
    artifactId: string;
    activationId: string;
    /** PRI-1140: true for principle-identity resolution (additive-only packing). */
    additiveOnly?: boolean;
    hookInvocationId?: string;
    signal?: AbortSignal;
    deadlineAt?: number;
  } | undefined | Promise<{
    artifactId: string;
    activationId: string;
    additiveOnly?: boolean;
    hookInvocationId?: string;
    signal?: AbortSignal;
    deadlineAt?: number;
  } | undefined>;
  ruleContextProvider?(event: PluginHookBeforeToolCallEvent, context: PluginHookToolContext, request: ProductionRuleContextRequest): unknown | Promise<unknown>;
  ruleInputEnrichmentProvider?(event: PluginHookBeforeToolCallEvent, context: PluginHookToolContext, request: ProductionRuleContextRequest): unknown | Promise<unknown>;
  onBeforeToolResult?(event: PluginHookBeforeToolCallEvent, context: PluginHookToolContext, result: HostEventResult): PluginHookBeforeToolCallResult | void;
  painEnrichmentProvider?(event: PluginHookAfterToolCallEvent, context: PluginHookToolContext): ProductionPainEnrichment | Promise<ProductionPainEnrichment>;
}

export interface OpenClawHostRuntime {
  readonly runtime: HostRuntime;
  dispatchBeforePromptBuild(event: PluginHookBeforePromptBuildEvent, context: PluginHookAgentContext): Promise<PluginHookBeforePromptBuildResult | void>;
  dispatchBeforeToolCall(event: PluginHookBeforeToolCallEvent, context: PluginHookToolContext): Promise<PluginHookBeforeToolCallResult | void>;
  /**
   * PRI-1137 final review P1-4: after_tool_call dispatches return the shared
   * runtime's degradation facts (e.g. `trajectory_db_not_found`) instead of an
   * opaque void — evidence that failed to persist must be observable to the
   * operator, never silently recorded as a successful hook execution.
   */
  dispatchAfterToolCall(event: PluginHookAfterToolCallEvent, context: PluginHookToolContext): Promise<AfterToolCallDispatch>;
}

/** Degradation facts surfaced by one after_tool_call dispatch (P1-4). */
export interface AfterToolCallDispatch {
  /** Shared-runtime warnings (bounded); empty when the evidence path was healthy. */
  warnings: readonly string[];
  /** `unavailable` when the technical evidence could not be persisted. */
  outcome?: 'unavailable' | string;
  nextAction?: string;
}

function contextFor(workspaceDir: string, sessionId: string | undefined, toolName?: string): HostEventContext {
  return { workspaceDir, sessionId: sessionId ?? 'openclaw:session-unavailable', toolName };
}

/**
 * SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001: forward the hook context's model
 * facts (untrusted until the budget resolver validates them) so the shared
 * path resolves the injection budget from the SAME host facts the
 * plugin-local route sees. Fields are copied only when present — a host
 * context without model identity stays without model identity (WorkBuddy
 * semantics), never a guessed default.
 */
function modelContextFor(context: PluginHookAgentContext): HostModelContext | undefined {
  const modelContext: { modelProviderId?: string; modelId?: string; contextTokenBudget?: unknown; contextWindowSource?: unknown } = {};
  if (typeof context.modelProviderId === 'string' && context.modelProviderId.length > 0) {
    modelContext.modelProviderId = context.modelProviderId;
  }
  if (typeof context.modelId === 'string' && context.modelId.length > 0) {
    modelContext.modelId = context.modelId;
  }
  if (context.contextTokenBudget !== undefined) {
    modelContext.contextTokenBudget = context.contextTokenBudget;
  }
  if (context.contextWindowSource !== undefined) {
    modelContext.contextWindowSource = context.contextWindowSource;
  }
  return Object.keys(modelContext).length > 0 ? (modelContext as HostModelContext) : undefined;
}

export function createOpenClawHostRuntime(options: OpenClawHostRuntimeOptions): OpenClawHostRuntime {
  const payloads = new WeakMap<object, NativePayload>();
  const results = new WeakMap<HostEventResult, NativeResult>();

  function payloadFor(event: HostEvent): NativePayload {
    if (typeof event.rawPayload !== 'object' || event.rawPayload === null) {
      throw new Error(`OpenClaw ${event.kind} dispatch is missing its native payload token`);
    }
    const token = Object.hasOwn(event.rawPayload, 'nativeToken')
      ? Reflect.get(event.rawPayload, 'nativeToken')
      : event.rawPayload;
    if (typeof token !== 'object' || token === null) throw new Error(`OpenClaw ${event.kind} dispatch has an invalid native payload token`);
    const payload = payloads.get(token);
    if (!payload || payload.kind !== event.kind) {
      throw new Error(`OpenClaw ${event.kind} dispatch has a mismatched native payload`);
    }
    return payload;
  }

  function recordResult(
    event: HostEvent,
    native: NativeResult,
    decision: HostEventResult['decision'],
    reason?: string,
  ): HostEventResult {
    const result: HostEventResult = { decision, source: event.source, ...(reason ? { reason } : {}) };
    results.set(result, native);
    return result;
  }

  const runtime = createProductionHostRuntime({
    // PRI-634-F R2: the shared production gate resolves tool semantics through
    // the OpenClaw registry (not the core baseline) — production hints and
    // action.canonicalKind then agree with the plugin hook path and replay.
    toolSemantics: OPENCLAW_TOOL_SEMANTICS,
    ...(options.roundKeyProvider ? {
      roundKeyProvider(event: HostEvent) {
        const payload = payloadFor(event);
        if (payload.kind !== 'before_prompt_build') return undefined;
        return options.roundKeyProvider?.(payload.event, payload.context);
      },
    } : {}),
    ...(options.adaptiveGapProvider ? {
      adaptiveGapProvider(event, candidates, gapOptions) {
        const payload = payloadFor(event);
        if (payload.kind !== 'before_prompt_build') return Promise.resolve(undefined);
        return options.adaptiveGapProvider!(payload.event, payload.context, event, candidates, gapOptions);
      },
    } : {}),
    adaptivePriorityProvider(event) {
      const payload = payloadFor(event);
      if (payload.kind !== 'before_prompt_build') return undefined;
      return options.adaptivePriorityProvider?.(payload.event, payload.context);
    },
    ruleContextProvider(request) {
      if (typeof request.rawPayload !== 'object' || request.rawPayload === null) throw new Error('OpenClaw rule context request is missing its native payload');
      const token = Reflect.get(request.rawPayload, 'nativeToken');
      if (typeof token !== 'object' || token === null) throw new Error('OpenClaw rule context request has an invalid native token');
      const payload = payloads.get(token);
      if (!payload || payload.kind !== 'before_tool_call') throw new Error('OpenClaw rule context request has a mismatched native payload');
      return options.ruleContextProvider?.(payload.event, payload.context, request);
    },
    ruleInputEnrichmentProvider(request) {
      if (typeof request.rawPayload !== 'object' || request.rawPayload === null) throw new Error('OpenClaw rule enrichment request is missing its native payload');
      const token = Reflect.get(request.rawPayload, 'nativeToken');
      if (typeof token !== 'object' || token === null) throw new Error('OpenClaw rule enrichment request has an invalid native token');
      const payload = payloads.get(token);
      if (!payload || payload.kind !== 'before_tool_call') throw new Error('OpenClaw rule enrichment request has a mismatched native payload');
      return options.ruleInputEnrichmentProvider?.(payload.event, payload.context, request);
    },
    async beforePromptBuild(event, prompt) {
      const payload = payloadFor(event);
      if (payload.kind !== 'before_prompt_build') throw new Error('OpenClaw prompt payload mismatch');
      const value = await options.beforePromptBuild(payload.event, payload.context, prompt);
      return recordResult(event, { kind: payload.kind, value }, value ? 'modify' : 'allow');
    },
    painEnrichmentProvider(event) {
      const payload = payloadFor(event);
      if (payload.kind !== 'after_tool_call') throw new Error('OpenClaw pain payload mismatch');
      return options.painEnrichmentProvider?.(payload.event, payload.context);
    },
    // PRI-640: this adapter IS the OpenClaw host boundary — it owns host truth.
    hostKind: 'openclaw',
  });

  async function dispatch(payload: NativePayload, workspaceDir: string, sessionId: string | undefined): Promise<NativeResult> {
    const token = {};
    payloads.set(token, payload);
    const modelContext = modelContextFor(payload.context);
    // PRI-1137 final review P1-4: the SDK's native after-tool field is
    // `toolArgs`; parity/legacy hosts may still supply `params`. Preserve an
    // explicitly supplied params object as the authoritative legacy payload,
    // and use toolArgs only when params is absent/invalid. Both paths are
    // runtime-guarded before the shared evidence sanitizer receives them.
    const afterEvent = payload.kind === 'after_tool_call' ? payload.event : undefined;
    const legacyAfterParams: unknown = afterEvent !== undefined ? afterEvent.params : undefined;
    const isRecordValue = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value);
    const afterToolInput = isRecordValue(legacyAfterParams)
      ? legacyAfterParams
      : isRecordValue(afterEvent?.toolArgs) ? afterEvent.toolArgs : {};
    const event: HostEvent = {
      kind: payload.kind,
      context: {
        ...contextFor(workspaceDir, sessionId, payload.kind === 'before_prompt_build' ? undefined : payload.event.toolName),
        ...(afterEvent !== undefined ? {
          toolInput: afterToolInput,
          toolOutput: { error: afterEvent.error, result: afterEvent.result, durationMs: afterEvent.durationMs },
        } : {}),
        ...(modelContext !== undefined ? { modelContext } : {}),
      },
      rawPayload: payload.kind === 'before_tool_call'
        ? { nativeToken: token, toolInput: { toolName: payload.event.toolName, params: payload.event.params ?? {} } }
        : { nativeToken: token },
      source: `openclaw:${payload.kind}`,
    };
    const result = await runtime.dispatch(event);
    const native = results.get(result);
    if (payload.kind === 'before_tool_call' && !native) {
      const enrichedValue = options.onBeforeToolResult?.(payload.event, payload.context, result);
      if (result.decision === 'deny') {
        // PRI-1184 / F4: a deny must never be downgraded to allow, but the
        // plugin DOES own the owner-facing copy (PRI-530 receipt). Before this,
        // the enriched value was discarded here, so the shared production path
        // had no producer for `principle_receipt_block_copy` and every shared
        // deny surfaced the raw gate reason only. Honour a returned block
        // result; anything else keeps the gate's reason verbatim.
        return { kind: payload.kind, value: enrichedValue && typeof enrichedValue === 'object' && enrichedValue.block === true
          ? enrichedValue
          : { block: true, blockReason: result.reason } };
      }
      return { kind: payload.kind, value: enrichedValue };
    }
    if (payload.kind === 'after_tool_call' && !native) {
      // Phase A: the shared after-tool kernel only records technical evidence
      // now; no pain result needs a host-side continuation. P1-4: surface the
      // kernel's degradation facts (warnings / unavailable outcome) so the
      // caller can record an HONEST hook execution instead of a blind success.
      const metadata = (result as { metadata?: { outcome?: unknown; nextAction?: unknown } }).metadata;
      const outcome = typeof (metadata?.outcome) === 'string' ? metadata.outcome : undefined;
      const nextAction = typeof (metadata?.nextAction) === 'string' ? metadata.nextAction : undefined;
      return {
        kind: payload.kind,
        value: undefined,
        hostResult: { warnings: result.warnings ?? [], ...(outcome !== undefined ? { outcome } : {}), ...(nextAction !== undefined ? { nextAction } : {}) },
      };
    }
    if (!native || native.kind !== payload.kind) {
      throw new Error(`OpenClaw ${payload.kind} result mapping is missing`);
    }
    return native;
  }

  return {
    runtime,
    async dispatchBeforePromptBuild(event, context) {
      if (!context.workspaceDir) throw new Error('OpenClaw before_prompt_build requires workspaceDir');
      const native = await dispatch({ kind: 'before_prompt_build', event, context }, context.workspaceDir, context.sessionId);
      if (native.kind !== 'before_prompt_build') throw new Error('OpenClaw prompt result mismatch');
      return native.value;
    },
    async dispatchBeforeToolCall(event, context) {
      if (!context.workspaceDir) throw new Error('OpenClaw before_tool_call requires workspaceDir');
      const native = await dispatch({ kind: 'before_tool_call', event, context }, context.workspaceDir, context.sessionId);
      if (native.kind !== 'before_tool_call') throw new Error('OpenClaw gate result mismatch');
      return native.value;
    },
    async dispatchAfterToolCall(event, context): Promise<AfterToolCallDispatch> {
      if (!context.workspaceDir) throw new Error('OpenClaw after_tool_call requires workspaceDir');
      const native = await dispatch({ kind: 'after_tool_call', event, context }, context.workspaceDir, context.sessionId);
      if (native.kind !== 'after_tool_call') throw new Error('OpenClaw after_tool_call result mismatch');
      return native.hostResult ?? { warnings: [] };
    },
  };
}
