export interface ThinkingModelEventInput {
    sessionId: string;
    runId: string;
    assistantTurnId: number;
    modelId: string;
    matchedPattern: string;
    scenarioJson: unknown;
    toolContextJson: unknown;
    painContextJson: unknown;
    principleContextJson: unknown;
    triggerExcerpt: string;
    createdAt: string;
}
export interface ControlUiDatabaseOptions {
    workspaceDir: string;
    busyTimeoutMs?: number;
}
export interface RecentThinkingContext {
    toolCalls: Array<{
        id: number;
        toolName: string;
        outcome: 'success' | 'failure' | 'blocked';
        errorType: string | null;
        errorMessage: string | null;
        createdAt: string;
    }>;
    painEvents: Array<{
        id: number;
        source: string;
        score: number;
        reason: string | null;
        createdAt: string;
    }>;
    gateBlocks: Array<{
        id: number;
        toolName: string;
        reason: string;
        filePath: string | null;
        createdAt: string;
    }>;
    userCorrections: Array<{
        id: number;
        correctionCue: string | null;
        rawExcerpt: string | null;
        createdAt: string;
    }>;
    principleEvents: Array<{
        id: number;
        principleId: string | null;
        eventType: string;
        createdAt: string;
    }>;
}
export declare class ControlUiDatabase {
    private readonly workspaceDir;
    private readonly dbPath;
    private readonly blobDir;
    private readonly db;
    constructor(opts: ControlUiDatabaseOptions);
    dispose(): void;
    recordThinkingModelEvent(input: ThinkingModelEventInput): number;
    getRecentThinkingContext(sessionId: string, beforeCreatedAt: string, limit?: number): RecentThinkingContext;
    all<T>(sql: string, ...params: unknown[]): T[];
    get<T>(sql: string, ...params: unknown[]): T | undefined;
    restoreRawText(inlineText?: string | null, blobRef?: string | null): string;
    private initSchema;
    private withWrite;
}
