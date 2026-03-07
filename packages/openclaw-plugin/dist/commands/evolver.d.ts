import type { PluginCommandContext, PluginCommandResult } from '../openclaw-sdk.js';
/**
 * /evolve-task [task description]
 *
 * Returns instructions that tell the Agent to invoke the sessions_spawn tool
 * targeting the evolver agent. Plugin command handlers cannot directly call
 * Gateway tools — only the AI agent can do that via sessions_spawn.
 */
export declare function handleEvolveTask(ctx: PluginCommandContext): PluginCommandResult;
