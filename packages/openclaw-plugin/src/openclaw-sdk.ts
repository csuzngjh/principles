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
        loadSessionStore: (storePath: string, opts?: { skipCache?: boolean }) => Record<string, unknown>;
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
  on: (event: string, handler: (...args: any[]) => unknown) => void;
}

export interface PluginHookBeforePromptBuildEvent {
  agentId?: string;
  sessionId?: string;
  prompt: string;
  messages?: unknown[];
  [key: string]: unknown;
}

export interface PluginHookBeforePromptBuildResult {
  prompt?: string;
  messages?: unknown[];
  [key: string]: unknown;
}

export interface PluginHookBeforeToolCallEvent {
  toolName: string;
  params?: Record<string, unknown>;
  toolArgs?: Record<string, unknown>;
  agentId?: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface PluginHookBeforeToolCallResult {
  toolArgs?: Record<string, unknown>;
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
  output: string;
  agentId?: string;
  sessionId?: string;
  runId?: string;
  provider?: string;
  model?: string;
  usage?: TokenUsage;
  assistantTexts?: string[];
  trigger?: string;
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
  agentId?: string;
  sessionId?: string;
  workspaceDir?: string;
  logger?: Partial<PluginLogger>;
  [key: string]: unknown;
}

export interface PluginHookBeforeMessageWriteEvent {
  message: { role?: string; content?: unknown };
  agentId?: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface PluginHookBeforeMessageWriteResult {
  message?: { role?: string; content?: unknown };
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
