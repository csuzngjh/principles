import type { PluginHookBeforePromptBuildEvent, PluginHookAgentContext, PluginHookBeforePromptBuildResult } from '../openclaw-sdk.js';
export declare function handleBeforePromptBuild(event: PluginHookBeforePromptBuildEvent, ctx: PluginHookAgentContext & {
    api?: any;
}): Promise<PluginHookBeforePromptBuildResult | void>;
