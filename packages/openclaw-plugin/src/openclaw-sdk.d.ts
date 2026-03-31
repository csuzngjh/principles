import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * OpenClaw Plugin SDK type shims (Official V1.0 Alignment)
 * 
 * These types are based directly on the OpenClaw core source code to ensure
 * absolute compatibility during development and deployment.
 */

import type { TSchema, Static } from '@sinclair/typebox';

// ── Agent Tool Types (Strict Signature Enforcement) ───────────────────

/**
 * Standard tool result format returned to OpenClaw.
 * 
 * CRITICAL: Tools MUST return this format, not plain strings.
 */
export interface AgentToolResult<T = unknown> {
    content: Array<{
        type: string;  // 'text', 'image', etc.
        text?: string;
        data?: string;
        mimeType?: string;
    }>;
    meta?: T;
}

/**
 * Update callback for streaming tool results.
 */
export type AgentToolUpdateCallback<T = unknown> = (update: AgentToolResult<T>) => void;

/**
 * Strict tool definition interface.
 * 
 * CRITICAL: The execute signature MUST match exactly:
 * - First parameter: toolCallId (string) - the unique tool call identifier
 * - Second parameter: rawParams (Record<string, unknown>) - the actual parameters
 * - Third parameter: signal (AbortSignal | undefined) - for cancellation
 * - Fourth parameter: onUpdate (callback | undefined) - for streaming updates
 * 
 * Common mistake: Using (params, api, workspaceDir) will cause params to receive
 * the toolCallId string, making all parameter access return undefined.
 */
export interface AgentTool<TSchema extends TSchema = TSchema, TMeta = unknown> {
    name: string;
    description?: string;
    parameters: TSchema;
    label?: string;
    execute: (
        toolCallId: string,
        rawParams: Static<TSchema> & Record<string, unknown>,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<TMeta>
    ) => Promise<AgentToolResult<TMeta>>;
}

/**
 * Factory function type for creating tools with injected dependencies.
 * 
 * RECOMMENDED: Use factory pattern to capture `api` in closure:
 * 
 * @example
 * export function createMyTool(api: OpenClawPluginApi): AgentTool {
 *   return {
 *     name: 'my_tool',
 *     parameters: Type.Object({ ... }),
 *     async execute(toolCallId, rawParams, signal) {
 *       // Use `api` from closure
 *     },
 *   };
 * }
 */
export type AgentToolFactory = (api: OpenClawPluginApi) => AgentTool;

export interface PluginLogger {
    debug?: (message: string, meta?: Record<string, unknown>) => void;
    info: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
    error: (message: string, meta?: Record<string, unknown>) => void;
}

// ── Subagent runtime types ──────────────────────────────────────────

export interface SubagentRunParams {
    sessionKey: string; // 👈 官方字段名为 sessionKey
    message: string;    // 👈 官方字段名为 message
    extraSystemPrompt?: string;
    lane?: string;
    deliver?: boolean;
    idempotencyKey?: string;
}

export interface SubagentRunResult {
    runId: string;
}

export interface SubagentWaitParams {
    runId: string;
    timeoutMs?: number;
}

export interface SubagentWaitResult {
    status: 'ok' | 'error' | 'timeout';
    error?: string;
}

export interface SubagentGetSessionMessagesParams {
    sessionKey: string;
    limit?: number;
}

export interface SubagentGetSessionMessagesResult {
    messages: unknown[];
    assistantTexts?: string[]; // Optional helper provided by some runtime wrappers
}

export interface SubagentDeleteSessionParams {
    sessionKey: string;
    deleteTranscript?: boolean;
}

// ── Plugin Runtime ───────────────────────────────────────────────────

export interface PluginRuntime {
    version: string;
    subagent: {
        run: (params: SubagentRunParams) => Promise<SubagentRunResult>;
        waitForRun: (params: SubagentWaitParams) => Promise<SubagentWaitResult>;
        getSessionMessages: (params: SubagentGetSessionMessagesParams) => Promise<SubagentGetSessionMessagesResult>;
        deleteSession: (params: SubagentDeleteSessionParams) => Promise<void>;
    };
    tools: {
        createMemoryGetTool: (params: any) => any;
        createMemorySearchTool: (params: any) => any;
    };
    system: {
        enqueueSystemEvent: (event: any) => void;
        requestHeartbeatNow: () => void;
        runCommandWithTimeout: (cmd: string, args: string[], timeout: number) => Promise<any>;
    };
    logging: {
        shouldLogVerbose: () => boolean;
        getChildLogger: (bindings?: Record<string, unknown>) => PluginLogger;
    };
    state: {
        resolveStateDir: (env?: any, homedir?: any) => string;
    };
    config: {
        loadConfig: () => any;
        writeConfigFile: (cfg: any) => Promise<void>;
    };
}

// ── Plugin API ───────────────────────────────────────────────────────

