import type { PluginLogger } from '../openclaw-sdk.js';
export interface EmpathyObserverApi {
    config?: {
        empathy_engine?: {
            enabled?: boolean;
        };
    };
    runtime: {
        subagent: {
            run: (params: {
                sessionKey: string;
                message: string;
                lane?: string;
                deliver?: boolean;
                idempotencyKey?: string;
            }) => Promise<unknown>;
            getSessionMessages: (params: {
                sessionKey: string;
                limit?: number;
            }) => Promise<{
                messages: unknown[];
                assistantTexts?: string[];
            }>;
        };
    };
    logger: PluginLogger;
}
export declare class EmpathyObserverManager {
    private static instance;
    private sessionLocks;
    private constructor();
    static getInstance(): EmpathyObserverManager;
    /**
     * Probe whether the subagent runtime is actually functional.
     * api.runtime.subagent always exists (it's a Proxy), but in embedded mode
     * every method throws "only available during a gateway request".
     * We cache the result to avoid repeated probing.
     */
    private subagentAvailableCache;
    private isSubagentAvailable;
    shouldTrigger(api: EmpathyObserverApi | null | undefined, sessionId: string): boolean;
    spawn(api: EmpathyObserverApi | null | undefined, sessionId: string, userMessage: string): Promise<string | null>;
    reap(api: EmpathyObserverApi | null | undefined, targetSessionKey: string, workspaceDir: string): Promise<void>;
    private isObserverSession;
    private extractParentSessionId;
    private parseJsonPayload;
    private extractAssistantText;
    private scoreFromSeverity;
    private normalizeSeverity;
    private normalizeConfidence;
}
export declare const empathyObserverManager: EmpathyObserverManager;
