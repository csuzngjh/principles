import type { PluginHookAgentContext } from '../openclaw-sdk.js';
export declare function handleTrustCommand(ctx: PluginHookAgentContext & {
    workspaceDir?: string;
}): string;
