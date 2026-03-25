import type { PluginHookBeforeResetEvent, PluginHookBeforeCompactionEvent, PluginHookAfterCompactionEvent, PluginHookAgentContext } from '../openclaw-sdk.js';
export declare function handleBeforeReset(event: PluginHookBeforeResetEvent, ctx: PluginHookAgentContext): Promise<void>;
export declare function extractPainFromSessionFile(sessionFile: string, ctx: PluginHookAgentContext): Promise<void>;
export declare function handleBeforeCompaction(event: PluginHookBeforeCompactionEvent, ctx: PluginHookAgentContext): Promise<void>;
export declare function handleAfterCompaction(event: PluginHookAfterCompactionEvent, ctx: PluginHookAgentContext): Promise<void>;
