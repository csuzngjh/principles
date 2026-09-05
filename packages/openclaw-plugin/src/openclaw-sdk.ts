// OpenClaw Plugin SDK Type Definitions
// Provides type declarations for the OpenClaw plugin system
// This file is tracked in git (renamed from .d.ts to .ts)

export interface TokenUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}

export interface PluginLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface AgentTool {
  name: string;
  description?: string;
  parameters?: unknown;
  result?: unknown;
}

export interface SubagentRunParams {
  agentId: string;
  prompt: string;
  context?: Record<string, unknown>;
}

export interface SubagentRunResult {
  runId: string;
}

export interface SubagentWaitResult {
  status: 'ok' | 'error' | 'timeout';
  error?: string;
}

export interface SubagentGetSessionMessagesResult {
  messages: unknown[];
  assistantTexts?: string[];
}

export interface PluginRuntime {
  state: Record<string, unknown>;
  config?: Record<string, unknown>;
}

export interface PluginCommandContext {
  sessionId: string;
  sessionKey: string;
  agentId?: string;
  workspaceDir?: string;
  config?: Record<string, unknown>;
  args?: string | string[];
  /** Optional logger — the local hook adapter supplies it; PRI-686 command
   *  resolvers use it for workspace divergence warnings. */
  logger?: Partial<PluginLogger>;
  [key: string]: unknown;
}

export interface PluginCommandResult {
  text?: string;
  content?: string;
  [key: string]: unknown;
}

export interface PluginCommandDefinition {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  requireAuth?: boolean;
  handler: (ctx: PluginCommandContext) => PluginCommandResult | Promise<PluginCommandResult>;
}

export interface OpenClawPluginService {
  id: string;
  start?: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
  stop?: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
}

export interface OpenClawPluginApi {
  id: string;
  rootDir?: string;
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  config?: Record<string, unknown>;
  runtime?: {
    agent?: {
      run?: (opts: {
        sessionKey: string;
        message: string;
        lane?: string;
        deliver?: boolean;
        idempotencyKey?: string;
        expectsCompletionMessage?: boolean;
        extraSystemPrompt?: string;
      }) => Promise<SubagentRunResult>;
      resolveAgentWorkspaceDir?: (config: unknown, agentId: string) => string;
      runEmbeddedPiAgent?: (_opts: {
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
      }) => Promise<unknown>;
      session?: {
        resolveStorePath: () => string;
        /** Row-scoped read (replaces deprecated loadSessionStore whole-store reads). */
        getSessionEntry?: (params: {
          sessionKey: string;
          agentId?: string;
          storePath?: string;
        }) => Record<string, unknown> | undefined;
        /** Row-scoped write (replaces deprecated saveSessionStore whole-store writes). */
        patchSessionEntry?: (params: {
          sessionKey: string;
          agentId?: string;
          storePath?: string;
          replaceEntry?: boolean;
          preserveActivity?: boolean;
          update: (
            entry: Record<string, unknown>,
            context: { existingEntry?: Record<string, unknown> },
          ) =>
            | Promise<Partial<Record<string, unknown>> | null>
            | Partial<Record<string, unknown>>
            | null;
        }) => Promise<Record<string, unknown> | null>;
        /** Row-scoped upsert (replaces deprecated saveSessionStore whole-store writes). */
        upsertSessionEntry?: (params: {
          sessionKey: string;
          agentId?: string;
          storePath?: string;
          entry: Record<string, unknown>;
        }) => Promise<void>;
        /** @deprecated Use getSessionEntry for reads. Kept for compat with older OpenClaw hosts. */
        loadSessionStore: (storePath: string, opts?: { skipCache?: boolean }) => Record<string, unknown>;
        /** @deprecated Use patchSessionEntry/upsertSessionEntry for writes. Kept for compat with older OpenClaw hosts. */
        saveSessionStore: (storePath: string, store: Record<string, unknown>) => Promise<void>;
        resolveSessionFilePath: (sessionKey: string) => string;
        config?: unknown;
      };
    };
    subagent?: {
      run: (params: {
        sessionKey: string;
        message: string;
        lane?: string;
        deliver?: boolean;
        idempotencyKey?: string;
        expectsCompletionMessage?: boolean;
        extraSystemPrompt?: string;
      }) => Promise<SubagentRunResult>;
      waitForRun: (params: {
        runId: string;
        timeoutMs?: number;
      }) => Promise<SubagentWaitResult>;
      getSessionMessages: (params: {
        sessionKey: string;
        limit?: number;
      }) => Promise<SubagentGetSessionMessagesResult>;
      deleteSession: (params: {
        sessionKey: string;
        deleteTranscript?: boolean;
      }) => Promise<void>;
    };
    system?: {
      runHeartbeatOnce?: (opts?: { reason?: string }) => Promise<{
        status: 'ran' | 'skipped' | 'failed';
        durationMs?: number;
        reason?: string;
      }>;
    };
  };
  registerCommand: (cmd: PluginCommandDefinition) => void;
  registerService: (service: OpenClawPluginService) => void;
  registerTool: (tool: AgentTool) => void;
  registerHttpRoute: (route: {
    path: string;
    auth?: 'plugin' | 'gateway';
    match?: 'prefix' | 'exact';
    handler: (req: unknown, res: { json: (data: unknown) => void; status: (code: number) => { json: (data: unknown) => void }; text: (content: string, code?: number) => void }) => boolean | Promise<boolean>;
  }) => void;
  on: (
    event: string,
    handler: (...args: any[]) => unknown,
    opts?: { priority?: number; timeoutMs?: number },
  ) => void;
}

