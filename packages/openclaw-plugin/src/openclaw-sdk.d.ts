/**
 * OpenClaw Plugin SDK type shims (Aligned with v2026.4.4)
 *
 * These types are based directly on the OpenClaw core source code to ensure
 * absolute compatibility during development and deployment.
 *
 * Source: https://github.com/openclaw/openclaw (v2026.4.4)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TSchema, Static } from '@sinclair/typebox';

// ── Logger Types ──────────────────────────────────────────────────────

/**
 * Logger passed into plugin registration, services, and CLI surfaces.
 * Note: Does NOT support meta parameter - use runtime.logging.getChildLogger() for structured logging.
 */
export interface PluginLogger {
    debug?: (message: string) => void;
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
}

/**
 * Structured logger surface with meta parameter support.
 * Obtain via runtime.logging.getChildLogger(bindings).
 */
export interface RuntimeLogger {
    debug?: (message: string, meta?: Record<string, unknown>) => void;
    info: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
    error: (message: string, meta?: Record<string, unknown>) => void;
}

// ── Agent Tool Types (Strict Signature Enforcement) ───────────────────

/**
 * Standard tool result format returned to OpenClaw.
 */
export interface AgentToolResult<T = unknown> {
    content: Array<{
        type: string;
        text?: string;
        data?: string;
        mimeType?: string;
    }>;
    meta?: T;
}

export type AgentToolUpdateCallback<T = unknown> = (update: AgentToolResult<T>) => void;

/**
 * Strict tool definition interface.
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

export type AgentToolFactory = (api: OpenClawPluginApi) => AgentTool;

// ── Subagent Runtime Types ────────────────────────────────────────────

export interface SubagentRunParams {
    sessionKey: string;
    message: string;
    /** Optional provider override for this subagent run */
    provider?: string;
    /** Optional model override for this subagent run */
    model?: string;
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
}

export interface SubagentDeleteSessionParams {
    sessionKey: string;
    deleteTranscript?: boolean;
}

// ── Plugin Runtime ────────────────────────────────────────────────────

export interface PluginRuntimeSystem {
    enqueueSystemEvent: (event: unknown) => void;
    requestHeartbeatNow: () => void;
    runHeartbeatOnce: (opts?: {
        reason?: string;
        agentId?: string;
        sessionKey?: string;
        heartbeat?: { target?: string };
    }) => Promise<{ ok: boolean; status: string; durationMs?: number; reason?: string }>;
    runCommandWithTimeout: (cmd: string, args: string[], timeout: number) => Promise<unknown>;
    formatNativeDependencyHint: (deps: unknown[]) => string;
}

export interface PluginRuntimeLogging {
    shouldLogVerbose: () => boolean;
    getChildLogger: (bindings?: Record<string, unknown>, opts?: { level?: string }) => RuntimeLogger;
}

export interface PluginRuntimeConfig {
    loadConfig: () => unknown;
    writeConfigFile: (cfg: unknown) => Promise<void>;
}

export interface PluginRuntimeState {
    resolveStateDir: (env?: unknown, homedir?: string) => string;
}

/**
 * Agent-level runtime helpers for workspace and identity resolution.
 * Mirrors OpenClaw's PluginRuntimeCore.agent namespace.
 */
export interface PluginRuntimeAgent {
    defaults: {
        model: string;
        provider: string;
    };
    resolveAgentDir: (config: unknown, agentId: string) => string;
    resolveAgentWorkspaceDir: (config: unknown, agentId: string) => string;
    resolveAgentIdentity: (config: unknown, agentId: string) => { name?: string; avatar?: string };
    resolveThinkingDefault: (config: unknown) => { provider: string; model: string };
    resolveAgentTimeoutMs: (config: unknown, agentId: string) => number | undefined;
    ensureAgentWorkspace: (config: unknown, agentId: string) => string;
    session: {
        resolveStorePath: () => string;
        loadSessionStore: (storePath: string, opts?: { skipCache?: boolean }) => Record<string, unknown>;
        saveSessionStore: (storePath: string, store: Record<string, unknown>) => Promise<void>;
        resolveSessionFilePath: (sessionKey: string) => string;
    };
    /**
     * Run an embedded PI agent without requiring gateway request scope.
     * This method works in background contexts (services, cron, hooks).
     * @param sessionId - Unique session identifier
     * @param sessionFile - Path to a session file for storing conversation state
     * @param prompt - The user message to send
     * @param extraSystemPrompt - Optional system prompt to append
     * @param config - OpenClaw config object for provider/model resolution
     * @param provider - LLM provider (e.g., "minimax-portal", "openai"). Falls back to "openai" if not specified.
     * @param model - Model name without provider prefix (e.g., "MiniMax-M2.7"). Falls back to "gpt-5.4" if not specified.
     * @param timeoutMs - Timeout in milliseconds (required)
     * @param runId - Unique run identifier
     * @param disableTools - If true, the agent will not use any tools (pure LLM reasoning)
     * @returns Promise with payloads array containing the response
     */
    runEmbeddedPiAgent: (opts: {
        sessionId: string;
        sessionFile: string;
        prompt: string;
        extraSystemPrompt?: string;
        config?: unknown;
        provider?: string;
        model?: string;
        timeoutMs: number;
        runId: string;
        disableTools?: boolean;
    }) => Promise<{
        payloads?: Array<{ isError?: boolean; text?: string }>;
    }>;
}

