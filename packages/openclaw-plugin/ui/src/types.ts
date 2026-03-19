export interface OverviewResponse {
  workspaceDir: string;
  generatedAt: string;
  dataFreshness: string | null;
  summary: {
    repeatErrorRate: number;
    userCorrectionRate: number;
    pendingSamples: number;
    approvedSamples: number;
    thinkingCoverageRate: number;
    painEvents: number;
    principleEventCount: number;
  };
  dailyTrend: Array<{
    day: string;
    toolCalls: number;
    failures: number;
    userCorrections: number;
    thinkingTurns: number;
  }>;
  topRegressions: Array<{
    toolName: string;
    errorType: string;
    occurrences: number;
  }>;
  sampleQueue: {
    counters: Record<string, number>;
    preview: Array<{
      sampleId: string;
      sessionId: string;
      qualityScore: number;
      reviewStatus: string;
      createdAt: string;
    }>;
  };
  thinkingSummary: {
    activeModels: number;
    dormantModels: number;
    effectiveModels: number;
    coverageRate: number;
  };
}

export interface SamplesResponse {
  counters: Record<string, number>;
  items: Array<{
    sampleId: string;
    sessionId: string;
    reviewStatus: string;
    qualityScore: number;
    failureMode: string;
    relatedThinkingCount: number;
    createdAt: string;
    updatedAt: string;
    diffExcerpt: string;
  }>;
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export interface SampleDetailResponse {
  sampleId: string;
  sessionId: string;
  reviewStatus: string;
  qualityScore: number;
  createdAt: string;
  updatedAt: string;
  badAttempt: {
    assistantTurnId: number;
    rawText: string;
    sanitizedText: string;
    createdAt: string;
  };
  userCorrection: {
    userTurnId: number;
    rawText: string;
    correctionCue: string | null;
    createdAt: string;
  };
  recoveryToolSpan: Array<{ id: number; toolName: string }>;
  relatedPrinciples: Array<{
    principleId: string | null;
    eventType: string;
    createdAt: string;
  }>;
  relatedThinkingHits: Array<{
    id: number;
    modelId: string;
    modelName: string;
    matchedPattern: string;
    scenarios: string[];
    createdAt: string;
    triggerExcerpt: string;
  }>;
  reviewHistory: Array<{
    reviewStatus: string;
    note: string | null;
    createdAt: string;
  }>;
}

export interface ThinkingModelSummary {
  modelId: string;
  name: string;
  description: string;
  hits: number;
  coverageRate: number;
  successRate: number;
  failureRate: number;
  painRate: number;
  correctionRate: number;
  correctionSampleRate: number;
  commonScenarios: string[];
  recommendation: 'reinforce' | 'rework' | 'archive';
}

export interface ThinkingOverviewResponse {
  summary: {
    totalModels: number;
    activeModels: number;
    dormantModels: number;
    effectiveModels: number;
    coverageRate: number;
  };
  topModels: ThinkingModelSummary[];
  dormantModels: Array<{
    modelId: string;
    name: string;
    description: string;
  }>;
  effectiveModels: ThinkingModelSummary[];
  scenarioMatrix: Array<{
    modelId: string;
    modelName: string;
    scenario: string;
    hits: number;
  }>;
  coverageTrend: Array<{
    day: string;
    assistantTurns: number;
    thinkingTurns: number;
    coverageRate: number;
  }>;
}

export interface ThinkingModelDetailResponse {
  modelMeta: {
    modelId: string;
    name: string;
    description: string;
    hits: number;
    coverageRate: number;
    recommendation: 'reinforce' | 'rework' | 'archive';
  };
  usageTrend: Array<{
    day: string;
    hits: number;
  }>;
  scenarioDistribution: Array<{
    scenario: string;
    hits: number;
  }>;
  outcomeStats: {
    events: number;
    successRate: number;
    failureRate: number;
    painRate: number;
    correctionRate: number;
    correctionSampleRate: number;
  };
  recentEvents: Array<{
    id: number;
    createdAt: string;
    matchedPattern: string;
    scenarios: string[];
    triggerExcerpt: string;
    toolContext: Array<{ toolName: string; outcome: string; errorType?: string | null }>;
    painContext: Array<{ source: string; score: number }>;
    principleContext: Array<{ principleId: string | null; eventType: string }>;
  }>;
}
