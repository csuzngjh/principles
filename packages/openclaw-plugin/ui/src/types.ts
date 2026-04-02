export interface OverviewResponse {
  workspaceDir: string;
  generatedAt: string;
  dataFreshness: string | null;
  dataSource?: string;
  runtimeControlPlaneSource?: string;
  summary: {
    repeatErrorRate: number;
    userCorrectionRate: number;
    pendingSamples: number;
    approvedSamples: number;
    thinkingCoverageRate: number;
    painEvents: number;
    principleEventCount: number;
    gateBlocks?: number;
    taskOutcomes?: number;
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

// Evolution Types
export interface EvolutionTaskItem {
  taskId: string;
  traceId: string;
  source: string;
  reason: string | null;
  score: number;
  status: string;
  enqueuedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  duration: number | null;
  resolution: string | null;
  eventCount: number;
  createdAt: string;
}

export interface EvolutionTasksResponse {
  items: EvolutionTaskItem[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export interface EvolutionEventItem {
  id: number;
  traceId: string;
  taskId: string | null;
  stage: string;
  stageLabel: string;
  stageColor: string;
  level: string;
  message: string;
  summary: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface EvolutionEventsResponse {
  items: EvolutionEventItem[];
  pagination: {
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

export interface EvolutionTraceResponse {
  traceId: string;
  task: {
    taskId: string;
    traceId: string;
    source: string;
    reason: string | null;
    score: number;
    status: string;
    enqueuedAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
    duration: number | null;
    resolution: string | null;
    createdAt: string;
    updatedAt: string;
  };
  events: EvolutionEventItem[];
  timeline: Array<{
    stage: string;
    stageLabel: string;
    stageColor: string;
    timestamp: string;
    message: string;
    summary: string | null;
  }>;
}

export interface EvolutionStatsResponse {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  recentActivity: Array<{
    day: string;
    created: number;
    completed: number;
  }>;
  stageDistribution: Array<{
    stage: string;
    stageLabel: string;
    count: number;
  }>;
}

// ===== Phase 5: Health & Circuit API Types =====

export interface OverviewHealthResponse {
  gfi: { current: number; peakToday: number; threshold: number };
  trust: { stage: number; stageLabel: string; score: number };
  evolution: { tier: string; points: number };
  painFlag: { active: boolean; source: string | null; score: number | null };
  principles: { candidate: number; probation: number; active: number; deprecated: number };
  queue: { pending: number; inProgress: number; completed: number };
  activeStage: string;
}

export interface EvolutionPrinciplesResponse {
  principles: {
    summary: { candidate: number; probation: number; active: number; deprecated: number };
    recent: Array<{
      principleId: string;
      status: string;
      triggerPattern: string;
      action: string;
      fromStatus: string;
      toStatus: string;
      timestamp: string;
    }>;
  };
  nocturnalTraining: {
    queue: { pending: number; inProgress: number; completed: number };
    trinityRecords: Array<{ artifactId: string; status: string; createdAt: string }>;
    arbiterPassRate: number;
    orpoSampleCount: number;
    deployments: Array<{ modelId: string; status: string; checkpointPath: string | null }>;
  };
  painSourceDistribution: Record<string, number>;
  activeStage: string;
}

export interface FeedbackGfiResponse {
  current: number;
  peakToday: number;
  threshold: number;
  trend: Array<{ hour: string; value: number }>;
  sources: Record<string, number>;
}

export interface EmpathyEvent {
  timestamp: string;
  severity: string;
  score: number;
  reason: string;
  origin: string;
  gfiAfter: number;
}

export interface FeedbackGateBlock {
  timestamp: string;
  toolName: string;
  reason: string;
  gfi: number;
  trustStage: number;
}

export interface GateStatsResponse {
  today: {
    gfiBlocks: number;
    stageBlocks: number;
    p03Blocks: number;
    bypassAttempts: number;
    p16Exemptions: number;
  };
  trust: { stage: number; score: number; status: string };
  evolution: { tier: string; points: number; status: string };
}

export interface GateBlockItem {
  timestamp: string;
  toolName: string;
  filePath: string | null;
  reason: string;
  gateType: string;
  gfi: number;
  trustStage: number;
}

// ===== Phase 5: Health & Circuit API Types =====

export interface OverviewHealthResponse {
  gfi: { current: number; peakToday: number; threshold: number };
  trust: { stage: number; stageLabel: string; score: number };
  evolution: { tier: string; points: number };
  painFlag: { active: boolean; source: string | null; score: number | null };
  principles: { candidate: number; probation: number; active: number; deprecated: number };
  queue: { pending: number; inProgress: number; completed: number };
  activeStage: string;
}

export interface EvolutionPrinciplesResponse {
  principles: {
    summary: { candidate: number; probation: number; active: number; deprecated: number };
    recent: Array<{
      principleId: string;
      status: string;
      triggerPattern: string;
      action: string;
      fromStatus: string;
      toStatus: string;
      timestamp: string;
    }>;
  };
  nocturnalTraining: {
    queue: { pending: number; inProgress: number; completed: number };
    trinityRecords: Array<{ artifactId: string; status: string; createdAt: string }>;
    arbiterPassRate: number;
    orpoSampleCount: number;
    deployments: Array<{ modelId: string; status: string; checkpointPath: string | null }>;
  };
  painSourceDistribution: Record<string, number>;
  activeStage: string;
}

export interface FeedbackGfiResponse {
  current: number;
  peakToday: number;
  threshold: number;
  trend: Array<{ hour: string; value: number }>;
  sources: Record<string, number>;
}

export interface EmpathyEvent {
  timestamp: string;
  severity: string;
  score: number;
  reason: string;
  origin: string;
  gfiAfter: number;
}

export interface FeedbackGateBlock {
  timestamp: string;
  toolName: string;
  reason: string;
  gfi: number;
  trustStage: number;
}

export interface GateStatsResponse {
  today: {
    gfiBlocks: number;
    stageBlocks: number;
    p03Blocks: number;
    bypassAttempts: number;
    p16Exemptions: number;
  };
  trust: { stage: number; score: number; status: string };
  evolution: { tier: string; points: number; status: string };
}

export interface GateBlockItem {
  timestamp: string;
  toolName: string;
  filePath: string | null;
  reason: string;
  gateType: string;
  gfi: number;
  trustStage: number;
}
