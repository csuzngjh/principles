import { createHostRuntime, type HostRuntime } from '@principles/host-runtime';
import type { HostEvent, HostEventContext, HostEventResult } from '@principles/core/host';
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
  beforePromptBuild(event: PluginHookBeforePromptBuildEvent, context: PluginHookAgentContext): Promise<PluginHookBeforePromptBuildResult | void>;
  beforeToolCall(event: PluginHookBeforeToolCallEvent, context: PluginHookToolContext): PluginHookBeforeToolCallResult | void;
  afterToolCall(event: PluginHookAfterToolCallEvent, context: PluginHookToolContext): void;
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
    const payload = payloads.get(event.rawPayload);
    if (!payload || payload.kind !== event.kind) {
      throw new Error(`OpenClaw ${event.kind} dispatch has a mismatched native payload`);
    }
    return payload;
  }

  function recordResult(event: HostEvent, native: NativeResult, decision: HostEventResult['decision']): HostEventResult {
    const result: HostEventResult = { decision, source: event.source };
    results.set(result, native);
    return result;
  }

  const runtime = createHostRuntime({
    async beforePromptBuild(event) {
      const payload = payloadFor(event);
      if (payload.kind !== 'before_prompt_build') throw new Error('OpenClaw prompt payload mismatch');
      const value = await options.beforePromptBuild(payload.event, payload.context);
      return recordResult(event, { kind: payload.kind, value }, value ? 'modify' : 'allow');
    },
    async beforeToolCall(event) {
      const payload = payloadFor(event);
      if (payload.kind !== 'before_tool_call') throw new Error('OpenClaw gate payload mismatch');
      const value = options.beforeToolCall(payload.event, payload.context);
      const decision = value?.skipToolCall ? 'deny' : value ? 'modify' : 'allow';
      return recordResult(event, { kind: payload.kind, value }, decision);
    },
    async afterToolCall(event) {
      const payload = payloadFor(event);
      if (payload.kind !== 'after_tool_call') throw new Error('OpenClaw pain payload mismatch');
      options.afterToolCall(payload.event, payload.context);
      return recordResult(event, { kind: payload.kind, value: undefined }, 'observe');
    },
  });

  async function dispatch(payload: NativePayload, workspaceDir: string, sessionId: string | undefined): Promise<NativeResult> {
    const token = {};
    payloads.set(token, payload);
    const event: HostEvent = {
      kind: payload.kind,
      context: contextFor(workspaceDir, sessionId, payload.kind === 'before_prompt_build' ? undefined : payload.event.toolName),
      rawPayload: token,
      source: `openclaw:${payload.kind}`,
    };
    const result = await runtime.dispatch(event);
    const native = results.get(result);
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