/**
 * Event subscription helpers for agent and transcript events.
 */
export interface PluginRuntimeEvents {
    onAgentEvent: (
        agentId: string,
        handler: (event: { type: string; data: unknown }) => void | Promise<void>,
    ) => () => void;
    onSessionTranscriptUpdate: (
        sessionKey: string,
        handler: (update: { messages: unknown[] }) => void | Promise<void>,
    ) => () => void;
}

/**
 * Task Flow orchestration API.
 */
export interface PluginRuntimeTasks {
    runs: {
        list: (opts?: { sessionKey?: string; limit?: number }) => Promise<unknown[]>;
        get: (runId: string) => Promise<unknown | null>;
    };
    flows: {
        list: (opts?: { sessionKey?: string }) => Promise<unknown[]>;
        get: (flowId: string) => Promise<unknown | null>;
        create: (params: unknown) => Promise<{ flowId: string }>;
    };
}

/**
 * Model authentication helpers.
 */
export interface PluginRuntimeModelAuth {
    getApiKeyForModel: (model: string) => { key?: string; provider?: string } | null;
    resolveApiKeyForProvider: (provider: string) => { key?: string } | null;
}

export interface PluginRuntime {
    version: string;
    subagent: {
        run: (params: SubagentRunParams) => Promise<SubagentRunResult>;
        waitForRun: (params: SubagentWaitParams) => Promise<SubagentWaitResult>;
        getSessionMessages: (params: SubagentGetSessionMessagesParams) => Promise<SubagentGetSessionMessagesResult>;
        /** @deprecated Use getSessionMessages. */
        getSession: (params: SubagentGetSessionMessagesParams) => Promise<SubagentGetSessionMessagesResult>;
        deleteSession: (params: SubagentDeleteSessionParams) => Promise<void>;
    };
    system: PluginRuntimeSystem;
    logging: PluginRuntimeLogging;
    state: PluginRuntimeState;
    config: PluginRuntimeConfig;
    /** Agent-level workspace and identity resolution. */
    agent: PluginRuntimeAgent;
    /** Event subscriptions for agent and transcript events. */
    events: PluginRuntimeEvents;
    /** Task Flow orchestration. */
    tasks: PluginRuntimeTasks;
    /** Model authentication helpers. */
    modelAuth: PluginRuntimeModelAuth;
    /** Channel-specific runtime helpers (opaque for now). */
    channel?: unknown;
}

// ── Plugin API ─────────────────────────────────────────────────────────

export type PluginRegistrationMode = 'full' | 'hooks-only';

