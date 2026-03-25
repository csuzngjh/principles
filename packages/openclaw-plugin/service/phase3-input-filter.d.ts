export interface Phase3EvolutionInput {
    id?: string | null;
    status?: string | null;
    started_at?: string | null;
    completed_at?: string | null;
}
export interface Phase3TrustInput {
    score?: number | null;
    frozen?: boolean | null;
    lastUpdated?: string | null;
}
export interface Phase3EvolutionSample {
    taskId: string;
    status: 'pending' | 'in_progress' | 'completed';
    startedAt: string | null;
    completedAt: string | null;
}
export interface Phase3RejectedEvolutionSample {
    taskId: string | null;
    status: string | null;
    reasons: string[];
}
export interface Phase3TrustResult {
    eligible: boolean;
    rejectedReasons: string[];
}
export interface Phase3InputFilterResult {
    queueTruthReady: boolean;
    trustInputReady: boolean;
    phase3ShadowEligible: boolean;
    evolution: {
        eligible: Phase3EvolutionSample[];
        rejected: Phase3RejectedEvolutionSample[];
    };
    trust: Phase3TrustResult;
}
export declare function evaluatePhase3Inputs(queue: Phase3EvolutionInput[], trust: Phase3TrustInput): Phase3InputFilterResult;
