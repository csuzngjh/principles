import * as fs from 'fs';
import type {
    SubagentRunResult,
    SubagentWaitResult,
    SubagentGetSessionMessagesResult,
    PluginLogger,
} from '../../openclaw-sdk.js';
import { isExpectedSubagentError } from './subagent-error-utils.js';

export interface TransportDriver {
    run(params: RunParams): Promise<RunResult>;
    wait(params: WaitParams): Promise<WaitResult>;
    getResult(params: GetResultParams): Promise<GetResultResult>;
    cleanup(params: CleanupParams): Promise<void>;
}

export interface RunParams {
    sessionKey: string;
    message: string;
    lane?: string;
    deliver?: boolean;
    idempotencyKey?: string;
    expectsCompletionMessage?: boolean;
    extraSystemPrompt?: string;
}

export interface RunResult {
    runId: string;
}

export interface WaitParams {
    runId: string;
    timeoutMs?: number;
}

export interface WaitResult {
    status: 'ok' | 'error' | 'timeout';
    error?: string;
}

export interface GetResultParams {
    sessionKey: string;
    limit?: number;
}

export interface GetResultResult {
    messages: unknown[];
    assistantTexts?: string[];
}

export interface CleanupParams {
    sessionKey: string;
    deleteTranscript?: boolean;
}

