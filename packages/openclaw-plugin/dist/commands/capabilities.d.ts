import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';
export declare function scanEnvironment(workspaceDir: string): Record<string, unknown>;
export declare function handleBootstrapTools(ctx: PluginCommandContext): PluginCommandResult;
export declare function handleResearchTools(ctx: PluginCommandContext): PluginCommandResult;
