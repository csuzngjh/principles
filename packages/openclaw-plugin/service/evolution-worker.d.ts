import type { OpenClawPluginServiceContext, OpenClawPluginApi } from '../openclaw-sdk.js';
import { WorkspaceContext } from '../core/workspace-context.js';
export interface EvolutionQueueItem {
    id: string;
    task?: string;
    score: number;
    source: string;
    reason: string;
    timestamp: string;
    enqueued_at?: string;
    started_at?: string;
    completed_at?: string;
    assigned_session_key?: string;
    trigger_text_preview?: string;
    status: 'pending' | 'in_progress' | 'completed';
    resolution?: 'marker_detected' | 'auto_completed_timeout';
    session_id?: string;
    agent_id?: string;
    traceId?: string;
}
export declare const EVOLUTION_QUEUE_LOCK_SUFFIX = ".lock";
export declare const PAIN_CANDIDATES_LOCK_SUFFIX = ".candidates.lock";
export declare const LOCK_MAX_RETRIES = 50;
export declare const LOCK_RETRY_DELAY_MS = 50;
export declare const LOCK_STALE_MS = 30000;
export declare function createEvolutionTaskId(source: string, score: number, preview: string, reason: string, now: number): string;
export declare function shouldTrackPainCandidate(text: string): boolean;
export declare function createPainCandidateFingerprint(text: string): string;
export declare function summarizePainCandidateSample(text: string): string;
export declare function acquireQueueLock(resourcePath: string, logger: any, lockSuffix?: string): Promise<() => void>;
export declare function extractEvolutionTaskId(task: string): string | null;
export declare function hasRecentDuplicateTask(queue: EvolutionQueueItem[], source: string, preview: string, now: number, reason?: string): boolean;
export declare function hasEquivalentPromotedRule(dictionary: {
    getAllRules(): Record<string, {
        type: string;
        phrases?: string[];
        pattern?: string;
        status: string;
    }>;
}, phrase: string): boolean;
export declare function trackPainCandidate(text: string, wctx: WorkspaceContext): Promise<void>;
export declare function processPromotion(wctx: WorkspaceContext, logger: any, eventLog: any): Promise<void>;
export declare function registerEvolutionTaskSession(workspaceResolve: (key: string) => string, taskId: string, sessionKey: string, logger?: {
    warn?: (message: string) => void;
    info?: (message: string) => void;
}): Promise<boolean>;
export interface ExtendedEvolutionWorkerService {
    id: string;
    api: OpenClawPluginApi | null;
    start: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
    stop?: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
}
export declare const EvolutionWorkerService: ExtendedEvolutionWorkerService;
