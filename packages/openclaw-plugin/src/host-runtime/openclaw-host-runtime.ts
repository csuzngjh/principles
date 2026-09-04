import { createProductionHostRuntime, type ActivePrinciplePromptResult, type HostRuntime, type ProductionRuleContextRequest, type ProductionPainEnrichment } from '@principles/host-runtime';
import type { HostEvent, HostEventContext, HostEventResult } from '@principles/core/host';
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
  | { kind: 'after_tool_call'; value: void };

export interface OpenClawHostRuntimeOptions {
  beforePromptBuild(event: PluginHookBeforePromptBuildEvent, context: PluginHookAgentContext, prompt: ActivePrinciplePromptResult): Promise<PluginHookBeforePromptBuildResult | void>;
  promptExcludePrincipleIds?(event: PluginHookBeforePromptBuildEvent, context: PluginHookAgentContext): ReadonlySet<string>;
  ruleContextProvider?(event: PluginHookBeforeToolCallEvent, context: PluginHookToolContext, request: ProductionRuleContextRequest): unknown | Promise<unknown>;
  ruleInputEnrichmentProvider?(event: PluginHookBeforeToolCallEvent, context: PluginHookToolContext, request: ProductionRuleContextRequest): unknown | Promise<unknown>;
  onBeforeToolResult?(event: PluginHookBeforeToolCallEvent, context: PluginHookToolContext, result: HostEventResult): PluginHookBeforeToolCallResult | void;
  painEnrichmentProvider?(event: PluginHookAfterToolCallEvent, context: PluginHookToolContext): ProductionPainEnrichment | Promise<ProductionPainEnrichment>;
  onAfterToolResult?(event: PluginHookAfterToolCallEvent, context: PluginHookToolContext, result: HostEventResult): void | Promise<void>;
}

export interface OpenClawHostRuntime {
  readonly runtime: HostRuntime;
  dispatchBeforePromptBuild(event: PluginHookBeforePromptBuildEvent, context: PluginHookAgentContext): Promise<PluginHookBeforePromptBuildResult | void>;
  dispatchBeforeToolCall(event: PluginHookBeforeToolCallEvent, context: PluginHookToolContext): Promise<PluginHookBeforeToolCallResult | void>;
  dispatchAfterToolCall(event: PluginHookAfterToolCallEvent, context: PluginHookToolContext): Promise<void>;
}

function contextFor(workspaceDir: string, sessionId: string | undefined, toolName?: string): HostEventContext {
  return { workspaceDir, sessionId: sessionId ?? 'openclaw:session-unavailable', toolName };
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
    promptExcludePrincipleIds(event) {
      const payload = payloadFor(event);
      if (payload.kind !== 'before_prompt_build') throw new Error('OpenClaw prompt exclusion payload mismatch');
      return options.promptExcludePrincipleIds?.(payload.event, payload.context) ?? new Set();
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
    const event: HostEvent = {
      kind: payload.kind,
      context: {
        ...contextFor(workspaceDir, sessionId, payload.kind === 'before_prompt_build' ? undefined : payload.event.toolName),
        ...(payload.kind === 'after_tool_call' ? {
          toolInput: payload.event.params ?? {},
          toolOutput: { error: payload.event.error, result: payload.event.result, durationMs: payload.event.durationMs },
        } : {}),
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
      return { kind: payload.kind, value: result.decision === 'deny'
        ? { block: true, blockReason: result.reason }
        : enrichedValue };
    }
    if (payload.kind === 'after_tool_call' && !native) {
      if (result.metadata?.outcome !== 'unavailable') {
        await options.onAfterToolResult?.(payload.event, payload.context, result);
      }
      return { kind: payload.kind, value: undefined };
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
    async dispatchAfterToolCall(event, context) {
      if (!context.workspaceDir) throw new Error('OpenClaw after_tool_call requires workspaceDir');
      await dispatch({ kind: 'after_tool_call', event, context }, context.workspaceDir, context.sessionId);
    },
  };
}
