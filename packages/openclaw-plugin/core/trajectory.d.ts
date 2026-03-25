export type CorrectionSampleReviewStatus = 'pending' | 'approved' | 'rejected';
export type CorrectionExportMode = 'raw' | 'redacted';
export interface TrajectoryDataStats {
    dbPath: string;
    dbSizeBytes: number;
    assistantTurns: number;
    userTurns: number;
    toolCalls: number;
    painEvents: number;
    pendingSamples: number;
    approvedSamples: number;
    blobBytes: number;
    lastIngestAt: string | null;
}
export interface TrajectoryAssistantTurnInput {
    sessionId: string;
    runId: string;
    provider: string;
    model: string;
    rawText: string;
    sanitizedText: string;
    usageJson: unknown;
    empathySignalJson: unknown;
    createdAt?: string;
}
export interface TrajectoryUserTurnInput {
    sessionId: string;
    turnIndex: number;
    rawText: string;
    correctionDetected: boolean;
    correctionCue?: string | null;
    referencesAssistantTurnId?: number | null;
    createdAt?: string;
}
export interface TrajectoryToolCallInput {
    sessionId: string;
    toolName: string;
    outcome: 'success' | 'failure' | 'blocked';
    durationMs?: number | null;
    exitCode?: number | null;
    errorType?: string | null;
    errorMessage?: string | null;
    gfiBefore?: number | null;
    gfiAfter?: number | null;
    paramsJson?: unknown;
    createdAt?: string;
}
export interface TrajectoryPainEventInput {
    sessionId: string;
    source: string;
    score: number;
    reason?: string | null;
    severity?: string | null;
    origin?: string | null;
    confidence?: number | null;
    createdAt?: string;
}
export interface TrajectoryGateBlockInput {
    sessionId?: string | null;
    toolName: string;
    filePath?: string | null;
    reason: string;
    planStatus?: string | null;
    createdAt?: string;
}
export interface TrajectoryTrustChangeInput {
    sessionId?: string | null;
    previousScore: number;
    newScore: number;
    delta: number;
    reason: string;
    createdAt?: string;
}
export interface TrajectoryPrincipleEventInput {
    principleId?: string | null;
    eventType: string;
    payload: unknown;
    createdAt?: string;
}
export interface TrajectoryTaskOutcomeInput {
    sessionId: string;
    taskId?: string | null;
    outcome: string;
    summary?: string | null;
    principleIdsJson?: unknown;
    createdAt?: string;
}
export interface TrajectorySessionInput {
    sessionId: string;
    startedAt?: string;
}
export interface EvolutionTaskInput {
    taskId: string;
    traceId: string;
    source: string;
    reason?: string | null;
    score?: number;
    status?: string;
    enqueuedAt?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
    resolution?: string | null;
    createdAt?: string;
    updatedAt?: string;
}
export interface EvolutionEventInput {
    traceId: string;
    taskId?: string | null;
    stage: string;
    level?: string;
    message: string;
    summary?: string | null;
    metadata?: unknown;
    createdAt?: string;
}
export interface EvolutionTaskRecord {
    id: number;
    taskId: string;
    traceId: string;
    source: string;
    reason: string | null;
    score: number;
    status: string;
    enqueuedAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
    resolution: string | null;
    createdAt: string;
    updatedAt: string;
}
export interface EvolutionEventRecord {
    id: number;
    traceId: string;
    taskId: string | null;
    stage: string;
    level: string;
    message: string;
    summary: string | null;
    metadata: Record<string, unknown>;
    createdAt: string;
}
export interface EvolutionTaskFilters {
    status?: string;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
    offset?: number;
}
export interface AssistantTurnRecord {
    id: number;
    sessionId: string;
    runId: string;
    provider: string;
    model: string;
    rawText: string;
    sanitizedText: string;
    blobRef: string | null;
    createdAt: string;
}
export interface CorrectionSampleRecord {
    sampleId: string;
    sessionId: string;
    badAssistantTurnId: number;
    userCorrectionTurnId: number;
    recoveryToolSpanJson: string;
    diffExcerpt: string;
    principleIdsJson: string;
    qualityScore: number;
    reviewStatus: CorrectionSampleReviewStatus;
    exportMode: CorrectionExportMode;
    createdAt: string;
    updatedAt: string;
}
export interface TrajectoryExportResult {
    filePath: string;
    count: number;
    mode?: CorrectionExportMode;
}
export interface TrajectoryDatabaseOptions {
    workspaceDir: string;
    blobInlineThresholdBytes?: number;
    busyTimeoutMs?: number;
    orphanBlobGraceDays?: number;
}
export declare class TrajectoryDatabase {
    private readonly workspaceDir;
    private readonly stateDir;
    private readonly dbPath;
    private readonly blobDir;
    private readonly exportDir;
    private readonly blobInlineThresholdBytes;
    private readonly orphanBlobGraceMs;
    private readonly db;
    constructor(opts: TrajectoryDatabaseOptions);
    dispose(): void;
    recordSession(input: TrajectorySessionInput): void;
    recordAssistantTurn(input: TrajectoryAssistantTurnInput): number;
    recordUserTurn(input: TrajectoryUserTurnInput): number;
    recordToolCall(input: TrajectoryToolCallInput): number;
    recordPainEvent(input: TrajectoryPainEventInput): void;
    recordGateBlock(input: TrajectoryGateBlockInput): void;
    recordTrustChange(input: TrajectoryTrustChangeInput): void;
    recordPrincipleEvent(input: TrajectoryPrincipleEventInput): void;
    recordTaskOutcome(input: TrajectoryTaskOutcomeInput): void;
    recordEvolutionTask(input: EvolutionTaskInput): void;
    updateEvolutionTask(taskId: string, updates: Partial<Omit<EvolutionTaskInput, 'taskId' | 'traceId' | 'source'>>): void;
    recordEvolutionEvent(input: EvolutionEventInput): void;
    listEvolutionTasks(filters?: EvolutionTaskFilters): EvolutionTaskRecord[];
    listEvolutionEvents(traceId?: string, filters?: {
        limit?: number;
        offset?: number;
    }): EvolutionEventRecord[];
    getEvolutionTaskByTraceId(traceId: string): EvolutionTaskRecord | null;
    getEvolutionStats(): {
        total: number;
        pending: number;
        inProgress: number;
        completed: number;
        failed: number;
    };
    listAssistantTurns(sessionId: string): AssistantTurnRecord[];
    listCorrectionSamples(status?: CorrectionSampleReviewStatus): CorrectionSampleRecord[];
    reviewCorrectionSample(sampleId: string, status: Exclude<CorrectionSampleReviewStatus, 'pending'>, note?: string): CorrectionSampleRecord;
    exportCorrections(opts: {
        mode: CorrectionExportMode;
        approvedOnly: boolean;
    }): TrajectoryExportResult;
    exportAnalytics(): TrajectoryExportResult;
    getDataStats(): TrajectoryDataStats;
    cleanupBlobStorage(): {
        removedFiles: number;
        reclaimedBytes: number;
    };
    private initSchema;
    private importLegacyArtifacts;
    private migrateSchema;
    private dailyMetrics;
    private importLegacySessions;
    private importLegacyEvents;
    private importLegacyEvolution;
    private markImported;
    private isImported;
    private maybeCreateCorrectionSample;
    private recordExportAudit;
    private storeRawText;
    private restoreRawText;
    private computeBlobBytes;
    private pruneUnreferencedBlobs;
    private withWrite;
}
export declare class TrajectoryRegistry {
    private static instances;
    static get(workspaceDir: string, opts?: Omit<TrajectoryDatabaseOptions, 'workspaceDir'>): TrajectoryDatabase;
    static dispose(workspaceDir: string): void;
    static clear(): void;
    static use<T>(workspaceDir: string, fn: (db: TrajectoryDatabase) => T, opts?: Omit<TrajectoryDatabaseOptions, 'workspaceDir'>): T;
}