export interface OpenClawPluginApi {
    id: string;
    name: string;
    version?: string;
    description?: string;
    source: string;
    rootDir?: string;
    registrationMode: PluginRegistrationMode;
    config: Record<string, unknown>;
    pluginConfig?: Record<string, unknown>;
    runtime: PluginRuntime;
    logger: PluginLogger;
    registerTool: (tool: AgentTool | AgentToolFactory, opts?: { name?: string; names?: string[]; optional?: boolean }) => void;
    registerHook: (events: string | string[], handler: unknown, opts?: { entry?: string; name?: string; description?: string; register?: boolean }) => void;
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

// ── Command Types ──────────────────────────────────────────────────────

export interface PluginCommandDefinition {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    handler: (ctx: PluginCommandContext) => PluginCommandResult | Promise<PluginCommandResult>;
}

export interface PluginCommandContext {
    senderId?: string;
    channel: string;
    channelId?: string;
    sessionId?: string;
    isAuthorizedSender: boolean;
    args?: string;
    commandBody: string;
    config: Record<string, unknown>;
    workspaceDir?: string;
    from?: string;
    to?: string;
    accountId?: string;
    messageThreadId?: number;
}

export interface PluginCommandResult {
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    replyToId?: string;
    isError?: boolean;
    channelData?: Record<string, unknown>;
}

// ── Service Types ──────────────────────────────────────────────────────

export interface OpenClawPluginServiceContext {
    config: Record<string, unknown>;
    workspaceDir?: string;
    stateDir: string;
    logger: PluginLogger;
}

export interface OpenClawPluginService {
    id: string;
    start: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
    stop?: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
}

// ── HTTP Route Types ───────────────────────────────────────────────────

export type OpenClawPluginHttpRouteAuth = 'gateway' | 'plugin';
export type OpenClawPluginHttpRouteMatch = 'exact' | 'prefix';

export type OpenClawPluginHttpRouteHandler = (
    req: IncomingMessage,
    res: ServerResponse,
) => Promise<boolean | void> | boolean | void;

export interface OpenClawPluginHttpRouteParams {
    path: string;
    handler: OpenClawPluginHttpRouteHandler;
    auth: OpenClawPluginHttpRouteAuth;
    match?: OpenClawPluginHttpRouteMatch;
    replaceExisting?: boolean;
}

// ── Hook Names ─────────────────────────────────────────────────────────

export type PluginHookName =
    | 'before_model_resolve'
    | 'before_prompt_build'
    | 'before_agent_start'
    | 'before_agent_reply'
    | 'llm_input'
    | 'llm_output'
    | 'agent_end'
    | 'before_compaction'
    | 'after_compaction'
    | 'before_reset'
    | 'inbound_claim'
    | 'message_received'
    | 'message_sending'
    | 'message_sent'
    | 'before_tool_call'
    | 'after_tool_call'
    | 'tool_result_persist'
    | 'before_message_write'
    | 'session_start'
    | 'session_end'
    | 'subagent_spawning'
    | 'subagent_delivery_target'
    | 'subagent_spawned'
    | 'subagent_ended'
    | 'gateway_start'
    | 'gateway_stop'
    | 'before_dispatch'
    | 'before_install';

// ── Hook Contexts ──────────────────────────────────────────────────────

export interface PluginHookAgentContext {
    runId?: string;
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    workspaceDir?: string;
    stateDir?: string;
    modelProviderId?: string;
    modelId?: string;
    messageProvider?: string;
    trigger?: string;
    channelId?: string;
    logger?: PluginLogger;
}

export interface PluginHookToolContext {
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    workspaceDir?: string;
    runId?: string;
    toolName: string;
    toolCallId?: string;
}

export interface PluginHookSubagentContext {
    runId?: string;
    childSessionKey?: string;
    requesterSessionKey?: string;
}

export interface PluginHookSessionContext {
    agentId?: string;
    sessionId: string;
    sessionKey?: string;
}

// ── Hook Events ────────────────────────────────────────────────────────

export interface PluginHookBeforePromptBuildEvent {
    prompt: string;
    messages: unknown[];
}

export interface PluginHookBeforePromptBuildResult {
    systemPrompt?: string;
    prependContext?: string;
    prependSystemContext?: string;
    appendSystemContext?: string;
}

export interface PluginHookBeforeToolCallEvent {
    toolName: string;
    params: Record<string, any>;
    runId?: string;
    toolCallId?: string;
}

/**
 * Possible outcomes of a tool call approval request.
 * Mirrors OpenClaw's PluginApprovalResolutions constant.
 */
export type PluginApprovalResolution =
    | 'allow-once'
    | 'allow-always'
    | 'deny'
    | 'timeout'
    | 'cancelled';

export interface PluginHookBeforeToolCallResult {
    params?: Record<string, any>;
    block?: boolean;
    blockReason?: string;
    /**
     * Request human-in-the-loop approval for the tool call.
     * OpenClaw will pause execution and prompt the user.
     * The hook runner auto-sets `pluginId` — plugins should not set it.
     */
    requireApproval?: {
        title: string;
        description: string;
        severity?: 'info' | 'warning' | 'critical';
        timeoutMs?: number;
        timeoutBehavior?: 'allow' | 'deny';
        /**
         * Best-effort callback invoked with the final outcome after approval
         * resolves, times out, or is cancelled. OpenClaw does not await this
         * callback before allowing or denying the tool call.
         */
        onResolution?: (decision: PluginApprovalResolution) => void | Promise<void>;
    };
}

export interface PluginHookAfterToolCallEvent {
    toolName: string;
    params: Record<string, any>;
    runId?: string;
    toolCallId?: string;
    result?: unknown;
    error?: string;
    durationMs?: number;
}

export interface PluginHookLlmOutputEvent {
    runId: string;
    sessionId: string;
    provider: string;
    model: string;
    assistantTexts: string[];
    lastAssistant?: unknown;
    usage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        total?: number;
    };
}

