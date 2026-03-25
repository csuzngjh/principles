import type { PluginHookAfterToolCallEvent, PluginHookToolContext, OpenClawPluginApi } from '../openclaw-sdk.js';
export declare function handleAfterToolCall(event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext & {
    workspaceDir?: string;
    pluginConfig?: Record<string, unknown>;
}, api?: OpenClawPluginApi): void;
