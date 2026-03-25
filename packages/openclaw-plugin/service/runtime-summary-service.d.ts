export type RuntimeDataQuality = 'authoritative' | 'partial';
export type RuntimeRewardPolicy = 'frozen_all_positive' | 'frozen_atomic_positive_keep_plan_ready';
interface RuntimeSummarySource {
    source: string;
    score?: number;
    ts?: string;
    confidence?: number;
    origin?: string;
}
interface RuntimePainSignal {
    source: string;
    ts: string | null;
    reason: string | null;
}
export interface RuntimeSummary {
    gfi: {
        current: number | null;
        peak: number | null;
        sources: RuntimeSummarySource[];
        dataQuality: RuntimeDataQuality;
    };
    legacyTrust: {
        score: number | null;
        stage: 1 | 2 | 3 | 4 | null;
        frozen: true;
        lastUpdated: string | null;
        rewardPolicy: RuntimeRewardPolicy;
    };
    evolution: {
        queue: {
            pending: number;
            inProgress: number;
            completed: number;
        };
        directive: {
            exists: boolean;
            active: boolean | null;
            ageSeconds: number | null;
            taskPreview: string | null;
        };
        dataQuality: RuntimeDataQuality;
    };
    phase3: {
        queueTruthReady: boolean;
        trustInputReady: boolean;
        phase3ShadowEligible: boolean;
        evolutionEligible: number;
        evolutionRejected: number;
        evolutionRejectedReasons: string[];
        trustRejectedReasons: string[];
    };
    pain: {
        activeFlag: boolean;
        activeFlagSource: string | null;
        candidates: number | null;
        lastSignal: RuntimePainSignal | null;
    };
    gate: {
        recentBlocks: number | null;
        recentBypasses: number | null;
        dataQuality: RuntimeDataQuality;
    };
    metadata: {
        generatedAt: string;
        workspaceDir: string;
        sessionId: string | null;
        selectedSessionReason: 'explicit' | 'latest_active' | 'none';
        warnings: string[];
    };
}
export declare class RuntimeSummaryService {
    static getSummary(workspaceDir: string, options?: {
        sessionId?: string | null;
    }): RuntimeSummary;
    private static readSessions;
    private static selectSession;
    private static mergeSessionSnapshots;
    private static buildQueueStats;
    private static buildDirectiveSummary;
    private static readLegacyTrust;
    private static readEvents;
    private static buildGfiSources;
    private static findLastPainSignal;
    private static buildGateStats;
    private static resolveSessionSortTime;
    private static mergeEvents;
    private static getEventDedupKey;
    private static resolveEvolutionDataQuality;
    private static selectInProgressTask;
    private static getQueuePriority;
    private static isResolvableEvolutionTask;
    private static resolveDirectiveTimestamp;
    private static buildDirectiveTaskPreview;
    private static warnOnLegacyDirectiveMismatch;
    private static readJsonFile;
    private static asFiniteNumber;
}
export {};
