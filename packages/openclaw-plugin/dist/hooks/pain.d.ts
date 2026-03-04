import type { PluginHookAfterToolCallEvent, PluginHookToolContext } from '../openclaw-sdk.js';
export declare function handleAfterToolCall(event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext & {
    workspaceDir?: string;
    pluginConfig?: Record<string, unknown>;
}): void;
