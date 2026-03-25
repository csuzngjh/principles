/**
 * Agent Spawn Tool
 *
 * Provides a tool for spawning subagents with predefined agent definitions.
 * Uses the low-level OpenClaw Subagent API.
 */
import type { OpenClawPluginApi } from '../openclaw-sdk.js';
/**
 * Create Agent Spawn Tool
 *
 * Uses factory pattern to capture `api` in closure, following OpenClaw plugin SDK conventions.
 * The execute signature must be: async (_toolCallId: string, rawParams: Record<string, unknown>)
 */
export declare function createAgentSpawnTool(api: OpenClawPluginApi): {
    name: string;
    description: string;
    parameters: import("@sinclair/typebox").TObject<{
        agentType: import("@sinclair/typebox").TString;
        task: import("@sinclair/typebox").TString;
        runInBackground: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    }>;
    /**
     * Execution logic for the agent spawn tool
     *
     * OpenClaw tool execute signature:
     * - First parameter: _toolCallId (string) - the tool call ID
     * - Second parameter: rawParams (Record<string, unknown>) - the actual parameters
     * - Third parameter (optional): signal (AbortSignal) - for cancellation
     */
    execute(_toolCallId: string, rawParams: Record<string, unknown>): Promise<{
        content: Array<{
            type: string;
            text: string;
        }>;
    }>;
};
export declare const agentSpawnTool: {
    name: string;
    description: string;
    parameters: import("@sinclair/typebox").TObject<{
        agentType: import("@sinclair/typebox").TString;
        task: import("@sinclair/typebox").TString;
        runInBackground: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    }>;
    execute: () => never;
};
/**
 * Batch spawn multiple agents in sequence
 * Useful for evolution workflow
 */
export declare function spawnAgentSequence(agents: Array<{
    type: string;
    task: string;
}>, api: OpenClawPluginApi, onProgress?: (agent: string, result: string) => void): Promise<Map<string, string>>;
