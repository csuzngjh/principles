import type {
    SubagentRunResult,
    SubagentWaitResult,
    SubagentGetSessionMessagesResult,
    PluginLogger,
} from '../../openclaw-sdk.js';

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

export class RuntimeDirectDriver implements TransportDriver {
    private readonly subagent: PluginRuntimeSubagent;
    private readonly logger: PluginLogger;
    
    constructor(options: { subagent: PluginRuntimeSubagent; logger: PluginLogger }) {
        this.subagent = options.subagent;
        this.logger = options.logger;
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
            this.logger.error(`[PD:RuntimeDirectDriver] Spawn failed: ${String(error)}`);
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
            this.logger.error(`[PD:RuntimeDirectDriver] Cleanup failed: ${String(error)}`);
            throw error;
        }
    }
}
