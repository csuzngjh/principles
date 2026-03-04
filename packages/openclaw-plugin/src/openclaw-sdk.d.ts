// OpenClaw Plugin SDK type shims
// When openclaw is installed as a peer dependency, these types are imported from
// 'openclaw/plugin-sdk/core'. For local development without openclaw installed,
// these ambient shims provide type safety.
// In production: add "openclaw": ">=1.0.0" to peerDependencies.

export interface PluginLogger {
    debug?: (message: string) => void;
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
}

export interface OpenClawPluginApi {
    id: string;
    name: string;
    version?: string;
    source: string;
    config: Record<string, unknown>;
    pluginConfig?: Record<string, unknown>;
    runtime: unknown;
    logger: PluginLogger;
    registerTool: (tool: unknown, opts?: unknown) => void;
    registerHook: (events: string | string[], handler: unknown, opts?: unknown) => void;
    registerHttpRoute: (params: unknown) => void;
    registerChannel: (registration: unknown) => void;
    registerGatewayMethod: (method: string, handler: unknown) => void;
    registerCli: (registrar: unknown, opts?: { commands?: string[] }) => void;
    registerService: (service: unknown) => void;
    registerProvider: (provider: unknown) => void;
    registerCommand: (command: PluginCommandDefinition) => void;
    resolvePath: (input: string) => string;
    on: <K extends PluginHookName>(
        hookName: K,
        handler: PluginHookHandlerMap[K],
        opts?: { priority?: number },
    ) => void;
}

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
    isAuthorizedSender: boolean;
    args?: string;
    commandBody: string;
    config: Record<string, unknown>;
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
    channelData?: Record<string, unknown>;
};

// ── Hook names ──────────────────────────────────────────────────────────────
export type PluginHookName =
    | 'before_model_resolve' | 'before_prompt_build' | 'before_agent_start'
    | 'llm_input' | 'llm_output' | 'agent_end'
    | 'before_compaction' | 'after_compaction' | 'before_reset'
    | 'message_received' | 'message_sending' | 'message_sent'
    | 'before_tool_call' | 'after_tool_call' | 'tool_result_persist' | 'before_message_write'
    | 'session_start' | 'session_end'
    | 'subagent_spawning' | 'subagent_delivery_target' | 'subagent_spawned' | 'subagent_ended'
    | 'gateway_start' | 'gateway_stop';

// ── Agent context ────────────────────────────────────────────────────────────
export type PluginHookAgentContext = {
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    workspaceDir?: string;
    messageProvider?: string;
    /** "user" | "heartbeat" | "cron" | "memory" */
    trigger?: string;
    channelId?: string;
};

// ── Tool context ─────────────────────────────────────────────────────────────
export type PluginHookToolContext = {
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    runId?: string;
    toolName: string;
    toolCallId?: string;
};

// ── Subagent context ─────────────────────────────────────────────────────────
export type PluginHookSubagentContext = {
    runId?: string;
    childSessionKey?: string;
    requesterSessionKey?: string;
};

// ── Event types ───────────────────────────────────────────────────────────────

export type PluginHookBeforePromptBuildEvent = {
    prompt: string;
    messages: unknown[];
};

export type PluginHookBeforePromptBuildResult = {
    systemPrompt?: string;
    prependContext?: string;
};

export type PluginHookBeforeToolCallEvent = {
    toolName: string;
    params: Record<string, unknown>;
    runId?: string;
    toolCallId?: string;
};

export type PluginHookBeforeToolCallResult = {
    params?: Record<string, unknown>;
    block?: boolean;
    blockReason?: string;
};

export type PluginHookAfterToolCallEvent = {
    toolName: string;
    params: Record<string, unknown>;
    runId?: string;
    toolCallId?: string;
    result?: unknown;
    error?: string;
    durationMs?: number;
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

// ── Handler map (simplified — full map in openclaw/plugin-sdk/core) ──────────
export type PluginHookHandlerMap = {
    before_prompt_build: (
        event: PluginHookBeforePromptBuildEvent,
        ctx: PluginHookAgentContext
    ) => PluginHookBeforePromptBuildResult | void | Promise<PluginHookBeforePromptBuildResult | void>;

    before_tool_call: (
        event: PluginHookBeforeToolCallEvent,
        ctx: PluginHookToolContext
    ) => PluginHookBeforeToolCallResult | void | Promise<PluginHookBeforeToolCallResult | void>;

    after_tool_call: (
        event: PluginHookAfterToolCallEvent,
        ctx: PluginHookToolContext
    ) => void | Promise<void>;

    before_reset: (
        event: PluginHookBeforeResetEvent,
        ctx: PluginHookAgentContext
    ) => void | Promise<void>;

    before_compaction: (
        event: PluginHookBeforeCompactionEvent,
        ctx: PluginHookAgentContext
    ) => void | Promise<void>;

    subagent_spawning: (
        event: PluginHookSubagentSpawningEvent,
        ctx: PluginHookSubagentContext
    ) => PluginHookSubagentSpawningResult | void | Promise<PluginHookSubagentSpawningResult | void>;

    // Remaining hooks — permissive for now
    [key: string]: (...args: unknown[]) => unknown;
};