type PluginRuntimeSubagent = {
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

/**
 * OpenClaw plugin SDK's agent.session namespace — always available (not gateway-scoped).
 * These functions are imported directly from OpenClaw's session store module.
 */
export type AgentSessionAPI = {
    resolveStorePath: () => string;
    loadSessionStore: (storePath: string, opts?: { skipCache?: boolean }) => Record<string, unknown>;
    saveSessionStore: (storePath: string, store: Record<string, unknown>) => Promise<void>;
    resolveSessionFilePath: (sessionKey: string) => string;
    /** Optional: OpenClaw config object needed for session path resolution */
    config?: unknown;
};

export class RuntimeDirectDriver implements TransportDriver {
    private readonly subagent: PluginRuntimeSubagent;
    private readonly logger: PluginLogger;
    /** Agent-level session store API — works outside gateway request context (#188) */
    private readonly agentSession: AgentSessionAPI | undefined;

    constructor(options: {
        subagent: PluginRuntimeSubagent;
        logger: PluginLogger;
        /** Pass api.runtime.agent.session to enable heartbeat-safe cleanup (#188) */
        agentSession?: AgentSessionAPI;
    }) {
        this.subagent = options.subagent;
        this.logger = options.logger;
        this.agentSession = options.agentSession;
    }

    /** Expose subagent for availability checking (used by workflow manager for surface degrade) */
    getSubagent(): PluginRuntimeSubagent {
        return this.subagent;
    }

    async run(params: RunParams): Promise<RunResult> {
        // DEFENSIVE: Gateway AgentParamsSchema requires idempotencyKey as NonEmptyString (required).
        // server-plugins.ts uses conditional spread: ...(v && { v }), so falsy = omitted = validation failure.
        // Always guarantee a non-empty value even if caller forgets.
        const idempotencyKey = params.idempotencyKey || `pd:${params.sessionKey}:${Date.now()}`;

        this.logger.info(`[PD:RuntimeDirectDriver] Spawning subagent: sessionKey=${params.sessionKey}, idemKey=${idempotencyKey.substring(0, 40)}`);

        try {
            const result = await this.subagent.run({
                sessionKey: params.sessionKey,
                message: params.message,
                lane: params.lane ?? 'subagent',
                deliver: params.deliver ?? false,
                idempotencyKey,
                expectsCompletionMessage: params.expectsCompletionMessage ?? true,
                extraSystemPrompt: params.extraSystemPrompt,
            });

            this.logger.info(`[PD:RuntimeDirectDriver] Spawn succeeded: runId=${result.runId}`);
            return { runId: result.runId };
        } catch (error) {
            // Suppress expected errors during cron jobs, boot sessions, or isolated sessions.
            // These are not real failures — subagent runtime is only available in gateway requests.
            if (!isExpectedSubagentError(error)) {
                this.logger.error(`[PD:RuntimeDirectDriver] Spawn failed: ${String(error)}`);
            }
            throw error;
        }
    }

    async wait(params: WaitParams): Promise<WaitResult> {
        this.logger.info(`[PD:RuntimeDirectDriver] Waiting for run: runId=${params.runId}, timeout=${params.timeoutMs}ms`);

        try {
            const result = await this.subagent.waitForRun({
                runId: params.runId,
                timeoutMs: params.timeoutMs,
            });

            this.logger.info(`[PD:RuntimeDirectDriver] Wait completed: status=${result.status}`);
            return result;
        } catch (error) {
            this.logger.error(`[PD:RuntimeDirectDriver] Wait failed: ${String(error)}`);
            throw error;
        }
    }

    async getResult(params: GetResultParams): Promise<GetResultResult> {
        this.logger.info(`[PD:RuntimeDirectDriver] Getting messages: sessionKey=${params.sessionKey}`);

        try {
            const result = await this.subagent.getSessionMessages({
                sessionKey: params.sessionKey,
                limit: params.limit ?? 20,
            });

            return result;
        } catch (error) {
            this.logger.error(`[PD:RuntimeDirectDriver] GetResult failed: ${String(error)}`);
            throw error;
        }
    }

    async cleanup(params: CleanupParams): Promise<void> {
        this.logger.info(`[PD:RuntimeDirectDriver] Cleaning up session: sessionKey=${params.sessionKey}`);

        try {
            await this.subagent.deleteSession({
                sessionKey: params.sessionKey,
                deleteTranscript: params.deleteTranscript,
            });
            this.logger.info(`[PD:RuntimeDirectDriver] Cleanup succeeded`);
        } catch (error) {
            const errMsg = String(error);
            // #188/#219: runtime.subagent.deleteSession() only works during gateway requests.
            // Fall back to agent.session API which is always available (not gateway-scoped).
            // Handle multiple error patterns that indicate non-gateway context:
            // - 'gateway request' - Not in a gateway request scope
            // - 'missing scope' - Missing required scope (e.g., operator.admin)
            const isNonGatewayContext =
                errMsg.includes('gateway request') ||
                errMsg.includes('missing scope');

            if (isNonGatewayContext && this.agentSession) {
                this.logger.info(`[PD:RuntimeDirectDriver] Gateway-scoped cleanup unavailable (${errMsg.split(':')[0]}), falling back to agent.session`);
                await this.cleanupViaAgentSession(params.sessionKey);
                this.logger.info(`[PD:RuntimeDirectDriver] Fallback cleanup succeeded`);
            } else {
                this.logger.error(`[PD:RuntimeDirectDriver] Cleanup failed: ${errMsg}`);
                throw error;
            }
        }
    }

    /**
     * Heartbeat-safe session cleanup by directly manipulating the session store file.
     * This bypasses the gateway request scope requirement entirely.
     * Also removes transcript files from disk to avoid orphaned files.
     */
    private async cleanupViaAgentSession(sessionKey: string): Promise<void> {
        if (!this.agentSession) {
            throw new Error('agentSession not available for fallback cleanup');
        }

        const { resolveStorePath, loadSessionStore, saveSessionStore, resolveSessionFilePath } = this.agentSession;

        // Get the session store file path
        const storePath = resolveStorePath();

        if (!fs.existsSync(storePath)) {
            return; // No store file, nothing to clean up
        }

        // Read the store
        const store = loadSessionStore(storePath, { skipCache: true });
        if (!store || typeof store !== 'object') {
            return;
        }

        // Normalize session key matches OpenClaw's internal lowercase normalization
        const normalizedKey = sessionKey.toLowerCase();

        if (normalizedKey in store) {
            const entry = store[normalizedKey] as { sessionId?: string; sessionFile?: string } | undefined;

            // Archive or delete transcript files before removing store entry
            if (entry?.sessionFile) {
                try {
                    const transcriptPath = resolveSessionFilePath(normalizedKey);
                    if (fs.existsSync(transcriptPath)) {
                        fs.unlinkSync(transcriptPath);
                        this.logger.info(`[PD:RuntimeDirectDriver] Removed transcript file: ${transcriptPath}`);
                    }
                } catch (unlinkErr) {
                    this.logger.warn(`[PD:RuntimeDirectDriver] Failed to remove transcript file: ${String(unlinkErr)}`);
                }
            }

            delete store[normalizedKey];
            await saveSessionStore(storePath, store);
        }
    }
}