export interface PluginHookBeforeMessageWriteEvent {
    message: any;
    sessionKey?: string;
    agentId?: string;
}

export interface PluginHookBeforeMessageWriteResult {
    block?: boolean;
    message?: any;
}

export interface PluginHookSubagentEndedEvent {
    targetSessionKey: string;
    targetKind: 'subagent' | 'acp';
    reason: string;
    sendFarewell?: boolean;
    accountId?: string;
    runId?: string;
    endedAt?: number;
    outcome?: 'ok' | 'error' | 'timeout' | 'killed' | 'reset' | 'deleted';
    error?: string;
}

export interface PluginHookBeforeResetEvent {
    sessionFile?: string;
    messages?: unknown[];
    reason?: string;
}

export interface PluginHookBeforeCompactionEvent {
    messageCount: number;
    compactingCount?: number;
    tokenCount?: number;
    messages?: unknown[];
    sessionFile?: string;
}

export interface PluginHookAfterCompactionEvent {
    messageCount: number;
    tokenCount?: number;
    compactedCount: number;
    sessionFile?: string;
}

export interface PluginHookSubagentSpawningEvent {
    childSessionKey: string;
    agentId: string;
    label?: string;
    mode: 'run' | 'session';
    requester?: { channel?: string; accountId?: string; to?: string; threadId?: string | number };
    threadRequested: boolean;
}

export interface PluginHookSubagentSpawningResult {
    status: 'ok' | 'error';
    threadBindingReady?: boolean;
    error?: string;
}

export interface PluginHookSubagentDeliveryTargetEvent {
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
}

export interface PluginHookSubagentDeliveryTargetResult {
    origin?: {
        channel?: string;
        accountId?: string;
        to?: string;
        threadId?: string | number;
    };
}

export interface PluginHookSubagentSpawnedEvent {
    childSessionKey: string;
    agentId: string;
    label?: string;
    mode: 'run' | 'session';
    requester?: { channel?: string; accountId?: string; to?: string; threadId?: string | number };
    threadRequested: boolean;
    runId: string;
}

// ── Handler Map ────────────────────────────────────────────────────────

export interface PluginHookHandlerMap {
    before_prompt_build: (event: PluginHookBeforePromptBuildEvent, ctx: PluginHookAgentContext) => PluginHookBeforePromptBuildResult | void | Promise<PluginHookBeforePromptBuildResult | void>;
    before_tool_call: (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext) => PluginHookBeforeToolCallResult | void | Promise<PluginHookBeforeToolCallResult | void>;
    after_tool_call: (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => void | Promise<void>;
    llm_output: (event: PluginHookLlmOutputEvent, ctx: PluginHookAgentContext) => void | Promise<void>;
    subagent_ended: (event: PluginHookSubagentEndedEvent, ctx: PluginHookSubagentContext) => void | Promise<void>;
    subagent_spawning: (event: PluginHookSubagentSpawningEvent, ctx: PluginHookSubagentContext) => PluginHookSubagentSpawningResult | void | Promise<PluginHookSubagentSpawningResult | void>;
    subagent_delivery_target: (event: PluginHookSubagentDeliveryTargetEvent, ctx: PluginHookSubagentContext) => PluginHookSubagentDeliveryTargetResult | void | Promise<PluginHookSubagentDeliveryTargetResult | void>;
    subagent_spawned: (event: PluginHookSubagentSpawnedEvent, ctx: PluginHookSubagentContext) => void | Promise<void>;
    before_reset: (event: PluginHookBeforeResetEvent, ctx: PluginHookAgentContext) => void | Promise<void>;
    before_compaction: (event: PluginHookBeforeCompactionEvent, ctx: PluginHookAgentContext) => void | Promise<void>;
    after_compaction: (event: PluginHookAfterCompactionEvent, ctx: PluginHookAgentContext) => void | Promise<void>;
    before_message_write: (event: PluginHookBeforeMessageWriteEvent, ctx: PluginHookSessionContext) => PluginHookBeforeMessageWriteResult | void | Promise<PluginHookBeforeMessageWriteResult | void>;
    [key: string]: (...args: unknown[]) => unknown;
}