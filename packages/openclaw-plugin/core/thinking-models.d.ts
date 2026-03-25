export interface ThinkingModelDefinition {
    id: string;
    name: string;
    description: string;
    patterns: RegExp[];
    baselineScenarios: string[];
}
export interface ThinkingModelMatch {
    modelId: string;
    matchedPattern: string;
}
export interface ThinkingScenarioContext {
    recentToolCalls?: Array<{
        toolName: string;
        outcome: 'success' | 'failure' | 'blocked';
        errorType?: string | null;
    }>;
    recentPainEvents?: Array<{
        source: string;
        score: number;
    }>;
    recentGateBlocks?: Array<{
        toolName: string;
        reason: string;
    }>;
    recentUserCorrections?: Array<{
        correctionCue?: string | null;
    }>;
    recentPrincipleEvents?: Array<{
        eventType: string;
        principleId?: string | null;
    }>;
}
export declare const THINKING_MODEL_MAP: Map<string, ThinkingModelDefinition>;
export declare function listThinkingModels(): ThinkingModelDefinition[];
export declare function getThinkingModel(modelId: string): ThinkingModelDefinition | undefined;
export declare function detectThinkingModelMatches(text: string): ThinkingModelMatch[];
export declare function deriveThinkingScenarios(modelId: string, context: ThinkingScenarioContext): string[];