export interface OpenClawPluginApi {
    id: string;
    name: string;
    version?: string;
    source: string;
    rootDir: string;
    config: Record<string, any>;
    pluginConfig?: Record<string, any>;
    runtime: PluginRuntime;
    logger: PluginLogger;
    workspaceDir?: string; // Optional but commonly injected
    /**
     * Register a custom tool with OpenClaw.
     * 
     * CRITICAL: The tool MUST conform to AgentTool interface with correct execute signature:
     * - execute(toolCallId: string, rawParams: Record<string, unknown>, signal?: AbortSignal)
     * 
     * Common mistake: Using execute(params, api, workspaceDir) will cause runtime failures.
     */
    registerTool: (tool: AgentTool, opts?: { lane?: string }) => void;
    registerHook: (events: string | string[], handler: any, opts?: any) => void;
    registerHttpRoute: (params: OpenClawPluginHttpRouteParams) => void;
    registerService: (service: OpenClawPluginService) => void;
    registerCommand: (command: PluginCommandDefinition) => void;
    resolvePath: (input: string) => string;
    on: <K extends PluginHookName>(
        hookName: K,
        handler: PluginHookHandlerMap[K],
        opts?: { priority?: number },
    ) => void;
}

// ── Command types ───────────────────────────────────────────────────

export type PluginCommandDefinition = {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    handler: (ctx: PluginCommandContext) => PluginCommandResult | Promise<PluginCommandResult>;
};

export type PluginCommandContext = {
    senderId?: string;
    channel: string;
    channelId?: string;
    sessionId?: string;
    isAuthorizedSender: boolean;
    args?: string;
    commandBody: string;
    config: Record<string, any>;
    workspaceDir?: string;
    from?: string;
    to?: string;
    accountId?: string;
    messageThreadId?: number;
};

export type PluginCommandResult = {
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    replyToId?: string;
    isError?: boolean;
    channelData?: Record<string, any>;
};

// ── Hook types ──────────────────────────────────────────────────────

export type PluginHookName =
    | 'before_model_resolve' | 'before_prompt_build' | 'before_agent_start'
    | 'llm_input' | 'llm_output' | 'agent_end'
    | 'before_compaction' | 'after_compaction' | 'before_reset'
    | 'message_received' | 'message_sending' | 'message_sent'
    | 'before_tool_call' | 'after_tool_call' | 'tool_result_persist' | 'before_message_write' | 'session_start' | 'session_end'
    | 'session_start' | 'session_end'
    | 'subagent_spawning' | 'subagent_delivery_target' | 'subagent_spawned' | 'subagent_ended'
    | 'gateway_start' | 'gateway_stop';

export type PluginHookAgentContext = {
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    workspaceDir?: string;
    stateDir?: string;
    messageProvider?: string;
    trigger?: string;
    channelId?: string;
    logger?: PluginLogger;
};

export type PluginHookToolContext = {
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    workspaceDir?: string;
    runId?: string;
    toolName: string;
    toolCallId?: string;
};

export type PluginHookSubagentContext = {
    runId?: string;
    childSessionKey?: string;
    requesterSessionKey?: string;
    workspaceDir?: string; // CommonPD extension
};


export type PluginHookSessionContext = {
    agentId?: string;
    sessionId: string;
    sessionKey?: string;
};

// ── Event types ─────────────────────────────────────────────────────

export type PluginHookBeforePromptBuildEvent = {
    prompt: string;
    messages: unknown[];
};

export type PluginHookBeforePromptBuildResult = {
    systemPrompt?: string;
    prependContext?: string;
    prependSystemContext?: string;
    appendSystemContext?: string;
};

export type PluginHookBeforeToolCallEvent = {
    toolName: string;
    params: Record<string, any>;
    runId?: string;
    toolCallId?: string;
};

export type PluginHookBeforeToolCallResult = {
    params?: Record<string, any>;
    block?: boolean;
    blockReason?: string;
};

export type PluginHookAfterToolCallEvent = {
    toolName: string;
    params: Record<string, any>;
    runId?: string;
    toolCallId?: string;
    result?: any;
    error?: string;
    durationMs?: number;
};

