import type { PluginHookBeforeToolCallEvent, PluginHookToolContext, PluginHookBeforeToolCallResult } from '../openclaw-sdk.js';
export declare function handleBeforeToolCall(event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext & {
    workspaceDir?: string;
    pluginConfig?: Record<string, unknown>;
    logger?: any;
}): PluginHookBeforeToolCallResult | void;
