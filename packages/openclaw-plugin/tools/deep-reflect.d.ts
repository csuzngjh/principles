import type { OpenClawPluginApi } from '../openclaw-sdk.js';
/**
 * Create Deep Reflect Tool
 *
 * Uses factory pattern to capture `api` in closure, following OpenClaw plugin SDK conventions.
 * The execute signature must be: async (_toolCallId: string, rawParams: Record<string, unknown>)
 */
export declare function createDeepReflectTool(api: OpenClawPluginApi): {
    name: string;
    description: string;
    parameters: import("@sinclair/typebox").TObject<{
        context: import("@sinclair/typebox").TString;
        depth: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
        model_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    /**
     * Tool execution logic
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
export declare const deepReflectTool: {
    name: string;
    description: string;
    parameters: import("@sinclair/typebox").TObject<{
        context: import("@sinclair/typebox").TString;
        depth: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
        model_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
};
