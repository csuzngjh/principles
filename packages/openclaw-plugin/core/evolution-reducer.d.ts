import type { EvolutionLoopEvent, Principle } from './evolution-types.js';
export interface EvolutionReducer {
    emit(event: EvolutionLoopEvent): void;
    emitSync(event: EvolutionLoopEvent): void;
    getEventLog(): EvolutionLoopEvent[];
    getCandidatePrinciples(): Principle[];
    getProbationPrinciples(): Principle[];
    getActivePrinciples(): Principle[];
    getPrincipleById(id: string): Principle | null;
    promote(principleId: string, reason?: string): void;
    deprecate(principleId: string, reason: string): void;
    rollbackPrinciple(principleId: string, reason: string): void;
    recordProbationFeedback(principleId: string, success: boolean): void;
    /**
     * Creates a new principle with generalized trigger/action from diagnostician.
     * Called after diagnostician analysis to create principle directly.
     */
    createPrincipleFromDiagnosis(params: {
        painId: string;
        painType: 'tool_failure' | 'subagent_error' | 'user_frustration';
        triggerPattern: string;
        action: string;
        source: string;
    }): string | null;
    getStats(): {
        candidateCount: number;
        probationCount: number;
        activeCount: number;
        deprecatedCount: number;
        lastPromotedAt: string | null;
    };
}
export declare class EvolutionReducerImpl implements EvolutionReducer {
    private readonly streamPath;
    private readonly lockTargetPath;
    private readonly blacklistPath;
    private readonly workspaceDir;
    private readonly memoryEvents;
    private readonly principles;
    private readonly failureStreak;
    private lastPromotedAt;
    private isReplaying;
    constructor(opts: {
        workspaceDir: string;
    });
    emit(event: EvolutionLoopEvent): void;
    emitSync(event: EvolutionLoopEvent): void;
    getEventLog(): EvolutionLoopEvent[];
    getCandidatePrinciples(): Principle[];
    getProbationPrinciples(): Principle[];
    getActivePrinciples(): Principle[];
    getPrincipleById(id: string): Principle | null;
    promote(principleId: string, reason?: string): void;
    deprecate(principleId: string, reason: string): void;
    rollbackPrinciple(principleId: string, reason: string): void;
    recordProbationFeedback(principleId: string, success: boolean): void;
    /**
     * Creates a new principle with generalized trigger/action from diagnostician.
     * Called after diagnostician analysis to create principle directly (no intermediate overfitted principle).
     * @returns the new principle ID, or null if creation failed
     */
    createPrincipleFromDiagnosis(params: {
        painId: string;
        painType: 'tool_failure' | 'subagent_error' | 'user_frustration';
        triggerPattern: string;
        action: string;
        source: string;
    }): string | null;
    getStats(): {
        candidateCount: number;
        probationCount: number;
        activeCount: number;
        deprecatedCount: number;
        lastPromotedAt: string | null;
    };
    private ensureDirs;
    private loadFromStream;
    private applyEvent;
    private onCandidateCreated;
    private onPrinciplePromoted;
    private onPrincipleDeprecated;
    private onPrincipleRolledBack;
    private onPainDetected;
    private updateFailureStreakFromPain;
    private nextPrincipleId;
    private getByStatus;
    private sweepExpiredProbation;
    private persistBlacklist;
    private loadBlacklist;
    private isBlacklisted;
}
export declare function stableContentHash(input: string): string;