export interface PluginHookBeforePromptBuildEvent {
  prompt: string;
  messages: unknown[];
}

export interface PluginHookBeforePromptBuildResult {
  systemPrompt?: string;
  prependContext?: string;
  appendContext?: string;
  prependSystemContext?: string;
  appendSystemContext?: string;
}

export interface PluginHookBeforeToolCallEvent {
  toolName: string;
  /** Host-provided tool call arguments (OpenClaw 2026.7.x sends `params`). */
  params?: Record<string, unknown>;
  /** @deprecated Host sends `params`; kept for older adapter shims. */
  toolArgs?: Record<string, unknown>;
  agentId?: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface PluginHookBeforeToolCallResult {
  /**
   * Host merge contract (OpenClaw 2026.7.x, hook-before-tool-call-result.ts):
   * only `params`, `block`, `blockReason`, `requireApproval` are read from the
   * hook result. New code must use these fields.
   */
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
  /** Shape is host-defined (approval request details). */
  requireApproval?: unknown;
  /** @deprecated Use `params`. Host does not read `toolArgs`. */
  toolArgs?: Record<string, unknown>;
  /** @deprecated Blocking is expressed via `block: true`. Host does not read `skipToolCall`. */
  skipToolCall?: boolean;
  [key: string]: unknown;
}

export interface PluginHookToolContext {
  agentId?: string;
  sessionId?: string;
  workspaceDir?: string;
  logger?: Partial<PluginLogger>;
  [key: string]: unknown;
}

export interface PluginHookAfterToolCallEvent {
  toolName: string;
  toolArgs?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
  agentId?: string;
  sessionId?: string;
  durationMs?: number;
  [key: string]: unknown;
}

export interface PluginHookBeforeResetEvent {
  agentId?: string;
  sessionId?: string;
  messages?: unknown[];
  reason?: string;
  [key: string]: unknown;
}

export interface PluginHookBeforeCompactionEvent {
  agentId?: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface PluginHookAfterCompactionEvent {
  agentId?: string;
  sessionId?: string;
  sessionFile?: string;
  messageCount?: number;
  [key: string]: unknown;
}

export interface PluginHookSubagentEndedEvent {
  targetSessionKey: string;
  outcome: 'ok' | 'error' | 'timeout' | 'escalated' | 'deleted' | 'killed' | 'reset';
  agentId?: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface PluginHookLlmOutputEvent {
  /**
   * @deprecated Host (OpenClaw 2026.7.x) does not send `output`. It fires once
   * per model-loop attempt with `assistantTexts` + `lastAssistant`; read those.
   */
  output?: string;
  agentId?: string;
  sessionId?: string;
  runId?: string;
  provider?: string;
  model?: string;
  usage?: TokenUsage;
  /** Host-provided full assistant texts for this model-loop attempt. */
  assistantTexts?: string[];
  trigger?: string;
  /** Last complete assistant message object (host-defined shape). */
  lastAssistant?: unknown;
  [key: string]: unknown;
}

export interface PluginHookSubagentSpawningEvent {
  agentId: string;
  childSessionKey: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface PluginHookSubagentSpawningResult {
  status: 'ok' | 'error';
  [key: string]: unknown;
}

export interface PluginHookSubagentContext {
  agentId?: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface PluginHookAgentContext {
  runId?: string;
  jobId?: string;
  trace?: unknown;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  modelProviderId?: string;
  modelId?: string;
  messageProvider?: string;
  channel?: string;
  chatId?: string;
  senderId?: string;
  trigger?: string;
  channelId?: string;
  contextTokenBudget?: number;
  contextWindowSource?: 'model' | 'config';
  contextWindowReferenceTokens?: number;
  senderExternalId?: string;
  channelContext?: unknown;
  // PD's local hook adapter supplies a logger in addition to OpenClaw's host context.
  logger?: Partial<PluginLogger>;
}

export interface PluginHookBeforeMessageWriteEvent {
  message: { role?: string; content?: unknown };
  agentId?: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface PluginHookBeforeMessageWriteResult {
  message?: { role?: string; content?: unknown };
  /** Host contract: `block: true` prevents the transcript write entirely. */
  block?: boolean;
  [key: string]: unknown;
}

export interface OpenClawPluginHttpRouteParams {
  path: string;
  auth?: 'plugin' | 'gateway';
  match?: 'prefix' | 'exact';
  handler: (req: unknown, res: {
    json: (data: unknown) => void;
    status: (code: number) => { json: (data: unknown) => void };
    text: (content: string, code?: number) => void;
  }) => boolean | Promise<boolean>;
}

export interface OpenClawPluginServiceContext {
  api?: OpenClawPluginApi;
  workspaceDir?: string;
  logger?: PluginLogger;
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

// Empty export to force TypeScript to treat this as a module (not a script)
export {};
