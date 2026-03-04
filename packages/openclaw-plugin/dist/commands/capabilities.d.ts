import type { PluginCommandContext, PluginCommandResult } from '../types';
export declare function scanEnvironment(workspaceDir: string): Record<string, any>;
export declare function handleBootstrapTools(ctx: PluginCommandContext): PluginCommandResult;
