import type { PluginHookBeforeResetEvent, PluginHookBeforeCompactionEvent, PluginHookAgentContext } from '../openclaw-sdk.js';
export declare function handleBeforeReset(event: PluginHookBeforeResetEvent, ctx: PluginHookAgentContext): Promise<void>;
export declare function handleBeforeCompaction(event: PluginHookBeforeCompactionEvent, ctx: PluginHookAgentContext): Promise<void>;