export type PluginHookToolResultPersistContext = {
    agentId?: string;
    sessionKey?: string;
    toolName?: string;
    toolCallId?: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PluginHookToolResultPersistEvent<TMessage = any> = {
    toolName?: string;
    toolCallId?: string;
    /** The toolResult message about to be written to the session transcript. */
    message: TMessage;
    isSynthetic?: boolean;
};

export type PluginHookToolResultPersistResult<TMessage = any> = {
    message?: TMessage;
};

export type PluginHookLlmOutputEvent = {
    runId: string;
    sessionId: string;
    provider: string;
    model: string;
    assistantTexts: string[];
    lastAssistant?: any;
    usage?: {
        input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number;
    };
};

export type PluginHookBeforeMessageWriteEvent = {
    message: any;
    sessionKey?: string;
    agentId?: string;
};

export type PluginHookBeforeMessageWriteResult = {
    block?: boolean;
    message?: any;
};

export type PluginHookSubagentEndedEvent = {
    targetSessionKey: string;
    targetKind: 'subagent' | 'acp';
    reason: string;
    sendFarewell?: boolean;
    accountId?: string;
    runId?: string;
    endedAt?: number;
    outcome?: 'ok' | 'error' | 'timeout' | 'killed' | 'reset' | 'deleted';
    error?: string;
};

export type PluginHookBeforeResetEvent = {
    sessionFile?: string;
    messages?: unknown[];
    reason?: string;
};

export type PluginHookBeforeCompactionEvent = {
    messageCount: number;
    compactingCount?: number;
    tokenCount?: number;
    messages?: unknown[];
    sessionFile?: string;
};

export type PluginHookAfterCompactionEvent = {
    messageCount: number;
    tokenCount?: number;
    compactedCount: number;
    sessionFile?: string;
};

export type PluginHookSubagentSpawningEvent = {
    childSessionKey: string;
    agentId: string;
    label?: string;
    mode: 'run' | 'session';
    requester?: { channel?: string; accountId?: string; to?: string; threadId?: string | number };
    threadRequested: boolean;
};

export type PluginHookSubagentSpawningResult =
    | { status: 'ok'; threadBindingReady?: boolean }
    | { status: 'error'; error: string };

// Subagent target kind (synced from OpenClaw v2026.3.23)
export type PluginHookSubagentTargetKind = 'subagent' | 'acp';

// subagent_delivery_target hook (synced from OpenClaw v2026.3.23)
export type PluginHookSubagentDeliveryTargetEvent = {
    childSessionKey: string;
    requesterSessionKey: string;
    requesterOrigin?: {
        channel?: string;
        accountId?: string;
        to?: string;
        threadId?: string | number;
    };
    childRunId?: string;
    spawnMode?: 'run' | 'session';
    expectsCompletionMessage: boolean;
};

export type PluginHookSubagentDeliveryTargetResult = {
    origin?: {
        channel?: string;
        accountId?: string;
        to?: string;
        threadId?: string | number;
    };
};

// subagent_spawned hook (synced from OpenClaw v2026.3.23)
export type PluginHookSubagentSpawnedEvent = {
    childSessionKey: string;
    agentId: string;
    label?: string;
    mode: 'run' | 'session';
    requester?: { channel?: string; accountId?: string; to?: string; threadId?: string | number };
    threadRequested: boolean;
    runId: string;
};

// ── Service types ────────────────────────────────────────────────────

export interface OpenClawPluginServiceContext {
    config: Record<string, any>;
    workspaceDir?: string;
    stateDir: string;
    logger: PluginLogger;
}

export interface OpenClawPluginService {
    id: string;
    start: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
    stop?: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
}

export type OpenClawPluginHttpRouteAuth = 'gateway' | 'plugin';
export type OpenClawPluginHttpRouteMatch = 'exact' | 'prefix';

export type OpenClawPluginHttpRouteHandler = (
    req: IncomingMessage,
    res: ServerResponse,
) => Promise<boolean | void> | boolean | void;

export type OpenClawPluginHttpRouteParams = {
    path: string;
    handler: OpenClawPluginHttpRouteHandler;
    auth: OpenClawPluginHttpRouteAuth;
    match?: OpenClawPluginHttpRouteMatch;
    replaceExisting?: boolean;
};

// ── Handler map ─────────────────────────────────────────────────────

export type PluginHookHandlerMap = {
    before_prompt_build: (event: PluginHookBeforePromptBuildEvent, ctx: PluginHookAgentContext) => any;
    before_tool_call: (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext) => any;
    after_tool_call: (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => any;
    llm_output: (event: PluginHookLlmOutputEvent, ctx: PluginHookAgentContext) => any;
    subagent_ended: (event: PluginHookSubagentEndedEvent, ctx: PluginHookSubagentContext) => any;
    subagent_spawning: (event: PluginHookSubagentSpawningEvent, ctx: PluginHookSubagentContext) => any;
    subagent_delivery_target: (event: PluginHookSubagentDeliveryTargetEvent, ctx: PluginHookSubagentContext) => PluginHookSubagentDeliveryTargetResult | void | Promise<PluginHookSubagentDeliveryTargetResult | void>;
    subagent_spawned: (event: PluginHookSubagentSpawnedEvent, ctx: PluginHookSubagentContext) => void | Promise<void>;
    before_reset: (event: PluginHookBeforeResetEvent, ctx: PluginHookAgentContext) => any;
    before_compaction: (event: PluginHookBeforeCompactionEvent, ctx: PluginHookAgentContext) => any;
    after_compaction: (event: PluginHookAfterCompactionEvent, ctx: PluginHookAgentContext) => any;
    before_message_write: (event: PluginHookBeforeMessageWriteEvent, ctx: PluginHookSessionContext) => any;
    tool_result_persist: (event: PluginHookToolResultPersistEvent, ctx: PluginHookToolResultPersistContext) => PluginHookToolResultPersistResult | void;
    [key: string]: (...args: any[]) => any;
};
